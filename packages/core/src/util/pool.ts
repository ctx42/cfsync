// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A bounded-concurrency map, the fan-out primitive the pull uses so a large
// space runs many page fetches at once instead of one at a time. It keeps at
// most `limit` calls in flight and returns results in input order, so a caller
// can fold them deterministically. It launches a fixed pool of workers rather
// than `limit` promises per batch, so the in-flight count never exceeds `limit`
// even for thousands of items; the HTTP client's own semaphore still caps
// sockets underneath.

/**
 * mapPool maps `fn` over `items` with at most `limit` calls in flight at once,
 * resolving to the results in input order. `limit` is floored to an integer and
 * clamped to at least 1 and never above the item count; a fractional, zero,
 * negative, or non-finite `limit` falls back to 1. A rejected `fn` rejects the
 * whole call, so a
 * caller that must not abort the batch on one failure catches inside `fn` and
 * returns a result that encodes the error (as the pull does).
 */
export async function mapPool<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    if (items.length === 0) {
        return results;
    }
    const capped = Math.min(Math.floor(limit), items.length);
    const width = capped >= 1 ? capped : 1; // NaN/≤0 fall back to 1
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i] as T, i);
        }
    };
    const workers: Promise<void>[] = [];
    for (let w = 0; w < width; w++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}
