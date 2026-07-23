// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Push orchestration, ported from `pkg/cfsync/push.go` (the edit-push half). A
// push reads an edited note's `cfsync:` frontmatter and body, reloads the cached
// baseline ADF of the recorded version, back-ports the edits with the Put lens,
// and — when the remote has moved since the note was pulled — rebases them onto
// the live document with a block-level three-way merge, so both lens laws still
// gate the result and a block edited on both sides is a refused conflict. The new
// ADF is PUT to Confluence and the cache and note refreshed to the pushed version.
// Everything is driven through the {@link ConfluenceClient}, {@link FileSystem},
// {@link Reporter}, and {@link Yaml} ports; the run is sequential. New-image
// upload lands in the second layer; page creation + create-and-restrict is M7.4.

import { MergeConflictError, merge3Links } from "../adf/lens/merge.ts";
import type { NewImage } from "../adf/lens/reconstruct.ts";
import { goQuote } from "../adf/render/frontmatter.ts";
import { cacheFile, type Page, pageDoc, writePage } from "../cache/cache.ts";
import type { Config } from "../config/config.ts";
import type { ConfluenceClient, PageData } from "../confluence/client.ts";
import type { Flavor } from "../flavor/flavor.ts";
import { type ADF, newADF } from "../models/adf.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Reporter } from "../ports/progress.ts";
import type { Yaml } from "../ports/yaml.ts";
import { posixJoin } from "../util/path.ts";
import {
    type CreateInput,
    classifyCreates,
    ensureFolders,
    rollbackFolders,
} from "./create.ts";
import { mdFilesUnder } from "./fswalk.ts";
import {
    canonicalizeImages,
    deleteAttachments,
    type MintLocalId,
    type UploadedImage,
    uploadNewImages,
} from "./images.ts";
import { type LinkIndex, linkMapper, pageName } from "./linkindex.ts";
import { hasConflictMarkers } from "./merge.ts";

/** PageImage is one entry of the `page_images` frontmatter list. */
export interface PageImage {
    localId: string;
    file: string;
    alt: string;
}

/** PushMeta is the `cfsync:` frontmatter a push reads from an edited note. */
export interface PushMeta {
    title: string;
    pageId: string;
    pageVersion: number;
    spaceId: string;
    spaceKey: string;
    parentId: string;
    domain: string;
    /** The `cf_local` marker: a page created locally, not yet pushed. */
    local: boolean;
    /** True when the `cfsync-plugin: pull` marker is present: a cfsync-managed note pulled from Confluence. */
    cfsync: boolean;
    /**
     * True when the `cfsync-plugin: ignore-push` marker is present: the note is
     * excluded from push (never created, updated, or reported as movable), even
     * though it still lives under a managed root. Use it to keep an in-progress
     * or intentionally-local edit out of Confluence without moving the file.
     */
    ignorePush: boolean;
    mentions: Record<string, string>;
    pageImages: PageImage[];
}

/** PushOutcome is the log, counts, and per-page failures of a batch push. */
export interface PushOutcome {
    log: string;
    pushed: number;
    unchanged: number;
    total: number;
    errors: string[];
    /**
     * Non-fatal problems on pages that were still pushed — e.g. the remote was
     * updated but refreshing the local copy afterwards failed. Distinct from
     * `errors`, which are pages that did not push.
     */
    warnings: string[];
}

/**
 * splitFrontmatter separates the `---`-fenced YAML frontmatter of an edited note
 * from its body, returning the raw frontmatter text and the body with the
 * frontmatter and surrounding blank lines removed. It throws when the frontmatter
 * is missing or unterminated; parsing the YAML is the {@link Yaml} port's job.
 */
export function splitFrontmatter(md: string): {
    frontmatter: string;
    body: string;
    /** 1-based line in `md` where `body` begins, so a push error can name it. */
    bodyLine: number;
} {
    if (!md.startsWith("---\n")) {
        throw new Error("file has no frontmatter");
    }
    const rest = md.slice("---\n".length);
    const end = rest.indexOf("\n---");
    if (end < 0) {
        throw new Error("file has unterminated frontmatter");
    }
    const frontmatter = rest.slice(0, end + 1);
    const afterFence = rest.slice(end + "\n---".length);
    const body = afterFence.replace(/^\n+/, "").replace(/\n+$/, "");
    const consumed =
        "---\n".length + end + "\n---".length + skippedLeadingLen(afterFence);
    const bodyLine = countNewlines(md.slice(0, consumed)) + 1;
    return { frontmatter, body, bodyLine };
}

/** skippedLeadingLen is the length of the leading run of newlines stripped from s. */
function skippedLeadingLen(s: string): number {
    return s.length - s.replace(/^\n+/, "").length;
}

/** countNewlines counts the newline characters in s. */
function countNewlines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s.charAt(i) === "\n") {
            n++;
        }
    }
    return n;
}

