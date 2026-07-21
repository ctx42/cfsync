// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Pull orchestration, ported from `pkg/cfsync/pull.go`. A pull fetches each
// managed page's ADF, caches it, renders its Markdown (downloading the page's
// images first so the render can link them), and writes the Markdown to both the
// cache and the note. A batch pull first probes every page's current remote
// version in one bulk request: a page whose version is already in the ADF cache
// renders straight from the cache, skipping the body download, so a re-pull of a
// mostly-unchanged space costs a fraction of the requests. The ADF cache and the per-version `.md` live under the
// injected `cacheDir` (the plugin data dir / CLI work tree, device-local per
// M6.3); images land under `assetsDir` (below the sync root); notes go to their
// dest paths. Everything is driven through the {@link ConfluenceClient},
// {@link FileSystem}, and {@link Reporter} ports. A batch pull fans out over its
// pages with {@link mapPool}, running up to {@link PULL_CONCURRENCY} at once (the
// HTTP client's semaphore still caps sockets), and folds the per-page results
// back in input order so the log and tally stay deterministic. Folder/space
// discovery is in `./discover.ts`; this module is the page pull and the
// `pullConfig`/`pullSelected` entry points.

import {
    cacheFile,
    cacheFileName,
    type Page,
    pageDoc,
    readCachedPage,
    writePage,
} from "../cache/cache.ts";
import type { Config } from "../config/config.ts";
import type { ConfluenceClient, PageData } from "../confluence/client.ts";
import { pageID, tryPageID } from "../confluence/sources.ts";
import { type Flavor, resolveFlavor } from "../flavor/flavor.ts";
import { fileMedia } from "../models/adf.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Reporter } from "../ports/progress.ts";
import { posixClean, posixDir, posixJoin } from "../util/path.ts";
import { mapPool } from "../util/pool.ts";
import { assetsFromDisk, downloadImages } from "./assets.ts";
import {
    collides,
    discoverFolder,
    discoverFolders,
    discoverSpace,
    discoverSpaces,
} from "./discover.ts";
import { dirEmpty, mdFilesUnder } from "./fswalk.ts";
import {
    buildLinkIndex,
    type DiscoveredPage,
    type LinkIndex,
    linkMapper,
    loadLinkIndex,
    pageName,
} from "./linkindex.ts";
import { hasConflictMarkers, mergeThreeWay } from "./merge.ts";
import { splitFrontmatter } from "./push.ts";

/** The default number of pages a batch pull fetches and renders at once. */
export const PULL_CONCURRENCY = 8;

/** PageState is the outcome of storing one pulled page. */
export type PageState =
    | "pulled"
    | "rerendered"
    | "unchanged"
    | "merged"
    | "conflict";

/** PullStats tallies the outcomes of pulling a set of pages. */
export interface PullStats {
    /** Pages fetched at a version not yet cached. */
    pulled: number;
    /** Cached pages whose re-rendered Markdown differed and was rewritten. */
    rendered: number;
    /** Cached pages whose Markdown was already current, so nothing was written. */
    unchanged: number;
    /** Pages whose unpushed local edits and remote changes merged cleanly. */
    merged: number;
    /** Pages left with unresolved conflict markers for manual resolution. */
    conflict: number;
    /** Pages attempted; total less the others is the number that failed. */
    total: number;
}

/** PullOutcome is the log, tally, and per-page failures of a batch pull. */
export interface PullOutcome {
    log: string;
    stats: PullStats;
    /** One message per failed page; the batch continues past a failure. */
    errors: string[];
}

/** PullItemResult is one page's contribution to a batch, folded back in order. */
interface PullItemResult {
    /** The per-page log line, or `""` when the page failed. */
    line: string;
    /** The store outcome, or `null` when the page failed. */
    state: PageState | null;
    /** The `"name: message"` failure, or `null` on success. */
    error: string | null;
}

/** emptyStats returns a zeroed tally. */
export function emptyStats(): PullStats {
    return {
        pulled: 0,
        rendered: 0,
        unchanged: 0,
        merged: 0,
        conflict: 0,
        total: 0,
    };
}

/** addStats returns the element-wise sum of two tallies. */
export function addStats(a: PullStats, b: PullStats): PullStats {
    return {
        pulled: a.pulled + b.pulled,
        rendered: a.rendered + b.rendered,
        unchanged: a.unchanged + b.unchanged,
        merged: a.merged + b.merged,
        conflict: a.conflict + b.conflict,
        total: a.total + b.total,
    };
}

