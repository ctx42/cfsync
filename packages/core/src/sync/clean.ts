// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Clean, ported from `pkg/cfsync/clean.go`. It removes local notes under the
// configured folder and space roots that no longer exist in Confluence, plus any
// directory they leave empty. `findStale` discovers each root's current remote
// content and returns the stale items; a root whose discovery fails (or reports
// any per-page error) is skipped with a warning, never cleaned on an incomplete
// picture. `removeStale` deletes a chosen set. The confirm/prompt UX is the
// adapter's (a confirm modal / a TTY prompt); core only computes and removes.
// Everything is under the sync root, honoring the scope guard.

import type { Config } from "../config/config.ts";
import type { ConfluenceClient } from "../confluence/client.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Reporter } from "../ports/progress.ts";
import type { Yaml } from "../ports/yaml.ts";
import { posixJoin } from "../util/path.ts";
import {
    type DiscoverResult,
    discoverFolder,
    discoverSpace,
} from "./discover.ts";
import { dirEmpty } from "./fswalk.ts";
import { readPageMeta } from "./push.ts";

/** StaleItem is a local path with no live Confluence counterpart. */
export interface StaleItem {
    path: string;
    /** Whether it is a directory rather than a managed Markdown file. */
    isDir: boolean;
}

/** CleanPlan is the stale items found plus one warning per skipped root. */
export interface CleanPlan {
    items: StaleItem[];
    warnings: string[];
}

/** CleanDeps are the ports and config clean needs. */
export interface CleanDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
    reporter: Reporter;
}

/**
 * findStale discovers the current remote content of each configured folder and
 * space and returns the managed notes under each root that no longer exist
 * remotely, plus the directories they leave empty. A root whose discovery fails or
 * reports any per-page error is skipped with a warning, so it is never cleaned on
 * an incomplete picture.
 */
export async function findStale(deps: CleanDeps): Promise<CleanPlan> {
    const items: StaleItem[] = [];
    const warnings: string[] = [];
    await staleInRoots(
        deps,
        deps.config.folders,
        discoverFolder,
        items,
        warnings,
    );
    await staleInRoots(
        deps,
        deps.config.spaces,
        discoverSpace,
        items,
        warnings,
    );
    return { items, warnings };
}

/** staleInRoots appends the stale items under each root in `roots` to `items`. */
async function staleInRoots(
    deps: CleanDeps,
    roots: Record<string, string>,
    discover: (
        client: ConfluenceClient,
        config: Config,
        reporter: Reporter,
        src: string,
        root: string,
    ) => Promise<DiscoverResult>,
    items: StaleItem[],
    warnings: string[],
): Promise<void> {
    for (const root of Object.keys(roots).sort()) {
        let found: DiscoverResult;
        try {
            found = await discover(
                deps.client,
                deps.config,
                deps.reporter,
                roots[root] ?? "",
                root,
            );
        } catch (err) {
            warnings.push(`skipping ${root}: ${message(err)}`);
            continue;
        }
        if (found.errors.length > 0) {
            // An incomplete listing could delete a page that is really still there.
            warnings.push(`skipping ${root}: ${found.errors.join("; ")}`);
            continue;
        }
        // Empty-discovery safety floor: a successful discovery that returns zero
        // pages while managed notes still sit on disk is treated as suspect (a
        // revoked permission or a transient empty result), not a genuine remote
        // emptying — cleaning here would wipe every managed note under the root.
        // When in doubt, skip and warn rather than delete. A root with no managed
        // notes on disk is left to the normal scan, which is a no-op there.
        if (found.pages.length === 0 && (await hasManaged(deps, root))) {
            warnings.push(
                `skipping ${root}: discovery returned no pages but managed ` +
                    "notes exist on disk; refusing to delete on a possibly " +
                    "incomplete listing",
            );
            continue;
        }
        const expected = new Set(found.pages.map((p) => p.dest));
        await scanStale(deps, root, expected, items);
    }
}