/** parseMeta maps a parsed frontmatter object onto the typed {@link PushMeta}. */
export function parseMeta(obj: unknown): PushMeta {
    const o = asObj(obj);
    return {
        title: asStr(o["title"]),
        pageId: asStr(o["page_id"]),
        pageVersion: asInt(o["page_version"]),
        spaceId: asStr(o["space_id"]),
        spaceKey: asStr(o["space_key"]),
        parentId: asStr(o["parent_id"]),
        domain: asStr(o["cf_domain"]),
        local: o["cf_local"] === true,
        cfsync: o["cfsync-plugin"] === "pull",
        ignorePush: o["cfsync-plugin"] === "ignore-push",
        mentions: asStrMap(o["mentions"]),
        pageImages: asArr(o["page_images"]).map((v) => {
            const im = asObj(v);
            return {
                localId: asStr(im["local_id"]),
                file: asStr(im["file"]),
                alt: asStr(im["alt"]),
            };
        }),
    };
}

/**
 * readPageMeta reads and parses a note's frontmatter into {@link PushMeta},
 * resolving to `null` when the file is missing, has no frontmatter, or has invalid
 * YAML — the "unreadable" case gc and clean treat conservatively.
 */
export async function readPageMeta(
    fs: FileSystem,
    yaml: Yaml,
    path: string,
): Promise<PushMeta | null> {
    let text: string;
    try {
        text = await fs.readText(path);
    } catch {
        return null;
    }
    try {
        return parseMeta(yaml.parse(splitFrontmatter(text).frontmatter));
    } catch {
        return null;
    }
}

/**
 * MetaCache memoizes {@link readPageMeta} within a single push or status run.
 * The planning phase reads each candidate note's frontmatter more than once —
 * to discover the managed dests ({@link managedPushDests}), to classify creates
 * ({@link planCreates}), and to preflight ({@link pushPreflight}) — and no note
 * is mutated before planning ends, so a per-run cache keyed by path collapses
 * those to one read each. It is deliberately not shared across runs (frontmatter
 * changes between pushes) and is not used by the execution phase, which reads
 * each note fresh (it also needs the body). The parsed {@link PushMeta} is never
 * mutated by callers, so sharing one instance per path is safe.
 */
export class MetaCache {
    private readonly memo = new Map<string, Promise<PushMeta | null>>();

    read(fs: FileSystem, yaml: Yaml, path: string): Promise<PushMeta | null> {
        let pending = this.memo.get(path);
        if (pending === undefined) {
            pending = readPageMeta(fs, yaml, path);
            this.memo.set(path, pending);
        }
        return pending;
    }
}

/**
 * readMeta reads a note's frontmatter through `cache` when one is supplied,
 * otherwise directly — letting the planning functions dedupe reads within a run
 * while staying callable (in tests, and by the single-note commands) without a
 * cache.
 */
export function readMeta(
    cache: MetaCache | undefined,
    fs: FileSystem,
    yaml: Yaml,
    path: string,
): Promise<PushMeta | null> {
    return cache ? cache.read(fs, yaml, path) : readPageMeta(fs, yaml, path);
}

/**
 * metaAssets rebuilds the localId→image-path map from `page_images`, so the
 * baseline render on push matches the render on pull.
 */
export function metaAssets(meta: PushMeta): Record<string, string> {
    const out: Record<string, string> = {};
    for (const img of meta.pageImages) {
        out[img.localId] = img.file;
    }
    return out;
}

/** PusherDeps are the ports and resolved paths a {@link Pusher} needs. */
export interface PusherDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
    reporter: Reporter;
    /** Device-local ADF cache dir (`.vN.json`/`.vN.md`). */
    cacheDir: string;
    /** Image assets dir, under the sync root, where pushed images are canonicalized. */
    assetsDir: string;
    /** Mints a fresh media-node localId for an uploaded image (injected for determinism). */
    mintLocalId: MintLocalId;
    /** The link index for this run, or null to disable link rewriting. */
    links: LinkIndex | null;
    /** The Markdown flavor driving ADF↔Markdown conversion. */
    flavor: Flavor;
    /** Re-derive every editable block from its Markdown even when unedited (push --force). Defaults to `false`. */
    force?: boolean;
}

/**
 * managedPushDests returns the note destinations a push considers: every
 * configured `pages:` key, plus every pushable `.md` file on disk under a
 * configured folder or space root — unique and sorted. Walking the roots (not
 * just the last pull's link index) is what surfaces a **new** note under a root
 * for creation, alongside the already-managed pages edited in place. A note
 * marked `cf_local` or `cfsync-plugin: ignore-push` is excluded everywhere; a
 * root file with no frontmatter, or with neither a page id nor a title, is not a
 * managed page and is skipped.
 */
