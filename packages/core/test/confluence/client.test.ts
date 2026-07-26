// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the fetch-level cases of pkg/cfsync's connection/pull/spaces/
// folders/assets tests. The core client talks through the HttpClient port, so it
// is unit-tested with the in-memory StubHttpClient (canned responses keyed by
// method+URL); the shared MSW fake Confluence lands with the first fetch/
// requestUrl adapter (M8.1/M10.2). Transport-error wrapping and per-request
// timeout are M9.1, so only the status/parse cases port here.

import { describe, expect, it } from "vitest";
import {
    basicAuth,
    CHILDREN_PATH,
    ConfluenceClient,
    type ConfluenceClientConfig,
    FOLDER_ENDPOINT,
} from "../../src/confluence/client.ts";
import { StubHttpClient } from "../support/http-stub.ts";

const cfg: ConfluenceClientConfig = {
    host: "https://ex.atlassian.net",
    account: "a@ex.com",
    token: "secret",
};

const clientWith = (stub: StubHttpClient): ConfluenceClient =>
    new ConfluenceClient(stub, cfg);

describe("currentAccountID", () => {
    it("sends an authenticated GET to the user endpoint", async () => {
        const stub = new StubHttpClient().on(
            "GET",
            "https://ex.atlassian.net/wiki/rest/api/user/current",
            { body: '{"accountId":"acc-1"}' },
        );

        const account = await clientWith(stub).currentAccountID();

        expect(account).toBe("acc-1");
        const req = stub.requests[0];
        expect(req?.method).toBe("GET");
        expect(req?.url).toBe(
            "https://ex.atlassian.net/wiki/rest/api/user/current",
        );
        expect(req?.headers?.["Authorization"]).toBe(
            basicAuth("a@ex.com", "secret"),
        );
    });

    it("accepts a 2xx status other than 200", async () => {
        const stub = new StubHttpClient().on(
            "GET",
            "https://ex.atlassian.net/wiki/rest/api/user/current",
            { status: 201, body: '{"accountId":"acc-1"}' },
        );
        await expect(clientWith(stub).currentAccountID()).resolves.toBe(
            "acc-1",
        );
    });

    const rejects: Array<{
        name: string;
        status: number;
        body: string;
        want: string;
    }> = [
        {
            name: "unauthorized",
            status: 401,
            body: "",
            want: "authentication rejected",
        },
        {
            name: "forbidden",
            status: 403,
            body: "",
            want: "authentication rejected",
        },
        { name: "server error", status: 500, body: "", want: "connecting to" },
        {
            name: "missing account id",
            status: 200,
            body: "{}",
            want: "no accountId",
        },
        {
            name: "invalid response",
            status: 200,
            body: "not json",
            want: "invalid response",
        },
    ];
    for (const tc of rejects) {
        it(`rejects ${tc.name}`, async () => {
            const stub = new StubHttpClient().on(
                "GET",
                "https://ex.atlassian.net/wiki/rest/api/user/current",
                { status: tc.status, body: tc.body },
            );
            await expect(clientWith(stub).currentAccountID()).rejects.toThrow(
                tc.want,
            );
        });
    }
});

describe("fetchPage", () => {
    const pageURL =
        "https://ex.atlassian.net/wiki/api/v2/pages/123?body-format=atlas_doc_format";

    it("fetches and parses a page in atlas_doc_format", async () => {
        const stub = new StubHttpClient().on("GET", pageURL, {
            body: JSON.stringify({
                id: "123",
                title: "My Page",
                spaceId: "9",
                parentId: "7",
                version: { number: 3 },
                body: {
                    atlas_doc_format: {
                        value: '{"type":"doc","content":[]}',
                    },
                },
            }),
        });

        const page = await clientWith(stub).fetchPage("123");

        expect(page).toEqual({
            id: "123",
            title: "My Page",
            version: 3,
            spaceId: "9",
            parentId: "7",
            adf: '{"type":"doc","content":[]}',
        });
        expect(stub.requests[0]?.headers?.["Authorization"]).toBe(
            basicAuth("a@ex.com", "secret"),
        );
    });

    it("rejects a non-2xx status", async () => {
        const stub = new StubHttpClient().on("GET", pageURL, { status: 404 });
        await expect(clientWith(stub).fetchPage("123")).rejects.toThrow(
            "page 123: HTTP 404",
        );
    });

    it("rejects an unparseable ADF body", async () => {
        const stub = new StubHttpClient().on("GET", pageURL, {
            body: JSON.stringify({
                id: "123",
                body: { atlas_doc_format: { value: "not json{" } },
            }),
        });
        await expect(clientWith(stub).fetchPage("123")).rejects.toThrow(
            "invalid ADF body",
        );
    });
});

