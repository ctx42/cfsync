// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Garbage collection, ported from `pkg/cfsync/gc.go`. It reports (and, with
// prune, deletes) orphaned files in the shared assets directory: files no managed
// page's `page_images` frontmatter references. Because `_cfsync-media/` is shared across
// every page, a file is orphaned only when NO page references it, so gc reads the
// frontmatter of every managed note — each configured page and every note under a
// configured folder or space root (walked on disk, since gc runs offline). It
// runs entirely through the {@link FileSystem} and {@link Yaml} ports and only
// ever touches files under the injected `assetsDir`, honoring the scope guard.
// Given the ADF `cacheDir` too, it also reports (and prunes) the cache entries
// of notes that no longer exist — left behind when a note is moved or deleted
// locally — which it otherwise would never revisit.

import type { Config } from "../config/config.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Yaml } from "../ports/yaml.ts";
import { posixBase, posixDir, posixJoin } from "../util/path.ts";
import { mdFilesUnder, walkDir } from "./fswalk.ts";
import { pageName } from "./linkindex.ts";
import { readPageMeta } from "./push.ts";

/** GcDeps are the ports, config, and assets dir garbage collection needs. */
export interface GcDeps {
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
    /** The shared assets directory (under the sync root). */
    assetsDir: string;
    /** The ADF cache directory; when set, its orphaned entries are collected too. */
    cacheDir?: string;
}

/** GcResult is the report plus the orphan/unreadable lists and pruned count. */
export interface GcResult {
    report: string;
    /** Absolute paths of orphaned asset files. */
    orphans: string[];
    /** Names of managed notes whose frontmatter could not be read. */
    unreadable: string[];
    /** How many orphans were deleted (0 unless pruning). */
    pruned: number;
    /** Absolute paths of ADF cache files whose note no longer exists. */
    orphanCache: string[];
}

/**
 * collectGarbage finds orphaned assets and, when `prune` is set, deletes them. It
 * refuses to prune when any managed note could not be read, since that note's
 * references are then unknown and a still-used image could be deleted by mistake.
 */
export async function collectGarbage(
    deps: GcDeps,
    prune: boolean,
): Promise<GcResult> {
    const { orphans, unreadable } = await orphanedAssets(deps);
    const orphanCache =
        deps.cacheDir === undefined
            ? []
            : await orphanedCache(deps.fs, deps.config.syncRoot, deps.cacheDir);
    let report = "";
    for (const name of unreadable) {
        report += `warning: cannot read ${name}; its images are unknown\n`;
    }
    if (prune && orphans.length > 0 && unreadable.length > 0) {
        throw new Error(
            `refusing to prune: ${unreadable.length} managed page(s) ` +
                "could not be read",
        );
    }
    const cacheReport = await gcCache(deps, orphanCache, prune);

    if (orphans.length === 0) {
        return {
            report: `${report}cfsync: no orphaned assets\n${cacheReport}`,
            orphans,
            unreadable,
            pruned: 0,
            orphanCache,
        };
    }

    if (!prune) {
        const label = posixBase(deps.assetsDir);
        report += `${orphans.length} orphaned asset(s) in ${label}:\n`;
        for (const o of orphans) {
            report += `  ${posixBase(o)}\n`;
        }
        report += 'cfsync: run "cfsync gc --prune" to delete them\n';
        return {
            report: report + cacheReport,
            orphans,
            unreadable,
            pruned: 0,
            orphanCache,
        };
    }

    for (const o of orphans) {
        await deps.fs.remove(o);
        report += `pruned ${posixBase(o)}\n`;
    }
    report += `cfsync: pruned ${orphans.length} orphaned asset(s)\n`;
    return {
        report: report + cacheReport,
        orphans,
        unreadable,
        pruned: orphans.length,
        orphanCache,
    };
}

/**
 * gcCache reports the orphaned cache entries and, when pruning, deletes them,
 * returning the report lines. Unlike an asset, a cache entry's owner is known
 * from its path alone, so an unreadable note never blocks this prune. Nothing is
 * reported when there are none.
 */
