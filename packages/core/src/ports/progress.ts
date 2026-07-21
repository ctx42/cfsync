// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The progress port, ported from `pkg/cfsync/progress.go`. A long pull or push
// drives it at four points, and the interface lets the CLI render a live TTY bar
// and the plugin a Notice / status bar without the sync core knowing which. This
// carries the contract, the no-op default, the pure {@link Tracker} model shared
// by every reporter (with {@link renderBar}/{@link percent}), and the
// {@link PlainReporter} that writes time-gated heartbeat lines to an injected
// {@link Writer}. The live TTY reporter and terminal detection need the process
// streams, so they stay in the CLI adapter (M10.2); the plugin reporter is M8.5.

import type { Clock } from "./clock.ts";
import type { Writer } from "./streams.ts";

/** Receives progress events during a long-running pull or push. */
export interface Reporter {
    /** One page was discovered during the walk. */
    found(): void;
    /** The walk finished; `total` pages will be processed. */
    discovered(total: number): void;
    /** Processing of the page named `name` has begun. */
    item(name: string): void;
    /** A per-page result line was produced. */
    log(line: string): void;
    /** Tear down any live display. */
    finish(): void;
    /**
     * Whether this reporter already emitted the per-page log itself, so the
     * caller omits that line from stdout to avoid printing it twice.
     */
    streamsLog(): boolean;
}

/** A {@link Reporter} that does nothing — the default when no progress is wanted. */
export class NoopReporter implements Reporter {
    found(): void {}
    discovered(_total: number): void {}
    item(_name: string): void {}
    log(_line: string): void {}
    finish(): void {}
    streamsLog(): boolean {
        return false;
    }
}

/** The minimum elapsed time (ms) before any progress is shown, so a quick run stays silent. */
export const PROGRESS_THRESHOLD_MS = 1500;
/** The minimum gap (ms) between successive non-terminal heartbeat lines. */
export const PROGRESS_INTERVAL_MS = 1000;
/** The cell width of the drawn progress bar. */
export const PROGRESS_BAR_WIDTH = 20;

/**
 * percent returns `pos` as a whole-number percentage of `total`, clamped to 100,
 * or 0 when `total` is not positive.
 */
export function percent(pos: number, total: number): number {
    if (total <= 0) {
        return 0;
    }
    if (pos >= total) {
        return 100;
    }
    return Math.floor((pos * 100) / total);
}

/**
 * renderBar draws a progress bar of {@link PROGRESS_BAR_WIDTH} cells filled to the
 * `pos`-of-`total` ratio.
 */
export function renderBar(pos: number, total: number): string {
    const filled = Math.floor((percent(pos, total) * PROGRESS_BAR_WIDTH) / 100);
    return `▕${"█".repeat(filled)}${"░".repeat(PROGRESS_BAR_WIDTH - filled)}▏`;
}

/**
 * Tracker is the pure progress model shared by the terminal and non-terminal
 * reporters. It counts discovery and processing events, decides when enough time
 * has elapsed to show progress, and renders the status lines. It performs no I/O;
 * the {@link Clock} is injected so its timing is testable. It begins in the
 * discovering phase (total unknown) and moves to processing once the total is set.
 */
export class Tracker {
    readonly verb: string;
    private readonly clock: Clock;
    private readonly startMs: number;
    private processing = false;
    private foundCount = 0;
    private totalCount = 0;
    private posCount = 0;
    private currentName = "";
    private lastBeatMs = 0;
    private beaten = false;

    constructor(clock: Clock, verb: string) {
        this.clock = clock;
        this.verb = verb;
        this.startMs = clock().getTime();
    }

    /** recordFound counts one page discovered during the walk. */
    recordFound(): void {
        this.foundCount++;
    }

    /** recordTotal ends the discovering phase, fixing the number of pages to process. */
    recordTotal(total: number): void {
        this.totalCount = total;
        this.processing = true;
    }

    /** recordItem advances to the page named `name`. */
    recordItem(name: string): void {
        this.posCount++;
        this.currentName = name;
    }

    /** active reports whether progress has run long enough to be shown. */
    active(): boolean {
        return this.clock().getTime() - this.startMs >= PROGRESS_THRESHOLD_MS;
    }

    /**
     * bar renders the full-width status line for a terminal: a running count of
     * discovered pages during the walk, or the position, current page, drawn bar,
     * and percent during processing.
     */
    bar(): string {
        if (!this.processing) {
            return `discovering… ${this.foundCount} pages found`;
        }
        const width = String(this.totalCount).length;
        const pos = String(this.posCount).padStart(width);
        const bar = renderBar(this.posCount, this.totalCount);
        const pct = String(percent(this.posCount, this.totalCount)).padStart(3);
        return `[${pos}/${this.totalCount}] ${this.verb} ${this.currentName} ${bar} ${pct}%`;
    }

    /**
     * beat returns the next non-terminal heartbeat line and `ok: true` when one is
     * due: progress has passed the threshold and the interval since the last beat
     * has elapsed. It records the beat time as a side effect.
     */
    beat(): { line: string; ok: boolean } {
        const now = this.clock().getTime();
        if (now - this.startMs < PROGRESS_THRESHOLD_MS) {
            return { line: "", ok: false };
        }
        if (this.beaten && now - this.lastBeatMs < PROGRESS_INTERVAL_MS) {
            return { line: "", ok: false };
        }
        this.lastBeatMs = now;
        this.beaten = true;
        return { line: this.heartbeat(), ok: true };
    }

    /**
     * heartbeat renders the compact, bar-free status line written to a
     * non-terminal stderr.
     */
    heartbeat(): string {
        if (!this.processing) {
            return `discovering… ${this.foundCount} pages found`;
        }
        const width = String(this.totalCount).length;
        const pos = String(this.posCount).padStart(width);
        return `[${pos}/${this.totalCount}] ${this.verb}…`;
    }
}

/**
 * PlainReporter writes time-gated heartbeat lines to a non-terminal stderr (an
 * injected {@link Writer}). It does not stream the per-page log: those lines stay
 * in the caller's buffer and reach stdout unchanged.
 */
export class PlainReporter implements Reporter {
    private readonly trk: Tracker;
    private readonly err: Writer;

    constructor(clock: Clock, verb: string, err: Writer) {
        this.trk = new Tracker(clock, verb);
        this.err = err;
    }

    found(): void {
        this.trk.recordFound();
        this.beat();
    }

    discovered(total: number): void {
        this.trk.recordTotal(total);
    }

    item(name: string): void {
        this.trk.recordItem(name);
        this.beat();
    }

    log(_line: string): void {}

    finish(): void {}

    streamsLog(): boolean {
        return false;
    }

    /** beat writes one heartbeat line to stderr when the tracker says one is due. */
    private beat(): void {
        const { line, ok } = this.trk.beat();
        if (ok) {
            this.err.write(`${line}\n`);
        }
    }
}
