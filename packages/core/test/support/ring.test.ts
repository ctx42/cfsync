// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Exercises the ring test harness the way the Go `ringtest` suite does: a fake
// command reads injected env and argv and writes to the captured streams.

import { describe, expect, it } from "vitest";
import type { Ring } from "../support/ring.ts";
import { createRing, FIXED_NOW } from "../support/ring.ts";

/** A fake command: greet using an env var and the first argument. */
function greet(ring: Ring): void {
    const who = ring.args[0] ?? "world";
    ring.streams.stdout.write(`${ring.env.get("GREETING")}, ${who}!\n`);
    if (ring.env.lookup("MISSING") === undefined) {
        ring.streams.stderr.write("MISSING is unset\n");
    }
}

describe("ring harness", () => {
    it("a fake command reads injected env/argv and writes captured stdout", () => {
        const t = createRing({
            args: ["World"],
            env: { GREETING: "Hello" },
        });

        greet(t.ring);

        expect(t.stdout()).toBe("Hello, World!\n");
        expect(t.stderr()).toBe("MISSING is unset\n");
    });

    it("distinguishes an unset var from an empty one", () => {
        const t = createRing({ env: { EMPTY: "" } });

        expect(t.ring.env.lookup("EMPTY")).toBe("");
        expect(t.ring.env.get("EMPTY")).toBe("");
        expect(t.ring.env.lookup("ABSENT")).toBeUndefined();
        expect(t.ring.env.get("ABSENT")).toBe("");
    });

    it("serves injected stdin and defaults name/args", () => {
        const t = createRing({ stdin: "piped input" });

        expect(t.ring.streams.stdin.readAll()).toBe("piped input");
        expect(t.ring.name).toBe("cfsync");
        expect(t.ring.args).toEqual([]);
    });

    it("uses a fixed clock by default and honours an injected one", () => {
        expect(createRing().ring.clock()).toEqual(FIXED_NOW);

        const fixed = new Date("2020-05-05T10:00:00.000Z");
        const t = createRing({ clock: () => fixed });
        expect(t.ring.clock().toISOString()).toBe("2020-05-05T10:00:00.000Z");
    });
});
