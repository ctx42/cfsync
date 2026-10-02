// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// An in-memory LockIO for run-lock tests: a path→text map plus a settable set of
// live PIDs.

import type { LockIO } from "../../src/ports/lock.ts";

/** MemLock is an in-memory {@link LockIO}. */
export class MemLock implements LockIO {
    readonly files = new Map<string, string>();
    readonly alive = new Set<number>();

    async create(path: string, text: string): Promise<boolean> {
        if (this.files.has(path)) {
            return false;
        }
        this.files.set(path, text);
        return true;
    }

    async read(path: string): Promise<string> {
        return this.files.get(path) ?? "";
    }

    async remove(path: string): Promise<void> {
        this.files.delete(path);
    }

    isAlive(pid: number): boolean {
        return this.alive.has(pid);
    }
}
