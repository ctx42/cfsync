// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    isEscapedMarker,
    MAX_INDENT_LEVEL,
    parseIndentMarker,
    planIndentDecorations,
} from "../../src/render/indent.ts";

describe("parseIndentMarker", () => {
    it("parses a level-1 marker", () => {
        expect(parseIndentMarker("1> hello")).toEqual({
            level: 1,
            markerLen: 3,
        });
    });

    it("parses a multi-digit level", () => {
        expect(parseIndentMarker("10> deep")).toEqual({
            level: 10,
            markerLen: 4,
        });
    });

    it("returns null for a non-marker line", () => {
        expect(parseIndentMarker("hello 1> world")).toBeNull();
        expect(parseIndentMarker("> quote")).toBeNull();
        expect(parseIndentMarker("1>no-space")).toBeNull();
    });

    it("returns null for the escaped form", () => {
        expect(parseIndentMarker("\\2> literal")).toBeNull();
    });

    it("clamps an absurd level to MAX_INDENT_LEVEL", () => {
        expect(parseIndentMarker("999> x")?.level).toBe(MAX_INDENT_LEVEL);
    });
});

describe("isEscapedMarker", () => {
    it("detects the escaped form", () => {
        expect(isEscapedMarker("\\2> literal")).toBe(true);
    });
    it("rejects a real marker and plain text", () => {
        expect(isEscapedMarker("2> real")).toBe(false);
        expect(isEscapedMarker("plain")).toBe(false);
    });
});

describe("planIndentDecorations", () => {
    it("plans a single indented line, hiding the marker", () => {
        const decos = planIndentDecorations(["1> hello"], new Set());
        expect(decos).toEqual([
            { line: 0, level: 1, markerFrom: 0, markerTo: 3, hideMarker: true },
        ]);
    });

    it("reveals the marker on the line being edited", () => {
        const decos = planIndentDecorations(["1> hello"], new Set([0]));
        expect(decos[0]?.hideMarker).toBe(false);
    });

    it("ignores non-indented and escaped lines", () => {
        expect(planIndentDecorations(["plain", "\\2> lit"], new Set())).toEqual(
            [],
        );
    });

    it("indents wrapped continuation lines at the paragraph level", () => {
        // A margin>0 paragraph: first line has the marker, the next non-blank
        // line is an aligned continuation, then a blank line ends the paragraph.
        const decos = planIndentDecorations(
            ["1> aaa", "   bbb", ""],
            new Set(),
        );
        expect(decos.map((d) => d.line)).toEqual([0, 1]);
        expect(decos[1]).toMatchObject({ level: 1, hideMarker: false });
        expect(decos[1]?.markerFrom).toBe(decos[1]?.markerTo); // nothing hidden
    });

    it("treats a line starting with its own marker as a new paragraph, not a continuation", () => {
        const decos = planIndentDecorations(["1> aaa", "2> bbb"], new Set());
        expect(decos).toEqual([
            { line: 0, level: 1, markerFrom: 0, markerTo: 3, hideMarker: true },
            { line: 1, level: 2, markerFrom: 0, markerTo: 3, hideMarker: true },
        ]);

        const decosEditingSecond = planIndentDecorations(
            ["1> aaa", "2> bbb"],
            new Set([1]),
        );
        expect(decosEditingSecond[1]?.hideMarker).toBe(false);
    });
});