describe("fetchPageVersions", () => {
    it("bulk-fetches versions keyed by id in one request", async () => {
        const url =
            "https://ex.atlassian.net/wiki/api/v2/pages?id=101&id=102&limit=250";
        const stub = new StubHttpClient().on("GET", url, {
            body: JSON.stringify({
                results: [
                    { id: "101", version: { number: 5 } },
                    { id: "102", version: { number: 7 } },
                ],
                _links: {},
            }),
        });

        const got = await clientWith(stub).fetchPageVersions(["101", "102"]);

        expect(got).toEqual(
            new Map([
                ["101", 5],
                ["102", 7],
            ]),
        );
        expect(stub.requests.length).toBe(1);
        expect(stub.requests[0]?.headers?.["Authorization"]).toBe(
            basicAuth("a@ex.com", "secret"),
        );
    });

    it("returns an empty map for no ids without a request", async () => {
        const stub = new StubHttpClient();
        await expect(clientWith(stub).fetchPageVersions([])).resolves.toEqual(
            new Map(),
        );
        expect(stub.requests.length).toBe(0);
    });

    it("omits an id absent from the response", async () => {
        const url =
            "https://ex.atlassian.net/wiki/api/v2/pages?id=404&limit=250";
        const stub = new StubHttpClient().on("GET", url, {
            body: '{"results":[],"_links":{}}',
        });
        await expect(
            clientWith(stub).fetchPageVersions(["404"]),
        ).resolves.toEqual(new Map());
    });

    it("follows the pagination cursor to completion", async () => {
        const first =
            "https://ex.atlassian.net/wiki/api/v2/pages?id=1&id=2&limit=250";
        const nextPath = "/wiki/api/v2/pages?cursor=abc";
        const stub = new StubHttpClient()
            .on("GET", first, {
                body: JSON.stringify({
                    results: [{ id: "1", version: { number: 3 } }],
                    _links: { next: nextPath },
                }),
            })
            .on("GET", `https://ex.atlassian.net${nextPath}`, {
                body: JSON.stringify({
                    results: [{ id: "2", version: { number: 9 } }],
                    _links: {},
                }),
            });

        const got = await clientWith(stub).fetchPageVersions(["1", "2"]);

        expect(got).toEqual(
            new Map([
                ["1", 3],
                ["2", 9],
            ]),
        );
    });

    it("rejects a non-2xx status", async () => {
        const url = "https://ex.atlassian.net/wiki/api/v2/pages?id=1&limit=250";
        const stub = new StubHttpClient().on("GET", url, { status: 500 });
        await expect(clientWith(stub).fetchPageVersions(["1"])).rejects.toThrow(
            "page versions: HTTP 500",
        );
    });
});

describe("resolveSpace", () => {
    const spaceURL = "https://ex.atlassian.net/wiki/api/v2/spaces?keys=TEST";

    it("resolves a space id and homepage id by key", async () => {
        const stub = new StubHttpClient().on("GET", spaceURL, {
            body: JSON.stringify({
                results: [{ id: "42", homepageId: "100" }],
            }),
        });

        await expect(clientWith(stub).resolveSpace("TEST")).resolves.toEqual({
            id: "42",
            homepageId: "100",
        });
    });

    it("rejects a key with no matching space", async () => {
        const stub = new StubHttpClient().on("GET", spaceURL, {
            body: '{"results":[]}',
        });
        await expect(clientWith(stub).resolveSpace("TEST")).rejects.toThrow(
            'space "TEST" not found',
        );
    });

    it("rejects a non-2xx status", async () => {
        const stub = new StubHttpClient().on("GET", spaceURL, { status: 500 });
        await expect(clientWith(stub).resolveSpace("TEST")).rejects.toThrow(
            'space "TEST": HTTP 500',
        );
    });
});

