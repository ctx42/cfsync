// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Folder and space discovery, ported from the walk halves of
// `pkg/cfsync/folders.go` and `spaces.go`. A configured folder or space is walked
// recursively to derive a Markdown destination for every descendant page, without
// writing anything — the pull (`./pull.ts`) fetches and stores them. A page that
// cannot be placed (its title derives to an empty name, or its name collides with
// a sibling) is recorded and skipped along with its subtree; sibling pages still
// proceed. Everything goes through the {@link ConfluenceClient} and
// {@link Reporter} ports; paths are POSIX.

import type { Config } from "../config/config.ts";
import {
    CHILDREN_PATH,
    type ChildNode,
    type ConfluenceClient,
    FOLDER_ENDPOINT,
    PAGE_ENDPOINT,
} from "../confluence/client.ts";
import {
    folderID,
    spaceKeyOf,
    spaceLinkKey,
    tryPageID,
} from "../confluence/sources.ts";
import type { Reporter } from "../ports/progress.ts";
import { posixJoin } from "../util/path.ts";
import { type DiscoveredPage, pageName, pageURL } from "./linkindex.ts";

/** indexFile holds a container page's own body: the space homepage and any page with children. */
const INDEX_FILE = "_index.md";
/** indexName is the reserved base name; a page deriving to it is disambiguated. */
const INDEX_NAME = "_index";
/** unsafeNameChars are replaced with `_` when a Confluence title becomes a path segment. */
const UNSAFE_CHARS = '/\\:?*"<>|';

/** DiscoverResult is the pages a walk placed plus one error message per failed root. */
export interface DiscoverResult {
    pages: DiscoveredPage[];
    errors: string[];
}

/**
 * deriveName turns a Confluence title into a safe lower-case path segment:
 * whitespace runs become `_`, control and reserved characters become `_`, and
 * leading/trailing dots become `_`. It throws when the result is empty.
 */
export function deriveName(title: string): string {
    let name = title
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== "")
        .join("_");
    name = [...name]
        .map((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return code < 0x20 || code === 0x7f || UNSAFE_CHARS.includes(ch)
                ? "_"
                : ch;
        })
        .join("");
    const chars = [...name];
    for (let i = 0; i < chars.length && chars[i] === "."; i++) {
        chars[i] = "_";
    }
    for (let i = chars.length - 1; i >= 0 && chars[i] === "."; i--) {
        chars[i] = "_";
    }
    name = chars.join("");
    if (name === "") {
        throw new Error(`title "${title}" derives to an empty name`);
    }
    return name;
}

/** isCurrent reports whether a child status denotes live content a walk keeps. */
function isCurrent(status: string): boolean {
    return status === "" || status === "current";
}

/** childrenLink builds the direct-children path for a page or folder node. */
function childrenLink(kind: string, id: string): string {
    const base = kind === "folder" ? FOLDER_ENDPOINT : PAGE_ENDPOINT;
    return `${base}${id}${CHILDREN_PATH}`;
}

/**
 * discoverFolders walks every configured folder and returns its descendant pages,
 * with one error message per folder that failed. Folders are walked in a stable
 * order; a failed folder does not stop the rest.
 */
export async function discoverFolders(
    client: ConfluenceClient,
    config: Config,
    reporter: Reporter,
): Promise<DiscoverResult> {
    const pages: DiscoveredPage[] = [];
    const errors: string[] = [];
    for (const root of Object.keys(config.folders).sort()) {
        const rel = pageName(config.syncRoot, root);
        try {
            const r = await discoverFolder(
                client,
                config,
                reporter,
                config.folders[root] ?? "",
                root,
            );
            pages.push(...r.pages);
            if (r.errors.length > 0) {
                errors.push(`${rel}: ${r.errors.join("; ")}`);
            }
        } catch (err) {
            errors.push(`${rel}: ${message(err)}`);
        }
    }
    return { pages, errors };
}

/**
 * discoverFolder walks one folder `src` into the absolute directory `root`,
 * returning its descendant pages and per-page errors. It throws when `src` is not
 * a folder source. Used by clean to discover a single root's current content.
 */
export async function discoverFolder(
    client: ConfluenceClient,
    config: Config,
    reporter: Reporter,
    src: string,
    root: string,
): Promise<DiscoverResult> {
    const walk = new FolderWalk(client, config, reporter, spaceKeyOf(src));
    return walk.walk(folderID(src), root);
}

/**
 * discoverSpaces walks every configured space and returns its pages, with one
 * error message per space that failed. The walk starts at the space homepage,
 * which becomes `<root>/_index.md`.
 */
