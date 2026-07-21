// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// In-memory FileSystem for tests: a flat map of normalized paths to bytes,
// with directories tracked so mkdirp/readdir/stat behave. Paths use `/`
// separators and are normalized (no trailing slash, no `.`/`..` resolution —
// tests pass already-clean paths).

import type { FileStat, FileSystem } from "../../src/ports/fs.ts";

/** Normalize a path: drop trailing slashes, collapse repeated slashes. */
function clean(path: string): string {
    const norm = path.replace(/\/+/g, "/").replace(/\/$/, "");
    return norm === "" ? "/" : norm;
}

/** The parent directory of `path`, or "" for a top-level entry. */
function parent(path: string): string {
    const at = path.lastIndexOf("/");
    return at <= 0 ? "" : path.slice(0, at);
}

/** An in-memory {@link FileSystem}. */
export class MemFS implements FileSystem {
    private readonly files = new Map<string, Uint8Array>();
    private readonly dirs = new Set<string>(["/"]);

    read(path: string): Promise<Uint8Array> {
        const data = this.files.get(clean(path));
        if (data === undefined) {
            return Promise.reject(new Error(`no such file: ${path}`));
        }
        return Promise.resolve(data);
    }

    async readText(path: string): Promise<string> {
        return new TextDecoder().decode(await this.read(path));
    }

    write(path: string, data: Uint8Array | string): Promise<void> {
        const key = clean(path);
        const bytes =
            typeof data === "string" ? new TextEncoder().encode(data) : data;
        this.files.set(key, bytes);
        this.registerParents(key);
        return Promise.resolve();
    }

    exists(path: string): Promise<boolean> {
        const key = clean(path);
        return Promise.resolve(this.files.has(key) || this.dirs.has(key));
    }

    mkdirp(path: string): Promise<void> {
        const key = clean(path);
        this.dirs.add(key);
        this.registerParents(key);
        return Promise.resolve();
    }

    readdir(path: string): Promise<string[]> {
        const dir = clean(path);
        const names = new Set<string>();
        for (const key of [...this.files.keys(), ...this.dirs]) {
            if (key !== dir && parent(key) === dir) {
                names.add(key.slice(dir === "/" ? 1 : dir.length + 1));
            }
        }
        return Promise.resolve([...names].sort());
    }

    remove(path: string): Promise<void> {
        const key = clean(path);
        this.files.delete(key);
        this.dirs.delete(key);
        const prefix = `${key}/`;
        for (const f of [...this.files.keys()]) {
            if (f.startsWith(prefix)) {
                this.files.delete(f);
            }
        }
        for (const d of [...this.dirs]) {
            if (d.startsWith(prefix)) {
                this.dirs.delete(d);
            }
        }
        return Promise.resolve();
    }

    stat(path: string): Promise<FileStat> {
        const key = clean(path);
        const file = this.files.get(key);
        if (file !== undefined) {
            return Promise.resolve({ isDirectory: false, size: file.length });
        }
        if (this.dirs.has(key)) {
            return Promise.resolve({ isDirectory: true, size: 0 });
        }
        return Promise.reject(new Error(`no such file: ${path}`));
    }

    /** Register every ancestor directory of `key`. */
    private registerParents(key: string): void {
        let dir = parent(key);
        while (dir !== "") {
            this.dirs.add(dir);
            dir = parent(dir);
        }
    }
}