/** pullSummary formats the closing summary of a completed pull. */
export function pullSummary(s: PullStats): string {
    const noun = s.total === 1 ? "page" : "pages";
    let summary =
        `cfsync: ${s.total} ${noun} — ${s.pulled} pulled (new version), ` +
        `${s.rendered} re-rendered, ${s.merged} merged, ` +
        `${s.conflict} conflicted, ${s.unchanged} unchanged\n`;
    if (s.rendered > 0) {
        summary +=
            "cfsync: a re-render rewrites Markdown from cached ADF without " +
            "fetching, so those pages show up as changes in git even though " +
            "no new version was pulled\n";
    }
    if (s.conflict > 0) {
        summary +=
            "cfsync: some notes carry unresolved <<<<<<< conflict markers; " +
            "resolve them before pushing\n";
    }
    return summary;
}

/** okLine reports a page pulled at a new version. */
function okLine(name: string, ver: number): string {
    return `pulling ${name} ... ok (v${ver})\n`;
}

/** skipLine reports a cached page whose re-rendered Markdown was rewritten. */
function skipLine(name: string, ver: number): string {
    return `pulling ${name} ... skipped (v${ver} cached), md written\n`;
}

/** unchangedLine reports a cached page whose Markdown was already current. */
function unchangedLine(name: string, ver: number): string {
    return `pulling ${name} ... skipped (v${ver} cached), unchanged\n`;
}

/** mergedLine reports a page whose local edits merged cleanly with the remote. */
function mergedLine(name: string, ver: number): string {
    return `pulling ${name} ... merged local edits with v${ver}\n`;
}

/** conflictLine reports a page left with conflict markers to resolve. */
function conflictLine(name: string, ver: number): string {
    return `pulling ${name} ... CONFLICT with v${ver}, resolve markers before pushing\n`;
}

/** PullerDeps are the ports and resolved paths a {@link Puller} needs. */
export interface PullerDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    config: Config;
    reporter: Reporter;
    /** Device-local ADF cache dir (`.vN.json`/`.vN.md`). */
    cacheDir: string;
    /** Image assets dir, under the sync root. */
    assetsDir: string;
    /** The link index for this run, or null to disable link rewriting. */
    links: LinkIndex | null;
    /** The Markdown flavor driving ADF→Markdown rendering. */
    flavor: Flavor;
    /** Pages to fetch/render at once; defaults to {@link PULL_CONCURRENCY}. */
    concurrency?: number;
    /**
     * The current remote version of each managed page id, if known. When a page's
     * remote version is already in the ADF cache, the pull renders from the cache
     * instead of re-downloading the body. Absent (or a missing id) means always
     * fetch — the behaviour before the version probe.
     */
    knownVersions?: Map<string, number>;
}

/**
 * Puller fetches and stores managed pages. It holds the ports and resolved dirs
 * for one run; the discovery walk and the combining `pullConfig` compose it.
 */
export class Puller {
    constructor(private readonly d: PullerDeps) {}

    /**
     * pullPages pulls every configured `pages:` entry. The pages are fetched and
     * rendered concurrently ({@link PULL_CONCURRENCY} at once), so the live
     * {@link Reporter} stream (per-page `item`/`log` callbacks) reflects
     * completion order, which varies run to run. The returned {@link PullOutcome}
     * is deterministic regardless: its log, tally, and per-page failures are
     * folded back in the stable, sorted dest order, so the final log matches a
     * serial run. A page that fails is recorded and skipped; the batch still
     * completes.
     */
    async pullPages(): Promise<PullOutcome> {
        const dests = Object.keys(this.d.config.pages).sort();
        const results = await mapPool(dests, this.concurrency(), (dest) =>
            this.pullItem(dest, this.d.config.pages[dest] ?? "", ""),
        );
        return this.fold(results, dests.length);
    }

    /**
     * pullDiscovered pulls every walk-discovered page (from a folder or space),
     * concurrently but folded back in the given order, tallying and logging like
     * {@link pullPages}. The walk itself is `./discover.ts`.
     */
    async pullDiscovered(pages: DiscoveredPage[]): Promise<PullOutcome> {
        const results = await mapPool(pages, this.concurrency(), (p) =>
            this.pullItem(p.dest, p.url, p.spaceKey, p.parentId),
        );
        return this.fold(results, pages.length);
    }

    /** concurrency is the configured page fan-out width, defaulted and floored at 1. */
    private concurrency(): number {
        return Math.max(1, this.d.concurrency ?? PULL_CONCURRENCY);
    }

