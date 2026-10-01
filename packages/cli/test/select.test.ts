// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    decodeKey,
    renderSelect,
    type SelectRow,
    type SelectState,
    stepSelect,
} from "../src/select.ts";

const rows: SelectRow[] = [
    { label: "a.md", options: ["skip", "push", "overwrite"] },
    { label: "bb.md", options: ["skip", "pull"] },
];
const start: SelectState = { cursor: 0, choices: [0, 0] };
const step = (s: SelectState, data: string) =>
    stepSelect(rows, s, decodeKey(data)) as SelectState;

describe("stepSelect", () => {
    it("moves the cursor and stops at both ends", () => {
        let s = step(start, "\x1b[A");
        expect(s.cursor).toBe(0);
        s = step(step(s, "\x1b[B"), "\x1b[B");
        expect(s.cursor).toBe(1);
    });

    it("cycles the cursor row's own options both ways", () => {
        const seen: number[] = [];
        let s = start;
        for (let i = 0; i < 3; i++) {
            s = step(s, " ");
            seen.push(s.choices[0] ?? -1);
        }
        expect(seen).toEqual([1, 2, 0]);
        expect(step(start, "\x1b[D").choices[0]).toBe(2);
        expect(step(step(start, "\x1b[B"), " ").choices).toEqual([0, 1]);
    });

    it("picks an option by its first letter", () => {
        expect(step(start, "o").choices[0]).toBe(2);
        expect(step(start, "z")).toBe(start);
    });

    it("finishes on enter and cancels on q or ctrl-c", () => {
        expect(stepSelect(rows, start, decodeKey("\r"))).toBe("done");
        expect(stepSelect(rows, start, decodeKey("q"))).toBe("cancel");
        expect(stepSelect(rows, start, decodeKey("\x03"))).toBe("cancel");
    });
});

describe("renderSelect", () => {
    it("draws the cursor, a changed-row mark, and each chosen option", () => {
        const have = renderSelect(rows, { cursor: 1, choices: [2, 0] });

        expect(have.slice(1)).toEqual([
            " * a.md   [overwrite]",
            ">  bb.md  [skip]",
        ]);
    });
});
