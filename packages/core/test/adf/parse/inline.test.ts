// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported 1:1 from pkg/adf/parse_inline_test.go (Test_parseInline_tabular),
// re-baselined to the Obsidian dialect: a directive is an `adf:` inline code
// span instead of the reference `[[…]]`, so a `[[TOC]]` now stays literal text.
// Expected nodes are unchanged — only the input carrier differs. The self-check
// (inlineRoundTrips) is M3.2.

import { describe, expect, it } from "vitest";
import { type ParseCtx, parseInline } from "../../../src/adf/parse/inline.ts";
import type { Mark, Node } from "../../../src/models/adf.ts";

describe("parseInline", () => {
    const strong: Mark[] = [{ type: "strong" }];
    const em: Mark[] = [{ type: "em" }];
    const code: Mark[] = [{ type: "code" }];
    const strike: Mark[] = [{ type: "strike" }];
    const link = (href: string): Mark[] => [{ type: "link", attrs: { href } }];

    const tt: Array<{ testN: string; in: string; pc: ParseCtx; want: Node[] }> =
        [
            {
                testN: "plain text",
                in: "hello world",
                pc: {},
                want: [{ type: "text", text: "hello world" }],
            },
            {
                testN: "strong",
                in: "**bold**",
                pc: {},
                want: [{ type: "text", text: "bold", marks: strong }],
            },
            {
                testN: "em",
                in: "*it*",
                pc: {},
                want: [{ type: "text", text: "it", marks: em }],
            },
            {
                testN: "code is literal",
                in: "`a*b`",
                pc: {},
                want: [{ type: "text", text: "a*b", marks: code }],
            },
            {
                testN: "strike",
                in: "~~no~~",
                pc: {},
                want: [{ type: "text", text: "no", marks: strike }],
            },
            {
                testN: "link",
                in: "[label](http://x)",
                pc: {},
                want: [
                    { type: "text", text: "label", marks: link("http://x") },
                ],
            },
            {
                testN: "text around a mark",
                in: "a **b** c",
                pc: {},
                want: [
                    { type: "text", text: "a " },
                    { type: "text", text: "b", marks: strong },
                    { type: "text", text: " c" },
                ],
            },
            {
                testN: "nested em inside strong",
                in: "**a *b* c**",
                pc: {},
                want: [
                    { type: "text", text: "a ", marks: strong },
                    {
                        type: "text",
                        text: "b",
                        marks: [{ type: "em" }, { type: "strong" }],
                    },
                    { type: "text", text: " c", marks: strong },
                ],
            },
            {
                testN: "mention resolved from the map",
                in: "`adf:@Ann`",
                pc: { mentions: { Ann: "A" } },
                want: [{ type: "mention", attrs: { id: "A", text: "@Ann" } }],
            },
            {
                testN: "mention with an inline id",
                in: "`adf:@Sam|id=S2`",
                pc: {},
                want: [{ type: "mention", attrs: { id: "S2", text: "@Sam" } }],
            },
            {
                testN: "unresolved mention degrades to text",
                in: "`adf:@Ghost`",
                pc: {},
                want: [{ type: "text", text: "@Ghost" }],
            },
            {
                testN: "status directive with color and style",
                in: "`adf:!APPROVED|color=green;style=bold`",
                pc: {},
                want: [
                    {
                        type: "status",
                        attrs: {
                            text: "APPROVED",
                            color: "green",
                            style: "bold",
                        },
                    },
                ],
            },
            {
                testN: "status directive defaults a missing color to neutral",
                in: "`adf:!TODO`",
                pc: {},
                want: [
                    {
                        type: "status",
                        attrs: { text: "TODO", color: "neutral" },
                    },
                ],
            },
            {
                testN: "date directive takes ts as authoritative",
                in: "`adf:#2024-07-06|ts=1720224000000`",
                pc: {},
                want: [{ type: "date", attrs: { timestamp: "1720224000000" } }],
            },
            {
                testN: "emoji directive rebuilds shortName and id",
                in: "`adf::smile|id=1f604`",
                pc: {},
                want: [
                    {
                        type: "emoji",
                        attrs: { shortName: ":smile:", id: "1f604" },
                    },
                ],
            },
            {
                testN: "a bare colon is literal text",
                in: "ready at 12:30 sharp",
                pc: {},
                want: [{ type: "text", text: "ready at 12:30 sharp" }],
            },
            {
                testN: "a generic directive builds an unknown node",
                in: "`adf:*wibble:x|y=z`",
                pc: {},
                want: [{ type: "wibble", attrs: { text: "x", y: "z" } }],
            },
            {
                testN: "a sigil-less double bracket stays literal",
                in: "[[TOC]]",
                pc: {},
                want: [{ type: "text", text: "[[TOC]]" }],
            },
            {
                testN: "an autolink becomes an inlineCard",
                in: "<https://example.com/x>",
                pc: {},
                want: [
                    {
                        type: "inlineCard",
                        attrs: { url: "https://example.com/x" },
                    },
                ],
            },
            {
                testN: "a non-URL angle span stays literal",
                in: "a <br> b",
                pc: {},
                want: [{ type: "text", text: "a <br> b" }],
            },
            {
                testN: "an escaped asterisk is literal",
                in: String.raw`2 \* 3`,
                pc: {},
                want: [{ type: "text", text: "2 * 3" }],
            },
            {
                testN: "an escaped bracket defuses a link",
                in: String.raw`\[x](y)`,
                pc: {},
                want: [{ type: "text", text: "[x](y)" }],
            },
            {
                testN: "a doubled backslash is one literal backslash",
                in: String.raw`a \\ b`,
                pc: {},
                want: [{ type: "text", text: String.raw`a \ b` }],
            },
            {
                testN: "a backslash before a plain char stays literal",
                in: String.raw`c:\dir`,
                pc: {},
                want: [{ type: "text", text: String.raw`c:\dir` }],
            },
            {
                testN: "a variable-length fence reads an inner backtick",
                in: "``a`b``",
                pc: {},
                want: [{ type: "text", text: "a`b", marks: code }],
            },
            {
                testN: "a padded fence strips one surrounding space",
                in: "`` `x` ``",
                pc: {},
                want: [{ type: "text", text: "`x`", marks: code }],
            },
            {
                testN: "an escaped bracket in a link label is unescaped",
                in: String.raw`[a\]b](u)`,
                pc: {},
                want: [{ type: "text", text: "a]b", marks: link("u") }],
            },
            {
                testN: "an angle-form destination carries a space",
                in: "[d](<my file>)",
                pc: {},
                want: [{ type: "text", text: "d", marks: link("my file") }],
            },
            {
                testN: "a quoted directive key with a separator re-parses",
                in: '`adf:*wibble:x|"a;b"=c`',
                pc: {},
                want: [{ type: "wibble", attrs: { text: "x", "a;b": "c" } }],
            },
        ];

    for (const tc of tt) {
        it(tc.testN, () => {
            expect(parseInline(tc.in, tc.pc)).toEqual(tc.want);
        });
    }
});