    /**
     * pullItem pulls one page and returns its per-page outcome rather than
     * mutating a shared tally, so a pool of these can run concurrently and
     * {@link fold} reassembles them in order. A failure is captured as `error`
     * (never thrown), so one bad page does not abort the pool.
     */
    private async pullItem(
        dest: string,
        src: string,
        spaceKey: string,
        parentOverride?: string,
    ): Promise<PullItemResult> {
        const name = pageName(this.d.config.syncRoot, dest);
        this.d.reporter.item(name);
        try {
            const { state, version } = await this.pullOne(
                dest,
                src,
                spaceKey,
                parentOverride,
            );
            const line = this.stateLine(state, name, version);
            this.d.reporter.log(line);
            return { line, state, error: null };
        } catch (err) {
            return { line: "", state: null, error: `${name}: ${message(err)}` };
        }
    }

    /**
     * fold reassembles the per-page results into one {@link PullOutcome}: the log
     * concatenated in input order, the states tallied, and the errors collected —
     * the same result a serial pull produced, independent of completion order.
     */
    private fold(results: PullItemResult[], total: number): PullOutcome {
        const out: PullOutcome = {
            log: "",
            stats: { ...emptyStats(), total },
            errors: [],
        };
        for (const r of results) {
            if (r.error !== null) {
                out.errors.push(r.error);
                continue;
            }
            out.log += r.line;
            if (r.state === "pulled") {
                out.stats.pulled++;
            } else if (r.state === "rerendered") {
                out.stats.rendered++;
            } else if (r.state === "merged") {
                out.stats.merged++;
            } else if (r.state === "conflict") {
                out.stats.conflict++;
            } else {
                out.stats.unchanged++;
            }
        }
        return out;
    }

    /** stateLine formats the per-page progress line for a page state. */
    private stateLine(state: PageState, name: string, ver: number): string {
        if (state === "rerendered") {
            return skipLine(name, ver);
        }
        if (state === "unchanged") {
            return unchangedLine(name, ver);
        }
        if (state === "merged") {
            return mergedLine(name, ver);
        }
        if (state === "conflict") {
            return conflictLine(name, ver);
        }
        return okLine(name, ver);
    }

    /**
     * pullOne fetches the page at `src` for the note at `dest`, tags it with the
     * space key and Site domain, and stores it. `src` must be a single page URL.
     * A defined `parentOverride` replaces the fetched parent id — the walk's tree
     * parent, which may differ from Confluence's, for a discovered page.
     */
    async pullOne(
        dest: string,
        src: string,
        spaceKey: string,
        parentOverride?: string,
    ): Promise<{ state: PageState; version: number }> {
        const id = pageID(src);
        const { data, cacheHit } = await this.fetchOrCache(id, dest);
        return this.storeData(dest, spaceKey, parentOverride, data, cacheHit);
    }

    /**
     * fetchOrCache returns the data for page `id`: from the ADF cache when the
     * page's current remote version (from {@link PullerDeps.knownVersions}) is
     * already cached — skipping the body download — and from the Site otherwise. A
     * cache miss or an absent version hint falls through to a normal fetch, so the
     * result is always the current version. `cacheHit` reports whether the body
     * came from the cache, so {@link store} can likewise skip the attachment
     * round-trip and rebuild the assets map from disk.
     */
    private async fetchOrCache(
        id: string,
        dest: string,
    ): Promise<{ data: PageData; cacheHit: boolean }> {
        const known = this.d.knownVersions?.get(id);
        if (known !== undefined) {
            const name = pageName(this.d.config.syncRoot, dest);
            const path = posixJoin(this.d.cacheDir, cacheFileName(name, known));
            const cached = await readCachedPage(this.d.fs, path);
            if (cached !== null) {
                return { data: cached, cacheHit: true };
            }
        }
        return { data: await this.d.client.fetchPage(id), cacheHit: false };
    }

    /** storeData tags fetched-or-cached data with the run's identity and stores it. */
    private storeData(
        dest: string,
        spaceKey: string,
        parentOverride: string | undefined,
        data: PageData,
        cacheHit: boolean,
    ): Promise<{ state: PageState; version: number }> {
        const page: Page = {
            name: pageName(this.d.config.syncRoot, dest),
            id: data.id,
            title: data.title,
            version: data.version,
            spaceId: data.spaceId,
            parentId: parentOverride ?? data.parentId,
            spaceKey,
            domain: this.d.config.domain,
            adf: data.adf,
        };
        return this.store(page, dest, cacheHit);
    }