async function gcCache(
    deps: GcDeps,
    orphans: string[],
    prune: boolean,
): Promise<string> {
    const dir = deps.cacheDir;
    if (dir === undefined || orphans.length === 0) {
        return "";
    }
    const rel = (p: string): string => p.slice(dir.length + 1);
    if (!prune) {
        let report =
            `${orphans.length} orphaned cache file(s) for notes that no ` +
            "longer exist:\n";
        for (const o of orphans) {
            report += `  ${rel(o)}\n`;
        }
        return `${report}cfsync: run "cfsync gc --prune" to delete them\n`;
    }
    let report = "";
    for (const o of orphans) {
        await deps.fs.remove(o);
        report += `pruned ${rel(o)}\n`;
    }
    return `${report}cfsync: pruned ${orphans.length} orphaned cache file(s)\n`;
}

/**
 * CACHE_ENTRY matches a per-note cache file — the cached ADF and render of a
 * version (`<name>.v<N>.json` / `.md`) or the comment record
 * (`<name>.comments.json`) — capturing the note name without `.md`.
 */
const CACHE_ENTRY = /^(.+?)\.(?:v\d+\.(?:json|md)|comments\.json)$/;

/**
 * orphanedCache lists the per-note files under `cacheDir` whose note no longer
 * exists under `syncRoot`, sorted. Files of any other shape (the link index) are
 * never listed.
 */
export async function orphanedCache(
    fs: FileSystem,
    syncRoot: string,
    cacheDir: string,
): Promise<string[]> {
    const files: string[] = [];
    await walkDir(fs, cacheDir, (path) => {
        files.push(path);
    });
    const orphans: string[] = [];
    for (const path of files) {
        const m = CACHE_ENTRY.exec(path.slice(cacheDir.length + 1));
        if (m?.[1] === undefined) {
            continue;
        }
        if (!(await fs.exists(posixJoin(syncRoot, `${m[1]}.md`)))) {
            orphans.push(path);
        }
    }
    return orphans.sort();
}

/**
 * orphanedAssets lists the files in the assets directory that no managed page
 * references, plus the names of pages whose frontmatter could not be read. It
 * reports no orphans when the assets directory does not exist.
 */
export async function orphanedAssets(
    deps: GcDeps,
): Promise<{ orphans: string[]; unreadable: string[] }> {
    const { referenced, unreadable } = await referencedAssets(deps);
    let names: string[];
    try {
        names = await deps.fs.readdir(deps.assetsDir);
    } catch {
        return { orphans: [], unreadable: unreadable.sort() };
    }

    const orphans: string[] = [];
    for (const name of names) {
        const abs = posixJoin(deps.assetsDir, name);
        let isDir: boolean;
        try {
            isDir = (await deps.fs.stat(abs)).isDirectory;
        } catch {
            continue;
        }
        if (!isDir && !referenced.has(abs)) {
            orphans.push(abs);
        }
    }
    return { orphans: orphans.sort(), unreadable: unreadable.sort() };
}

/**
 * referencedAssets reads the `page_images` frontmatter of every managed note and
 * returns the set of absolute asset paths they reference, plus the names of notes
 * that could not be read. Each `page_images` path is resolved relative to its own
 * note, mirroring how it was written.
 */
async function referencedAssets(
    deps: GcDeps,
): Promise<{ referenced: Set<string>; unreadable: string[] }> {
    const referenced = new Set<string>();
    const unreadable: string[] = [];
    const seen = new Set<string>();
    const roots = [
        ...Object.keys(deps.config.folders),
        ...Object.keys(deps.config.spaces),
    ];
    const dests = [
        ...Object.keys(deps.config.pages),
        ...(await mdFilesUnder(deps.fs, roots)),
    ];

    for (const dest of dests) {
        if (seen.has(dest)) {
            continue;
        }
        seen.add(dest);
        const meta = await readPageMeta(deps.fs, deps.yaml, dest);
        if (meta === null) {
            unreadable.push(pageName(deps.config.syncRoot, dest));
            continue;
        }
        const base = posixDir(dest);
        for (const img of meta.pageImages) {
            referenced.add(posixJoin(base, img.file));
        }
    }
    return { referenced, unreadable };
}
