// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFS } from "../../src/adapters/fs.ts";

describe("NodeFS", () => {
    let dir: string;
    const fs = new NodeFS();

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "cfsync-fs-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("writes through missing parents and reads back text and bytes", async () => {
        const path = join(dir, "a/b/c.md");
        await fs.write(path, "hello");
        expect(await fs.readText(path)).toBe("hello");
        expect(new TextDecoder().decode(await fs.read(path))).toBe("hello");
    });

    it("reports existence, lists a directory, and stats entries", async () => {
        await fs.write(join(dir, "sub/one.md"), "1");
        await fs.write(join(dir, "sub/two.md"), "2");
        expect(await fs.exists(join(dir, "sub/one.md"))).toBe(true);
        expect(await fs.exists(join(dir, "sub/missing.md"))).toBe(false);
        expect((await fs.readdir(join(dir, "sub"))).sort()).toEqual([
            "one.md",
            "two.md",
        ]);
        expect((await fs.stat(join(dir, "sub"))).isDirectory).toBe(true);
        expect((await fs.stat(join(dir, "sub/one.md"))).isDirectory).toBe(
            false,
        );
    });

    it("removes a directory tree and tolerates removing a missing path", async () => {
        await fs.write(join(dir, "tree/x.md"), "x");
        await fs.remove(join(dir, "tree"));
        expect(await fs.exists(join(dir, "tree"))).toBe(false);
        await expect(fs.remove(join(dir, "gone"))).resolves.toBeUndefined();
    });

    it("rejects reading a missing file", async () => {
        await expect(fs.readText(join(dir, "nope.md"))).rejects.toThrow();
    });
});
