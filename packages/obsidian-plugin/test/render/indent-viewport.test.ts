// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    type IndentDecoration,
    planIndentDecorations,
} from "../../src/render/indent.ts";
import {
    blockScanStart,
    planViewportDecorations,
} from "../../src/render/indent-livepreview.ts";

/** getter turns a line array into the lazy `lineText(n)` accessor the helpers use. */
function getter(lines: string[]): (n: number) => string {
    return (n) => lines[n] ?? "";
}

describe("blockScanStart", () => {
    it("returns the viewport start when it is already a marker line", () => {
        const lines = ["1> a", "cont", "", "2> b"];
        expect(blockScanStart(getter(lines), 0)).toBe(0);
        expect(blockScanStart(getter(lines), 3)).toBe(3);
    });

    it("backs up over continuation lines to the owning marker", () => {
        const lines = ["1> a", "cont1", "cont2"];
        expect(blockScanStart(getter(lines), 2)).toBe(0);
        expect(blockScanStart(getter(lines), 1)).toBe(0);
    });

    it("stops at a blank boundary above the viewport", () => {
        const lines = ["plain", "", "1> a", "cont"];
        // Line 3 ("cont") backs up to its marker at line 2.
        expect(blockScanStart(getter(lines), 3)).toBe(2);
        // A blank first-visible line is itself a boundary; do not cross it.
        expect(blockScanStart(getter(lines), 1)).toBe(1);
    });

    it("stops at line 0 for a leading plain paragraph", () => {
        const lines = ["plain1", "plain2"];
        expect(blockScanStart(getter(lines), 1)).toBe(0);
    });
});

/** visibleOf keeps only the decorations for absolute lines within [from, to]. */
function visibleOf(
    decos: IndentDecoration[],
    from: number,
    to: number,
): IndentDecoration[] {
    return decos.filter((d) => d.line >= from && d.line <= to);
}

describe("planViewportDecorations", () => {
    // The scoped plan must equal the full-document plan restricted to the
    // visible lines — for every viewport window over a representative document.
    const doc = [
        "1> alpha", // 0  marker, level 1
        "wrapped", //  1  continuation of line 0
        "more wrap", // 2  continuation of line 0
        "", //           3  blank boundary
        "plain para", // 4  plain (no marker)
        "3> beta", //    5  marker, level 3
        "beta cont", //  6  continuation of line 5
        "2> gamma", //   7  marker (ends line 5's block with no blank between)
        "", //           8  blank
        "10> delta", //  9  marker, level 10
    ];

    it("matches the full-document plan for every viewport window", () => {
        const full = planIndentDecorations(doc, new Set());
        for (let from = 0; from < doc.length; from++) {
            for (let to = from; to < doc.length; to++) {
                const scoped = planViewportDecorations(
                    getter(doc),
                    from,
                    to,
                    new Set(),
                );
                expect(
                    visibleOf(scoped, from, to),
                    `viewport [${from}, ${to}]`,
                ).toEqual(visibleOf(full, from, to));
            }
        }
    });

    it("keeps a wrapped paragraph's level when the viewport opens mid-paragraph", () => {
        // Viewport starts on line 2 (a continuation of the level-1 marker on
        // line 0). Without back-expansion the planner would miss its level.
        const scoped = planViewportDecorations(getter(doc), 2, 2, new Set());
        expect(scoped).toContainEqual({
            line: 2,
            level: 1,
            markerFrom: 0,
            markerTo: 0,
            hideMarker: false,
        });
    });

    it("reveals the marker for a line under the cursor inside the viewport", () => {
        // Editing line 0 (absolute) is inside the viewport [0, 2].
        const scoped = planViewportDecorations(getter(doc), 0, 2, new Set([0]));
        const first = scoped.find((d) => d.line === 0);
        expect(first?.hideMarker).toBe(false);
    });

    it("returns absolute line indices offset by the expanded start", () => {
        // Viewport [6, 7] expands back to the marker on line 5; indices stay
        // absolute (5, 6, 7), never slice-relative.
        const scoped = planViewportDecorations(getter(doc), 6, 7, new Set());
        expect(scoped.map((d) => d.line)).toEqual([5, 6, 7]);
    });

    it("produces strictly ascending line indices (RangeSetBuilder requirement)", () => {
        const scoped = planViewportDecorations(
            getter(doc),
            0,
            doc.length - 1,
            new Set(),
        );
        const linesOut = scoped.map((d) => d.line);
        for (let i = 1; i < linesOut.length; i++) {
            expect(linesOut[i]).toBeGreaterThanOrEqual(linesOut[i - 1] ?? -1);
        }
    });
});
