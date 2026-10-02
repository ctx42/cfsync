// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The run lock serializing cfsync operations that share one cache home — the
// plugin and a CLI run inside the same vault use the same ADF cache and link
// index, and interleaved writes would corrupt the base every push rests on. Every
// operation, read-only `status` included, holds the lock for its duration. The
// lock file records its holder; a holder whose process is gone is stale and is
// cleared. The cache home is device-local, so a PID check is meaningful.

import type { LockIO } from "../ports/lock.ts";
import { posixJoin } from "../util/path.ts";

/** LOCK_FILE is the run lock's name, under the cache directory. */
export const LOCK_FILE = "cfsync.lock";

/** LockHolder identifies the run holding the lock. */
export interface LockHolder {
    /** The holding process's id. */
    pid: number;
    /** Which host runs the operation. */
    tool: "cli" | "plugin";
    /** The operation, e.g. `pull`. */
    command: string;
    /** When the run started, as an ISO 8601 instant. */
    startedAt: string;
}

/** RunLockError is thrown when another live run holds the lock. */
export class RunLockError extends Error {
    readonly holder: LockHolder;

    constructor(holder: LockHolder) {
        super(`busy: ${describeHolder(holder)} is running`);
        this.name = "RunLockError";
        this.holder = holder;
    }
}

/** lockPath returns the run lock's path under the cache directory. */
export function lockPath(cacheDir: string): string {
    return posixJoin(cacheDir, LOCK_FILE);
}

/** describeHolder names a holder for a message: `cfsync CLI pull, pid 42`. */
export function describeHolder(h: LockHolder): string {
    const tool = h.tool === "cli" ? "CLI" : "plugin";
    return `cfsync ${tool} ${h.command}, pid ${h.pid}`;
}

/**
 * acquireRunLock takes the lock at `path` for `holder` and returns its release
 * function. A lock held by a live process throws {@link RunLockError}; a lock
 * whose holder is dead, or whose content is unreadable, is stale and is replaced.
 * Release removes the file only while it is still this holder's.
 */
export async function acquireRunLock(
    io: LockIO,
    path: string,
    holder: LockHolder,
): Promise<() => Promise<void>> {
    const text = `${JSON.stringify(holder)}\n`;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (await io.create(path, text)) {
            return async () => {
                if ((await io.read(path)) === text) {
                    await io.remove(path);
                }
            };
        }
        const current = await io.read(path);
        const other = parseHolder(current);
        if (other !== null && io.isAlive(other.pid)) {
            throw new RunLockError(other);
        }
        // Stale: clear it unless another run replaced it meanwhile, then retry.
        if ((await io.read(path)) === current) {
            await io.remove(path);
        }
    }
    const other = parseHolder(await io.read(path));
    throw other === null
        ? new Error(`run lock: cannot take ${path}`)
        : new RunLockError(other);
}

/** withRunLock runs `fn` while holding the lock, releasing it however it ends. */
export async function withRunLock<T>(
    io: LockIO,
    path: string,
    holder: LockHolder,
    fn: () => Promise<T>,
): Promise<T> {
    const release = await acquireRunLock(io, path, holder);
    try {
        return await fn();
    } finally {
        await release();
    }
}

/** parseHolder reads lock-file text, or null when it is not a valid holder. */
function parseHolder(text: string): LockHolder | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof raw !== "object" || raw === null) {
        return null;
    }
    const o = raw as Record<string, unknown>;
    if (
        typeof o["pid"] !== "number" ||
        !Number.isInteger(o["pid"]) ||
        (o["tool"] !== "cli" && o["tool"] !== "plugin") ||
        typeof o["command"] !== "string" ||
        typeof o["startedAt"] !== "string"
    ) {
        return null;
    }
    return {
        pid: o["pid"],
        tool: o["tool"],
        command: o["command"],
        startedAt: o["startedAt"],
    };
}
