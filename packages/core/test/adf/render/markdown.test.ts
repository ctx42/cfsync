// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/markdown_test.go: the inline-render cases
// (Test_renderTextRun_tabular). Go exercises renderText only through the block
// renderers (paragraphs, M2.3); the two renderText cases here cover its own
// paths — mark nesting under a link wrapper, and the literal code-span branch.

import { describe, expect, it } from "vitest";
import { renderText, renderTextRun } from "../../../src/adf/render/markdown.ts";
import type { Node } from "../../../src/models/adf.ts";

describe("renderTextRun", () => {
    const strike = { type: "strike" };
    const strong = { type: "strong" };

    const tt: Array<{ testN: string; run: Node[]; want: string }> = [
        {
            testN: "shared mark hoisted across the boundary",
            run: [
                { type: "text", text: "SC-9:", marks: [strike, strong] },
                { type: "text", text: " Track it.", marks: [strike] },
            ],
            want: "~~**SC-9:** Track it.~~",
        },
        {
            testN: "adjacent equal marks merge without an empty run",
            run: [
                { type: "text", text: "a", marks: [strong] },
                { type: "text", text: "b", marks: [strong] },
            ],
            want: "**ab**",
        },
        {
            testN: "a mark on one node only wraps that node",
            run: [
                { type: "text", text: "a", marks: [strong] },
                { type: "text", text: "b" },
            ],
            want: "**a**b",
        },
        {
            testN: "plain nodes concatenate",
            run: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
            ],
            want: "ab",
        },
        {
            testN: "underline wraps in an HTML tag pair",
            run: [{ type: "text", text: "u", marks: [{ type: "underline" }] }],
            want: "<u>u</u>",
        },
        {
            testN: "textColor carries its color in a span",
            run: [
                {
                    type: "text",
                    text: "red",
                    marks: [{ type: "textColor", attrs: { color: "#ff0000" } }],
                },
            ],
            want: `<span style="color:#ff0000">red</span>`,
        },
        {
            testN: "same-color span merges across the boundary",
            run: [
                {
                    type: "text",
                    text: "a",
                    marks: [{ type: "textColor", attrs: { color: "#0a0" } }],
                },
                {
                    type: "text",
                    text: "b",
                    marks: [{ type: "textColor", attrs: { color: "#0a0" } }],
                },
            ],
            want: `<span style="color:#0a0">ab</span>`,
        },
    ];

    for (const tc of tt) {
        it(tc.testN, () => {
            expect(renderTextRun(tc.run)).toBe(tc.want);
        });
    }
});

describe("renderText", () => {
    it("nests marks inside a link wrapper", () => {
        const nod: Node = {
            type: "text",
            text: "hi",
            marks: [
                { type: "strong" },
                { type: "link", attrs: { href: "http://x" } },
            ],
        };

        expect(renderText(nod, {})).toBe("[**hi**](http://x)");
    });

    it("renders a code-marked node as a literal backtick span", () => {
        const nod: Node = {
            type: "text",
            text: "a*b",
            marks: [{ type: "code" }],
        };

        // The code span is literal: its "*" is not escaped.
        expect(renderText(nod, {})).toBe("`a*b`");
    });

    it("widens the fence for a backtick in the content", () => {
        const nod: Node = {
            type: "text",
            text: "a`b",
            marks: [{ type: "code" }],
        };
        expect(renderText(nod, {})).toBe("``a`b``");
    });

    it("pads a space when the content edge is a backtick", () => {
        const nod: Node = {
            type: "text",
            text: "`x`",
            marks: [{ type: "code" }],
        };
        expect(renderText(nod, {})).toBe("`` `x` ``");
    });

    it("escapes a bracket in a link label", () => {
        const nod: Node = {
            type: "text",
            text: "see [1]",
            marks: [{ type: "link", attrs: { href: "x.md" } }],
        };
        expect(renderText(nod, {})).toBe(String.raw`[see \[1\]](x.md)`);
    });

    it("wraps a link destination with a space in angle brackets", () => {
        const nod: Node = {
            type: "text",
            text: "d",
            marks: [{ type: "link", attrs: { href: "my file.md" } }],
        };
        expect(renderText(nod, {})).toBe("[d](<my file.md>)");
    });
});
