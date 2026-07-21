// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A sequential-response stub HttpClient, the counterpart of Go's httpkit test
// server: responses are returned in the order they were enqueued, regardless of
// URL, so a test can drive a multi-request flow (create folder, restrict, create
// page, restrict…) that hits the same endpoint more than once. Use StubHttpClient
// instead when each route needs one fixed response keyed by method+URL.

import type {
    HttpClient,
    HttpRequest,
    HttpResponse,
} from "../../src/ports/http.ts";

/** A queued response, with text sugar for JSON bodies. */
export interface QueuedResponse {
    status?: number;
    body?: Uint8Array | string;
}

/** A {@link HttpClient} that replays queued responses first-in, first-out. */
export class QueueHttpClient implements HttpClient {
    private readonly queue: QueuedResponse[] = [];
    /** Every request received, in order — for asserting what was sent. */
    readonly requests: HttpRequest[] = [];

    /** Enqueue the next response. Returns `this` for chaining. */
    rsp(status: number, body?: Uint8Array | string): this {
        this.queue.push({ status, ...(body !== undefined ? { body } : {}) });
        return this;
    }

    /** The number of requests received so far. */
    get count(): number {
        return this.requests.length;
    }

    /** The decoded UTF-8 body of the request at `index`. */
    bodyOf(index: number): string {
        const b = this.requests[index]?.body;
        if (b === undefined) {
            return "";
        }
        return typeof b === "string" ? b : new TextDecoder().decode(b);
    }

    do(request: HttpRequest): Promise<HttpResponse> {
        this.requests.push(request);
        const next = this.queue.shift();
        const body = next?.body ?? new Uint8Array();
        return Promise.resolve({
            status: next?.status ?? 200,
            headers: {},
            body:
                typeof body === "string"
                    ? new TextEncoder().encode(body)
                    : body,
        });
    }
}
