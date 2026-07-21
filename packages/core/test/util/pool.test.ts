// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { mapPool } from "../../src/util/pool.ts";

/** deferred makes a promise resolvable from the outside, for ordering control. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe("mapPool", () => {
    it("returns results in input order regardless of completion order", async () => {
        // Item i resolves only after item (i+1) has, so completion is reversed.
        const gates = [deferred(), deferred(), deferred()];
        const out = mapPool([0, 1, 2], 3, async (n) => {
            await gates[n]?.promise;
            return n * 10;
        });
        gates[2]?.resolve();
        gates[1]?.resolve();
        gates[0]?.resolve();
        expect(await out).toEqual([0, 10, 20]);
    });

    it("keeps at most `limit` calls in flight", async () => {
        let inFlight = 0;
        let peak = 0;
        await mapPool(
            Array.from({ length: 20 }, (_, i) => i),
            4,
            async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await Promise.resolve();
                await Promise.resolve();
                inFlight--;
            },
        );
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBeGreaterThan(1); // it did run concurrently
    });

    it("processes every item and passes the index", async () => {
        const seen = await mapPool(["a", "b", "c"], 2, (s, i) =>
            Promise.resolve(`${i}:${s}`),
        );
        expect(seen).toEqual(["0:a", "1:b", "2:c"]);
    });

    it("returns an empty array for no items without calling fn", async () => {
        let calls = 0;
        const out = await mapPool([], 4, async () => {
            calls++;
        });
        expect(out).toEqual([]);
        expect(calls).toBe(0);
    });

    it("rejects when a task rejects", async () => {
        await expect(
            mapPool([1, 2, 3], 2, async (n) => {
                if (n === 2) {
                    throw new Error("boom");
                }
                return n;
            }),
        ).rejects.toThrow("boom");
    });
});
