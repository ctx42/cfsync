// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported 1:1 from pkg/adf/markdown_test.go (Test_escapeInline). The escaping is
// dialect-stable: it mirrors the inline parser's opener checks, so a character
// is escaped precisely when leaving it raw would begin a construct. The
// directive/wikilink carriers change in M2.2; this suite tracks the Go dialect
// until then, per the M2.1 scope decision.

import { describe, expect, it } from "vitest";
import { escapeInline } from "../../../src/adf/render/escape.ts";

describe("escapeInline", () => {
    const tt: Array<{ testN: string; in: string; want: string }> = [
        {
            testN: "asterisk is always escaped",
            in: "2 * 3",
            want: String.raw`2 \* 3`,
        },
        {
            testN: "backtick is always escaped",
            in: "a `b` c",
            want: "a \\`b\\` c",
        },
        {
            testN: "backslash is doubled",
            in: String.raw`a \ b`,
            want: String.raw`a \\ b`,
        },
        {
            testN: "double tilde is escaped once",
            in: "x ~~y",
            want: String.raw`x \~~y`,
        },
        {
            testN: "a link pattern is defused",
            in: "see [a](b)",
            want: String.raw`see \[a](b)`,
        },
        {
            testN: "a directive opener is escaped",
            in: "[[!x]]",
            want: String.raw`\[[!x]]`,
        },
        {
            testN: "an autolink opener is escaped",
            in: "<http://x>",
            want: String.raw`\<http://x>`,
        },
        { testN: "a lone tilde is left clean", in: "~/path", want: "~/path" },
        {
            testN: "a clock colon is left clean",
            in: "at 12:30",
            want: "at 12:30",
        },
        {
            testN: "an email at-sign is left clean",
            in: "a@ex.com",
            want: "a@ex.com",
        },
        {
            testN: "a bare double bracket is left clean",
            in: "[[TOC]]",
            want: "[[TOC]]",
        },
        {
            testN: "a non-link bracket is left clean",
            in: "item [1] here",
            want: "item [1] here",
        },
        {
            testN: "a stray angle is left clean",
            in: "a < b > c",
            want: "a < b > c",
        },
    ];

    for (const tc of tt) {
        it(tc.testN, () => {
            expect(escapeInline(tc.in)).toBe(tc.want);
        });
    }

    describe("in a link label", () => {
        it("escapes both brackets so the label round-trips", () => {
            expect(escapeInline("a [1] b", true)).toBe(String.raw`a \[1\] b`);
            expect(escapeInline("x]y", true)).toBe(String.raw`x\]y`);
        });

        it("still leaves a non-bracket character clean", () => {
            expect(escapeInline("plain text", true)).toBe("plain text");
        });
    });
});