    /**
     * store caches the page's ADF (only when its version is not already cached),
     * resolves its images, renders its Markdown, and writes the Markdown to both
     * the cache and `dest`, each only where the content differs. It returns the
     * page state and version.
     *
     * On a version/cache hit (`cacheHit`) the images were downloaded by an earlier
     * pull, so it rebuilds the assets map from disk ({@link assetsFromDisk}) rather
     * than re-listing the page's attachments — the round-trip the version probe is
     * meant to save. It falls back to a full {@link downloadImages} when any
     * referenced image is missing on disk (an earlier pull may have cached the ADF
     * then been interrupted before downloading them).
     */
    private async store(
        page: Page,
        dest: string,
        cacheHit: boolean,
    ): Promise<{ state: PageState; version: number }> {
        const adfPath = posixJoin(this.d.cacheDir, cacheFile(page));
        const exists = await this.d.fs.exists(adfPath);
        if (!exists) {
            await writePage(this.d.fs, adfPath, page);
        }

        const doc = pageDoc(page);
        const refs = fileMedia(doc);
        const assets =
            (cacheHit
                ? await assetsFromDisk(this.d.fs, this.d.assetsDir, dest, refs)
                : null) ??
            (await downloadImages(
                this.d.client,
                this.d.fs,
                this.d.assetsDir,
                page.id,
                dest,
                refs,
            ));
        const links = linkMapper(
            this.d.links,
            dest,
            this.d.config.domain,
            this.d.config.host,
        );
        const md = this.d.flavor.render(doc, {
            assets,
            links,
            margin: this.d.config.margin,
        })[0];

        const mdCache = `${adfPath.slice(0, -".json".length)}.md`;
        const wroteCache = await writeIfChanged(this.d.fs, mdCache, md);
        const merge = await this.mergeIntoNote(page, dest, md);

        if (merge === "conflict") {
            return { state: "conflict", version: page.version };
        }
        if (merge === "merged") {
            return { state: "merged", version: page.version };
        }
        if (!exists) {
            return { state: "pulled", version: page.version };
        }
        if (wroteCache || merge === "wrote") {
            return { state: "rerendered", version: page.version };
        }
        return { state: "unchanged", version: page.version };
    }

    /**
     * mergeIntoNote writes the remote render `remote` to the note at `dest`
     * without clobbering unpushed local edits. It compares the note (local)
     * against the cached render of its recorded version (base) and the fresh
     * render (remote):
     *
     * - the note is missing, or its content already equals the remote: write it;
     * - the note carries unresolved conflict markers: leave it untouched so a
     *   re-pull never overwrites a resolution in progress (`conflict`);
     * - the note has no readable frontmatter (foreign or corrupt): overwrite it,
     *   healing the managed note (matches the pre-merge behavior);
     * - local matches base (no local edits): take the remote (`wrote`/`kept`);
     * - remote matches base (no remote change): keep the local edits (`kept`);
     * - both changed: three-way merge in place, writing the remote frontmatter
     *   over the merged body — cleanly (`merged`) or with markers (`conflict`).
     *
     * The remote frontmatter carries the current version, so a later push treats
     * the resolved note as based on that version rather than re-merging.
     */
    private async mergeIntoNote(
        page: Page,
        dest: string,
        remote: string,
    ): Promise<"wrote" | "kept" | "merged" | "conflict"> {
        let local: string;
        try {
            local = await this.d.fs.readText(dest);
        } catch {
            await this.d.fs.write(dest, remote);
            return "wrote";
        }
        if (hasConflictMarkers(local)) {
            return "conflict";
        }
        if (local === remote) {
            return "kept";
        }

        let localFm: { frontmatter: string; body: string };
        let remoteFm: { frontmatter: string; body: string };
        try {
            localFm = splitFrontmatter(local);
            remoteFm = splitFrontmatter(remote);
        } catch {
            // A note with no frontmatter is not a managed edit; heal it.
            const wrote = await writeIfChanged(this.d.fs, dest, remote);
            return wrote ? "wrote" : "kept";
        }

        if (localFm.body === remoteFm.body) {
            const wrote = await writeIfChanged(this.d.fs, dest, remote);
            return wrote ? "wrote" : "kept";
        }

        const noteVersion = frontmatterVersion(localFm.frontmatter);
        const base =
            noteVersion > 0
                ? await this.readBaseBody(page.name, noteVersion)
                : null;
        if (base !== null && localFm.body === base) {
            // No local edits; the remote moved on — take it.
            const wrote = await writeIfChanged(this.d.fs, dest, remote);
            return wrote ? "wrote" : "kept";
        }
        if (base !== null && remoteFm.body === base) {
            // Local edits only; the remote is unchanged — keep the edits.
            return "kept";
        }

        const result = mergeThreeWay(base ?? "", localFm.body, remoteFm.body, {
            local: "local (your edits)",
            remote: `remote (Confluence v${page.version})`,
        });
        await this.d.fs.write(
            dest,
            assembleNote(remoteFm.frontmatter, result.text),
        );
        return result.conflict ? "conflict" : "merged";
    }

    /**
     * readBaseBody returns the body of the cached render of page `name` at
     * `version` — the last state the local note and the remote agreed on — or
     * null when that render is not cached (a fresh clone, or a pruned cache).
     */
    private readBaseBody(
        name: string,
        version: number,
    ): Promise<string | null> {
        return readCacheBody(this.d.fs, this.d.cacheDir, name, version);
    }
}