describe("fetchChildren", () => {
    it("fetches direct children and resolves the next cursor", async () => {
        const path = `${FOLDER_ENDPOINT}5${CHILDREN_PATH}`;
        const stub = new StubHttpClient().on(
            "GET",
            `https://ex.atlassian.net${path}`,
            {
                body: JSON.stringify({
                    results: [
                        {
                            id: "1",
                            type: "page",
                            title: "Child",
                            status: "current",
                        },
                        {
                            id: "2",
                            type: "folder",
                            title: "Sub",
                            status: "current",
                        },
                    ],
                    _links: { next: `${path}?cursor=abc` },
                }),
            },
        );

        const { results, next } = await clientWith(stub).fetchChildren(path);

        expect(results).toEqual([
            { id: "1", type: "page", title: "Child", status: "current" },
            { id: "2", type: "folder", title: "Sub", status: "current" },
        ]);
        expect(next).toBe(`https://ex.atlassian.net${path}?cursor=abc`);
    });

    it("returns an empty next when there is no more", async () => {
        const path = `${FOLDER_ENDPOINT}5${CHILDREN_PATH}`;
        const stub = new StubHttpClient().on(
            "GET",
            `https://ex.atlassian.net${path}`,
            { body: '{"results":[],"_links":{}}' },
        );
        await expect(clientWith(stub).fetchChildren(path)).resolves.toEqual({
            results: [],
            next: "",
        });
    });

    it("rejects a non-2xx status", async () => {
        const path = `${FOLDER_ENDPOINT}5${CHILDREN_PATH}`;
        const stub = new StubHttpClient().on(
            "GET",
            `https://ex.atlassian.net${path}`,
            { status: 500 },
        );
        await expect(clientWith(stub).fetchChildren(path)).rejects.toThrow(
            "children: HTTP 500",
        );
    });
});

describe("fetchAttachments", () => {
    const base = "https://ex.atlassian.net/wiki/api/v2/pages/123/attachments";

    it("follows the pagination cursor and keys by fileId", async () => {
        const stub = new StubHttpClient()
            .on("GET", base, {
                body: JSON.stringify({
                    results: [
                        {
                            fileId: "F1",
                            title: "a.png",
                            mediaType: "image/png",
                            downloadLink: "/download/a",
                        },
                    ],
                    _links: {
                        next: "/wiki/api/v2/pages/123/attachments?cursor=n",
                    },
                }),
            })
            .on("GET", `${base}?cursor=n`, {
                body: JSON.stringify({
                    results: [
                        {
                            fileId: "F2",
                            title: "b.jpg",
                            mediaType: "image/jpeg",
                            downloadLink: "/download/b",
                        },
                    ],
                    _links: {},
                }),
            });

        const atts = await clientWith(stub).fetchAttachments("123");

        expect([...atts.keys()].sort()).toEqual(["F1", "F2"]);
        expect(atts.get("F1")).toEqual({
            fileId: "F1",
            title: "a.png",
            mediaType: "image/png",
            downloadLink: "/download/a",
        });
        expect(atts.get("F2")?.mediaType).toBe("image/jpeg");
    });

    it("rejects a non-2xx status", async () => {
        const stub = new StubHttpClient().on("GET", base, { status: 500 });
        await expect(clientWith(stub).fetchAttachments("123")).rejects.toThrow(
            "attachments for 123: HTTP 500",
        );
    });
});

