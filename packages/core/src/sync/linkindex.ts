// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The cross-page link index, ported from `pkg/cfsync/links.go`. It maps the
// pulled pages between their Confluence identity and their local Markdown path so
// a pull can rewrite a cross-page link to a local path-based target and a push
// can restore the Confluence href. `DocLinks` implements the {@link Links} the
// renderer and parser consume; the render form (`[label](path)` today) is the
// renderer's concern — this module only supplies the path↔href mapping. Paths are
// POSIX throughout, so Go's ToSlash/FromSlash are identities here.

import type { Links, LocalLink } from "../adf/links.ts";
import { isDigits, spaceKeyOf, tryPageID } from "../confluence/sources.ts";
import type { FileSystem } from "../ports/fs.ts";
import {
    isAbsPosix,
    posixBase,
    posixDir,
    posixJoin,
    posixRel,
} from "../util/path.ts";

/**
 * LinkEntry records one pulled page: its Confluence id, its Markdown destination
 * relative to the sync root (forward slashes), its canonical Confluence page URL,
 * its title (the label when an inlineCard is rewritten), and, for a space page,
 * that space's key.
 */
export interface LinkEntry {
    id: string;
    dest: string;
    url: string;
    title: string;
    /** The space key, set only for a space-pulled page (omitted from JSON when empty). */
    spaceKey: string;
}

/**
 * DiscoveredPage is the subset of a walk-discovered page the link index needs.
 * The full discovery walk is M7.4; this is the shape it will supply.
 */
export interface DiscoveredPage {
    dest: string;
    id: string;
    title: string;
    url: string;
    /** The id of the page's parent node in the walk (a page or folder), or `""`. */
    parentId: string;
    spaceKey: string;
}

/** INDEX_NAME is the reserved base name a container page's `_index.md` carries. */
const INDEX_NAME = "_index";

/**
 * pageURL builds the canonical Confluence page URL for a page id in a space. A
 * missing space still yields an id-addressable path Confluence resolves.
 */
export function pageURL(space: string, id: string): string {
    if (space === "") {
        return `/wiki/pages/viewpage.action?pageId=${id}`;
    }
    return `/wiki/spaces/${space}/pages/${id}`;
}

/**
 * LinkIndex is the in-memory link index: entries keyed both by Confluence id (to
 * rewrite a link on pull) and by absolute destination (to restore it on push).
 * `syncRoot` anchors the relative dests.
 */
export class LinkIndex {
    readonly byID = new Map<string, LinkEntry>();
    readonly byDest = new Map<string, LinkEntry>();

    constructor(readonly syncRoot: string) {}

    /** add indexes one entry by both id and absolute destination. */
    add(entry: LinkEntry): void {
        this.byID.set(entry.id, entry);
        this.byDest.set(posixJoin(this.syncRoot, entry.dest), entry);
    }

    /** entries returns the index entries sorted by destination, for a stable file. */
    entries(): LinkEntry[] {
        return [...this.byID.values()].sort((a, b) =>
            a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0,
        );
    }

    /**
     * write persists the index as pretty-printed JSON (with a trailing newline) to
     * `path` through the filesystem port. An empty index writes nothing: there are
     * no pages to link between.
     */
    async write(fs: FileSystem, path: string): Promise<void> {
        const entries = this.entries();
        if (entries.length === 0) {
            return;
        }
        const json = JSON.stringify(entries.map(entryJSON), null, 2);
        await fs.write(path, `${json}\n`);
    }
}

/** entryJSON serializes a LinkEntry in Go's field order, omitting an empty space_key. */
function entryJSON(entry: LinkEntry): Record<string, unknown> {
    const out: Record<string, unknown> = {
        id: entry.id,
        dest: entry.dest,
        url: entry.url,
        title: entry.title,
    };
    if (entry.spaceKey !== "") {
        out["space_key"] = entry.spaceKey;
    }
    return out;
}

/**
 * buildLinkIndex assembles the link index for a pull from the configured pages
 * (resolved path → source) and the discovered space/folder pages. A configured
 * page whose source is not a page URL contributes nothing.
 */
