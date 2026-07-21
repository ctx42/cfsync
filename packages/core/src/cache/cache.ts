// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The ADF cache, ported from `pkg/cfsync/cache.go` and redesigned for the
// Obsidian-native layout. A {@link Page} is a single Confluence page as pulled:
// the value written, pretty-printed, to the cache and re-parsed on push so the
// lens sees exactly the bytes it validated. The cache is device-local by design —
// a second device re-pulls before pushing. Its *home* is resolved by the adapter
// and passed in as a path: the CLI caches under its work tree, and the plugin
// caches in an out-of-vault OS cache dir (so it never lands in another plugin's
// reach, e.g. obsidian-git). This module only names, marshals, writes, and
// re-parses a page, all through the injected {@link FileSystem} port.

import { type ADF, newADF } from "../models/adf.ts";
import type { FileSystem } from "../ports/fs.ts";

/**
 * Page is a single Confluence page pulled from the Site: the destination name,
 * the Confluence identity, and the body as a raw ADF JSON string. It is the value
 * cached and the value {@link cacheFile} names. `parentId`, `spaceKey`, and
 * `domain` are omitted from the cache JSON when empty, matching the frontmatter
 * they round-trip into.
 */
export interface Page {
    /** The destination name from the config, relative to the sync root, ending `.md`. */
    name: string;
    /** The numeric Confluence page id. */
    id: string;
    /** The page title as stored in Confluence. */
    title: string;
    /** The Confluence page version number. */
    version: number;
    /** The numeric id of the space the page belongs to. */
    spaceId: string;
    /** The numeric id of the parent node; `""` for a space homepage (omitted). */
    parentId: string;
    /** The space key, set only for a space-pulled page (omitted when empty). */
    spaceKey: string;
    /** The Site host the page was pulled from (omitted when empty). */
    domain: string;
    /** The page body as a raw ADF JSON string, embedded verbatim. */
    adf: string;
}

/**
 * cacheFile returns the cache file name for a page relative to the cache
 * directory: its config name with the `.md` suffix dropped and the version
 * appended, so `test/root_page_1.md` at version 5 becomes
 * `test/root_page_1.v5.json`.
 */
export function cacheFile(page: Page): string {
    return cacheFileName(page.name, page.version);
}

/**
 * cacheFileName is {@link cacheFile} by destination name and version, for a caller
 * that knows a page's name and remote version but has not built its {@link Page} —
 * e.g. a pull probing whether the current version is already cached.
 */
export function cacheFileName(name: string, version: number): string {
    const base = name.endsWith(".md") ? name.slice(0, -3) : name;
    return `${base}.v${version}.json`;
}

/**
 * marshalPage returns the page as pretty-printed (2-space) wrapper JSON, the form
 * {@link newADF} parses back. The ADF body is embedded as a re-indented object,
 * and the optional identity fields are omitted when empty. It throws when the ADF
 * body is not valid JSON.
 */
export function marshalPage(page: Page): string {
    let body: unknown;
    try {
        body = JSON.parse(page.adf);
    } catch (err) {
        throw new Error(`encoding page ${page.id}: ${message(err)}`);
    }
    const wrapper: Record<string, unknown> = {
        name: page.name,
        id: page.id,
        title: page.title,
        version: page.version,
        space_id: page.spaceId,
    };
    if (page.parentId !== "") {
        wrapper["parent_id"] = page.parentId;
    }
    if (page.spaceKey !== "") {
        wrapper["space_key"] = page.spaceKey;
    }
    if (page.domain !== "") {
        wrapper["cf_domain"] = page.domain;
    }
    wrapper["adf"] = body;
    return JSON.stringify(wrapper, null, 2);
}

/**
 * writePage writes the page as pretty-printed wrapper JSON (with a trailing
 * newline) to `path` through the filesystem port, which creates any missing
 * parent directories.
 */
export async function writePage(
    fs: FileSystem,
    path: string,
    page: Page,
): Promise<void> {
    await fs.write(path, `${marshalPage(page)}\n`);
}

/**
 * pageDoc parses the page into an {@link ADF} document, round-tripping it through
 * its wrapper JSON so the parsed document matches the cached ADF exactly.
 */
export function pageDoc(page: Page): ADF {
    return newADF(marshalPage(page));
}

/**
 * readCachedPage reads a page previously written by {@link writePage} back from
 * `path`, or returns null when the file is absent or is not a parseable cache
 * wrapper. It is the read side of the cache: a pull that already knows a page's
 * current remote version can load its ADF from here instead of re-downloading the
 * body. The `adf` object is re-serialized to the raw JSON string a {@link Page}
 * carries; the identity fields mirror {@link marshalPage}'s wrapper keys.
 */
export async function readCachedPage(
    fs: FileSystem,
    path: string,
): Promise<Page | null> {
    if (!(await fs.exists(path))) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(await fs.readText(path));
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const o = parsed as Record<string, unknown>;
    if (o["adf"] === undefined || o["adf"] === null) {
        return null;
    }
    return {
        name: asStr(o["name"]),
        id: asStr(o["id"]),
        title: asStr(o["title"]),
        version: asNum(o["version"]),
        spaceId: asStr(o["space_id"]),
        parentId: asStr(o["parent_id"]),
        spaceKey: asStr(o["space_key"]),
        domain: asStr(o["cf_domain"]),
        adf: JSON.stringify(o["adf"]),
    };
}

/** asStr reads a JSON string, or `""`. */
function asStr(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** asNum reads a JSON number truncated toward zero, or `0`. */
function asNum(v: unknown): number {
    return typeof v === "number" ? Math.trunc(v) : 0;
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
