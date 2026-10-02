// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    acquireRunLock,
    describeHolder,
    type LockHolder,
    lockPath,
    RunLockError,
    withRunLock,
} from "../../src/sync/runlock.ts";
import { MemLock } from "../support/memlock.ts";

const PATH = lockPath("/cache");

function holder(pid: number, command = "pull"): LockHolder {
    return { pid, tool: "cli", command, startedAt: "2026-10-02T10:00:00Z" };
}

describe("run lock", () => {
    it("lives under the cache directory", () => {
        expect(PATH).toBe("/cache/cfsync.lock");
    });

    it("describes its holder", () => {
        expect(describeHolder(holder(42))).toBe("cfsync CLI pull, pid 42");
        expect(describeHolder({ ...holder(7), tool: "plugin" })).toBe(
            "cfsync plugin pull, pid 7",
        );
    });

    it("takes a free lock and releases it", async () => {
        const io = new MemLock();

        const release = await acquireRunLock(io, PATH, holder(1));

        expect(JSON.parse(io.files.get(PATH) ?? "")).toEqual(holder(1));
        await release();
        expect(io.files.has(PATH)).toBe(false);
    });

    it("refuses a lock held by a live process, naming it", async () => {
        const io = new MemLock();
        io.alive.add(1);
        await acquireRunLock(io, PATH, holder(1, "push"));

        const have = acquireRunLock(io, PATH, holder(2));

        await expect(have).rejects.toThrow(
            "busy: cfsync CLI push, pid 1 is running",
        );
        await expect(have).rejects.toBeInstanceOf(RunLockError);
    });

    it("replaces a lock whose holder is dead", async () => {
        const io = new MemLock();
        await acquireRunLock(io, PATH, holder(1));

        await acquireRunLock(io, PATH, holder(2));

        expect(JSON.parse(io.files.get(PATH) ?? "").pid).toBe(2);
    });

    it("replaces an unreadable lock", async () => {
        const io = new MemLock();
        io.files.set(PATH, "garbage");

        await acquireRunLock(io, PATH, holder(2));

        expect(JSON.parse(io.files.get(PATH) ?? "").pid).toBe(2);
    });

    it("does not release a lock another run took over", async () => {
        const io = new MemLock();
        const release = await acquireRunLock(io, PATH, holder(1));
        io.files.set(PATH, JSON.stringify(holder(2)));

        await release();

        expect(io.files.has(PATH)).toBe(true);
    });

    it("holds the lock for the duration of a run, even one that throws", async () => {
        const io = new MemLock();

        const have = withRunLock(io, PATH, holder(1), async () => {
            expect(io.files.has(PATH)).toBe(true);
            throw new Error("boom");
        });

        await expect(have).rejects.toThrow("boom");
        expect(io.files.has(PATH)).toBe(false);
    });
});