export async function managedPushDests(
    fs: FileSystem,
    yaml: Yaml,
    config: Config,
    cache?: MetaCache,
): Promise<string[]> {
    const seen = new Set<string>();
    const dests: string[] = [];
    const add = (dest: string): void => {
        if (!seen.has(dest)) {
            seen.add(dest);
            dests.push(dest);
        }
    };

    // Configured single pages, minus notes marked local or ignore-push.
    for (const dest of Object.keys(config.pages)) {
        const meta = await readMeta(cache, fs, yaml, dest);
        if (meta?.local === true || meta?.ignorePush === true) {
            continue;
        }
        add(dest);
    }

    // Pushable files under the folder and space roots.
    const roots = [
        ...Object.keys(config.folders),
        ...Object.keys(config.spaces),
    ];
    for (const dest of await pushableFiles(
        fs,
        yaml,
        await mdFilesUnder(fs, roots),
        cache,
    )) {
        add(dest);
    }

    dests.sort();
    return dests;
}

/**
 * pushableFiles keeps the notes among `dests` a push can act on: a managed page
 * (has a `page_id`) or a create candidate (has a `title`). A note marked
 * `cf_local` or `cfsync-plugin: ignore-push`, or one with no frontmatter at all,
 * is dropped.
 */
async function pushableFiles(
    fs: FileSystem,
    yaml: Yaml,
    dests: string[],
    cache?: MetaCache,
): Promise<string[]> {
    const out: string[] = [];
    for (const dest of dests) {
        const meta = await readMeta(cache, fs, yaml, dest);
        if (meta === null || meta.local || meta.ignorePush) {
            continue;
        }
        if (meta.pageId !== "" || meta.title !== "") {
            out.push(dest);
        }
    }
    return out;
}

/**
 * CreatePlan records, for one push run, which discovered new pages the user
 * confirmed and the author account created pages are restricted to. A `null` plan
 * means the run creates nothing; a dest absent from `decided` is an existing page
 * pushed as an update, not a create.
 */
export interface CreatePlan {
    /** Each create candidate's dest → whether to create it. */
    decided: Map<string, boolean>;
    /** Each dest whose space/parent could not be derived → the refusal reason. */
    refused: Map<string, string>;
    /** Each candidate's dest → its resolved identity (space, parent, folders). */
    inputs: Map<string, CreateInput>;
    /** The author every created page is restricted to; `""` when none is confirmed. */
    accountId: string;
}

/**
 * planWants reports whether the plan creates the page at `dest` (`create`), and
 * whether `dest` is a create candidate at all (`isCand`). A `null` plan never
 * creates and has no candidates.
 */
export function planWants(
    plan: CreatePlan | null,
    dest: string,
): { create: boolean; isCand: boolean } {
    if (plan === null || !plan.decided.has(dest)) {
        return { create: false, isCand: false };
    }
    return { create: plan.decided.get(dest) === true, isCand: true };
}

/** planRefusal returns why the create at `dest` was refused, or `""` when it was not. */
export function planRefusal(plan: CreatePlan | null, dest: string): string {
    return plan?.refused.get(dest) ?? "";
}

/**
 * planCreates classifies the note destinations into new-page candidates and
 * refusals (disk-only, from the configured folder and space roots), asks the
 * injected `confirm` which candidates to create (the prompt UX is the adapter's),
 * and resolves the author account once any create is confirmed. It resolves to
 * `null` when nothing is to be created or refused, so the caller pushes updates
 * only. `confirm` receives the candidates and returns each dest → create decision.
 */
export async function planCreates(
    deps: Pick<PusherDeps, "client" | "fs" | "yaml" | "config">,
    dests: string[],
    confirm: (cands: CreateInput[]) => Promise<Map<string, boolean>>,
    cache?: MetaCache,
): Promise<CreatePlan | null> {
    const roots = [
        ...Object.keys(deps.config.folders),
        ...Object.keys(deps.config.spaces),
    ];
    const { candidates, refusals } = await classifyCreates(
        deps.fs,
        deps.yaml,
        dests,
        roots,
        cache,
    );
    if (candidates.length === 0 && refusals.size === 0) {
        return null;
    }
    const decided = await confirm(candidates);
    const inputs = new Map<string, CreateInput>();
    for (const c of candidates) {
        inputs.set(c.dest, c);
    }
    let accountId = "";
    for (const create of decided.values()) {
        if (create) {
            accountId = await deps.client.currentAccountID();
            break;
        }
    }
    return { decided, refused: refusals, inputs, accountId };
}

/** Pusher back-ports edited notes to Confluence. It holds the ports for one run. */
export class Pusher {
    constructor(private readonly d: PusherDeps) {}

