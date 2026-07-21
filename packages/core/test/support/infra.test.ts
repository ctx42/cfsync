// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Exercises the M1.5 test infrastructure: the in-memory FileSystem, the stub
// HttpClient, and the Links helpers. These back the sync tests that arrive from
// M6 onward, so they must behave before those depend on them.

import { describe, expect, it } from "vitest";
import { type Links, localLink, remoteLink } from "../../src/adf/links.ts";
import { responseText } from "../../src/ports/http.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

describe("MemFS", () => {
    it("round-trips a text file and creates parent dirs", async () => {
        const fs = new MemFS();
        await fs.write("notes/page.md", "hello");

        expect(await fs.readText("notes/page.md")).toBe("hello");
        expect(await fs.exists("notes/page.md")).toBe(true);
        expect(await fs.exists("notes")).toBe(true);
        expect((await fs.stat("notes")).isDirectory).toBe(true);
        expect((await fs.stat("notes/page.md")).size).toBe(5);
    });

    it("lists immediate children and removes a subtree", async () => {
        const fs = new MemFS();
        await fs.write("space/a.md", "a");
        await fs.write("space/sub/b.md", "b");

        expect(await fs.readdir("space")).toEqual(["a.md", "sub"]);

        await fs.remove("space/sub");
        expect(await fs.exists("space/sub/b.md")).toBe(false);
        expect(await fs.readdir("space")).toEqual(["a.md"]);
    });

    it("rejects reading a missing file", async () => {
        const fs = new MemFS();
        await expect(fs.read("nope.md")).rejects.toThrow("no such file");
    });
});

describe("StubHttpClient", () => {
    it("replays a registered response and records the request", async () => {
        const http = new StubHttpClient().on("GET", "https://ex/api", {
            status: 200,
            body: '{"ok":true}',
        });

        const resp = await http.do({ method: "GET", url: "https://ex/api" });

        expect(resp.status).toBe(200);
        expect(responseText(resp)).toBe('{"ok":true}');
        expect(http.requests).toHaveLength(1);
    });

    it("returns 404 for an unregistered route", async () => {
        const http = new StubHttpClient();
        const resp = await http.do({ method: "GET", url: "https://ex/none" });
        expect(resp.status).toBe(404);
    });
});

describe("Links helpers", () => {
    const links: Links = {
        toLocal: (href) =>
            href === "https://ex/p/1"
                ? { target: "folder/Note.md", label: "Note" }
                : undefined,
        toRemote: (target) =>
            target === "folder/Note.md" ? "https://ex/p/1" : undefined,
    };

    it("map each way and round-trip", () => {
        expect(localLink(links, "https://ex/p/1")).toBe("folder/Note.md");
        expect(remoteLink(links, "folder/Note.md")).toBe("https://ex/p/1");
    });

    it("leave unmapped links and a null Links untouched", () => {
        expect(localLink(links, "https://ex/other")).toBe("https://ex/other");
        expect(localLink(null, "https://ex/p/1")).toBe("https://ex/p/1");
        expect(remoteLink(null, "folder/Note.md")).toBe("folder/Note.md");
    });
});
