// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/textwrap/example_test.go — the runnable examples kept as
// behavioural specs.

import { describe, expect, it } from "vitest";
import { wrap, wrapTokens } from "../../src/textwrap/textwrap.ts";

describe("examples", () => {
    it("wrap reflows a paragraph at width 20", () => {
        const s = "The state-of-the-art solution wraps text nicely.";
        expect(wrap(s, 20)).toBe(
            "The state-of-the-art\nsolution wraps text\nnicely.",
        );
    });

    it("wrapTokens keeps a spaced token whole", () => {
        // A token that contains spaces, such as a Markdown link, stays whole: it
        // is never split at its internal space even on its own line.
        const words = ["click", "[Asset Data](url)", "here"];
        expect(wrapTokens(words, 18)).toBe("click\n[Asset Data](url)\nhere");
    });
});
