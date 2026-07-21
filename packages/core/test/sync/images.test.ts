// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the upload cases of pkg/cfsync/images_test.go and the
// canonical-name helper. The multipart upload goes through the HttpClient port.

import { describe, expect, it } from "vitest";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { canonicalAssetName, uploadNewImages } from "../../src/sync/images.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const client = (stub: StubHttpClient): ConfluenceClient =>
    new ConfluenceClient(stub, {
        host: "https://ex.atlassian.net",
        account: "a@ex.com",
        token: "secret",
    });

describe("client.uploadAttachment", () => {
    const url =
        "https://ex.atlassian.net/wiki/rest/api/content/123/child/attachment";

    it("POSTs multipart and returns the fileId and content id", async () => {
        const stub = new StubHttpClient().on("POST", url, {
            body: JSON.stringify({
                results: [{ id: "C1", extensions: { fileId: "F1" } }],
            }),
        });

        const res = await client(stub).uploadAttachment(
            "123",
            "pic.png",
            new TextEncoder().encode("IMG"),
        );

        expect(res).toEqual({ fileId: "F1", contentId: "C1" });
        const req = stub.requests[0];
        expect(req?.method).toBe("POST");
        expect(req?.headers?.["Content-Type"]).toContain("multipart/form-data");
        expect(req?.headers?.["X-Atlassian-Token"]).toBe("no-check");
        // The multipart body carries the filename and the bytes.
        const sent = new TextDecoder().decode(req?.body as Uint8Array);
        expect(sent).toContain('filename="pic.png"');
        expect(sent).toContain("IMG");
    });

    it("rejects a response with no fileId", async () => {
        const stub = new StubHttpClient().on("POST", url, {
            body: '{"results":[]}',
        });
        await expect(
            client(stub).uploadAttachment("123", "pic.png", new Uint8Array()),
        ).rejects.toThrow("carried no fileId");
    });
});

describe("uploadNewImages: tracked-image matching", () => {
    const uploadURL =
        "https://ex.atlassian.net/wiki/rest/api/content/123/child/attachment";

    it("does not re-upload a path-qualified embed of an already-tracked image", async () => {
        const fs = new MemFS();
        // The user embeds the pulled image via a path-qualified target; the file
        // exists on disk, so only the base-name match keeps it from re-uploading.
        await fs.write("/vault/notes/sub/photo.png", "IMG");
        const assets = { L1: "../_cfsync-media/photo.png" };
        const body = "intro\n\n![[sub/photo.png]]\n";
        // No upload route registered: a wrongful upload would 404 and throw.
        const stub = new StubHttpClient();

        const res = await uploadNewImages(
            client(stub),
            fs,
            "123",
            "/vault/notes/page.md",
            body,
            assets,
            () => "L2",
        );

        expect(res.images).toEqual([]);
        expect(res.uploaded).toEqual([]);
        expect(stub.requests).toHaveLength(0);
    });

    it("still uploads a path-qualified image whose base name is untracked", async () => {
        const fs = new MemFS();
        await fs.write("/vault/notes/sub/fresh.png", "IMG");
        const assets: Record<string, string> = {
            L1: "../_cfsync-media/photo.png",
        };
        const body = "![[sub/fresh.png]]\n";
        const stub = new StubHttpClient().on("POST", uploadURL, {
            body: JSON.stringify({
                results: [{ id: "C1", extensions: { fileId: "F1" } }],
            }),
        });

        const res = await uploadNewImages(
            client(stub),
            fs,
            "123",
            "/vault/notes/page.md",
            body,
            assets,
            () => "L2",
        );

        expect(res.images).toHaveLength(1);
        expect(res.images[0]?.path).toBe("sub/fresh.png");
        expect(assets["L2"]).toBe("sub/fresh.png");
    });
});

describe("canonicalAssetName", () => {
    it("names as a pull would, normalizing the extension", () => {
        expect(canonicalAssetName("F1", "L1", "pics/photo.jpeg")).toBe(
            "F1-L1.jpg",
        );
        expect(canonicalAssetName("F1", "L1", "diagram.png")).toBe("F1-L1.png");
        expect(canonicalAssetName("F1", "L1", "sketch.drawio")).toBe(
            "F1-L1.drawio",
        );
    });
});