/** PullConfigDeps are a {@link Puller}'s deps minus the (built-here) link index. */
export interface PullConfigDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    config: Config;
    reporter: Reporter;
    cacheDir: string;
    assetsDir: string;
    /** Where to persist the link index (e.g. `<cacheDir>/links.json`). */
    linksPath: string;
}

/**
 * pullConfig pulls every configured page and the pages of every configured folder
 * and space. It discovers the folder/space trees, aborts the whole run (throwing)
 * when any destination or Confluence page is claimed by more than one entry,
 * builds the link index (persisting it only when discovery was complete, so a
 * partial index never overwrites a good one), then pulls the configured and
 * discovered pages. Discovery and per-page failures are returned in
 * {@link PullOutcome.errors}; the run still completes.
 */
export async function pullConfig(deps: PullConfigDeps): Promise<PullOutcome> {
    const { client, fs, config, reporter, cacheDir, assetsDir, linksPath } =
        deps;

    const folders = await discoverFolders(client, config, reporter);
    const spaces = await discoverSpaces(client, config, reporter);
    const discovered = [...folders.pages, ...spaces.pages];
    const discErrors = [...folders.errors, ...spaces.errors];

    collides(config, discovered); // throws to abort before any write

    const links = buildLinkIndex(config.syncRoot, config.pages, discovered);
    // Persist only when discovery was complete: a partial index written over a
    // prior complete one would drop the failed entries' pages.
    if (discErrors.length === 0) {
        await links.write(fs, linksPath);
    }

    // Reconcile notes left behind by a moved page before pulling: a partial tree
    // could misplace a note, so this runs only when discovery was complete.
    const relocated =
        discErrors.length === 0
            ? await relocateMovedNotes(fs, config, cacheDir, discovered)
            : { log: "", moved: 0 };

    reporter.discovered(Object.keys(config.pages).length + discovered.length);

    // Probe every managed page's current remote version in one bulk request, so
    // a page whose version is already cached renders from the cache instead of
    // re-downloading its body. A failed probe just disables that shortcut.
    const knownVersions = await probeVersions(client, config, discovered);

    const puller = new Puller({
        client,
        fs,
        config,
        reporter,
        cacheDir,
        assetsDir,
        links,
        flavor: resolveFlavor(config.flavor),
        knownVersions,
    });
    const pagesOut = await puller.pullPages();
    const treeOut = await puller.pullDiscovered(discovered);

    return {
        log: relocated.log + pagesOut.log + treeOut.log,
        stats: addStats(pagesOut.stats, treeOut.stats),
        errors: [...discErrors, ...pagesOut.errors, ...treeOut.errors],
    };
}

/**
 * probeVersions bulk-fetches the current remote version of every managed page —
 * the configured pages plus the discovered folder/space pages — keyed by page id.
 * It is best-effort: a failure (or a page with no resolvable id) yields no entry,
 * so the pull falls back to fetching that page's body. The cost is one request per
 * 250 ids, negligible against the body downloads it lets a warm pull skip.
 */
async function probeVersions(
    client: ConfluenceClient,
    config: Config,
    discovered: DiscoveredPage[],
): Promise<Map<string, number>> {
    const ids = [
        ...discovered.map((p) => p.id),
        ...Object.values(config.pages)
            .map((src) => tryPageID(src))
            .filter((id): id is string => id !== undefined),
    ];
    if (ids.length === 0) {
        return new Map();
    }
    try {
        return await client.fetchPageVersions(ids);
    } catch {
        return new Map();
    }
}

/** ResolveSourceDeps are what {@link resolvePageSource} needs to look a page up
 * and, when it is not yet indexed, discover the root that contains it. */
export interface ResolveSourceDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    config: Config;
    reporter: Reporter;
    /** Where the link index is persisted (e.g. `<cacheDir>/links.json`). */
    linksPath: string;
}

/** ResolvedSource is a single page's remote source plus the link index to pull it
 * with — the persisted index, or one just built by on-demand discovery. */
export interface ResolvedSource {
    src: string;
    spaceKey: string;
    links: LinkIndex | null;
}

/**
 * resolvePageSource returns the Confluence source URL and space key for the single
 * managed page at `dest` (an absolute note path), together with the link index to
 * pull it with. A configured `pages:` entry resolves straight from the config (no
 * space key). Otherwise the page is a descendant of a configured folder or space
 * root, whose remote URL is only known through the link index: when the persisted
 * index already carries `dest` it is used as is; when the index is missing or
 * lacks `dest`, the one root that contains `dest` is discovered on the spot (not
 * the whole config), its pages merged into and re-persisted over the existing
 * index, and `dest` resolved from the result. It throws when `dest` lies under no
 * configured root, or the discovered root does not contain it.
 */
