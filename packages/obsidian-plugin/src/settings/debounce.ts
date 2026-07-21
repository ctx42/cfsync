// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A minimal trailing-edge debounce with an explicit flush. The settings tab
// uses it to coalesce per-keystroke persistence into one `data.json` write,
// while `flush()` guarantees the tail is never dropped when the tab hides or an
// explicit commit (Add/Done/Delete) happens — dropping the tail would silently
// lose the user's last keystrokes, a correctness bug a bare debounce invites.

/** Debounced wraps a function so rapid calls collapse into one delayed call. */
export interface Debounced<A extends unknown[]> {
    /** Schedule `fn(...args)` to run after the wait, replacing any pending call. */
    (...args: A): void;
    /** Run a pending call now (if any), cancelling its timer. No-op when idle. */
    flush(): void;
    /** Drop a pending call without running it. */
    cancel(): void;
    /** pending reports whether a call is scheduled but not yet run. */
    pending(): boolean;
}

/**
 * debounce returns a {@link Debounced} wrapper of `fn`: invoking it (re)starts a
 * `waitMs` timer carrying the latest arguments, so only the final call in a
 * burst runs. `flush()` forces the pending call immediately (used on tab hide
 * and on explicit map commits) and `cancel()` discards it. Trailing-edge only —
 * `fn` never runs synchronously on the first call.
 */
export function debounce<A extends unknown[]>(
    fn: (...args: A) => void,
    waitMs: number,
): Debounced<A> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: A | null = null;

    const run = (): void => {
        timer = null;
        if (lastArgs === null) {
            return;
        }
        const args = lastArgs;
        lastArgs = null;
        fn(...args);
    };

    const debounced = ((...args: A): void => {
        lastArgs = args;
        if (timer !== null) {
            clearTimeout(timer);
        }
        timer = setTimeout(run, waitMs);
    }) as Debounced<A>;

    debounced.flush = (): void => {
        if (timer !== null) {
            clearTimeout(timer);
            run();
        }
    };
    debounced.cancel = (): void => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        lastArgs = null;
    };
    debounced.pending = (): boolean => timer !== null;

    return debounced;
}
