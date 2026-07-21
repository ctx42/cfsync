// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/blocks_test.go (Test_normalizeBlock_tabular,
// Test_segmentBody), plus the splitTableRow round-trip assertions carried over
// from the render table test. The segmentation/normalization is dialect-stable.
// baselineBlocks and the source-map-backed Test_segmentBody_matches_render /
// Test_ADF_baselineBlocks land with the source map in M5.2.

import { describe, expect, it } from "vitest";
import {
    normalizeBlock,
    segmentBody,
    splitTableRow,
} from "../../../src/adf/parse/blocks.ts";
import { escapeTableCell } from "../../../src/adf/render/table.ts";

describe("normalizeBlock", () => {
    const tt: Array<{ testN: string; in: string; want: string }> = [
        {
            testN: "collapses soft wrap",
            in: "one two\nthree four",
            want: "one two three four",
        },
        {
            testN: "trims and collapses runs",
            in: "  a   b\t c \n",
            want: "a b c",
        },
        { testN: "keeps a hard break marker", in: "a\\\nb", want: "a\\ b" },
        {
            testN: "canonicalizes a table, dropping padding and separator width",
            in: "| a | b |\n|-----|-----|\n| c | d |",
            want: "|a|b| |-| |c|d|",
        },
        {
            testN: "a table with differing widths normalizes the same",
            in: "| a  | b |\n|---|---|\n| cc | d |",
            want: "|a|b| |-| |cc|d|",
        },
        {
            testN: "a single-column dash data cell is kept, not read as a separator",
            in: "| h |\n|---|\n| --- |",
            want: "|h| |-| |---|",
        },
        {
            testN: "significant whitespace in a code span is preserved",
            in: "text `a  b` more",
            want: "text `a  b` more",
        },
        {
            testN: "significant whitespace in a link label is preserved",
            in: "see [a  b](u) now",
            want: "see [a  b](u) now",
        },
        {
            testN: "a non-breaking space is content, not collapsed layout",
            in: "a  b",
            want: "a  b",
        },
        { testN: "empty stays empty", in: "   \n  ", want: "" },
    ];

    for (const tc of tt) {
        it(tc.testN, () => {
            expect(normalizeBlock(tc.in)).toBe(tc.want);
        });
    }
});

describe("segmentBody", () => {
    it("splits on blank lines and trims", () => {
        const have = segmentBody(
            "# Title\n\nfirst para\nwrapped\n\n\nsecond para\n",
        );
        expect(have.map((b) => b.text)).toEqual([
            "# Title",
            "first para\nwrapped",
            "second para",
        ]);
    });

    it("keeps a fenced code block whole", () => {
        const have = segmentBody(
            "intro\n\n```go\nx := 1\n\ny := 2\n```\n\ntail",
        );
        expect(have.map((b) => b.text)).toEqual([
            "intro",
            "```go\nx := 1\n\ny := 2\n```",
            "tail",
        ]);
    });

    it("keeps a multi-paragraph list whole", () => {
        const have = segmentBody(
            "intro\n\n- one lead\n\n  one follow\n- two\n\ntail",
        );
        expect(have.map((b) => b.text)).toEqual([
            "intro",
            "- one lead\n\n  one follow\n- two",
            "tail",
        ]);
    });

    it("a blank line after a list ends it", () => {
        const have = segmentBody("- a\n- b\n\nafter");
        expect(have.map((b) => b.text)).toEqual(["- a\n- b", "after"]);
    });

    it("an empty body yields no blocks", () => {
        expect(segmentBody("")).toHaveLength(0);
        expect(segmentBody("\n\n  \n")).toHaveLength(0);
    });
});

describe("splitTableRow", () => {
    it("recovers a cell whose directive pipe is escaped", () => {
        const cells = splitTableRow(
            "| **State** | `adf:!In progress\\|color=blue;style=bold` |",
        );
        expect(cells).toEqual([
            "**State**",
            "`adf:!In progress|color=blue;style=bold`",
        ]);
    });

    it("round-trips a cell holding a backslash and a pipe", () => {
        const text = String.raw`a\b|c`;
        const escaped = escapeTableCell(text);
        expect(escaped).toBe(String.raw`a\\b\|c`);
        expect(splitTableRow(`| ${escaped} |`)).toEqual([text]);
    });
});
