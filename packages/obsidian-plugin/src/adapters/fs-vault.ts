// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's FileSystem port over Obsidian's Vault DataAdapter. The core reads
// and writes notes, the ADF cache, and assets only through this port; here it is
// backed by vault-relative paths. `VaultAdapter` is the subset of Obsidian's
// `DataAdapter` used, injected (not imported) so this module carries no obsidian
// runtime dependency and unit-tests with a fake.

import type { FileStat, FileSystem } from "@cfsync/core";

/** VaultAdapter is the subset of Obsidian's DataAdapter this port uses. */
export interface VaultAdapter {
    read(path: string): Promise<string>;
    readBinary(path: string): Promise<ArrayBuffer>;
    write(path: string, data: string): Promise<void>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    remove(path: string): Promise<void>;
    rmdir(path: string, recursive: boolean): Promise<void>;
    stat(
        path: string,
    ): Promise<{ type: "file" | "folder"; size: number } | null>;
}

/** VaultFileSystem implements the core {@link FileSystem} over a {@link VaultAdapter}. */
export class VaultFileSystem implements FileSystem {
    constructor(private readonly a: VaultAdapter) {}

    async read(path: string): Promise<Uint8Array> {
        return new Uint8Array(await this.a.readBinary(vaultPath(path)));
    }

    readText(path: string): Promise<string> {
        return this.a.read(vaultPath(path));
    }

    async write(path: string, data: Uint8Array | string): Promise<void> {
        const p = vaultPath(path);
        const dir = parentOf(p);
        if (dir !== "") {
            await this.mkdirp(dir);
        }
        if (typeof data === "string") {
            await this.a.write(p, data);
        } else {
            await this.a.writeBinary(
                p,
                data.buffer.slice(
                    data.byteOffset,
                    data.byteOffset + data.byteLength,
                ) as ArrayBuffer,
            );
        }
    }

    exists(path: string): Promise<boolean> {
        return this.a.exists(vaultPath(path));
    }

    async mkdirp(path: string): Promise<void> {
        const p = vaultPath(path);
        if (p === "") return;
        const segments = p.split("/");
        let prefix = "";
        for (const segment of segments) {
            prefix = prefix === "" ? segment : `${prefix}/${segment}`;
            if (!(await this.a.exists(prefix))) {
                await this.a.mkdir(prefix);
            }
        }
    }

    async readdir(path: string): Promise<string[]> {
        const listing = await this.a.list(vaultPath(path));
        return [...listing.files, ...listing.folders].map(baseName);
    }

    async remove(path: string): Promise<void> {
        const p = vaultPath(path);
        const st = await this.a.stat(p);
        if (st === null) {
            // Removing a missing path is a no-op — the port's other impls
            // (NodeFileSystem/CLI via rm force:true, the in-memory fs via
            // Map.delete) all succeed silently, and Obsidian's remove() would
            // otherwise reject with 'file not found'.
            return;
        }
        if (st.type === "folder") {
            await this.a.rmdir(p, true);
        } else {
            await this.a.remove(p);
        }
    }

    async stat(path: string): Promise<FileStat> {
        const st = await this.a.stat(vaultPath(path));
        if (st === null) {
            throw new Error(`no such file: ${path}`);
        }
        return {
            isDirectory: st.type === "folder",
            size: st.type === "folder" ? 0 : st.size,
        };
    }
}

/** vaultPath maps a core path to a vault-relative one: strips `./` and root `.`. */
function vaultPath(path: string): string {
    if (path === "." || path === "") return "";
    return path.startsWith("./") ? path.slice(2) : path;
}

/** parentOf returns the parent directory of `p`, or "" for a top-level entry. */
function parentOf(p: string): string {
    const at = p.lastIndexOf("/");
    return at < 0 ? "" : p.slice(0, at);
}

/** baseName returns the last path segment of `p`. */
function baseName(p: string): string {
    const at = p.lastIndexOf("/");
    return at < 0 ? p : p.slice(at + 1);
}
