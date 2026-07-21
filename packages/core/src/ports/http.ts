// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The HTTP port. The core talks to Confluence only through this interface,
// never `fetch` or `node:http` directly, so the CLI can back it with `fetch`
// and the plugin with Obsidian's `requestUrl` (which sidesteps CORS). Ported
// from the `*http.Client` usage in `pkg/cfsync/connection.go`. Retry/backoff
// and bounded concurrency wrap an `HttpClient` in M9.1.

/** An HTTP request. */
export interface HttpRequest {
    /** The HTTP method, e.g. `GET` or `PUT`. */
    method: string;
    /** The absolute request URL. */
    url: string;
    /** Request headers, if any. */
    headers?: Record<string, string>;
    /** The request body, if any. */
    body?: Uint8Array | string;
}

/** An HTTP response. */
export interface HttpResponse {
    /** The HTTP status code. */
    status: number;
    /** Response headers, lower-cased keys. */
    headers: Record<string, string>;
    /** The raw response body; images and JSON alike arrive as bytes. */
    body: Uint8Array;
}

/** Performs HTTP requests. */
export interface HttpClient {
    /** Send `request` and resolve with its response. */
    do(request: HttpRequest): Promise<HttpResponse>;
}

/** Decode an {@link HttpResponse} body as UTF-8 text. */
export function responseText(response: HttpResponse): string {
    return new TextDecoder().decode(response.body);
}