export async function discoverSpaces(
    client: ConfluenceClient,
    config: Config,
    reporter: Reporter,
): Promise<DiscoverResult> {
    const pages: DiscoveredPage[] = [];
    const errors: string[] = [];
    for (const root of Object.keys(config.spaces).sort()) {
        const rel = pageName(config.syncRoot, root);
        try {
            const r = await discoverSpace(
                client,
                config,
                reporter,
                config.spaces[root] ?? "",
                root,
            );
            pages.push(...r.pages);
            if (r.errors.length > 0) {
                errors.push(`${rel}: ${r.errors.join("; ")}`);
            }
        } catch (err) {
            errors.push(`${rel}: ${message(err)}`);
        }
    }
    return { pages, errors };
}

/**
 * discoverSpace walks one space `src` into the absolute directory `root`, starting
 * at the space homepage (which becomes `<root>/_index.md`). It throws when `src`
 * is not a space-root link or the space has no homepage.
 */
export async function discoverSpace(
    client: ConfluenceClient,
    config: Config,
    reporter: Reporter,
    src: string,
    root: string,
): Promise<DiscoverResult> {
    const key = spaceLinkKey(src);
    const space = await client.resolveSpace(key);
    if (space.homepageId === "") {
        throw new Error(`space "${key}" has no homepage`);
    }
    const walk = new SpaceWalk(client, config, reporter, key);
    return walk.walkRoot(space.homepageId, root);
}

/**
 * collides throws on the first cross-entry collision among the configured pages
 * and the discovered pages: two entries resolving to the same destination, or one
 * Confluence page id claimed by two entries. A configured page whose source is not
 * a page URL contributes no id, so it takes part only in the destination check.
 */
export function collides(config: Config, discovered: DiscoveredPage[]): void {
    const rel = (d: string): string => pageName(config.syncRoot, d);
    const seenDest = new Set<string>();
    const seenID = new Map<string, string>();
    const claimID = (id: string, dest: string): void => {
        const prev = seenID.get(id);
        if (prev !== undefined) {
            throw new Error(
                `page ${id} is claimed by more than one entry: ` +
                    `"${rel(prev)}" and "${rel(dest)}"`,
            );
        }
        seenID.set(id, dest);
    };
    for (const [dest, src] of Object.entries(config.pages)) {
        seenDest.add(dest);
        const id = tryPageID(src);
        if (id !== undefined) {
            claimID(id, dest);
        }
    }
    for (const p of discovered) {
        if (seenDest.has(p.dest)) {
            throw new Error(
                `destination "${rel(p.dest)}" is claimed by more than one entry`,
            );
        }
        seenDest.add(p.dest);
        claimID(p.id, p.dest);
    }
}

/**
 * FolderWalk recurses a folder tree, placing each descendant page's destination
 * directly under its parent directory. A sub-folder emits no page of its own; its
 * children carry its id as their parent id. Placement and the sibling-collision
 * check run synchronously in listing order (so a clash always drops the later
 * sibling deterministically); only the recursion into sub-folders is async, and
 * those run concurrently, with the results concatenated in child order — so the
 * output is identical to a serial walk. The HTTP client's semaphore caps sockets.
 */
class FolderWalk {
    constructor(
        private readonly client: ConfluenceClient,
        private readonly config: Config,
        private readonly reporter: Reporter,
        private readonly space: string,
    ) {}

    async walk(id: string, dir: string): Promise<DiscoverResult> {
        const children: ChildNode[] = [];
        let path = `${FOLDER_ENDPOINT}${id}${CHILDREN_PATH}`;
        while (path !== "") {
            let resp: { results: ChildNode[]; next: string };
            try {
                resp = await this.client.fetchChildren(path);
            } catch (err) {
                return { pages: [], errors: [message(err)] };
            }
            for (const child of resp.results) {
                if (isCurrent(child.status)) {
                    children.push(child);
                }
            }
            path = resp.next;
        }

        const seenPages = new Set<string>();
        const seenDirs = new Set<string>();
        // .map runs its callback synchronously and in order, so the collision
        // sets are claimed deterministically before any sub-folder walk begins;
        // Promise.all then keeps the results in child order.
        const tasks = children.map((child): Promise<DiscoverResult> => {
            if (child.type === "page") {
                return Promise.resolve(
                    this.placePage(child, dir, id, seenPages),
                );
            }
            if (child.type === "folder") {
                const claimed = this.claimFolder(child, dir, seenDirs);
                return claimed.sub === null
                    ? Promise.resolve({ pages: [], errors: claimed.errors })
                    : this.walk(child.id, claimed.sub);
            }
            return Promise.resolve({ pages: [], errors: [] });
        });
        return merge(await Promise.all(tasks));
    }