export function buildLinkIndex(
    syncRoot: string,
    pages: Record<string, string>,
    discovered: DiscoveredPage[],
): LinkIndex {
    const idx = new LinkIndex(syncRoot);
    for (const [dest, src] of Object.entries(pages)) {
        const id = tryPageID(src);
        if (id === undefined) {
            continue;
        }
        // Rebuild the canonical view URL from the parsed id and space rather
        // than storing `src` verbatim: a page configured with the browser's
        // edit URL (`.../pages/edit-v2/{id}`) would otherwise be emitted in
        // that action form on push, which carries no heading anchors.
        const spaceKey = spaceKeyOf(src);
        idx.add({
            id,
            dest: pageName(syncRoot, dest),
            url: pageURL(spaceKey, id),
            title: "",
            spaceKey,
        });
    }
    for (const p of discovered) {
        idx.add({
            id: p.id,
            dest: pageName(syncRoot, p.dest),
            url: p.url,
            title: p.title,
            spaceKey: p.spaceKey,
        });
    }
    return idx;
}

/**
 * loadLinkIndex reads the link index written by the last pull from `path`. It
 * resolves to `null` when the file does not exist, so a push before any pull
 * simply skips link restoration.
 */
export async function loadLinkIndex(
    fs: FileSystem,
    path: string,
    syncRoot: string,
): Promise<LinkIndex | null> {
    if (!(await fs.exists(path))) {
        return null;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(await fs.readText(path));
    } catch (err) {
        throw new Error(`parsing links: ${message(err)}`);
    }
    const idx = new LinkIndex(syncRoot);
    for (const item of asArr(raw)) {
        const o = asObj(item);
        idx.add({
            id: asStr(o["id"]),
            dest: asStr(o["dest"]),
            url: asStr(o["url"]),
            title: asStr(o["title"]),
            spaceKey: asStr(o["space_key"]),
        });
    }
    return idx;
}

/**
 * linkMapper returns the {@link Links} that rewrites links for the document at the
 * path `dest`, or `null` when no index is loaded (link rewriting off). `host` is
 * the bare Site host (to recognize a same-Site link) and `site` the Site base URL
 * (to absolutize a pushed href).
 */
export function linkMapper(
    idx: LinkIndex | null,
    dest: string,
    host: string,
    site: string,
): Links | null {
    if (idx === null) {
        return null;
    }
    return new DocLinks(idx, posixDir(dest), host, trimTrailingSlash(site));
}

/**
 * DocLinks implements {@link Links} for one document at `dir`: it maps a
 * Confluence page link to a sync-root-relative Markdown path and back, using the
 * shared index. `host` scopes the match to this Site; `site` absolutizes a pushed
 * href.
 */
export class DocLinks implements Links {
    constructor(
        private readonly idx: LinkIndex,
        private readonly dir: string,
        private readonly host: string,
        private readonly site: string,
    ) {}

    /**
     * toLocal maps a Confluence page href to the Markdown target of that page
     * relative to this document, preserving any `#fragment`. The label is the
     * target page's title, falling back to its file name.
     */
    toLocal(href: string): LocalLink | undefined {
        const ref = this.pageRef(href);
        if (ref === undefined) {
            return undefined;
        }
        const entry = this.idx.byID.get(ref.id);
        if (entry === undefined) {
            return undefined;
        }
        const abs = posixJoin(this.idx.syncRoot, entry.dest);
        let target = posixRel(this.dir, abs);
        if (ref.frag !== "") {
            target += `#${ref.frag}`;
        }
        const label = entry.title !== "" ? entry.title : fileLabel(entry);
        return { target, label };
    }

    /**
     * toRemote maps a sync-root-relative Markdown target back to the absolute
     * Confluence URL of the page it names, preserving any `#fragment`. A target
     * that is not a local path to an indexed page is left unchanged.
     */
    toRemote(target: string): string | undefined {
        const [path, frag] = cutFragment(target);
        if (path === "" || path.includes("://")) {
            return undefined;
        }
        const entry = this.idx.byDest.get(posixJoin(this.dir, path));
        if (entry === undefined) {
            return undefined;
        }
        let href = this.pageHref(entry);
        if (frag !== "") {
            href += `#${frag}`;
        }
        return href;
    }

    /**
     * pageHref builds the absolute Confluence URL of an indexed page, restoring
     * the host and title slug {@link toLocal} drops. The title slug is a trailing
     * path segment of the path-style URL (`.../pages/{id}/{slug}`), so it is
     * appended only to that form: the query form (`viewpage.action?pageId={id}`,
     * emitted for a page with no space key) carries the id in its query string and
     * accepts no slug — appending one would push the slug inside the query string
     * and write an invalid link back to Confluence. A discovered page's title
     * becomes the slug (space → `+`, mirroring Confluence); a configured page has
     * no title, so its URL is used as-is. A host-relative URL is absolutized
     * against the Site, which an unset Site leaves relative.
     */
    private pageHref(entry: LinkEntry): string {
        let href = entry.url;
        if (entry.title !== "" && !href.includes("?")) {
            href += `/${queryEscape(entry.title)}`;
        }
        if (this.site !== "" && href.startsWith("/")) {
            href = this.site + href;
        }
        return href;
    }

