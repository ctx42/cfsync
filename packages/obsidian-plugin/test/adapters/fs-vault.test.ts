// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    type VaultAdapter,
    VaultFileSystem,
} from "../../src/adapters/fs-vault.ts";

/** FakeAdapter is an in-memory {@link VaultAdapter} for the tests. */
class FakeAdapter implements VaultAdapter {
    files = new Map<string, string>();
    dirs = new Set<string>();
    async read(p: string) {
        const v = this.files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
    }
    async readBinary(p: string) {
        return new TextEncoder().encode(await this.read(p))
            .buffer as ArrayBuffer;
    }
    async write(p: string, d: string) {
        this.files.set(p, d);
    }
    async writeBinary(p: string, d: ArrayBuffer) {
        this.files.set(p, new TextDecoder().decode(new Uint8Array(d)));
    }
    async exists(p: string) {
        return this.files.has(p) || this.dirs.has(p);
    }
    async mkdir(p: string) {
        this.dirs.add(p);
    }
    async list(p: string) {
        const files = [...this.files.keys()].filter((k) => parent(k) === p);
        const folders = [...this.dirs].filter((k) => parent(k) === p);
        return { files, folders };
    }
    async remove(p: string) {
        this.files.delete(p);
    }
    async rmdir(p: string) {
        this.dirs.delete(p);
        for (const k of [...this.files.keys()])
            if (k.startsWith(`${p}/`)) this.files.delete(k);
    }
    async stat(p: string) {
        if (this.files.has(p))
            return {
                type: "file" as const,
                size: (this.files.get(p) ?? "").length,
            };
        if (this.dirs.has(p)) return { type: "folder" as const, size: 0 };
        return null;
    }
}
function parent(p: string): string {
    const at = p.lastIndexOf("/");
    return at < 0 ? "" : p.slice(0, at);
}

describe("VaultFileSystem", () => {
    it("writes then reads text and bytes", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        await fs.write("dir/a.md", "hi");
        expect(await fs.readText("dir/a.md")).toBe("hi");
        expect(new TextDecoder().decode(await fs.read("dir/a.md"))).toBe("hi");
    });

    it("mkdirp then readdir returns base names", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        await fs.mkdirp("root/sub");
        await fs.write("root/x.md", "1");
        expect((await fs.readdir("root")).sort()).toEqual(["sub", "x.md"]);
    });

    it("stat reports directory-ness and rejects a missing path", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        await fs.write("f.md", "z");
        expect((await fs.stat("f.md")).isDirectory).toBe(false);
        await expect(fs.stat("nope")).rejects.toThrow();
    });

    it("normalizes a leading ./ to the vault path", async () => {
        const adapter = new FakeAdapter();
        const fs = new VaultFileSystem(adapter);
        await fs.write("./a.md", "v");
        expect(adapter.files.has("a.md")).toBe(true);
    });

    it("writes a byte-offset view and reads back only its bytes", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        const view = new Uint8Array([0, 0, 7, 8, 9]).subarray(2, 5);
        await fs.write("bytes.bin", view);
        expect([...(await fs.read("bytes.bin"))]).toEqual([7, 8, 9]);
    });

    it("write builds the full ancestor chain against a non-recursive mkdir", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        await fs.write("a/b/c/x.md", "v");
        expect(await fs.readText("a/b/c/x.md")).toBe("v");
        expect(await fs.exists("a")).toBe(true);
        expect(await fs.exists("a/b")).toBe(true);
    });

    it("removes a file", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        await fs.write("gone.md", "x");
        await fs.remove("gone.md");
        expect(await fs.exists("gone.md")).toBe(false);
    });

    it("removes a folder recursively", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        await fs.mkdirp("d/sub");
        await fs.write("d/sub/f.md", "1");
        await fs.remove("d");
        expect(await fs.exists("d/sub/f.md")).toBe(false);
    });

    it("mkdirp is idempotent", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        await fs.mkdirp("root/sub");
        await expect(fs.mkdirp("root/sub")).resolves.not.toThrow();
    });

    it("stat reports a directory with size 0", async () => {
        const fs = new VaultFileSystem(new FakeAdapter());
        await fs.mkdirp("dd");
        const st = await fs.stat("dd");
        expect(st.isDirectory).toBe(true);
        expect(st.size).toBe(0);
    });
});