    /** placePage derives a leaf page's destination, or records why it was skipped. */
    private placePage(
        child: ChildNode,
        dir: string,
        parentId: string,
        seen: Set<string>,
    ): DiscoverResult {
        let name: string;
        try {
            name = deriveName(child.title);
        } catch (err) {
            return { pages: [], errors: [`page ${child.id}: ${message(err)}`] };
        }
        const file = `${name}.md`;
        const dest = posixJoin(dir, file);
        if (seen.has(file)) {
            return { pages: [], errors: [`name collision: ${this.rel(dest)}`] };
        }
        seen.add(file);
        this.reporter.found();
        return {
            pages: [
                {
                    dest,
                    id: child.id,
                    title: child.title,
                    url: pageURL(this.space, child.id),
                    parentId,
                    spaceKey: "",
                },
            ],
            errors: [],
        };
    }

    /**
     * claimFolder derives a sub-folder's directory name and reserves its sibling
     * slot, returning the sub-directory to recurse into — or `sub: null` with the
     * reason (an empty-deriving name, or a collision) when the folder is skipped.
     */
    private claimFolder(
        child: ChildNode,
        dir: string,
        seen: Set<string>,
    ): { sub: string | null; errors: string[] } {
        let name: string;
        try {
            name = deriveName(child.title);
        } catch (err) {
            return {
                sub: null,
                errors: [`folder ${child.id}: ${message(err)}`],
            };
        }
        const sub = posixJoin(dir, name);
        if (seen.has(name)) {
            return { sub: null, errors: [`name collision: ${this.rel(sub)}`] };
        }
        seen.add(name);
        return { sub, errors: [] };
    }

    private rel(p: string): string {
        return pageName(this.config.syncRoot, p);
    }
}

/**
 * ResolvedNode is a non-root space node whose name, sibling slot, and destination
 * are decided but whose subtree is not yet walked. Resolving a node fetches only
 * its own direct children (to classify it as a leaf, a container, or a folder);
 * the recursion into that subtree, and the {@link Reporter.found} call for the
 * node's own page, are deferred until the node survives the sibling-collision
 * check — so a dropped node never over-counts a discovery nor fetches its subtree.
 */
interface ResolvedNode {
    /** The `f:` (leaf-page) or `d:` (folder/container) slot for the collision check. */
    slot: string;
    /** The path named in this node's collision error. */
    clash: string;
    /** The node's own page destination, or `""` for a folder / page with no body. */
    dest: string;
    /** The directory to recurse into (folder or container page), or `""` for a leaf. */
    ownDir: string;
    id: string;
    parentId: string;
    title: string;
    /** The node's direct children, fetched while classifying it. */
    kids: ChildNode[];
}

/** ResolveResult carries a resolved node, or its skip error when it cannot be placed. */
interface ResolveResult {
    node: ResolvedNode | null;
    errors: string[];
}

/**
 * SpaceWalk recurses a space tree. The homepage becomes `<root>/_index.md`; a page
 * with children becomes a container directory with its own `_index.md`; a leaf
 * page becomes `<name>.md`; a folder emits no page. A page and a sub-folder of the
 * same name occupy separate sibling slots. Siblings are resolved concurrently
 * (each fetching only its own direct children to classify it), then their sibling
 * slots are claimed in listing order — so a clash drops the later sibling
 * deterministically. Only a surviving sibling then reports {@link Reporter.found}
 * for its own page and has its subtree walked (again concurrently), so a dropped
 * node neither over-counts the discovery total nor fetches its descendants. Every
 * child's result is still folded back in listing order, matching a serial walk.
 * The HTTP client's semaphore caps sockets.
 */
class SpaceWalk {
    constructor(
        private readonly client: ConfluenceClient,
        private readonly config: Config,
        private readonly reporter: Reporter,
        private readonly key: string,
    ) {}

    /**
     * walkRoot walks the space from its homepage (which becomes `<root>/_index.md`)
     * and returns every descendant page. The homepage's children and their
     * subtrees are walked concurrently, folded back in listing order.
     */
    async walkRoot(id: string, root: string): Promise<DiscoverResult> {
        let kids: ChildNode[];
        try {
            kids = await this.children("page", id);
        } catch (err) {
            return { pages: [], errors: [message(err)] };
        }
        const out: DiscoverResult = {
            pages: [
                {
                    dest: posixJoin(root, INDEX_FILE),
                    id,
                    title: "",
                    url: pageURL(this.key, id),
                    parentId: "",
                    spaceKey: this.key,
                },
            ],
            errors: [],
        };
        this.reporter.found();
        const sub = await this.walkChildren(kids, id, root);
        out.pages.push(...sub.pages);
        out.errors.push(...sub.errors);
        return out;
    }