    /**
     * pageRef extracts the Confluence page id and fragment from an href pointing
     * at a page on this Site, or `undefined` for another host or a non-page href.
     * Both the path form (`.../pages/{id}/...`) and the query form
     * (`viewpage.action?pageId={id}`) are accepted.
     */
    private pageRef(href: string): { id: string; frag: string } | undefined {
        const u = parseHref(href);
        if (u.host !== "" && u.host !== this.host) {
            return undefined;
        }
        const id = tryPageID(u.path);
        if (id !== undefined) {
            return { id, frag: u.fragment };
        }
        if (isDigits(u.pageId)) {
            return { id: u.pageId, frag: u.fragment };
        }
        return undefined;
    }
}

/** pageName returns dest relative to syncRoot, falling back to dest when Rel cannot apply. */
export function pageName(syncRoot: string, dest: string): string {
    if (isAbsPosix(syncRoot) !== isAbsPosix(dest)) {
        return dest; // filepath.Rel requires two same-kind paths
    }
    return posixRel(syncRoot, dest);
}

/** parseHref splits an href into the fields the page mapping needs. */
function parseHref(href: string): {
    host: string;
    path: string;
    fragment: string;
    pageId: string;
} {
    let s = href;
    let fragment = "";
    const h = s.indexOf("#");
    if (h >= 0) {
        fragment = s.slice(h + 1);
        s = s.slice(0, h);
    }
    let query = "";
    const q = s.indexOf("?");
    if (q >= 0) {
        query = s.slice(q + 1);
        s = s.slice(0, q);
    }
    let host = "";
    let path = s;
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)(\/.*)?$/i.exec(s);
    if (m !== null) {
        host = m[1] ?? "";
        path = m[2] ?? "";
    }
    let pageId = "";
    for (const pair of query.split("&")) {
        const eq = pair.indexOf("=");
        const key = eq >= 0 ? pair.slice(0, eq) : pair;
        if (key === "pageId") {
            pageId = decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : "");
            break;
        }
    }
    return { host, path, fragment, pageId };
}

/** cutFragment splits a target at its first `#`, mirroring Go's strings.Cut. */
function cutFragment(s: string): [string, string] {
    const i = s.indexOf("#");
    return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/** stripMd drops a trailing `.md`. */
function stripMd(s: string): string {
    return s.endsWith(".md") ? s.slice(0, -3) : s;
}

/**
 * fileLabel derives a link label for a titleless indexed entry from its
 * destination file name. A space homepage has an empty title and lands at
 * `_index.md`, whose bare base name (`_index`) reads as noise in a link; label it
 * with its containing section (the space root directory) instead, falling back to
 * the space key and finally the base name when neither is meaningful.
 */
function fileLabel(entry: LinkEntry): string {
    const base = stripMd(posixBase(entry.dest));
    if (base !== INDEX_NAME) {
        return base;
    }
    const dir = posixBase(posixDir(entry.dest));
    if (dir !== "" && dir !== "." && dir !== "/") {
        return dir;
    }
    return entry.spaceKey !== "" ? entry.spaceKey : base;
}

/** trimTrailingSlash drops a single trailing `/`. */
function trimTrailingSlash(s: string): string {
    return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * queryEscape percent-encodes a title for a URL slug with `+` for spaces,
 * approximating Go's `url.QueryEscape`. The slug is cosmetic — Confluence resolves
 * a page by id — and never enters the GetPut-compared Markdown, so exact parity
 * with every escaped character is unnecessary.
 */
function queryEscape(s: string): string {
    return encodeURIComponent(s).replace(/%20/g, "+");
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** asObj narrows a parsed JSON value to a record, or `{}`. */
function asObj(v: unknown): Record<string, unknown> {
    return typeof v === "object" && v !== null
        ? (v as Record<string, unknown>)
        : {};
}

/** asStr reads a JSON string, or `""`. */
function asStr(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** asArr narrows a parsed JSON value to an array, or `[]`. */
function asArr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}
