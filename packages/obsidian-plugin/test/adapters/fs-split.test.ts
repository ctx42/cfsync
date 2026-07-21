// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { FileStat, FileSystem } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { SplitFileSystem } from "../../src/adapters/fs-split.ts";

/** TagFs is a fake FileSystem that records every path it is handed. */
class TagFs implements FileSystem {
    seen: string[] = [];
    constructor(readonly label: string) {}
    async read(p: string) {
        this.seen.push(p);
        return new TextEncoder().encode(this.label);
    }
    async readText(p: string) {
        this.seen.push(p);
        return this.label;
    }
    async write(p: string) {
        this.seen.push(p);
    }
    async exists(p: string) {
        this.seen.push(p);
        return true;
    }
    async mkdirp(p: string) {
        this.seen.push(p);
    }
    async readdir(p: string) {
        this.seen.push(p);
        return [this.label];
    }
    async remove(p: string) {
        this.seen.push(p);
    }
    async stat(p: string): Promise<FileStat> {
        this.seen.push(p);
        return { isDirectory: false, size: 0 };
    }
}

const ROOT = "/home/u/.cache/cfsync/vault-abc";

function split() {
    const vault = new TagFs("vault");
    const node = new TagFs("node");
    return { vault, node, fs: new SplitFileSystem(vault, node, ROOT) };
}

describe("SplitFileSystem", () => {
    it("routes paths under the cache root to the node fs", async () => {
        const { vault, node, fs } = split();
        await fs.write(`${ROOT}/test/page.v1.json`, "x");
        expect(node.seen).toEqual([`${ROOT}/test/page.v1.json`]);
        expect(vault.seen).toEqual([]);
    });

    it("routes vault-relative paths to the vault fs", async () => {
        const { vault, node, fs } = split();
        await fs.write("Notes/page.md", "x");
        expect(vault.seen).toEqual(["Notes/page.md"]);
        expect(node.seen).toEqual([]);
    });

    it("routes the cache root itself to the node fs", async () => {
        const { vault, node, fs } = split();
        await fs.mkdirp(ROOT);
        expect(node.seen).toEqual([ROOT]);
        expect(vault.seen).toEqual([]);
    });

    it("does not route a sibling that merely shares the root's prefix", async () => {
        const { vault, node, fs } = split();
        await fs.write(`${ROOT}-other/f.json`, "x");
        expect(vault.seen).toEqual([`${ROOT}-other/f.json`]);
        expect(node.seen).toEqual([]);
    });

    it("delegates every operation and returns the chosen fs's result", async () => {
        const { fs } = split();
        expect(await fs.readText(`${ROOT}/links.json`)).toBe("node");
        expect(await fs.readText("Notes/a.md")).toBe("vault");
        expect(new TextDecoder().decode(await fs.read(`${ROOT}/x`))).toBe(
            "node",
        );
        expect(await fs.exists(`${ROOT}/x`)).toBe(true);
        expect(await fs.readdir(`${ROOT}`)).toEqual(["node"]);
        await fs.remove(`${ROOT}/x`);
        expect((await fs.stat(`${ROOT}/x`)).isDirectory).toBe(false);
    });
});