    /**
     * resolveNode classifies one non-root node — a leaf page becomes `<name>.md`, a
     * page with children a container directory with its own `_index.md`, a folder a
     * directory with no page of its own — fetching only the node's own direct
     * children to make that decision. It reports {@link Reporter.found} for nothing
     * and recurses into nothing: placement and the subtree walk are the caller's,
     * run only once the node survives the sibling-collision check. A name that
     * derives to nothing, or a failed children fetch, yields a null node and the
     * error so the caller drops it before any of that work.
     */
    private async resolveNode(
        kind: string,
        id: string,
        parentId: string,
        title: string,
        parentDir: string,
    ): Promise<ResolveResult> {
        let name: string;
        try {
            name = deriveName(title);
        } catch (err) {
            return { node: null, errors: [`${kind} ${id}: ${message(err)}`] };
        }
        if (name === INDEX_NAME) {
            name += `-${id}`;
        }

        let kids: ChildNode[];
        try {
            kids = await this.children(kind, id);
        } catch (err) {
            return { node: null, errors: [message(err)] };
        }

        let ownDir = "";
        let dest = "";
        if (kind === "folder") {
            ownDir = posixJoin(parentDir, name);
        } else if (kids.length > 0) {
            ownDir = posixJoin(parentDir, name);
            dest = posixJoin(ownDir, INDEX_FILE);
        } else {
            dest = posixJoin(parentDir, `${name}.md`);
        }

        return {
            node: {
                slot: ownDir !== "" ? `d:${name}` : `f:${name}`,
                clash: ownDir !== "" ? ownDir : dest,
                dest,
                ownDir,
                id,
                parentId,
                title,
                kids,
            },
            errors: [],
        };
    }

    /**
     * placeNode emits a survivor's own page (reporting one {@link Reporter.found})
     * and walks its subtree, folding the subtree back after the page. Called only
     * after the node has claimed its sibling slot, so every found() maps to a page
     * that is actually returned.
     */
    private async placeNode(node: ResolvedNode): Promise<DiscoverResult> {
        const result: DiscoverResult = { pages: [], errors: [] };
        if (node.dest !== "") {
            result.pages.push({
                dest: node.dest,
                id: node.id,
                title: node.title,
                url: pageURL(this.key, node.id),
                parentId: node.parentId,
                spaceKey: this.key,
            });
            this.reporter.found();
        }
        const sub = await this.walkChildren(node.kids, node.id, node.ownDir);
        result.pages.push(...sub.pages);
        result.errors.push(...sub.errors);
        return result;
    }

    /**
     * walkChildren resolves a node's children concurrently, then claims each
     * surviving child's sibling slot in listing order — a clash drops the later
     * sibling before it is placed or recursed into. Survivors are placed and their
     * subtrees walked concurrently, and every child's contribution is folded back
     * in listing order, so the output matches a serial walk.
     */
    private async walkChildren(
        kids: ChildNode[],
        parentId: string,
        parentDir: string,
    ): Promise<DiscoverResult> {
        const resolved = await Promise.all(
            kids.map((kid) =>
                this.resolveNode(
                    kid.type,
                    kid.id,
                    parentId,
                    kid.title,
                    parentDir,
                ),
            ),
        );

        // Claim sibling slots in listing order. A dropped child (skip error or a
        // slot clash) is recorded here and placed/recursed into nothing.
        const seen = new Set<string>();
        const decided = resolved.map((r): ResolveResult => {
            if (r.node === null) {
                return r;
            }
            if (seen.has(r.node.slot)) {
                return {
                    node: null,
                    errors: [`name collision: ${this.rel(r.node.clash)}`],
                };
            }
            seen.add(r.node.slot);
            return r;
        });

        // Place survivors (found() fires here) and walk their subtrees, folding
        // every child's result back in listing order.
        const parts = await Promise.all(
            decided.map((r) =>
                r.node === null
                    ? Promise.resolve<DiscoverResult>({ pages: [], errors: [] })
                    : this.placeNode(r.node),
            ),
        );
        const out: DiscoverResult = { pages: [], errors: [] };
        decided.forEach((r, i) => {
            out.errors.push(...r.errors);
            const part = parts[i] ?? { pages: [], errors: [] };
            out.pages.push(...part.pages);
            out.errors.push(...part.errors);
        });
        return out;
    }

    private async children(kind: string, id: string): Promise<ChildNode[]> {
        const out: ChildNode[] = [];
        let path = childrenLink(kind, id);
        while (path !== "") {
            const resp = await this.client.fetchChildren(path);
            for (const kid of resp.results) {
                if (
                    isCurrent(kid.status) &&
                    (kid.type === "page" || kid.type === "folder")
                ) {
                    out.push(kid);
                }
            }
            path = resp.next;
        }
        return out;
    }

    private rel(p: string): string {
        return pageName(this.config.syncRoot, p);
    }
}

/** merge concatenates discover results in order into one, pages then errors. */
function merge(parts: DiscoverResult[]): DiscoverResult {
    const pages: DiscoveredPage[] = [];
    const errors: string[] = [];
    for (const p of parts) {
        pages.push(...p.pages);
        errors.push(...p.errors);
    }
    return { pages, errors };
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