export async function resolvePageSource(
    deps: ResolveSourceDeps,
    dest: string,
): Promise<ResolvedSource> {
    const { config, fs, linksPath } = deps;
    const links = await loadLinkIndex(fs, linksPath, config.syncRoot);

    const configured = config.pages[dest];
    if (configured !== undefined) {
        return { src: configured, spaceKey: "", links };
    }
    const known = links?.byDest.get(dest);
    if (known !== undefined) {
        return { src: known.url, spaceKey: known.spaceKey, links };
    }

    // Not configured and not in the index — discover the root that contains it,
    // exactly what pulling that folder or space would have done, then resolve.
    const discovered = await discoverContainingRoot(deps, links, dest);
    const entry = discovered.byDest.get(dest);
    if (entry === undefined) {
        throw new Error(
            `${pageName(config.syncRoot, dest)}: not a managed page`,
        );
    }
    return { src: entry.url, spaceKey: entry.spaceKey, links: discovered };
}

/**
 * discoverContainingRoot walks the one configured folder or space root that
 * contains `dest` and returns a link index merging its freshly discovered pages
 * over `existing` (so entries from the other roots survive), re-persisting the
 * result. The merge only adds entries, so persisting can never drop a prior
 * root's pages even when this single-root discovery is partial. It throws when
 * `dest` lies under no configured root.
 */
async function discoverContainingRoot(
    deps: ResolveSourceDeps,
    existing: LinkIndex | null,
    dest: string,
): Promise<LinkIndex> {
    const { client, fs, config, reporter, linksPath } = deps;
    const found = containingRoot(config, dest);
    if (found === null) {
        throw new Error(
            `${pageName(config.syncRoot, dest)}: not a managed page`,
        );
    }
    reporter.log(
        `discovering ${found.kind} ${pageName(config.syncRoot, found.root)} ` +
            `to resolve ${pageName(config.syncRoot, dest)}\n`,
    );
    // The caller has already announced the one page being pulled, so the walk's
    // per-page found() events must not reopen the "discovering…" counter — only
    // its log line above conveys that a root is being resolved.
    const quiet = withoutFound(reporter);
    const result =
        found.kind === "folder"
            ? await discoverFolder(client, config, quiet, found.src, found.root)
            : await discoverSpace(client, config, quiet, found.src, found.root);

    const links = buildLinkIndex(config.syncRoot, config.pages, result.pages);
    // Carry the other roots' entries (from a prior full pull) forward; the
    // freshly discovered root is authoritative for its own ids and dests.
    if (existing !== null) {
        for (const e of existing.entries()) {
            const abs = posixJoin(config.syncRoot, e.dest);
            if (!links.byID.has(e.id) && !links.byDest.has(abs)) {
                links.add(e);
            }
        }
    }
    await links.write(fs, linksPath);
    return links;
}

/**
 * withoutFound returns a reporter that forwards every event to `r` except
 * found(), which it drops — so an on-demand discovery walk during a single-page
 * pull leaves the reporter in its already-announced processing phase instead of
 * flashing a "discovering… N pages found" counter.
 */
function withoutFound(r: Reporter): Reporter {
    return {
        found: () => {},
        discovered: (total) => r.discovered(total),
        item: (name) => r.item(name),
        log: (line) => r.log(line),
        finish: () => r.finish(),
        streamsLog: () => r.streamsLog(),
    };
}

/**
 * containingRoot returns the configured folder or space root that is an ancestor
 * directory of `dest`, with the kind that selects its discovery walk, or null
 * when none is. Roots never nest (the config rejects that), so at most one matches.
 */
function containingRoot(
    config: Config,
    dest: string,
): { src: string; kind: "folder" | "space"; root: string } | null {
    for (const [root, src] of Object.entries(config.folders)) {
        if (isUnderDir(dest, root)) {
            return { src, kind: "folder", root };
        }
    }
    for (const [root, src] of Object.entries(config.spaces)) {
        if (isUnderDir(dest, root)) {
            return { src, kind: "space", root };
        }
    }
    return null;
}

/** isUnderDir reports whether the file path `dest` lies within the directory `dir`. */
function isUnderDir(dest: string, dir: string): boolean {
    return dest.startsWith(`${dir}/`);
}

/** resolvePagePath returns an absolute note path from a selected path under the sync root. */
export function resolvePagePath(syncRoot: string, path: string): string {
    return path.startsWith("/") ? posixClean(path) : posixJoin(syncRoot, path);
}

