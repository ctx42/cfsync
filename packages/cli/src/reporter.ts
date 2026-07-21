// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's progress reporters and the factory that chooses between them, the
// cfsync counterpart of `progress_tea.go` + `newReporter`. On an interactive
// stderr the live view keeps a single spinner+bar status line pinned at the
// bottom, printing each per-page result above it as it lands; piped or in CI it
// falls back to the plain time-gated heartbeat (M7.5). Both drive the pure core
// {@link Tracker}, so the timing and rendered lines are the same model, just a
// different surface. The live view streams the per-page log itself
// (`streamsLog() → true`), so the command writes only the summary to stdout.

import {
    type Clock,
    PlainReporter,
    type Reporter,
    Tracker,
    type Writer,
} from "@cfsync/core";

/** The Braille spinner frames, cycled while a run is active. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Carriage return + "erase whole line": rewinds to redraw the status in place. */
const CLEAR_LINE = "\r\x1b[2K";

/** TtyReporterOptions tune the live view; the interval is injectable for tests. */
export interface TtyReporterOptions {
    /** Spinner animation interval in ms; 0 disables the timer (advance per event). */
    spinnerIntervalMs?: number;
}

/**
 * TtyReporter renders a live spinner + progress bar to an interactive stderr. It
 * keeps one status line pinned at the bottom: `item`/`found` refresh it, `log`
 * prints a result line above it, and `finish` erases it. Nothing is drawn until
 * the {@link Tracker} says enough time has passed, so a quick run stays silent.
 */
export class TtyReporter implements Reporter {
    private readonly trk: Tracker;
    private readonly err: Writer;
    private readonly intervalMs: number;
    private frame = 0;
    private shown = false;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        clock: Clock,
        verb: string,
        err: Writer,
        opts: TtyReporterOptions = {},
    ) {
        this.trk = new Tracker(clock, verb);
        this.err = err;
        this.intervalMs = opts.spinnerIntervalMs ?? 120;
    }

    found(): void {
        this.trk.recordFound();
        this.render();
    }

    discovered(total: number): void {
        this.trk.recordTotal(total);
        this.render();
    }

    item(name: string): void {
        this.trk.recordItem(name);
        this.render();
    }

    log(line: string): void {
        if (this.shown) {
            this.err.write(CLEAR_LINE);
            this.shown = false;
        }
        this.err.write(line);
        if (this.trk.active()) {
            this.draw();
        }
    }

    finish(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.shown) {
            this.err.write(CLEAR_LINE);
            this.shown = false;
        }
    }

    streamsLog(): boolean {
        return true;
    }

    /** render draws the status line and, once active, starts the spinner timer. */
    private render(): void {
        if (!this.trk.active()) {
            return;
        }
        this.startTimer();
        this.draw();
    }

    /** draw writes the spinner + bar over the current line. */
    private draw(): void {
        const spin = SPINNER[this.frame % SPINNER.length] ?? SPINNER[0];
        this.err.write(`${CLEAR_LINE}${spin} ${this.trk.bar()}`);
        this.shown = true;
    }

    /** startTimer begins the spinner animation once, if enabled. */
    private startTimer(): void {
        if (this.timer !== null || this.intervalMs <= 0) {
            return;
        }
        this.timer = setInterval(() => {
            this.frame++;
            if (this.trk.active()) {
                this.draw();
            }
        }, this.intervalMs);
        // Never keep the process alive for the animation alone.
        this.timer.unref?.();
    }
}

/**
 * newReporter builds the progress reporter for a run whose per-page lines use
 * `verb`: the live {@link TtyReporter} on an interactive stderr, else the plain
 * {@link PlainReporter}. `isTTY` is the adapter's terminal check (a piped or CI
 * stderr is not a terminal), kept out of the core.
 */
export function newReporter(
    clock: Clock,
    verb: string,
    err: Writer,
    isTTY: boolean,
    opts: TtyReporterOptions = {},
): Reporter {
    return isTTY
        ? new TtyReporter(clock, verb, err, opts)
        : new PlainReporter(clock, verb, err);
}
