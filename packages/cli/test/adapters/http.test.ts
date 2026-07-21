// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { FetchHttpClient } from "../../src/adapters/http.ts";

const noSleep = (): Promise<void> => Promise.resolve();

describe("FetchHttpClient", () => {
    it("returns the response, lowercasing headers and reading the body bytes", async () => {
        const fetchImpl = ((_url: string) =>
            Promise.resolve(
                new Response("hello", {
                    status: 200,
                    headers: { "Content-Type": "text/plain" },
                }),
            )) as unknown as typeof fetch;
        const client = new FetchHttpClient({ fetchImpl, sleep: noSleep });

        const resp = await client.do({ method: "GET", url: "http://x/a" });

        expect(resp.status).toBe(200);
        expect(resp.headers["content-type"]).toBe("text/plain");
        expect(new TextDecoder().decode(resp.body)).toBe("hello");
    });

    it("retries a transient 503 and returns the eventual success", async () => {
        let calls = 0;
        const fetchImpl = ((_url: string) => {
            calls++;
            return Promise.resolve(
                new Response("", { status: calls < 3 ? 503 : 200 }),
            );
        }) as unknown as typeof fetch;
        const client = new FetchHttpClient({
            fetchImpl,
            sleep: noSleep,
            maxRetries: 3,
        });

        const resp = await client.do({ method: "GET", url: "http://x/a" });

        expect(resp.status).toBe(200);
        expect(calls).toBe(3);
    });

    it("gives up after the retry budget, returning the last transient status", async () => {
        let calls = 0;
        const fetchImpl = ((_url: string) => {
            calls++;
            return Promise.resolve(new Response("", { status: 503 }));
        }) as unknown as typeof fetch;
        const client = new FetchHttpClient({
            fetchImpl,
            sleep: noSleep,
            maxRetries: 2,
        });

        const resp = await client.do({ method: "GET", url: "http://x/a" });

        expect(resp.status).toBe(503);
        expect(calls).toBe(3); // first attempt + 2 retries
    });

    it("times out a hung request, aborting and then retrying to exhaustion", async () => {
        let calls = 0;
        // A fetch that only ever settles when its signal aborts.
        const fetchImpl = ((_url: string, init?: RequestInit) => {
            calls++;
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                    reject(new Error("aborted")),
                );
            });
        }) as unknown as typeof fetch;
        const client = new FetchHttpClient({
            fetchImpl,
            sleep: noSleep,
            timeoutMs: 5,
            maxRetries: 1,
        });

        await expect(
            client.do({ method: "GET", url: "http://x/a" }),
        ).rejects.toThrow("aborted");
        expect(calls).toBe(2); // first attempt + 1 retry, both timed out
    });

    it("bounds concurrency to the configured limit", async () => {
        let active = 0;
        let peak = 0;
        const fetchImpl = ((_url: string) => {
            active++;
            peak = Math.max(peak, active);
            return new Promise<Response>((resolve) => {
                setTimeout(() => {
                    active--;
                    resolve(new Response("", { status: 200 }));
                }, 5);
            });
        }) as unknown as typeof fetch;
        const client = new FetchHttpClient({
            fetchImpl,
            sleep: noSleep,
            concurrency: 2,
        });

        await Promise.all(
            Array.from({ length: 6 }, (_v, i) =>
                client.do({ method: "GET", url: `http://x/${i}` }),
            ),
        );

        expect(peak).toBeLessThanOrEqual(2);
    });
});
