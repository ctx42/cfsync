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

import type { Config } from "../config/config.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Yaml } from "../ports/yaml.ts";
import { posixBase, posixDir, posixJoin } from "../util/path.ts";
import { mdFilesUnder } from "./fswalk.ts";
import { pageName } from "./linkindex.ts";
import { readPageMeta } from "./push.ts";

/** GcDeps are the ports, config, and assets dir garbage collection needs. */
export interface GcDeps {
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
    /** The shared assets directory (under the sync root). */
    assetsDir: string;
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
    let report = "";
    for (const name of unreadable) {
        report += `warning: cannot read ${name}; its images are unknown\n`;
    }

    if (orphans.length === 0) {
        return {
            report: `${report}cfsync: no orphaned assets\n`,
            orphans,
            unreadable,
            pruned: 0,
        };
    }

    if (!prune) {
        const label = posixBase(deps.assetsDir);
        report += `${orphans.length} orphaned asset(s) in ${label}:\n`;
        for (const o of orphans) {
            report += `  ${posixBase(o)}\n`;
        }
        report += 'cfsync: run "cfsync gc --prune" to delete them\n';
        return { report, orphans, unreadable, pruned: 0 };
    }

    if (unreadable.length > 0) {
        throw new Error(
            `refusing to prune: ${unreadable.length} managed page(s) ` +
                "could not be read",
        );
    }

    for (const o of orphans) {
        await deps.fs.remove(o);
        report += `pruned ${posixBase(o)}\n`;
    }
    report += `cfsync: pruned ${orphans.length} orphaned asset(s)\n`;
    return { report, orphans, unreadable, pruned: orphans.length };
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