    /**
     * pushDests pushes each note in order, recording per-page failures without
     * stopping the run. A dest the `plan` marks as a confirmed create is created
     * and restricted rather than updated; one it marks as skipped is left
     * untouched; one it refused fails with the refusal. A `null` plan pushes every
     * dest as an update. Folders new this run are created once and shared across
     * the pages under them.
     */
    async pushDests(
        dests: string[],
        plan: CreatePlan | null = null,
    ): Promise<PushOutcome> {
        const out: PushOutcome = {
            log: "",
            pushed: 0,
            unchanged: 0,
            total: dests.length,
            errors: [],
            warnings: [],
        };
        // folderIds tracks folders created this run so pages sharing a new
        // ancestor directory create it once (see ensureFolders).
        const folderIds = new Map<string, string>();
        for (const dest of dests) {
            const name = pageName(this.d.config.syncRoot, dest);
            this.d.reporter.item(name);

            const refusal = planRefusal(plan, dest);
            if (refusal !== "") {
                out.errors.push(`${name}: ${refusal}`);
                continue;
            }
            const { create, isCand } = planWants(plan, dest);
            if (isCand) {
                if (!create) {
                    const line = `creating ${name} ... skipped\n`;
                    out.log += line;
                    this.d.reporter.log(line);
                    continue;
                }
                try {
                    const input = plan?.inputs.get(dest);
                    if (input === undefined) {
                        throw new Error(
                            "create candidate has no resolved input",
                        );
                    }
                    const { version, reused } = await this.pushCreate(
                        dest,
                        input,
                        plan?.accountId ?? "",
                        folderIds,
                    );
                    out.pushed++;
                    let line = `creating ${name} ... ok (v${version})\n`;
                    for (const title of reused) {
                        line += `      reused existing folder "${title}"\n`;
                    }
                    out.log += line;
                    this.d.reporter.log(line);
                } catch (err) {
                    out.errors.push(`${name}: ${message(err)}`);
                }
                continue;
            }

            try {
                const { changed, version, warning } = await this.pushOne(dest);
                const line = changed
                    ? `pushing ${name} ... ok (v${version})\n`
                    : `pushing ${name} ... unchanged\n`;
                out.log += line;
                this.d.reporter.log(line);
                if (warning !== "") {
                    const warnLine = `      warning: ${warning}\n`;
                    out.log += warnLine;
                    this.d.reporter.log(warnLine);
                    out.warnings.push(`${name}: ${warning}`);
                }
                if (changed) {
                    out.pushed++;
                } else {
                    out.unchanged++;
                }
            } catch (err) {
                out.errors.push(`${name}: ${message(err)}`);
            }
        }
        return out;
    }

    /**
     * pushCreate creates a new Confluence page from the note at `dest` and
     * restricts it to `accountId`, first ensuring any ancestor folders the plan
     * named exist (see {@link ensureFolders}). The space and parent come from the
     * resolved `input`, not the note's (possibly empty) frontmatter, and the parent
     * is the deepest new folder when this page created its own ancestors. On a
     * create failure past the folders it rolls them back; on a restriction failure
     * it deletes the world-visible page and rolls the folders back. Once the page
     * is live it stamps the new id onto the note before the local refresh, so a
     * later refresh failure still leaves the page tracked rather than re-created.
     * `folderIds` is the run-scoped folder-dedupe map (see {@link pushDests}).
     */
    async pushCreate(
        dest: string,
        input: CreateInput,
        accountId: string,
        folderIds: Map<string, string>,
    ): Promise<{ version: number; reused: string[] }> {
        const { parent, created, reused } = await ensureFolders(
            this.d.client,
            input,
            accountId,
            folderIds,
        );
        // Any failure past this point must also unwind the folders created above,
        // so a rejected page leaves no orphan folder chain behind.
        const fail = async (err: unknown): Promise<never> => {
            await rollbackFolders(this.d.client, folderIds, created);
            throw err instanceof Error ? err : new Error(String(err));
        };

        let edited: string;
        try {
            edited = await this.d.fs.readText(dest);
        } catch (err) {
            return fail(new Error(`reading ${dest}: ${message(err)}`));
        }
        if (hasConflictMarkers(edited)) {
            return fail(
                new Error(
                    `${pageName(this.d.config.syncRoot, dest)}: unresolved ` +
                        "conflict markers; resolve them before pushing",
                ),
            );
        }
        let meta: PushMeta;
        let body: string;
        try {
            const split = splitFrontmatter(edited);
            body = split.body;
            meta = parseMeta(this.d.yaml.parse(split.frontmatter));
        } catch (err) {
            return fail(err);
        }
        // The space and parent were resolved during planning, so use them, not the
        // possibly empty frontmatter, both to create the page and to stamp it back.
        meta.spaceId = input.spaceId;
        meta.parentId = parent;
        const name = pageName(this.d.config.syncRoot, dest);
        const links = linkMapper(
            this.d.links,
            dest,
            this.d.config.domain,
            this.d.config.host,
        );
        const assets = metaAssets(meta);

        let docJSON: string;
        try {
            const base: ADF = {
                name,
                id: "",
                title: meta.title,
                version: 0,
                spaceId: meta.spaceId,
                spaceKey: "",
                parentId: parent,
                domain: "",
                doc: { type: "doc" },
            };
            const next = this.d.flavor.reconstruct(base, body, {
                mentions: meta.mentions,
                assets,
                images: null,
                links,
            });
            docJSON = JSON.stringify(next.doc);
        } catch (err) {
            return fail(err);
        }

        let id: string;
        let version: number;
        try {
            const res = await this.d.client.createPage({
                spaceId: meta.spaceId,
                title: meta.title,
                parentId: parent,
                docJSON,
            });
            id = res.id;
            version = res.version;
        } catch (err) {
            return fail(err);
        }

        // The page exists but is world-visible until restricted — the one state a
        // create must not leave. On failure delete the page and unwind any folders
        // this page created; surface a delete failure with the restriction error.
        try {
            await this.d.client.restrictToAuthor(id, accountId);
        } catch (err) {
            let joined = message(err);
            try {
                await this.d.client.deletePage(id);
            } catch (delErr) {
                joined = `${joined}; ${message(delErr)}`;
            }
            return fail(new Error(joined));
        }

        // Stamp the new identity onto the note before the full refresh so a later
        // push updates this page even when the refresh fails mid-way. The folders
        // are live and the page depends on them, so a failure past here does not
        // roll them back.
        meta.pageId = id;
        meta.pageVersion = version;
        try {
            await stampCreateIdentity(this.d.fs, dest, meta);
        } catch (err) {
            throw new Error(
                `page ${id} created but not tracked: ${message(err)}`,
            );
        }
        await refreshAfterPush(
            this.d.fs,
            this.d.cacheDir,
            name,
            dest,
            meta,
            docJSON,
            version,
            assets,
            links,
            this.d.config.margin,
            this.d.flavor,
        );
        return { version, reused };
    }

