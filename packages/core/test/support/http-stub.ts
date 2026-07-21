// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A programmable stub HttpClient for core sync tests that want to inject canned
// responses directly, without MSW. The core Confluence client (M6.2) is
// unit-tested with this stub, since it talks through the HttpClient port; the
// shared MSW fake Confluence exercises the real fetch/requestUrl adapters against
// it once those land (M8.1/M10.2).

import type {
    HttpClient,
    HttpRequest,
    HttpResponse,
} from "../../src/ports/http.ts";

/** A canned response, with text sugar for JSON bodies. */
export interface StubResponse {
    status?: number;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
}

/** Route key: `METHOD url`. */
function key(method: string, url: string): string {
    return `${method.toUpperCase()} ${url}`;
}

/** A {@link HttpClient} that replays responses registered by method and URL. */
export class StubHttpClient implements HttpClient {
    private readonly routes = new Map<string, StubResponse>();
    /** Every request received, in order — for asserting what was sent. */
    readonly requests: HttpRequest[] = [];

    /** Register the response for `method url`. Returns `this` for chaining. */
    on(method: string, url: string, response: StubResponse): this {
        this.routes.set(key(method, url), response);
        return this;
    }

    do(request: HttpRequest): Promise<HttpResponse> {
        this.requests.push(request);
        const stub = this.routes.get(key(request.method, request.url));
        if (stub === undefined) {
            return Promise.resolve({
                status: 404,
                headers: {},
                body: new Uint8Array(),
            });
        }
        const body = stub.body ?? new Uint8Array();
        return Promise.resolve({
            status: stub.status ?? 200,
            headers: stub.headers ?? {},
            body:
                typeof body === "string"
                    ? new TextEncoder().encode(body)
                    : body,
        });
    }
}