/**
 * writeIfChanged writes `data` to `path` only when its current content differs,
 * returning whether it wrote, so an unchanged render leaves the file untouched.
 */
async function writeIfChanged(
    fs: FileSystem,
    path: string,
    data: string,
): Promise<boolean> {
    try {
        if ((await fs.readText(path)) === data) {
            return false;
        }
    } catch {
        // Missing (or unreadable) file: fall through to write it.
    }
    await fs.write(path, data);
    return true;
}

/** frontmatterVersion reads the `page_version` from raw frontmatter, or 0. */
function frontmatterVersion(frontmatter: string): number {
    const m = frontmatter.match(/^page_version:\s*(\d+)/m);
    return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : 0;
}

/**
 * assembleNote rebuilds a note from tool-managed `frontmatter` and a `body`,
 * matching the `---`-fenced layout the renderer and push stamper both write.
 */
function assembleNote(frontmatter: string, body: string): string {
    let out = `---\n${frontmatter}---\n`;
    if (body !== "") {
        out += `${body}\n`;
    }
    return out;
}

/** mdCachePath is the cached-render (`.md`) path for page `name` at `version`. */
function mdCachePath(cacheDir: string, name: string, version: number): string {
    const json = cacheFileName(name, version);
    return posixJoin(cacheDir, `${json.slice(0, -".json".length)}.md`);
}

/**
 * readCacheBody returns the body of the cached render of page `name` at
 * `version` — the last state a note and the remote agreed on — or null when
 * that render is not cached (a fresh clone, or a pruned cache).
 */
async function readCacheBody(
    fs: FileSystem,
    cacheDir: string,
    name: string,
    version: number,
): Promise<string | null> {
    try {
        const text = await fs.readText(mdCachePath(cacheDir, name, version));
        return splitFrontmatter(text).body;
    } catch {
        return null;
    }
}

/** MoveOutcome reports the moved-page pre-pass's log and how many notes it moved. */
interface MoveOutcome {
    log: string;
    moved: number;
}

/**
 * relocateMovedNotes reconciles the duplicate a moved page leaves behind. A page
 * carries a stable `page_id` but its note path is re-derived each pull from the
 * page's place in the folder/space tree, so when a page moves in Confluence the
 * pull writes the note to its new path and the old note lingers. This pre-pass
 * scans every managed note under the folder/space roots, and for each whose
 * `page_id` resolves (via the freshly discovered tree) to a different path than
 * where it sits, carries its content to the new path — so the per-page pull's
 * merge preserves any unpushed edits there — and removes the stale copy, pruning
 * emptied directories. Notes marked `cf_local` or lacking a `page_id` are left
 * alone. It runs only on a full pull (a selected pull sees a partial tree) and
 * only when discovery was complete; the caller enforces both.
 */
async function relocateMovedNotes(
    fs: FileSystem,
    config: Config,
    cacheDir: string,
    discovered: DiscoveredPage[],
): Promise<MoveOutcome> {
    const expected = new Map<string, string>();
    for (const p of discovered) {
        expected.set(p.id, posixClean(p.dest));
    }
    const roots = [
        ...Object.keys(config.folders),
        ...Object.keys(config.spaces),
    ];
    const files = await mdFilesUnder(fs, roots);

    // Collect the stale copies (a managed note sitting at a path other than the
    // one its page now maps to), grouped by page id in walk order.
    const stale = new Map<string, string[]>();
    for (const path of files) {
        let frontmatter: string;
        try {
            frontmatter = splitFrontmatter(await fs.readText(path)).frontmatter;
        } catch {
            continue; // unreadable or no frontmatter: not a managed note
        }
        if (/^cf_local:\s*true\b/m.test(frontmatter)) {
            continue; // a local-only page, never pulled
        }
        const id = frontmatter.match(/^page_id:\s*"([^"]*)"/m)?.[1] ?? "";
        const dest = id === "" ? undefined : expected.get(id);
        if (dest === undefined || posixClean(path) === dest) {
            continue; // not a discovered page, or already in place
        }
        const list = stale.get(id) ?? [];
        list.push(posixClean(path));
        stale.set(id, list);
    }

    let log = "";
    let moved = 0;
    for (const [id, copies] of stale) {
        const dest = expected.get(id) ?? "";
        const to = pageName(config.syncRoot, dest);
        for (const src of copies) {
            const from = pageName(config.syncRoot, src);
            const outcome = await relocateCopy(
                fs,
                cacheDir,
                config.syncRoot,
                src,
                dest,
            );
            if (outcome === "moved") {
                log += `moving ${from} -> ${to} (page ${id} moved in Confluence)\n`;
                moved++;
            } else if (outcome === "removed") {
                log += `removing stale ${from} (page ${id} is now ${to})\n`;
                moved++;
            } else {
                log +=
                    `warning: ${from} and ${to} both hold unpushed edits for ` +
                    `page ${id}; left in place, resolve by hand\n`;
            }
        }
    }
    return { log, moved };
}

