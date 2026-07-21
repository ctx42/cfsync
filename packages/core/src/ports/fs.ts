// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The filesystem port. The core reads and writes notes, caches, and assets only
// through this interface — never `node:fs` — so the CLI can back it with the
// real filesystem and the plugin with Obsidian's Vault API. It is asynchronous
// because the Vault API is: the lowest common denominator of both adapters.
//
// The in-memory implementation used by tests, and the interface's consumers,
// land in later milestones; this milestone fixes the contract.

/** Metadata about a filesystem entry. */
export interface FileStat {
    /** Whether the entry is a directory. */
    readonly isDirectory: boolean;
    /** The entry's size in bytes (0 for directories). */
    readonly size: number;
}

/** Asynchronous read/write access to a hierarchical filesystem. */
export interface FileSystem {
    /** Read `path` as raw bytes. Rejects when it does not exist. */
    read(path: string): Promise<Uint8Array>;

    /** Read `path` as UTF-8 text. Rejects when it does not exist. */
    readText(path: string): Promise<string>;

    /** Write `data` to `path`, creating parent directories as needed. */
    write(path: string, data: Uint8Array | string): Promise<void>;

    /** Report whether `path` exists. */
    exists(path: string): Promise<boolean>;

    /** Create the directory at `path` and any missing parents. */
    mkdirp(path: string): Promise<void>;

    /** List the entry names directly under directory `path`. */
    readdir(path: string): Promise<string[]>;

    /** Remove the file or directory at `path`; a directory is removed with its contents. */
    remove(path: string): Promise<void>;

    /** Stat `path`. Rejects when it does not exist. */
    stat(path: string): Promise<FileStat>;
}