/**
 * scanStale walks `dir`, appending each stale managed note and each removable
 * sub-directory to `items`, and returns whether `dir` itself is removable — it is
 * non-empty and holds only stale files and removable sub-directories. An empty or
 * absent directory is not removable, so a directory clean did not empty is left
 * alone.
 */
async function scanStale(
    deps: CleanDeps,
    dir: string,
    expected: Set<string>,
    items: StaleItem[],
): Promise<boolean> {
    let names: string[];
    try {
        names = await deps.fs.readdir(dir);
    } catch {
        return false;
    }
    if (names.length === 0) {
        return false;
    }

    let removable = true;
    for (const name of names) {
        const path = posixJoin(dir, name);
        let isDir: boolean;
        try {
            isDir = (await deps.fs.stat(path)).isDirectory;
        } catch {
            removable = false;
            continue;
        }
        if (isDir) {
            if (await scanStale(deps, path, expected, items)) {
                items.push({ path, isDir: true });
            } else {
                removable = false;
            }
        } else if (await staleFile(deps, path, expected)) {
            items.push({ path, isDir: false });
        } else {
            removable = false;
        }
    }
    return removable;
}

/**
 * staleFile reports whether the file at `path` is a stale managed note: it is a
 * managed note (see {@link isManaged}) that is not among the expected paths. A
 * file clean did not write, or cannot read, is never stale.
 */
async function staleFile(
    deps: CleanDeps,
    path: string,
    expected: Set<string>,
): Promise<boolean> {
    return (await isManaged(deps, path)) && !expected.has(path);
}

/**
 * isManaged reports whether the file at `path` is a cfsync-managed note: it ends
 * in `.md` and carries the `cfsync-plugin: pull` marker. A non-Markdown file, or
 * one that cannot be read or lacks the marker, is not managed.
 */
async function isManaged(deps: CleanDeps, path: string): Promise<boolean> {
    if (!path.endsWith(".md")) {
        return false;
    }
    const meta = await readPageMeta(deps.fs, deps.yaml, path);
    return meta?.cfsync ?? false;
}

/**
 * hasManaged reports whether any cfsync-managed note exists anywhere in the tree
 * under `dir`. It backs the empty-discovery safety floor: a discovery that yields
 * no pages over a tree that still holds managed notes is refused rather than
 * cleaned. An absent or unreadable directory holds nothing managed.
 */
async function hasManaged(deps: CleanDeps, dir: string): Promise<boolean> {
    let names: string[];
    try {
        names = await deps.fs.readdir(dir);
    } catch {
        return false;
    }
    for (const name of names) {
        const path = posixJoin(dir, name);
        let isDir: boolean;
        try {
            isDir = (await deps.fs.stat(path)).isDirectory;
        } catch {
            continue;
        }
        if (isDir) {
            if (await hasManaged(deps, path)) {
                return true;
            }
        } else if (await isManaged(deps, path)) {
            return true;
        }
    }
    return false;
}

/**
 * removeStale deletes the chosen items — files first, then directories
 * deepest-first, and only when still empty — returning a report and the counts. A
 * directory left non-empty (a kept file inside it) is skipped.
 */
export async function removeStale(
    fs: FileSystem,
    items: StaleItem[],
): Promise<{ report: string; removedFiles: number; removedDirs: number }> {
    let report = "";
    let removedFiles = 0;
    for (const it of items.filter((i) => !i.isDir)) {
        try {
            await fs.remove(it.path);
            removedFiles++;
            report += `removed ${it.path}\n`;
        } catch (err) {
            report += `warning: ${message(err)}\n`;
        }
    }

    const dirs = items
        .filter((i) => i.isDir)
        .sort((a, b) => b.path.length - a.path.length);
    let removedDirs = 0;
    for (const it of dirs) {
        if (!(await dirEmpty(fs, it.path))) {
            continue;
        }
        try {
            await fs.remove(it.path);
            removedDirs++;
            report += `removed ${it.path}/\n`;
        } catch (err) {
            report += `warning: ${message(err)}\n`;
        }
    }
    report +=
        `cfsync: removed ${removedFiles} file(s) and ` +
        `${removedDirs} director(ies)\n`;
    return { report, removedFiles, removedDirs };
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
