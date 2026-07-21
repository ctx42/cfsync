// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { Clock, Writer } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { newReporter, TtyReporter } from "../src/reporter.ts";

const THRESHOLD = 1500;

/** A buffer {@link Writer} that accumulates everything written. */
class Buf implements Writer {
    text = "";
    write(t: string): void {
        this.text += t;
    }
}

/** A controllable clock. */
class Clk {
    private ms = 1_000_000;
    readonly now: Clock = () => new Date(this.ms);
    tick(d: number): void {
        this.ms += d;
    }
}

describe("TtyReporter", () => {
    const tty = (clk: Clk, buf: Buf): TtyReporter =>
        new TtyReporter(clk.now, "pulling", buf, { spinnerIntervalMs: 0 });

    it("stays silent before the threshold", () => {
        const clk = new Clk();
        const buf = new Buf();
        const rep = tty(clk, buf);
        rep.discovered(3);
        rep.item("a.md");
        expect(buf.text).toBe("");
    });

    it("draws a spinner and bar status line once active", () => {
        const clk = new Clk();
        const buf = new Buf();
        const rep = tty(clk, buf);
        rep.discovered(3);
        clk.tick(THRESHOLD);
        rep.item("a.md");
        expect(buf.text).toContain("pulling a.md");
        expect(buf.text).toContain("\x1b[2K"); // erases the line to redraw in place
        expect(rep.streamsLog()).toBe(true);
    });

    it("prints a result line above the status and clears on finish", () => {
        const clk = new Clk();
        const buf = new Buf();
        const rep = tty(clk, buf);
        rep.discovered(2);
        clk.tick(THRESHOLD);
        rep.item("a.md");
        buf.text = "";
        rep.log("pulling a.md ... ok (v1)\n");
        expect(buf.text).toContain("pulling a.md ... ok (v1)\n");
        rep.finish();
        expect(buf.text.endsWith("\x1b[2K")).toBe(true); // status erased last
    });
});

describe("newReporter", () => {
    it("returns a plain reporter off a TTY and a live one on a TTY", () => {
        const clk = new Clk();
        const plain = newReporter(clk.now, "pulling", new Buf(), false);
        const live = newReporter(clk.now, "pulling", new Buf(), true, {
            spinnerIntervalMs: 0,
        });
        expect(plain.streamsLog()).toBe(false);
        expect(live.streamsLog()).toBe(true);
    });
});
