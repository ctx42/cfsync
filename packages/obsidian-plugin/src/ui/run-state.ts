// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The panel's progress model and the Reporter that drives it. PanelReporter
// implements the core Reporter port so the sync core stays UI-agnostic: the four
// progress events mutate a RunState and notify the view to re-render. It has no
// obsidian dependency, so it unit-tests directly. Per-page refusals are not
// streamed by the core (they land in the outcome), so the view feeds them back
// via fail().

import type { Reporter } from "@cfsync/core";

export type RunPhase = "idle" | "discovering" | "processing" | "done" | "error";
export type RowKind =
    | "ok"
    | "warn"
    | "err"
    | "info"
    | "added"
    | "updated"
    | "unchanged"
    | "deleted"
    | "conflict";

/** PullTally is a pull's per-action breakdown, shown in the footer. */
export interface PullTally {
    added: number;
    updated: number;
    unchanged: number;
    conflict: number;
    deleted: number;
}

/** LogRow is one line in the panel's scrolling log. */
export interface LogRow {
    text: string;
    kind: RowKind;
}

/**
 * rowKind classifies a streamed log line by its leading word, so a pull's
 * `added`/`updated`/`unchanged`/`conflict`/`deleted` lines render in their own
 * colour and a `warning:` line as a warning. Anything else (a push line, a
 * discovery note) stays a neutral `info` row.
 */
export function rowKind(line: string): RowKind {
    switch (line.trimStart().split(/\s/, 1)[0]) {
        case "added":
            return "added";
        case "updated":
            return "updated";
        case "unchanged":
            return "unchanged";
        case "conflict":
            return "conflict";
        case "deleted":
            return "deleted";
        case "warning:":
            return "warn";
        default:
            return "info";
    }
}

/** RunState is the panel's full render model for one operation. */
export interface RunState {
    verb: string;
    phase: RunPhase;
    found: number;
    total: number;
    pos: number;
    current: string;
    rows: LogRow[];
    counts: { ok: number; warn: number; err: number };
    /** The pull's per-action breakdown for the footer, or null for a push. */
    tally: PullTally | null;
    /** errorText holds the fatal-run message when phase is "error", else "". */
    errorText: string;
}

/** PanelReporter maps core progress events onto a {@link RunState}. */
export class PanelReporter implements Reporter {
    private readonly s: RunState;
    private readonly onChange: (s: RunState) => void;

    constructor(verb: string, onChange: (s: RunState) => void) {
        this.s = {
            verb,
            phase: "discovering",
            found: 0,
            total: 0,
            pos: 0,
            current: "",
            rows: [],
            counts: { ok: 0, warn: 0, err: 0 },
            tally: null,
            errorText: "",
        };
        this.onChange = onChange;
    }

    found(): void {
        this.s.found++;
        this.emit();
    }

    discovered(total: number): void {
        this.s.total = total;
        this.s.phase = "processing";
        this.emit();
    }

    item(name: string): void {
        this.s.pos++;
        this.s.current = name;
        this.emit();
    }

    log(line: string): void {
        this.s.rows.push({
            text: line.replace(/\n+$/, ""),
            kind: rowKind(line),
        });
        this.emit();
    }

    finish(): void {
        this.s.phase = "done";
        this.emit();
    }

    /** error ends the run in the "error" phase, keeping the accumulated log and
     * counts so pages that already succeeded stay visible under the banner. */
    error(text: string): void {
        this.s.errorText = text;
        this.s.phase = "error";
        this.emit();
    }

    streamsLog(): boolean {
        return true;
    }

    /** state returns the current, live render model. */
    state(): RunState {
        return this.s;
    }

    /** fail appends an error row for an outcome refusal the core did not stream. */
    fail(text: string): void {
        this.s.rows.push({ text, kind: "err" });
        this.emit();
    }

    /** setCounts sets the footer tally after a run's outcome is known. */
    setCounts(c: { ok: number; warn: number; err: number }): void {
        this.s.counts = c;
        this.emit();
    }

    /**
     * setTally records a pull's per-action breakdown for the footer and mirrors
     * its error count into the shared `counts`, so the done-phase footer can show
     * added/updated/unchanged/conflict/deleted alongside the failure count.
     */
    setTally(tally: PullTally, err: number): void {
        this.s.tally = tally;
        this.s.counts = { ok: 0, warn: 0, err };
        this.emit();
    }

    private emit(): void {
        this.onChange(this.s);
    }
}
