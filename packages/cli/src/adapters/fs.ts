// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's FileSystem adapter over `node:fs/promises`. The core reads and writes
// notes, the ADF cache, and assets only through the {@link FileSystem} port, so
// the plugin can back it with Obsidian's Vault; here the real filesystem does.
// `write` creates parent directories first, matching the MemFS test double and
// the Vault adapter, so callers never mkdir before writing.

import {
    access,
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { FileStat, FileSystem } from "@cfsync/core";

/** NodeFS implements the {@link FileSystem} port against the local disk. */
export class NodeFS implements FileSystem {
    async read(path: string): Promise<Uint8Array> {
        return new Uint8Array(await readFile(path));
    }

    readText(path: string): Promise<string> {
        return readFile(path, "utf8");
    }

    async write(path: string, data: Uint8Array | string): Promise<void> {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
    }

    async exists(path: string): Promise<boolean> {
        try {
            await access(path);
            return true;
        } catch {
            return false;
        }
    }

    async mkdirp(path: string): Promise<void> {
        await mkdir(path, { recursive: true });
    }

    readdir(path: string): Promise<string[]> {
        return readdir(path);
    }

    async remove(path: string): Promise<void> {
        await rm(path, { recursive: true, force: true });
    }

    async stat(path: string): Promise<FileStat> {
        const s = await stat(path);
        const isDirectory = s.isDirectory();
        // FileStat.size is documented 0 for directories (both Obsidian adapters
        // agree); the raw directory size (e.g. 4096) would leak here otherwise.
        return { isDirectory, size: isDirectory ? 0 : s.size };
    }
}
