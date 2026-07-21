// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's HttpClient adapter over Obsidian's `requestUrl`, which issues
// requests from the desktop app and so sidesteps the CORS restrictions a
// browser `fetch` to Atlassian would hit. `requestUrl` is injected as a
// function (not imported as a value here) so this module carries no Obsidian
// runtime dependency and unit-tests with a fake. Retry/backoff/concurrency are
// deliberately absent — the plugin's only caller today is a single-request
// connection test; the wrapped client is a later concern.

import type { HttpClient, HttpRequest, HttpResponse } from "@cfsync/core";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

/** RequestUrlFn is Obsidian's `requestUrl`, narrowed to what this adapter uses. */
export type RequestUrlFn = (
    param: RequestUrlParam,
) => Promise<RequestUrlResponse>;

/**
 * RequestUrlHttpClient implements the core's {@link HttpClient} port over an
 * injected `requestUrl`. It forwards method, url, headers, and body, forces
 * `throw: false` so a non-2xx status returns a response the core can inspect
 * (matching the CLI's fetch adapter), and normalises the reply into an
 * {@link HttpResponse} with lower-cased header keys and a `Uint8Array` body.
 */
export class RequestUrlHttpClient implements HttpClient {
    constructor(private readonly request: RequestUrlFn) {}

    async do(req: HttpRequest): Promise<HttpResponse> {
        const bodyVal = toBody(req.body);
        const resp = await this.request({
            url: req.url,
            method: req.method,
            ...(req.headers !== undefined && { headers: req.headers }),
            ...(bodyVal !== undefined && { body: bodyVal }),
            throw: false,
        });
        return {
            status: resp.status,
            headers: lowerCaseKeys(resp.headers),
            body: new Uint8Array(resp.arrayBuffer),
        };
    }
}

/** toBody adapts the port's `Uint8Array | string` body to `requestUrl`'s type. */
function toBody(
    body: Uint8Array | string | undefined,
): string | ArrayBuffer | undefined {
    if (body === undefined || typeof body === "string") {
        return body;
    }
    return body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
}

/** lowerCaseKeys returns headers with every key lower-cased. */
function lowerCaseKeys(
    headers: Record<string, string>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key.toLowerCase()] = value;
    }
    return out;
}
