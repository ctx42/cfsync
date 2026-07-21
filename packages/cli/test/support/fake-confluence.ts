// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A small in-memory fake Confluence Site as MSW request handlers. Unlike the
// StubHttpClient (which replaces the HttpClient port), these intercept the actual
// `fetch` the CLI's FetchHttpClient makes, so the real transport runs end to end:
// the Basic-auth header, the URL/query building, the request/response bodies, and
// the retry/timeout wrapper. State is mutable — a PUT bumps a page's version, a
// POST creates one — so a pull → edit → push round-trip works against it, and
// every request is logged for assertions.

import { HttpResponse, http } from "msw";

/** FakePage is one page the fake Site holds. */
export interface FakePage {
    id: string;
    title: string;
    version: number;
    spaceId: string;
    parentId: string;
    /** The page body as an ADF document object. */
    adf: Record<string, unknown>;
}

/** A logged request: method, path, and the Authorization header seen. */
export interface LoggedRequest {
    method: string;
    path: string;
    auth: string | null;
}

/** FakeState is the mutable state the handlers read and write. */
export interface FakeState {
    host: string;
    account: string;
    pages: Map<string, FakePage>;
    /** The id the next created page receives. */
    nextId: number;
    /** Requests received, in order. */
    requests: LoggedRequest[];
    /** How many more times `user/current` should fail with 503 (for retry tests). */
    failUserTimes: number;
}

/** newState builds a fresh fake with the given host, account, and seed pages. */
export function newState(
    host: string,
    account: string,
    pages: FakePage[] = [],
): FakeState {
    return {
        host,
        account,
        pages: new Map(pages.map((p) => [p.id, p])),
        nextId: 500,
        requests: [],
        failUserTimes: 0,
    };
}

/** paragraph builds a one-paragraph ADF doc carrying `text`. */
export function paragraphDoc(text: string): Record<string, unknown> {
    return {
        type: "doc",
        version: 1,
        content: [
            {
                type: "paragraph",
                attrs: { localId: "p1" },
                content: [{ type: "text", text }],
            },
        ],
    };
}

/** handlers builds the MSW handlers over `state`, all under `state.host`. */
export function handlers(state: FakeState) {
    const log = (request: Request): void => {
        state.requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
            auth: request.headers.get("authorization"),
        });
    };
    const h = state.host;

    return [
        // The authenticated account, with an optional transient failure so a test
        // can exercise the adapter's retry/backoff.
        http.get(`${h}/wiki/rest/api/user/current`, ({ request }) => {
            log(request);
            if (state.failUserTimes > 0) {
                state.failUserTimes--;
                return new HttpResponse(null, { status: 503 });
            }
            return HttpResponse.json({ accountId: state.account });
        }),

        // Bulk-fetch page versions by id (the pull's version probe). Returns each
        // requested id that exists, with its version; unknown ids are omitted.
        http.get(`${h}/wiki/api/v2/pages`, ({ request }) => {
            log(request);
            const ids = new URL(request.url).searchParams.getAll("id");
            const results = ids
                .map((id) => state.pages.get(id))
                .filter((p): p is FakePage => p !== undefined)
                .map((p) => ({ id: p.id, version: { number: p.version } }));
            return HttpResponse.json({ results, _links: {} });
        }),

        // Fetch a page as ADF.
        http.get(`${h}/wiki/api/v2/pages/:id`, ({ request, params }) => {
            log(request);
            const page = state.pages.get(String(params["id"]));
            if (page === undefined) {
                return new HttpResponse(null, { status: 404 });
            }
            return HttpResponse.json(pageBody(page));
        }),

        // A page's attachments (none in the fake).
        http.get(`${h}/wiki/api/v2/pages/:id/attachments`, ({ request }) => {
            log(request);
            return HttpResponse.json({ results: [], _links: {} });
        }),

        // Update a page: bump to the requested version and store the new ADF.
        http.put(`${h}/wiki/api/v2/pages/:id`, async ({ request, params }) => {
            log(request);
            const page = state.pages.get(String(params["id"]));
            if (page === undefined) {
                return new HttpResponse(null, { status: 404 });
            }
            const body = (await request.json()) as {
                title: string;
                version: { number: number };
                body: { value: string };
            };
            page.title = body.title;
            page.version = body.version.number;
            page.adf = JSON.parse(body.body.value);
            return HttpResponse.json({ id: page.id });
        }),

        // Create a page at version 1.
        http.post(`${h}/wiki/api/v2/pages`, async ({ request }) => {
            log(request);
            const body = (await request.json()) as {
                spaceId: string;
                title: string;
                parentId?: string;
                body: { value: string };
            };
            const id = String(state.nextId++);
            state.pages.set(id, {
                id,
                title: body.title,
                version: 1,
                spaceId: body.spaceId,
                parentId: body.parentId ?? "",
                adf: JSON.parse(body.body.value),
            });
            return HttpResponse.json({ id, version: { number: 1 } });
        }),

        // Restrict a page to its author.
        http.put(
            `${h}/wiki/rest/api/content/:id/restriction`,
            ({ request }) => {
                log(request);
                return HttpResponse.json({});
            },
        ),
    ];
}

/** pageBody renders a {@link FakePage} as the v2 page response the client parses. */
function pageBody(page: FakePage): Record<string, unknown> {
    return {
        id: page.id,
        title: page.title,
        spaceId: page.spaceId,
        parentId: page.parentId,
        version: { number: page.version },
        body: { atlas_doc_format: { value: JSON.stringify(page.adf) } },
    };
}