    /**
     * pushOne back-ports the edited note at `dest`. It loads the frontmatter and
     * cached baseline, back-ports the edits with the lens (rebasing onto the live
     * page when the remote moved), and — only when the body or title changed —
     * PUTs the new ADF and refreshes the cache and note to the pushed version.
     */
    async pushOne(
        dest: string,
    ): Promise<{ changed: boolean; version: number; warning: string }> {
        const { meta, body, base, bodyLine } = await loadPushInput(
            this.d.fs,
            this.d.yaml,
            this.d.cacheDir,
            this.d.config,
            dest,
        );
        const assets = metaAssets(meta);
        const links = linkMapper(
            this.d.links,
            dest,
            this.d.config.domain,
            this.d.config.host,
        );
        const force = this.d.force ?? false;

        // Upload any user-added local images first so the lens can splice them in;
        // an attachment already uploaded is an orphan until the PUT succeeds, so a
        // failure anywhere below deletes it. Once the page is live `uploaded` is
        // cleared, so a later refresh error never deletes a live attachment.
        let uploaded: UploadedImage[] = [];
        try {
            const up = await uploadNewImages(
                this.d.client,
                this.d.fs,
                meta.pageId,
                dest,
                body,
                assets,
                this.d.mintLocalId,
            );
            uploaded = up.uploaded;

            const next = this.d.flavor.reconstruct(base, body, {
                mentions: meta.mentions,
                assets,
                images: up.images,
                links,
                force,
                bodyLine,
            });
            const docJSON = JSON.stringify(next.doc);
            if (
                docJSON === JSON.stringify(base.doc) &&
                meta.title === base.title
            ) {
                await deleteAttachments(this.d.client, uploaded);
                return {
                    changed: false,
                    version: meta.pageVersion,
                    warning: "",
                };
            }

            const pushed = await pushDoc(
                this.d.client,
                meta,
                base,
                body,
                assets,
                up.images,
                links,
                docJSON,
                this.d.flavor,
                force,
                bodyLine,
            );
            await this.d.client.updatePage(
                meta.pageId,
                meta.title,
                pushed.version,
                pushed.docJSON,
            );

            // The remote is now updated: the push has SUCCEEDED and must never be
            // reported as failed by a later local-refresh error. Clear the
            // uploaded list (the attachments are live and must survive) and, from
            // here on, treat every local step as best-effort — stamping the new
            // version and refreshing the cache/note. Persisting the version to the
            // note first means a refresh failure cannot leave the note stale at the
            // old version, which would wrongly re-enter the merge path next push;
            // the refresh problem is surfaced as a warning, not a hard failure.
            const pushedImages = uploaded;
            uploaded = [];
            meta.pageVersion = pushed.version;
            let warning = "";
            try {
                await stampPushedVersion(this.d.fs, dest, pushed.version);
                await canonicalizeImages(
                    this.d.fs,
                    pushedImages,
                    dest,
                    this.d.assetsDir,
                    assets,
                );
                await refreshAfterPush(
                    this.d.fs,
                    this.d.cacheDir,
                    pageName(this.d.config.syncRoot, dest),
                    dest,
                    meta,
                    pushed.docJSON,
                    pushed.version,
                    assets,
                    links,
                    this.d.config.margin,
                    this.d.flavor,
                );
            } catch (err) {
                warning =
                    `pushed v${pushed.version} but refreshing the local ` +
                    `copy failed: ${message(err)}`;
            }
            return { changed: true, version: pushed.version, warning };
        } catch (err) {
            await deleteAttachments(this.d.client, uploaded);
            throw err;
        }
    }
}

