// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's HttpClient adapter over the global `fetch`, wrapping it with the
// three things a whole-space sync needs and the core stays free of: a per-request
// timeout (an AbortController the configured deadline trips), bounded concurrency
// (a semaphore, so a large space never opens hundreds of sockets at once), and
// retry with exponential backoff on transport errors and the transient 429/5xx
// statuses. `fetch` and `sleep` are injectable so the retry/timeout logic is
// tested without real time or sockets.

import type { HttpClient, HttpRequest, HttpResponse } from "@cfsync/core";

/** The transient HTTP statuses a request is retried on. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** FetchHttpOptions tune the timeout, retry, and concurrency behaviour. */
export interface FetchHttpOptions {
    /** Per-request timeout in milliseconds; a non-positive value disables it. */
    timeoutMs?: number;
    /** Maximum retries after the first attempt (default 3). */
    maxRetries?: number;
    /** Maximum concurrent in-flight requests (default 8). */
    concurrency?: number;
    /** Backoff base in milliseconds; retry `n` waits `base·2ⁿ⁻¹` (default 200). */
    backoffBaseMs?: number;
    /** The fetch implementation (injected in tests; defaults to the global). */
    fetchImpl?: typeof fetch;
    /** The delay function (injected in tests; defaults to a real timer). */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * FetchHttpClient implements the {@link HttpClient} port over `fetch`. One is
 * built per run with the resolved timeout; it is stateless apart from the
 * concurrency semaphore and never mutates its inputs.
 */
export class FetchHttpClient implements HttpClient {
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly backoffBaseMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly gate: Semaphore;

    constructor(opts: FetchHttpOptions = {}) {
        this.timeoutMs = opts.timeoutMs ?? 30_000;
        this.maxRetries = opts.maxRetries ?? 3;
        this.backoffBaseMs = opts.backoffBaseMs ?? 200;
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.sleep =
            opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.gate = new Semaphore(Math.max(1, opts.concurrency ?? 8));
    }

    async do(request: HttpRequest): Promise<HttpResponse> {
        return this.gate.run(() => this.attempt(request));
    }

    /** attempt runs the request, retrying transport errors and transient statuses. */
    private async attempt(request: HttpRequest): Promise<HttpResponse> {
        let lastErr: unknown;
        for (let n = 0; n <= this.maxRetries; n++) {
            if (n > 0) {
                await this.sleep(this.backoffBaseMs * 2 ** (n - 1));
            }
            let resp: HttpResponse;
            try {
                resp = await this.once(request);
            } catch (err) {
                lastErr = err;
                continue; // transport error or timeout: retry
            }
            if (n < this.maxRetries && RETRY_STATUSES.has(resp.status)) {
                continue; // transient status: retry
            }
            return resp;
        }
        throw lastErr instanceof Error
            ? lastErr
            : new Error(`request to ${request.url} failed`);
    }

    /** once performs a single fetch bounded by the timeout. */
    private async once(request: HttpRequest): Promise<HttpResponse> {
        const controller = new AbortController();
        const timer =
            this.timeoutMs > 0
                ? setTimeout(() => controller.abort(), this.timeoutMs)
                : undefined;
        try {
            // Built conditionally so no property is ever the literal `undefined`
            // (`exactOptionalPropertyTypes`), and cast to fetch's init type so the
            // adapter needs no DOM lib for `RequestInit`/`BodyInit`.
            const init: Record<string, unknown> = {
                method: request.method,
                signal: controller.signal,
            };
            if (request.headers !== undefined) {
                init["headers"] = request.headers;
            }
            if (request.body !== undefined) {
                init["body"] = request.body;
            }
            const resp = await this.fetchImpl(
                request.url,
                init as Parameters<typeof fetch>[1],
            );
            const body = new Uint8Array(await resp.arrayBuffer());
            const headers: Record<string, string> = {};
            resp.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value;
            });
            return { status: resp.status, headers, body };
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }
}

/** Semaphore bounds the number of concurrently running tasks. */
class Semaphore {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    /** run awaits a free slot, runs `task`, and releases the slot. */
    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            // Wait for a slot; the releaser hands us its permit without
            // decrementing `active`, so the count never dips between release
            // and wake — a newcomer arriving in that window still sees the slot
            // taken and cannot jump the queue past `limit`.
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        } else {
            this.active++;
        }
        try {
            return await task();
        } finally {
            const next = this.waiters.shift();
            if (next !== undefined) {
                next(); // transfer our permit; `active` stays unchanged
            } else {
                this.active--;
            }
        }
    }
}