/**
 * relocateCopy resolves one stale copy `src` of a page whose current note path
 * is `dest`. With no note yet at `dest`, or a clean one there while `src` has
 * unpushed edits, it carries `src` to `dest` (`moved`). A clean `src` beside an
 * existing `dest` is a pure leftover, removed (`removed`). When both `src` and
 * `dest` carry unpushed edits it refuses to choose, leaving both (`kept`).
 */
async function relocateCopy(
    fs: FileSystem,
    cacheDir: string,
    syncRoot: string,
    src: string,
    dest: string,
): Promise<"moved" | "removed" | "kept"> {
    if (!(await fs.exists(dest))) {
        await carryNote(fs, cacheDir, syncRoot, src, dest);
        return "moved";
    }
    if (!(await isDivergent(fs, cacheDir, syncRoot, src))) {
        await removeNote(fs, src, syncRoot);
        return "removed";
    }
    if (await isDivergent(fs, cacheDir, syncRoot, dest)) {
        return "kept";
    }
    await carryNote(fs, cacheDir, syncRoot, src, dest);
    return "moved";
}

/**
 * carryNote moves the note at `src` to `dest`, relocating the cached base render
 * of its recorded version alongside it (so the per-page pull's merge finds its
 * base under the new name), then removes `src` and prunes emptied directories.
 */
async function carryNote(
    fs: FileSystem,
    cacheDir: string,
    syncRoot: string,
    src: string,
    dest: string,
): Promise<void> {
    const content = await fs.readText(src);
    let version = 0;
    try {
        version = frontmatterVersion(splitFrontmatter(content).frontmatter);
    } catch {
        version = 0;
    }
    await moveCacheBase(
        fs,
        cacheDir,
        pageName(syncRoot, src),
        pageName(syncRoot, dest),
        version,
    );
    await fs.mkdirp(posixDir(dest));
    await fs.write(dest, content);
    await removeNote(fs, src, syncRoot);
}

/** removeNote deletes the note at `path` and prunes now-empty ancestor dirs. */
async function removeNote(
    fs: FileSystem,
    path: string,
    syncRoot: string,
): Promise<void> {
    await fs.remove(path);
    let dir = posixDir(path);
    while (dir.length > syncRoot.length && dir.startsWith(`${syncRoot}/`)) {
        try {
            if (!(await dirEmpty(fs, dir))) {
                break;
            }
            await fs.remove(dir);
        } catch {
            break; // a backend that cannot remove a dir just leaves it
        }
        dir = posixDir(dir);
    }
}

/**
 * moveCacheBase relocates the cached ADF and render of page `oldName` at
 * `version` to `newName`, so a moved note's merge base survives the rename. It
 * is best-effort: a cache entry that is absent is simply skipped.
 */
async function moveCacheBase(
    fs: FileSystem,
    cacheDir: string,
    oldName: string,
    newName: string,
    version: number,
): Promise<void> {
    if (version === 0 || oldName === newName) {
        return;
    }
    const oldJson = posixJoin(cacheDir, cacheFileName(oldName, version));
    const newJson = posixJoin(cacheDir, cacheFileName(newName, version));
    const pairs: [string, string][] = [
        [oldJson, newJson],
        [
            `${oldJson.slice(0, -".json".length)}.md`,
            `${newJson.slice(0, -".json".length)}.md`,
        ],
    ];
    for (const [from, to] of pairs) {
        try {
            await fs.write(to, await fs.read(from));
            await fs.remove(from);
        } catch {
            // Absent (or unreadable) cache entry: nothing to move.
        }
    }
}

/**
 * isDivergent reports whether the note at `path` differs from its cached base
 * render — i.e. it carries unpushed local edits. A note with no readable
 * frontmatter, no recorded version, or no cached base is treated as divergent,
 * so a copy that cannot be proven clean is never silently discarded.
 */
async function isDivergent(
    fs: FileSystem,
    cacheDir: string,
    syncRoot: string,
    path: string,
): Promise<boolean> {
    let text: string;
    try {
        text = await fs.readText(path);
    } catch {
        return false; // already gone
    }
    let frontmatter: string;
    let body: string;
    try {
        ({ frontmatter, body } = splitFrontmatter(text));
    } catch {
        return true;
    }
    const version = frontmatterVersion(frontmatter);
    if (version === 0) {
        return true;
    }
    const base = await readCacheBody(
        fs,
        cacheDir,
        pageName(syncRoot, path),
        version,
    );
    return base === null || body !== base;
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
