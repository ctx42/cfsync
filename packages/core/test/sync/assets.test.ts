// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the download cases of pkg/cfsync/assets_test.go. The client talks
// through the HttpClient port and the download through the FileSystem port, so
// both are stubbed (StubHttpClient + MemFS).

import { describe, expect, it } from "vitest";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import type { MediaRef } from "../../src/models/adf.ts";
import {
    assetName,
    assetsFromDisk,
    downloadImages,
    ensureAsset,
    imageExt,
    relPath,
} from "../../src/sync/assets.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const client = (stub: StubHttpClient): ConfluenceClient =>
    new ConfluenceClient(stub, {
        host: "https://ex.atlassian.net",
        account: "a@ex.com",
        token: "secret",
    });

describe("imageExt", () => {
    it("maps known media types", () => {
        expect(imageExt("image/jpeg", "x")).toBe(".jpg");
        expect(imageExt("image/png", "x")).toBe(".png");
        expect(imageExt("image/svg+xml", "x")).toBe(".svg");
    });
    it("falls back to the title extension", () => {
        expect(imageExt("application/octet-stream", "diagram.drawio")).toBe(
            ".drawio",
        );
        expect(imageExt("weird", "noext")).toBe("");
    });
});

describe("assetName", () => {
    it("builds {fileId}-{localId}{ext}", () => {
        const ref: MediaRef = { localId: "L1", fileId: "F1", alt: "a.png" };
        expect(
            assetName(ref, {
                fileId: "F1",
                title: "a.png",
                mediaType: "image/png",
                downloadLink: "/d",
            }),
        ).toBe("F1-L1.png");
    });
});

describe("relPath", () => {
    it("returns the target relative to the note's directory", () => {
        expect(
            relPath("/vault/notes/page.md", "/vault/_cfsync-media/F1-L1.png"),
        ).toBe("../_cfsync-media/F1-L1.png");
    });
});

describe("ensureAsset", () => {
    it("downloads to the path when absent", async () => {
        const stub = new StubHttpClient().on(
            "GET",
            "https://ex.atlassian.net/wiki/download/x",
            { body: "IMG" },
        );
        const fs = new MemFS();
        await ensureAsset(
            client(stub),
            fs,
            "/download/x",
            "/vault/_cfsync-media/a.png",
        );
        expect(await fs.readText("/vault/_cfsync-media/a.png")).toBe("IMG");
    });

    it("leaves an existing file untouched", async () => {
        const fs = new MemFS();
        await fs.write("/vault/_cfsync-media/a.png", "OLD");
        // No download route registered: a fetch would 404 → throw. It must not fetch.
        await ensureAsset(
            client(new StubHttpClient()),
            fs,
            "/download/x",
            "/vault/_cfsync-media/a.png",
        );
        expect(await fs.readText("/vault/_cfsync-media/a.png")).toBe("OLD");
    });
});

describe("downloadImages", () => {
    const refs: MediaRef[] = [{ localId: "L1", fileId: "F1", alt: "pic.png" }];

    it("resolves, downloads, and maps refs to relative paths", async () => {
        const stub = new StubHttpClient()
            .on(
                "GET",
                "https://ex.atlassian.net/wiki/api/v2/pages/123/attachments",
                {
                    body: JSON.stringify({
                        results: [
                            {
                                fileId: "F1",
                                title: "pic.png",
                                mediaType: "image/png",
                                downloadLink: "/download/x",
                            },
                        ],
                        _links: {},
                    }),
                },
            )
            .on("GET", "https://ex.atlassian.net/wiki/download/x", {
                body: "IMG",
            });
        const fs = new MemFS();

        const assets = await downloadImages(
            client(stub),
            fs,
            "/vault/_cfsync-media",
            "123",
            "/vault/notes/page.md",
            refs,
        );

        expect(assets).toEqual({ L1: "../_cfsync-media/F1-L1.png" });
        expect(await fs.readText("/vault/_cfsync-media/F1-L1.png")).toBe("IMG");
    });

    it("returns an empty map for a page with no media", async () => {
        const assets = await downloadImages(
            client(new StubHttpClient()),
            new MemFS(),
            "/vault/_cfsync-media",
            "123",
            "/vault/notes/page.md",
            [],
        );
        expect(assets).toEqual({});
    });

    it("skips a ref with no matching attachment", async () => {
        const stub = new StubHttpClient().on(
            "GET",
            "https://ex.atlassian.net/wiki/api/v2/pages/123/attachments",
            { body: '{"results":[],"_links":{}}' },
        );
        const assets = await downloadImages(
            client(stub),
            new MemFS(),
            "/vault/_cfsync-media",
            "123",
            "/vault/notes/page.md",
            refs,
        );
        expect(assets).toEqual({});
    });
});

describe("assetsFromDisk", () => {
    const refs: MediaRef[] = [{ localId: "L1", fileId: "F1", alt: "pic.png" }];

    it("reconstructs the assets map from files already on disk", async () => {
        const fs = new MemFS();
        await fs.write("/vault/_cfsync-media/F1-L1.png", "IMG");

        const assets = await assetsFromDisk(
            fs,
            "/vault/_cfsync-media",
            "/vault/notes/page.md",
            refs,
        );

        expect(assets).toEqual({ L1: "../_cfsync-media/F1-L1.png" });
    });

    it("matches an extension-less asset by its bare prefix", async () => {
        const fs = new MemFS();
        await fs.write("/vault/_cfsync-media/F1-L1", "IMG");

        const assets = await assetsFromDisk(
            fs,
            "/vault/_cfsync-media",
            "/vault/notes/page.md",
            refs,
        );

        expect(assets).toEqual({ L1: "../_cfsync-media/F1-L1" });
    });

    it("returns an empty map when there are no refs", async () => {
        expect(
            await assetsFromDisk(
                new MemFS(),
                "/vault/_cfsync-media",
                "/vault/notes/page.md",
                [],
            ),
        ).toEqual({});
    });

    it("returns null when a referenced image is missing on disk", async () => {
        const fs = new MemFS();
        await fs.mkdirp("/vault/_cfsync-media"); // dir exists but is empty

        const assets = await assetsFromDisk(
            fs,
            "/vault/_cfsync-media",
            "/vault/notes/page.md",
            refs,
        );

        expect(assets).toBeNull();
    });

    it("returns null when the assets dir does not exist yet", async () => {
        const assets = await assetsFromDisk(
            new MemFS(),
            "/vault/_cfsync-media",
            "/vault/notes/page.md",
            refs,
        );

        expect(assets).toBeNull();
    });

    it("does not confuse a sibling with a longer localId prefix", async () => {
        const fs = new MemFS();
        // F1-L10.png must not satisfy the ref for F1-L1.
        await fs.write("/vault/_cfsync-media/F1-L10.png", "OTHER");

        const assets = await assetsFromDisk(
            fs,
            "/vault/_cfsync-media",
            "/vault/notes/page.md",
            refs,
        );

        expect(assets).toBeNull();
    });
});
