// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's FileSystem port over Node's real filesystem, used for the
// device-local ADF cache that lives OUTSIDE the vault (see cache-home.ts). Paths
// are absolute OS paths (forward slashes accepted on every platform). Desktop
// only — the plugin is `isDesktopOnly`, so `node:fs` is always present; on mobile
// this module would never load. The in-vault notes and assets go through
// VaultFileSystem instead; the split fs routes between the two.

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

/** NodeFileSystem implements the core {@link FileSystem} over `node:fs/promises`. */
export class NodeFileSystem implements FileSystem {
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
        const st = await stat(path);
        return {
            isDirectory: st.isDirectory(),
            size: st.isDirectory() ? 0 : st.size,
        };
    }
}
