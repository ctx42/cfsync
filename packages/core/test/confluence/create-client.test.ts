// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the create-execution client cases of pkg/cfsync/create_test.go
// (Test_createPage/restrictToAuthor/deletePage/createFolder/deleteFolder) and the
// folder-lookup fallback. The client talks through the HttpClient port, so it is
// driven with the sequential QueueHttpClient, mirroring Go's httpkit test server.

import { describe, expect, it } from "vitest";
import {
    ConfluenceClient,
    FolderTitleTakenError,
} from "../../src/confluence/client.ts";
import { QueueHttpClient } from "../support/http-queue.ts";

const H = "https://ex.atlassian.net";
const client = (q: QueueHttpClient): ConfluenceClient =>
    new ConfluenceClient(q, { host: H, account: "a@ex.com", token: "secret" });

describe("ConfluenceClient.createPage", () => {
    it("posts the page and returns its id and version", async () => {
        const q = new QueueHttpClient().rsp(
            200,
            '{"id":"555","version":{"number":1}}',
        );
        const res = await client(q).createPage({
            spaceId: "9",
            title: "New Page",
            parentId: "77",
            docJSON: '{"type":"doc"}',
        });
        expect(res).toEqual({ id: "555", version: 1 });

        const req = q.requests[0];
        expect(req?.method).toBe("POST");
        expect(req?.url).toBe(`${H}/wiki/api/v2/pages`);
        const body = q.bodyOf(0);
        expect(body).toContain('"spaceId":"9"');
        expect(body).toContain('"title":"New Page"');
        expect(body).toContain('"parentId":"77"');
        expect(body).toContain('"representation":"atlas_doc_format"');
    });

    it("omits parentId for a space root and defaults a zero version to 1", async () => {
        const q = new QueueHttpClient().rsp(200, '{"id":"555"}');
        const res = await client(q).createPage({
            spaceId: "9",
            title: "Root",
            parentId: "",
            docJSON: "{}",
        });
        expect(res.version).toBe(1);
        expect(q.bodyOf(0)).not.toContain("parentId");
    });

    it("errors on a non-2xx status", async () => {
        const q = new QueueHttpClient().rsp(400);
        await expect(
            client(q).createPage({
                spaceId: "9",
                title: "New Page",
                parentId: "",
                docJSON: "{}",
            }),
        ).rejects.toThrow('create page "New Page": HTTP 400');
    });

    it("errors when the response has no id", async () => {
        const q = new QueueHttpClient().rsp(200, "{}");
        await expect(
            client(q).createPage({
                spaceId: "9",
                title: "New Page",
                parentId: "",
                docJSON: "{}",
            }),
        ).rejects.toThrow("response has no id");
    });
});

describe("ConfluenceClient.restrictToAuthor", () => {
    it("puts read and update restrictions for the author", async () => {
        const q = new QueueHttpClient().rsp(200, "{}");
        await client(q).restrictToAuthor("555", "acc-1");

        const req = q.requests[0];
        expect(req?.method).toBe("PUT");
        expect(req?.url).toBe(`${H}/wiki/rest/api/content/555/restriction`);
        const body = q.bodyOf(0);
        expect(body).toContain('"operation":"read"');
        expect(body).toContain('"operation":"update"');
        expect(body).toContain('"accountId":"acc-1"');
    });

    it("errors on a non-2xx status", async () => {
        const q = new QueueHttpClient().rsp(403);
        await expect(
            client(q).restrictToAuthor("555", "acc-1"),
        ).rejects.toThrow("restrict page 555: HTTP 403");
    });
});

describe("ConfluenceClient.deletePage", () => {
    it("deletes the page by id", async () => {
        const q = new QueueHttpClient().rsp(204);
        await client(q).deletePage("555");
        expect(q.requests[0]?.method).toBe("DELETE");
        expect(q.requests[0]?.url).toBe(`${H}/wiki/api/v2/pages/555`);
    });

    it("errors on a non-2xx status", async () => {
        const q = new QueueHttpClient().rsp(500);
        await expect(client(q).deletePage("555")).rejects.toThrow(
            "delete page 555: HTTP 500",
        );
    });
});

describe("ConfluenceClient.createFolder", () => {
    it("posts the folder and returns its id", async () => {
        const q = new QueueHttpClient().rsp(200, '{"id":"F1"}');
        const id = await client(q).createFolder("9", "100", "Alpha");
        expect(id).toBe("F1");

        const req = q.requests[0];
        expect(req?.method).toBe("POST");
        expect(req?.url).toBe(`${H}/wiki/api/v2/folders`);
        const body = q.bodyOf(0);
        expect(body).toContain('"spaceId":"9"');
        expect(body).toContain('"parentId":"100"');
        expect(body).toContain('"title":"Alpha"');
    });

    it("errors on a non-2xx status", async () => {
        const q = new QueueHttpClient().rsp(400);
        await expect(
            client(q).createFolder("9", "100", "Alpha"),
        ).rejects.toThrow('create folder "Alpha": HTTP 400');
    });

    it("errors when the response has no id", async () => {
        const q = new QueueHttpClient().rsp(200, "{}");
        await expect(
            client(q).createFolder("9", "100", "Alpha"),
        ).rejects.toThrow("response has no id");
    });

    it("throws FolderTitleTakenError for a duplicate title", async () => {
        const q = new QueueHttpClient().rsp(
            400,
            '{"errors":[{"title":"A folder exists with the same title in this space"}]}',
        );
        await expect(
            client(q).createFolder("9", "100", "Alpha"),
        ).rejects.toBeInstanceOf(FolderTitleTakenError);
    });
});

describe("ConfluenceClient.deleteFolder", () => {
    it("deletes the folder by id", async () => {
        const q = new QueueHttpClient().rsp(204);
        await client(q).deleteFolder("F1");
        expect(q.requests[0]?.method).toBe("DELETE");
        expect(q.requests[0]?.url).toBe(`${H}/wiki/api/v2/folders/F1`);
    });

    it("tolerates an already-missing folder", async () => {
        const q = new QueueHttpClient().rsp(404);
        await expect(client(q).deleteFolder("F1")).resolves.toBeUndefined();
    });

    it("errors on a non-2xx status", async () => {
        const q = new QueueHttpClient().rsp(500);
        await expect(client(q).deleteFolder("F1")).rejects.toThrow(
            "delete folder F1: HTTP 500",
        );
    });
});

describe("ConfluenceClient.childFolderTitled", () => {
    const found =
        '{"results":[{"id":"FX","type":"folder","title":"Alpha","status":"current"}],"_links":{}}';

    it("finds a matching folder under the folder endpoint", async () => {
        const q = new QueueHttpClient().rsp(200, found);
        expect(await client(q).childFolderTitled("100", "Alpha")).toBe("FX");
        expect(q.requests[0]?.url).toBe(
            `${H}/wiki/api/v2/folders/100/direct-children`,
        );
    });

    it("falls back to the page endpoint when the parent is a page", async () => {
        const q = new QueueHttpClient().rsp(404).rsp(200, found);
        expect(await client(q).childFolderTitled("100", "Alpha")).toBe("FX");
        expect(q.requests[1]?.url).toBe(
            `${H}/wiki/api/v2/pages/100/direct-children`,
        );
    });

    it("returns empty when no folder matches", async () => {
        const q = new QueueHttpClient()
            .rsp(200, '{"results":[],"_links":{}}')
            .rsp(200, '{"results":[],"_links":{}}');
        expect(await client(q).childFolderTitled("100", "Alpha")).toBe("");
    });
});