/** PreflightClass classifies a push candidate against its remote version. */
export type PreflightClass = "new" | "in-sync" | "remote-moved" | "skip";

/** PreflightEntry is one candidate's local/remote version comparison. */
export interface PreflightEntry {
    dest: string;
    name: string;
    pageId: string;
    localBase: number;
    remoteVersion: number;
    cls: PreflightClass;
    reason: string;
}

/** PreflightDeps are the ports a {@link pushPreflight} run reads. */
export interface PreflightDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
}

/**
 * pushPreflight classifies each dest before a push by comparing the note's local
 * base version (`page_version` frontmatter) with the current remote version. A
 * note with no readable frontmatter is `skip`; one with no page id is `new` (it
 * would be created); a readable managed page whose remote version exceeds the
 * local base is `remote-moved` (push will three-way-merge or refuse), else
 * `in-sync`. The remote versions come from one bulk {@link
 * ConfluenceClient.fetchPageVersions} call rather than a fetch per page, so a
 * whole preview costs a handful of requests. A page absent from that response
 * (deleted or not visible) is `skip`; a transport failure marks every looked-up
 * page `skip` with the error as the reason — it never throws, so one bad page,
 * or one failed batch, does not sink the preview. Results stay in `dests` order.
 */
export async function pushPreflight(
    deps: PreflightDeps,
    dests: string[],
    cache?: MetaCache,
): Promise<PreflightEntry[]> {
    const { client, fs, yaml, config } = deps;
    const out: (PreflightEntry | null)[] = new Array(dests.length).fill(null);
    const pending: {
        idx: number;
        dest: string;
        name: string;
        pageId: string;
        localBase: number;
    }[] = [];

    // Read every note's frontmatter first, settling the classes that need no
    // remote lookup and collecting the managed pages whose versions we fetch.
    for (let idx = 0; idx < dests.length; idx++) {
        const dest = dests[idx] ?? "";
        const name = pageName(config.syncRoot, dest);
        const meta = await readMeta(cache, fs, yaml, dest);
        if (meta === null) {
            out[idx] = entry(dest, name, "", 0, 0, "skip", "unreadable note");
        } else if (meta.pageId === "") {
            out[idx] = entry(dest, name, "", meta.pageVersion, 0, "new", "");
        } else {
            pending.push({
                idx,
                dest,
                name,
                pageId: meta.pageId,
                localBase: meta.pageVersion,
            });
        }
    }

    // One bulk call fetches the current version of every managed page. A
    // transport failure marks the whole batch skip rather than sinking the view.
    let versions: Map<string, number>;
    try {
        versions = await client.fetchPageVersions(pending.map((p) => p.pageId));
    } catch (err) {
        for (const p of pending) {
            out[p.idx] = entry(
                p.dest,
                p.name,
                "",
                p.localBase,
                0,
                "skip",
                message(err),
            );
        }
        return out as PreflightEntry[];
    }

    for (const p of pending) {
        const remote = versions.get(p.pageId);
        if (remote === undefined) {
            out[p.idx] = entry(
                p.dest,
                p.name,
                "",
                p.localBase,
                0,
                "skip",
                "page not found on Confluence",
            );
            continue;
        }
        const cls = remote > p.localBase ? "remote-moved" : "in-sync";
        out[p.idx] = entry(
            p.dest,
            p.name,
            p.pageId,
            p.localBase,
            remote,
            cls,
            "",
        );
    }
    return out as PreflightEntry[];
}

/** entry builds a {@link PreflightEntry}; keeps {@link pushPreflight} terse. */
function entry(
    dest: string,
    name: string,
    pageId: string,
    localBase: number,
    remoteVersion: number,
    cls: PreflightClass,
    reason: string,
): PreflightEntry {
    return { dest, name, pageId, localBase, remoteVersion, cls, reason };
}

/**
 * loadPushInput reads the edited note, splits and parses its frontmatter, and
 * loads the cached baseline ADF of the recorded version. It throws when the
 * frontmatter lacks the page id or version needed to push.
 */
