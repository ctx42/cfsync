// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/cfsync/progress_test.go: the pure progress model (percent,
// renderBar, Tracker) and the PlainReporter that heartbeats to an injected
// Writer. The clock is a controllable stub so the time-gated behaviour is
// deterministic; the writer is an in-memory buffer.

import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/ports/clock.ts";
import {
    NoopReporter,
    PlainReporter,
    PROGRESS_INTERVAL_MS,
    PROGRESS_THRESHOLD_MS,
    percent,
    renderBar,
    Tracker,
} from "../../src/ports/progress.ts";
import type { Writer } from "../../src/ports/streams.ts";

/** A controllable time source: `now` returns the current instant, `tick` advances it. */
class TestClock {
    private ms = 1_000_000;
    readonly now: Clock = () => new Date(this.ms);
    tick(d: number): void {
        this.ms += d;
    }
}

/** An in-memory {@link Writer} that accumulates everything written. */
class BufWriter implements Writer {
    text = "";
    write(t: string): void {
        this.text += t;
    }
}

describe("percent", () => {
    it.each([
        ["zero total", 3, 0, 0],
        ["negative total", 3, -1, 0],
        ["none done", 0, 10, 0],
        ["half done", 131, 262, 50],
        ["all done", 10, 10, 100],
        ["over total clamps", 12, 10, 100],
    ])("%s", (_name, pos, total, want) => {
        expect(percent(pos as number, total as number)).toBe(want);
    });
});

describe("renderBar", () => {
    it("half filled", () => {
        expect(renderBar(131, 262)).toBe("▕██████████░░░░░░░░░░▏");
    });
    it("empty", () => {
        expect(renderBar(0, 10)).toBe("▕░░░░░░░░░░░░░░░░░░░░▏");
    });
    it("full", () => {
        expect(renderBar(10, 10)).toBe("▕████████████████████▏");
    });
});

describe("Tracker", () => {
    it("starts discovering with the given verb", () => {
        const trk = new Tracker(new TestClock().now, "pulling");
        expect(trk.verb).toBe("pulling");
        expect(trk.bar()).toBe("discovering… 0 pages found");
    });

    it("counts found pages", () => {
        const trk = new Tracker(new TestClock().now, "pulling");
        trk.recordFound();
        trk.recordFound();
        expect(trk.bar()).toBe("discovering… 2 pages found");
    });

    it("moves to processing once the total is recorded", () => {
        const trk = new Tracker(new TestClock().now, "pulling");
        trk.recordTotal(7);
        trk.recordItem("a.md");
        expect(trk.bar()).toContain("[1/7] pulling a.md");
    });

    it("advances position and current on each item", () => {
        const trk = new Tracker(new TestClock().now, "pulling");
        trk.recordTotal(10);
        trk.recordItem("setup.md");
        trk.recordItem("faq.md");
        expect(trk.bar()).toContain("[ 2/10] pulling faq.md");
    });

    it("is silent before the threshold and active at it", () => {
        const clk = new TestClock();
        const trk = new Tracker(clk.now, "pulling");
        clk.tick(PROGRESS_THRESHOLD_MS - 1);
        expect(trk.active()).toBe(false);
        clk.tick(1);
        expect(trk.active()).toBe(true);
    });

    it("renders the processing bar with position, page, and percent", () => {
        const trk = new Tracker(new TestClock().now, "pulling");
        trk.recordTotal(262);
        for (let i = 0; i < 131; i++) {
            trk.recordItem("setup.md");
        }
        expect(trk.bar()).toBe(
            "[131/262] pulling setup.md ▕██████████░░░░░░░░░░▏  50%",
        );
    });

    it("pads the position to the total width", () => {
        const trk = new Tracker(new TestClock().now, "pushing");
        trk.recordTotal(263);
        trk.recordItem("a.md");
        expect(trk.bar()).toContain("[  1/263] pushing a.md ");
    });

    it("heartbeat shows the discovery count", () => {
        const trk = new Tracker(new TestClock().now, "pulling");
        trk.recordFound();
        expect(trk.heartbeat()).toBe("discovering… 1 pages found");
    });

    it("heartbeat omits the bar during processing", () => {
        const trk = new Tracker(new TestClock().now, "pushing");
        trk.recordTotal(263);
        trk.recordItem("a.md");
        expect(trk.heartbeat()).toBe("[  1/263] pushing…");
    });
});

describe("Tracker.beat", () => {
    it("does not beat before the threshold", () => {
        const trk = new Tracker(new TestClock().now, "pulling");
        expect(trk.beat()).toEqual({ line: "", ok: false });
    });

    it("beats once past the threshold", () => {
        const clk = new TestClock();
        const trk = new Tracker(clk.now, "pulling");
        trk.recordFound();
        clk.tick(PROGRESS_THRESHOLD_MS);
        expect(trk.beat()).toEqual({
            line: "discovering… 1 pages found",
            ok: true,
        });
    });

    it("does not beat again within the interval", () => {
        const clk = new TestClock();
        const trk = new Tracker(clk.now, "pulling");
        clk.tick(PROGRESS_THRESHOLD_MS);
        expect(trk.beat().ok).toBe(true);
        clk.tick(PROGRESS_INTERVAL_MS - 1);
        expect(trk.beat().ok).toBe(false);
    });

    it("beats again after the interval", () => {
        const clk = new TestClock();
        const trk = new Tracker(clk.now, "pulling");
        clk.tick(PROGRESS_THRESHOLD_MS);
        expect(trk.beat().ok).toBe(true);
        clk.tick(PROGRESS_INTERVAL_MS);
        expect(trk.beat().ok).toBe(true);
    });
});

describe("NoopReporter", () => {
    it("swallows every event and never streams", () => {
        const rep = new NoopReporter();
        rep.found();
        rep.discovered(3);
        rep.item("a");
        rep.log("line");
        rep.finish();
        expect(rep.streamsLog()).toBe(false);
    });
});

describe("PlainReporter", () => {
    it("is silent before the threshold", () => {
        const buf = new BufWriter();
        const rep = new PlainReporter(new TestClock().now, "pulling", buf);
        rep.found();
        rep.item("a");
        expect(buf.text).toBe("");
    });

    it("writes a discovery heartbeat past the threshold", () => {
        const clk = new TestClock();
        const buf = new BufWriter();
        const rep = new PlainReporter(clk.now, "pulling", buf);
        clk.tick(PROGRESS_THRESHOLD_MS);
        rep.found();
        expect(buf.text).toBe("discovering… 1 pages found\n");
    });

    it("writes a processing heartbeat", () => {
        const clk = new TestClock();
        const buf = new BufWriter();
        const rep = new PlainReporter(clk.now, "pulling", buf);
        rep.discovered(3);
        clk.tick(PROGRESS_THRESHOLD_MS);
        rep.item("a");
        expect(buf.text).toBe("[1/3] pulling…\n");
    });

    it("log writes nothing and does not stream", () => {
        const clk = new TestClock();
        const buf = new BufWriter();
        const rep = new PlainReporter(clk.now, "pulling", buf);
        clk.tick(PROGRESS_THRESHOLD_MS);
        rep.log("pulling a ... ok (v1)\n");
        expect(buf.text).toBe("");
        expect(rep.streamsLog()).toBe(false);
    });
});
