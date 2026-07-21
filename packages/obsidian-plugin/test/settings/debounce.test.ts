// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { debounce } from "../../src/settings/debounce.ts";

describe("debounce", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("coalesces a burst of calls into one trailing invocation", () => {
        const fn = vi.fn();
        const d = debounce(fn, 400);
        d();
        d();
        d();
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(400);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("passes the latest arguments to the trailing call", () => {
        const fn = vi.fn<(v: string) => void>();
        const d = debounce(fn, 400);
        d("a");
        d("ab");
        d("abc");
        vi.advanceTimersByTime(400);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith("abc");
    });

    it("does not run early while calls keep arriving within the wait", () => {
        const fn = vi.fn();
        const d = debounce(fn, 400);
        d();
        vi.advanceTimersByTime(399);
        d(); // resets the timer
        vi.advanceTimersByTime(399);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("flush runs the pending call immediately and cancels the timer", () => {
        const fn = vi.fn<(v: string) => void>();
        const d = debounce(fn, 400);
        d("tail");
        expect(d.pending()).toBe(true);
        d.flush();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith("tail");
        expect(d.pending()).toBe(false);
        // The timer must not fire a second time after a flush.
        vi.advanceTimersByTime(400);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("flush is a no-op when nothing is pending", () => {
        const fn = vi.fn();
        const d = debounce(fn, 400);
        d.flush();
        expect(fn).not.toHaveBeenCalled();
    });

    it("cancel drops the pending call without running it", () => {
        const fn = vi.fn();
        const d = debounce(fn, 400);
        d();
        d.cancel();
        expect(d.pending()).toBe(false);
        vi.advanceTimersByTime(400);
        expect(fn).not.toHaveBeenCalled();
    });

    it("can be reused after a flush", () => {
        const fn = vi.fn<(v: string) => void>();
        const d = debounce(fn, 400);
        d("first");
        d.flush();
        d("second");
        vi.advanceTimersByTime(400);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenLastCalledWith("second");
    });
});
