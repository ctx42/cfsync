// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/fs-node.ts";

describe("NodeFileSystem", () => {
    let root = "";
    const fs = new NodeFileSystem();
    const at = (p: string) => join(root, p);

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "cfsync-node-"));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("writes then reads text and bytes, creating parent directories", async () => {
        await fs.write(at("a/b/c.json"), "hi");
        expect(await fs.readText(at("a/b/c.json"))).toBe("hi");
        expect(new TextDecoder().decode(await fs.read(at("a/b/c.json")))).toBe(
            "hi",
        );
    });

    it("writes a byte-offset view and reads back only its bytes", async () => {
        const view = new Uint8Array([0, 0, 7, 8, 9]).subarray(2, 5);
        await fs.write(at("bytes.bin"), view);
        expect([...(await fs.read(at("bytes.bin")))]).toEqual([7, 8, 9]);
    });

    it("reports existence", async () => {
        expect(await fs.exists(at("nope"))).toBe(false);
        await fs.write(at("yes.txt"), "1");
        expect(await fs.exists(at("yes.txt"))).toBe(true);
    });

    it("mkdirp is idempotent and readdir lists base names", async () => {
        await fs.mkdirp(at("d/sub"));
        await fs.mkdirp(at("d/sub"));
        await fs.write(at("d/x.json"), "1");
        expect((await fs.readdir(at("d"))).sort()).toEqual(["sub", "x.json"]);
    });

    it("removes a file and a directory recursively", async () => {
        await fs.write(at("gone.txt"), "x");
        await fs.remove(at("gone.txt"));
        expect(await fs.exists(at("gone.txt"))).toBe(false);

        await fs.write(at("tree/sub/f.json"), "1");
        await fs.remove(at("tree"));
        expect(await fs.exists(at("tree"))).toBe(false);
    });

    it("stats files and directories and rejects a missing path", async () => {
        await fs.write(at("f.json"), "zzz");
        const file = await fs.stat(at("f.json"));
        expect(file.isDirectory).toBe(false);
        expect(file.size).toBe(3);

        await fs.mkdirp(at("dd"));
        const dir = await fs.stat(at("dd"));
        expect(dir.isDirectory).toBe(true);
        expect(dir.size).toBe(0);

        await expect(fs.stat(at("missing"))).rejects.toThrow();
    });
});
