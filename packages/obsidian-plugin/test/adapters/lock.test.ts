// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeLockIO } from "../../src/adapters/lock.ts";

describe("NodeLockIO", () => {
    let root = "";
    const io = new NodeLockIO();

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "cfsync-lock-"));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("creates only when absent, making parent directories", async () => {
        const path = join(root, "a/b/cfsync.lock");

        expect(await io.create(path, "one")).toBe(true);
        expect(await io.create(path, "two")).toBe(false);
        expect(await io.read(path)).toBe("one");
    });

    it("reads a missing file as empty and removes idempotently", async () => {
        const path = join(root, "cfsync.lock");

        expect(await io.read(path)).toBe("");
        await io.remove(path);
    });

    it("reports this process alive and an unused pid dead", () => {
        expect(io.isAlive(process.pid)).toBe(true);
        expect(io.isAlive(2 ** 22 + 12345)).toBe(false);
    });
});
