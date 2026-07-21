// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Offline directory-walk helpers over the {@link FileSystem} port, shared by the
// gc and clean maintenance commands. Ported from `mdFilesUnder`/`dirEmpty` in
// `pkg/cfsync/helpers.go`. An absent or unreadable directory yields nothing
// rather than failing, so a root not yet pulled is simply skipped.

import type { FileSystem } from "../ports/fs.ts";
import { posixJoin } from "../util/path.ts";

/**
 * CACHE_DIR_NAME is the ADF cache directory (mirrors the CLI's `CACHE_DIR`). The
 * walk skips any directory with this name: it holds cached page copies and ADF,
 * never user notes. Without the skip, a folder or space root mapped at the sync
 * root (where the cache dir lives) surfaces the cached `.md` copies as notes to
 * push, gc, or clean. Ported from Go's `adfCacheDir` skip in `mdFilesUnder`.
 */
const CACHE_DIR_NAME = ".adf_cache";

/**
 * walkDir recursively visits every file under `dir`, calling `onFile` with each
 * file's path. Directories are descended into (except the ADF cache directory,
 * see {@link CACHE_DIR_NAME}); an unreadable directory or entry is skipped.
 */
export async function walkDir(
    fs: FileSystem,
    dir: string,
    onFile: (path: string) => void,
): Promise<void> {
    let names: string[];
    try {
        names = await fs.readdir(dir);
    } catch {
        return; // absent or unreadable subtree
    }
    for (const name of names) {
        const path = posixJoin(dir, name);
        let isDir: boolean;
        try {
            isDir = (await fs.stat(path)).isDirectory;
        } catch {
            continue;
        }
        if (isDir) {
            if (name === CACHE_DIR_NAME) {
                continue; // cache artifacts are never user notes
            }
            await walkDir(fs, path, onFile);
        } else {
            onFile(path);
        }
    }
}

/**
 * mdFilesUnder returns every `.md` file under the given roots, sorted. A root that
 * does not exist contributes nothing, so garbage collection and clean (which run
 * offline) can walk the on-disk roots for the pages a pull discovered.
 */
export async function mdFilesUnder(
    fs: FileSystem,
    roots: string[],
): Promise<string[]> {
    const files: string[] = [];
    for (const root of roots) {
        await walkDir(fs, root, (path) => {
            if (path.endsWith(".md")) {
                files.push(path);
            }
        });
    }
    files.sort();
    return files;
}

/** dirEmpty reports whether `dir` has no entries; a missing directory is not empty. */
export async function dirEmpty(fs: FileSystem, dir: string): Promise<boolean> {
    try {
        return (await fs.readdir(dir)).length === 0;
    } catch {
        return false;
    }
}