export async function loadPushInput(
    fs: FileSystem,
    yaml: Yaml,
    cacheDir: string,
    config: Config,
    dest: string,
): Promise<{ meta: PushMeta; body: string; base: ADF; bodyLine: number }> {
    let edited: string;
    try {
        edited = await fs.readText(dest);
    } catch (err) {
        throw new Error(`reading ${dest}: ${message(err)}`);
    }
    if (hasConflictMarkers(edited)) {
        throw new Error(
            `${pageName(config.syncRoot, dest)}: unresolved conflict markers; ` +
                "resolve them before pushing",
        );
    }
    const { frontmatter, body, bodyLine } = splitFrontmatter(edited);
    const meta = parseMeta(yaml.parse(frontmatter));
    if (meta.pageId === "" || meta.pageVersion === 0) {
        throw new Error("frontmatter lacks page_id or page_version");
    }
    const base = await readCache(
        fs,
        cacheDir,
        pageName(config.syncRoot, dest),
        meta.pageVersion,
    );
    return { meta, body, base, bodyLine };
}

/** readCache reads and parses the cached ADF wrapper for a page version. */
async function readCache(
    fs: FileSystem,
    cacheDir: string,
    name: string,
    version: number,
): Promise<ADF> {
    const base = name.endsWith(".md") ? name.slice(0, -3) : name;
    const path = posixJoin(cacheDir, `${base}.v${version}.json`);
    let data: string;
    try {
        data = await fs.readText(path);
    } catch (err) {
        throw new Error(`reading cached baseline v${version}: ${message(err)}`);
    }
    return newADF(data);
}

/**
 * pushDoc fetches the live page and returns the ADF JSON and version to PUT. When
 * the remote still matches the note's base version it pushes `docJSON` at the next
 * version; when it has moved on it rebases via {@link mergeOntoLive}.
 */
async function pushDoc(
    client: ConfluenceClient,
    meta: PushMeta,
    base: ADF,
    body: string,
    assets: Record<string, string>,
    images: NewImage[],
    links: ReturnType<typeof linkMapper>,
    docJSON: string,
    flavor: Flavor,
    force: boolean,
    bodyLine: number,
): Promise<{ docJSON: string; version: number }> {
    const data = await client.fetchPage(meta.pageId);
    if (data.version === meta.pageVersion) {
        return { docJSON, version: meta.pageVersion + 1 };
    }
    return mergeOntoLive(
        base,
        liveADF(data),
        meta,
        body,
        assets,
        images,
        links,
        flavor,
        force,
        bodyLine,
    );
}

/**
 * mergeOntoLive rebases the local edits onto the live remote version after the
 * two diverged: it three-way merges the edited body against the live document
 * over the cached baseline, reconstructs the merged ADF with the lens, and returns
 * the encoded document and the version to push (live's plus one). A block or title
 * edited on both sides is a conflict. When only the remote changed the title, meta
 * adopts it so the push does not revert it.
 */
function mergeOntoLive(
    base: ADF,
    live: ADF,
    meta: PushMeta,
    body: string,
    assets: Record<string, string>,
    images: NewImage[],
    links: ReturnType<typeof linkMapper>,
    flavor: Flavor,
    force: boolean,
    bodyLine: number,
): { docJSON: string; version: number } {
    const conflict = (detail: string): never => {
        throw new Error(
            `conflict: local base v${meta.pageVersion} but remote is ` +
                `v${live.version}; re-pull first: ${detail}`,
        );
    };
    if (
        meta.title !== base.title &&
        live.title !== base.title &&
        meta.title !== live.title
    ) {
        conflict(
            `title changed both sides (local "${meta.title}", ` +
                `remote "${live.title}")`,
        );
    } else if (meta.title === base.title) {
        meta.title = live.title; // only the remote changed it; adopt it
    }

    // Only a genuine version/merge conflict earns the "re-pull first" guidance:
    // the three-way merge failing means the two sides edited the same block, and
    // re-pulling is how the user resolves it. The reconstruct that follows can
    // fail for a different reason — an edit the lens laws refuse to back-port
    // (e.g. changing a table's column count) — and re-pulling cannot fix that, so
    // its honest message must propagate exactly as it does on the in-sync path.
    let merged: string;
    try {
        merged = merge3Links(base, live, body, assets, links, bodyLine);
    } catch (err) {
        if (err instanceof MergeConflictError) {
            return conflict(message(err));
        }
        throw err;
    }
    const next = flavor.reconstruct(live, merged, {
        mentions: meta.mentions,
        assets,
        images,
        links,
        force,
        bodyLine,
    });
    return { docJSON: JSON.stringify(next.doc), version: live.version + 1 };
}

/**
 * refreshAfterPush rewrites the ADF cache and the rendered Markdown (cache `.md`
 * and the note) for the pushed version, so the local state matches what was
 * pushed and the next push has a correct baseline.
 */
