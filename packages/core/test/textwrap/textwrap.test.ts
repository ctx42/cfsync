// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported 1:1 from pkg/textwrap/textwrap_test.go. The tabular `Wrap` cases read
// the 8 golden fixtures reused verbatim from the Go suite.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { wrap, wrapTokens } from "../../src/textwrap/textwrap.ts";
import { loadGolden, metaInt, metaString } from "../support/golden.ts";

const TESTDATA = fileURLToPath(new URL("./testdata/", import.meta.url));

describe("wrap (golden fixtures)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
        ["basic reflow", "basic.yml"],
        ["hyphenated word stays intact", "hyphenated.yml"],
        ["over-long token overflows its line", "overflow.yml"],
        ["double-width runes", "double_width.yml"],
        ["whitespace collapses", "collapse.yml"],
        ["width zero means no limit", "no_limit.yml"],
        ["empty input", "empty.yml"],
        ["all whitespace input", "whitespace.yml"],
    ];

    it.each(cases)("%s", (_name, file) => {
        const golden = loadGolden(TESTDATA + file);

        const have = wrap(
            metaString(golden, "input"),
            metaInt(golden, "width"),
        );

        expect(have).toBe(golden.body);
    });
});

describe("wrapTokens", () => {
    const cases: ReadonlyArray<{
        name: string;
        words: string[];
        width: number;
        want: string;
    }> = [
        {
            name: "a token keeps its inner spaces intact",
            words: ["see", "[Asset Data](url)", "now"],
            width: 14,
            want: "see\n[Asset Data](url)\nnow",
        },
        {
            name: "an over-long token overflows its own line",
            words: ["a", "[very long label](url)", "b"],
            width: 5,
            want: "a\n[very long label](url)\nb",
        },
        {
            name: "width zero means no limit",
            words: ["a", "b c", "d"],
            width: 0,
            want: "a b c d",
        },
        {
            name: "negative width means no limit",
            words: ["a", "b c", "d"],
            width: -1,
            want: "a b c d",
        },
        {
            name: "no words yields empty",
            words: [],
            width: 10,
            want: "",
        },
    ];

    it.each(cases)("$name", ({ words, width, want }) => {
        expect(wrapTokens(words, width)).toBe(want);
    });
});