describe("fetchComments", () => {
    const v2 = "https://ex.atlassian.net/wiki/api/v2";
    const adf = "?body-format=atlas_doc_format";
    const inlineBase = `${v2}/pages/123/inline-comments${adf}`;
    const footerBase = `${v2}/pages/123/footer-comments${adf}`;
    /** A minimal ADF body value the client keeps as its raw JSON string. */
    const body = (text: string): { atlas_doc_format: { value: string } } => ({
        atlas_doc_format: {
            value: JSON.stringify({
                type: "doc",
                content: [
                    { type: "paragraph", content: [{ type: "text", text }] },
                ],
            }),
        },
    });
    /** An empty children listing, the leaf of every fetched thread. */
    const noChildren = { body: JSON.stringify({ results: [], _links: {} }) };

    it("reads inline and footer comments with their nested replies", async () => {
        const stub = new StubHttpClient()
            .on("GET", inlineBase, {
                body: JSON.stringify({
                    results: [
                        {
                            id: "C1",
                            status: "current",
                            resolutionStatus: "open",
                            properties: {
                                inlineMarkerRef: "M1",
                                inlineOriginalSelection: "commented span",
                            },
                            version: {
                                authorId: "U1",
                                createdAt: "2026-07-20T10:00:00Z",
                            },
                            body: body("where is this from?"),
                        },
                    ],
                    _links: {},
                }),
            })
            .on("GET", `${v2}/inline-comments/C1/children${adf}`, {
                body: JSON.stringify({
                    results: [
                        {
                            id: "C2",
                            version: {
                                authorId: "U2",
                                createdAt: "2026-07-21T09:00:00Z",
                            },
                            body: body("the appendix"),
                        },
                    ],
                    _links: {},
                }),
            })
            .on("GET", `${v2}/inline-comments/C2/children${adf}`, noChildren)
            .on("GET", footerBase, {
                body: JSON.stringify({
                    results: [
                        {
                            id: "F1",
                            version: {
                                authorId: "U3",
                                createdAt: "2026-07-22T08:00:00Z",
                            },
                            body: body("looks good"),
                        },
                    ],
                    _links: {},
                }),
            })
            .on("GET", `${v2}/footer-comments/F1/children${adf}`, noChildren);

        const comments = await clientWith(stub).fetchComments("123");

        expect(comments.inline).toHaveLength(1);
        const c1 = comments.inline[0];
        expect(c1).toMatchObject({
            id: "C1",
            kind: "inline",
            resolution: "open",
            markerRef: "M1",
            anchorText: "commented span",
            authorId: "U1",
            createdAt: "2026-07-20T10:00:00Z",
        });
        expect(c1?.adf).toContain("where is this from?");
        expect(c1?.replies).toHaveLength(1);
        expect(c1?.replies[0]).toMatchObject({ id: "C2", kind: "inline" });
        expect(c1?.replies[0]?.adf).toContain("the appendix");

        expect(comments.footer).toHaveLength(1);
        expect(comments.footer[0]).toMatchObject({
            id: "F1",
            kind: "footer",
            resolution: "",
            markerRef: "",
            anchorText: "",
            authorId: "U3",
        });
    });

    it("follows the pagination cursor of a comment listing", async () => {
        const nextPath = "/wiki/api/v2/pages/123/inline-comments?cursor=n";
        const stub = new StubHttpClient()
            .on("GET", inlineBase, {
                body: JSON.stringify({
                    results: [{ id: "C1", body: body("a") }],
                    _links: { next: nextPath },
                }),
            })
            .on("GET", `${v2}/inline-comments/C1/children${adf}`, noChildren)
            .on("GET", `https://ex.atlassian.net${nextPath}`, {
                body: JSON.stringify({
                    results: [{ id: "C3", body: body("b") }],
                    _links: {},
                }),
            })
            .on("GET", `${v2}/inline-comments/C3/children${adf}`, noChildren)
            .on("GET", footerBase, {
                body: JSON.stringify({ results: [], _links: {} }),
            });

        const comments = await clientWith(stub).fetchComments("123");

        expect(comments.inline.map((c) => c.id)).toEqual(["C1", "C3"]);
    });

    it("rejects a non-2xx status", async () => {
        const stub = new StubHttpClient()
            .on("GET", inlineBase, { status: 500 })
            .on("GET", footerBase, {
                body: JSON.stringify({ results: [], _links: {} }),
            });
        await expect(clientWith(stub).fetchComments("123")).rejects.toThrow(
            "inline comments: HTTP 500",
        );
    });
});

describe("createReply", () => {
    const v2 = "https://ex.atlassian.net/wiki/api/v2";
    const replyADF = JSON.stringify({
        type: "doc",
        content: [
            { type: "paragraph", content: [{ type: "text", text: "agreed" }] },
        ],
    });

    it("posts an inline reply carrying the parent id and returns the new id", async () => {
        const stub = new StubHttpClient().on("POST", `${v2}/inline-comments`, {
            body: '{"id":"C9"}',
        });

        const id = await clientWith(stub).createReply({
            parentId: "C1",
            kind: "inline",
            adf: replyADF,
        });

        expect(id).toBe("C9");
        const req = stub.requests[0];
        expect(req?.method).toBe("POST");
        const sent = JSON.parse(String(req?.body));
        // Only parentCommentId — the v2 create endpoint rejects a reply that
        // also carries pageId.
        expect(sent).toEqual({
            parentCommentId: "C1",
            body: { representation: "atlas_doc_format", value: replyADF },
        });
        expect(sent.pageId).toBeUndefined();
    });

    it("posts a footer reply to the footer-comments endpoint", async () => {
        const stub = new StubHttpClient().on("POST", `${v2}/footer-comments`, {
            body: '{"id":"F9"}',
        });

        await clientWith(stub).createReply({
            parentId: "F1",
            kind: "footer",
            adf: replyADF,
        });

        expect(stub.requests[0]?.url).toBe(`${v2}/footer-comments`);
    });

    it("rejects a non-2xx status and a response with no id", async () => {
        const fail = new StubHttpClient().on("POST", `${v2}/inline-comments`, {
            status: 500,
        });
        await expect(
            clientWith(fail).createReply({
                parentId: "C1",
                kind: "inline",
                adf: replyADF,
            }),
        ).rejects.toThrow("reply to comment C1: HTTP 500");

        const noId = new StubHttpClient().on("POST", `${v2}/inline-comments`, {
            body: "{}",
        });
        await expect(
            clientWith(noId).createReply({
                parentId: "C1",
                kind: "inline",
                adf: replyADF,
            }),
        ).rejects.toThrow("response has no id");
    });
});