async function refreshAfterPush(
    fs: FileSystem,
    cacheDir: string,
    name: string,
    dest: string,
    meta: PushMeta,
    docJSON: string,
    version: number,
    assets: Record<string, string>,
    links: ReturnType<typeof linkMapper>,
    margin: number,
    flavor: Flavor,
): Promise<void> {
    const page: Page = {
        name,
        id: meta.pageId,
        title: meta.title,
        version,
        spaceId: meta.spaceId,
        spaceKey: meta.spaceKey,
        parentId: meta.parentId,
        domain: meta.domain,
        adf: docJSON,
    };
    const adfPath = posixJoin(cacheDir, cacheFile(page));
    await writePage(fs, adfPath, page);

    const md = flavor.render(pageDoc(page), { assets, links, margin })[0];
    const mdCache = `${adfPath.slice(0, -".json".length)}.md`;
    await fs.write(mdCache, md);
    await fs.write(dest, md);
}

/**
 * stampCreateIdentity writes the new page id and version into the note's
 * frontmatter so the note is no longer a create candidate even if the subsequent
 * full refresh fails. Every field a later push needs to stay self-consistent is
 * preserved: the identity (title, space, parent), the cfsync marker, and — so a
 * refresh failure does not strand the note — the space key, domain, mentions, and
 * page_images that resolve its assets and mentions on the next push. A successful
 * refresh replaces the whole note. The body is preserved (surrounding blank lines
 * normalized).
 */
async function stampCreateIdentity(
    fs: FileSystem,
    dest: string,
    meta: PushMeta,
): Promise<void> {
    let text: string;
    try {
        text = await fs.readText(dest);
    } catch (err) {
        throw new Error(`reading ${dest}: ${message(err)}`);
    }
    const { body } = splitFrontmatter(text);
    let out = "---\n";
    out += "cfsync-plugin: pull\n";
    out += `title: ${goQuote(meta.title)}\n`;
    out += `page_id: ${goQuote(meta.pageId)}\n`;
    out += `page_version: ${meta.pageVersion}\n`;
    out += `space_id: ${goQuote(meta.spaceId)}\n`;
    if (meta.parentId !== "") {
        out += `parent_id: ${goQuote(meta.parentId)}\n`;
    }
    if (meta.spaceKey !== "") {
        out += `space_key: ${goQuote(meta.spaceKey)}\n`;
    }
    if (meta.domain !== "") {
        out += `cf_domain: ${goQuote(meta.domain)}\n`;
    }
    if (meta.pageImages.length > 0) {
        out += "page_images:\n";
        for (const img of meta.pageImages) {
            out += `  - local_id: ${goQuote(img.localId)}\n`;
            out += `    file: ${goQuote(img.file)}\n`;
            out += `    alt: ${goQuote(img.alt)}\n`;
        }
    }
    const mentionNames = Object.keys(meta.mentions);
    if (mentionNames.length > 0) {
        out += "mentions:\n";
        for (const name of mentionNames) {
            out += `  ${goQuote(name)}: ${goQuote(meta.mentions[name] ?? "")}\n`;
        }
    }
    out += "---\n";
    if (body !== "") {
        out += `${body}\n`;
    }
    await fs.write(dest, out);
}

/**
 * stampPushedVersion advances the `page_version` in an already-managed note's
 * frontmatter in place, preserving every other field and the body verbatim. It is
 * the update-path counterpart to {@link stampCreateIdentity}: called once the
 * remote update has succeeded, before the best-effort refresh, so a refresh
 * failure cannot leave the note stale at the old version and re-enter the merge
 * path on the next push.
 */
async function stampPushedVersion(
    fs: FileSystem,
    dest: string,
    version: number,
): Promise<void> {
    const text = await fs.readText(dest);
    const { frontmatter, body } = splitFrontmatter(text);
    const line = `page_version: ${version}`;
    const updated = /^page_version:.*$/m.test(frontmatter)
        ? frontmatter.replace(/^page_version:.*$/m, line)
        : `${frontmatter}${line}\n`;
    let out = `---\n${updated}---\n`;
    if (body !== "") {
        out += `${body}\n`;
    }
    await fs.write(dest, out);
}

/** liveADF builds an ADF document from a fetched live page for the merge/lens. */
function liveADF(data: PageData): ADF {
    return newADF(
        JSON.stringify({
            id: data.id,
            title: data.title,
            version: data.version,
            space_id: data.spaceId,
            parent_id: data.parentId,
            adf: JSON.parse(data.adf),
        }),
    );
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** asObj narrows a parsed value to a record, or `{}`. */
function asObj(v: unknown): Record<string, unknown> {
    return typeof v === "object" && v !== null
        ? (v as Record<string, unknown>)
        : {};
}

/** asStr reads a string, or `""`. */
function asStr(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** asInt reads a number truncated toward zero, or `0`. */
function asInt(v: unknown): number {
    return typeof v === "number" ? Math.trunc(v) : 0;
}

/** asArr narrows a parsed value to an array, or `[]`. */
function asArr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

/** asStrMap reads a string→string map, coercing non-string values. */
function asStrMap(v: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(asObj(v))) {
        out[k] = typeof val === "string" ? val : String(val);
    }
    return out;
}
