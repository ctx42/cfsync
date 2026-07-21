// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A FileSystem that routes by path: anything under the device-local cache root
// (an absolute OS path, see cache-home.ts) goes to the Node-backed fs OUTSIDE the
// vault; everything else — notes and shared assets, addressed vault-relative —
// goes to the vault fs. This lets the core keep its single injected FileSystem
// while the ADF cache and link index live where obsidian-git and other plugins
// cannot reach them.

import type { FileStat, FileSystem } from "@cfsync/core";

/** SplitFileSystem dispatches each path to the cache fs or the vault fs. */
export class SplitFileSystem implements FileSystem {
    /**
     * @param vault fs for vault-relative notes and assets.
     * @param cache fs for the device-local cache, rooted at `cacheRoot`.
     * @param cacheRoot the absolute cache directory; paths at or under it route to `cache`.
     */
    constructor(
        private readonly vault: FileSystem,
        private readonly cache: FileSystem,
        private readonly cacheRoot: string,
    ) {}

    /** pick returns the cache fs for a path under the cache root, else the vault fs. */
    private pick(path: string): FileSystem {
        const under =
            path === this.cacheRoot || path.startsWith(`${this.cacheRoot}/`);
        return under ? this.cache : this.vault;
    }

    read(path: string): Promise<Uint8Array> {
        return this.pick(path).read(path);
    }

    readText(path: string): Promise<string> {
        return this.pick(path).readText(path);
    }

    write(path: string, data: Uint8Array | string): Promise<void> {
        return this.pick(path).write(path, data);
    }

    exists(path: string): Promise<boolean> {
        return this.pick(path).exists(path);
    }

    mkdirp(path: string): Promise<void> {
        return this.pick(path).mkdirp(path);
    }

    readdir(path: string): Promise<string[]> {
        return this.pick(path).readdir(path);
    }

    remove(path: string): Promise<void> {
        return this.pick(path).remove(path);
    }

    stat(path: string): Promise<FileStat> {
        return this.pick(path).stat(path);
    }
}
