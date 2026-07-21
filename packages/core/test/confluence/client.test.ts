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
