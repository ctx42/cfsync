// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The exclusive-create file primitive the run lock needs (see `sync/runlock.ts`),
// plus the process-liveness probe that decides whether a lock is stale. Kept out
// of the FileSystem port because only the lock needs create-if-absent semantics
// and a PID check; the CLI and plugin implement it over `node:fs` + `process`.

/** LockIO is the I/O the run lock is built on. */
export interface LockIO {
    /**
     * create atomically writes `text` to `path` only when no file exists there,
     * creating parent directories; it resolves false when the file exists.
     */
    create(path: string, text: string): Promise<boolean>;
    /** read returns the file's text, or `""` when it does not exist. */
    read(path: string): Promise<string>;
    /** remove deletes the file; a missing file is not an error. */
    remove(path: string): Promise<void>;
    /** isAlive reports whether a process with `pid` runs on this device. */
    isAlive(pid: number): boolean;
}
