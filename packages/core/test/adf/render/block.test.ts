// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/markdown_test.go — the block-render cases. Headings,
// paragraphs (`N>` indent), lists, tables/`«`/kv, code blocks, and callouts
// (panel/blockquote/expand, kept in the reference `> [!TYPE]` form) are dialect-
// stable and port 1:1. Re-baselined to the Obsidian dialect: local media → an
// `![[file]]` embed, and frozen blocks (TOC, macros, media anchors) → a
// `` ```adf `` YAML fenced block.

import { describe, expect, it } from "vitest";
import { renderBlock, renderMedia } from "../../../src/adf/render/markdown.ts";
import type { Mark, Node } from "../../../src/models/adf.ts";

const ctx = {};
// wrapCtx enables soft-wrapping so the wrap-specific cases below have an effect;
// the default `ctx` (no margin) leaves block text unwrapped.
const wrapCtx = { margin: 80 };

describe("renderBlock hardBreak", () => {
    it("a paragraph hardBreak becomes a backslash break", () => {
        const nod: Node = {
            type: "paragraph",
            content: [
                { type: "text", text: "alpha beta" },
                { type: "hardBreak" },
                { type: "text", text: "gamma delta" },
            ],
        };
        expect(renderBlock(nod, ctx)).toBe("alpha beta\\\ngamma delta");
    });

    it("each hardBreak segment soft-wraps on its own", () => {
        const long = "word ".repeat(20).trim();
        const nod: Node = {
            type: "paragraph",
            content: [
                { type: "text", text: long },
                { type: "hardBreak" },
                { type: "text", text: "tail" },
            ],
        };
        const lines = renderBlock(nod, wrapCtx).split("\n");
        expect(lines.length).toBeGreaterThan(2);
        expect(lines[lines.length - 2]!.endsWith("\\")).toBe(true);
        expect(lines[lines.length - 1]).toBe("tail");
    });

    it("a one-line hardBreak renders as an HTML break", () => {
        const nod: Node = {
            type: "heading",
            attrs: { level: 2 },
            content: [
                { type: "text", text: "a" },
                { type: "hardBreak" },
                { type: "text", text: "b" },
            ],
        };
        expect(renderBlock(nod, ctx)).toBe("## a<br>b");
    });

    it("an unbalanced bracket does not disable later soft-wrapping", () => {
        // A stray `[` must not wedge the token splitter: the words after it must
        // still wrap. The escaped bracket keeps it a literal `[`, not a link.
        const nod: Node = {
            type: "paragraph",
            content: [
                {
                    type: "text",
                    text: `start \\[ ${"word ".repeat(20).trim()}`,
                },
            ],
        };
        const lines = renderBlock(nod, { margin: 20 }).split("\n");
        expect(lines.length).toBeGreaterThan(1);
    });

    it("keeps a code span with spaces whole across a wrap", () => {
        const nod: Node = {
            type: "paragraph",
            content: [
                { type: "text", text: `${"word ".repeat(12).trim()} ` },
                { type: "text", text: "a b c d", marks: [{ type: "code" }] },
            ],
        };
        const lines = renderBlock(nod, { margin: 20 }).split("\n");
        expect(lines.some((ln) => ln.includes("`a b c d`"))).toBe(true);
    });
});

describe("renderBlock extension", () => {
    it("a toc macro renders as a frozen adf block", () => {
        const nod: Node = {
            type: "extension",
            attrs: { extensionKey: "toc", localId: "e1" },
        };
        expect(renderBlock(nod, ctx)).toBe(
            "```adf\ntype: toc\nlocalId: e1\n```",
        );
    });

    it("another macro renders as a frozen adf anchor block", () => {
        const nod: Node = {
            type: "extension",
            attrs: { extensionKey: "chart", localId: "e2" },
        };
        expect(renderBlock(nod, ctx)).toBe(
            "```adf\ntype: extension\nextensionKey: chart\nlocalId: e2\n```",
        );
    });
});

describe("renderMedia", () => {
    it("renders an embed when the asset resolves", () => {
        const nod: Node = {
            type: "media",
            attrs: { type: "file", localId: "L1", alt: "pic.jpg" },
        };
        const assets = { L1: "../_cfsync-media/F1-L1.jpg" };
        expect(renderMedia(nod, assets)).toBe("![[F1-L1.jpg]]");
    });

    it("falls back to a frozen adf anchor block without an asset", () => {
        const nod: Node = {
            type: "media",
            attrs: { type: "file", localId: "L1", alt: "pic.jpg", id: "F1" },
        };
        expect(renderMedia(nod, {})).toBe(
            "```adf\ntype: media\nalt: pic.jpg\nid: F1\nlocalId: L1\n```",
        );
    });

    it("renders external media as an image from its url", () => {
        const nod: Node = {
            type: "media",
            attrs: {
                type: "external",
                url: "https://example.com/p.png",
                alt: "P",
            },
        };
        expect(renderMedia(nod, {})).toBe("![P](https://example.com/p.png)");
    });

    it("external media without a url renders an anchor block", () => {
        const nod: Node = { type: "media", attrs: { type: "external" } };
        expect(renderMedia(nod, {})).toBe("```adf\ntype: media\n```");
    });
});

describe("renderBlock paragraph indentation", () => {
    const indent = (level: number): Mark[] => [
        { type: "indentation", attrs: { level } },
    ];

    it("an indented paragraph gets an N> marker", () => {
        const nod: Node = {
            type: "paragraph",
            marks: indent(1),
            content: [{ type: "text", text: "hello world" }],
        };
        expect(renderBlock(nod, ctx)).toBe("1> hello world");
    });

    it("continuation lines align under the text", () => {
        const long = "word ".repeat(30).trim();
        const nod: Node = {
            type: "paragraph",
            marks: indent(2),
            content: [{ type: "text", text: long }],
        };
        const lines = renderBlock(nod, wrapCtx).split("\n");
        expect(lines.length).toBeGreaterThan(1);
        expect(lines[0]!.startsWith("2> word")).toBe(true);
        expect(lines[1]!.startsWith("   word")).toBe(true);
    });

    it("a level-zero paragraph is unmarked", () => {
        const nod: Node = {
            type: "paragraph",
            content: [{ type: "text", text: "plain" }],
        };
        expect(renderBlock(nod, ctx)).toBe("plain");
    });

    it("literal text that looks like a marker is escaped", () => {
        const nod: Node = {
            type: "paragraph",
            content: [{ type: "text", text: "3> a reply quote" }],
        };
        expect(renderBlock(nod, ctx)).toBe("\\3> a reply quote");
    });
});

describe("renderBlock blockquote", () => {
    const quote = (...texts: string[]): Node => ({
        type: "blockquote",
        content: texts.map((tx) => ({
            type: "paragraph",
            content: [{ type: "text", text: tx }],
        })),
    });

    it("a single-paragraph quote gets a > marker", () => {
        expect(renderBlock(quote("to be or not"), ctx)).toBe("> to be or not");
    });

    it("it carries no [!TYPE] tag, unlike a panel", () => {
        const panel: Node = {
            type: "panel",
            attrs: { panelType: "info" },
            content: [
                {
                    type: "paragraph",
                    content: [{ type: "text", text: "note" }],
                },
            ],
        };
        expect(renderBlock(quote("note"), ctx)).toBe("> note");
        expect(renderBlock(panel, ctx)).toBe("> [!INFO]\n> note");
    });

    it("two paragraphs are separated by a bare > line", () => {
        expect(renderBlock(quote("one", "two"), ctx)).toBe("> one\n>\n> two");
    });
});

describe("renderBlock expand", () => {
    const expand = (title: string, ...texts: string[]): Node => ({
        type: "expand",
        attrs: { title },
        content: texts.map((tx) => ({
            type: "paragraph",
            content: [{ type: "text", text: tx }],
        })),
    });

    it("the title rides the [!EXPAND] tag line", () => {
        expect(renderBlock(expand("Details", "the body"), ctx)).toBe(
            "> [!EXPAND] Details\n> the body",
        );
    });

    it("an empty title leaves a bare tag", () => {
        expect(renderBlock(expand("", "the body"), ctx)).toBe(
            "> [!EXPAND]\n> the body",
        );
    });

    it("two paragraphs are separated by a bare > line", () => {
        expect(renderBlock(expand("T", "one", "two"), ctx)).toBe(
            "> [!EXPAND] T\n> one\n>\n> two",
        );
    });

    it("a panel typed expand falls back to an anchor block", () => {
        const nod: Node = {
            type: "panel",
            attrs: { panelType: "expand", localId: "p1" },
            content: [
                { type: "paragraph", content: [{ type: "text", text: "x" }] },
            ],
        };
        expect(renderBlock(nod, ctx)).toBe(
            "```adf\ntype: panel\nlocalId: p1\npanelType: expand\n```",
        );
    });
});

describe("renderBlock bulletList", () => {
    const item = (...texts: string[]): Node => ({
        type: "listItem",
        content: texts.map((tx) => ({
            type: "paragraph",
            content: [{ type: "text", text: tx }],
        })),
    });
    const list = (...items: Node[]): Node => ({
        type: "bulletList",
        content: items,
    });

    it("single-paragraph items render tight", () => {
        expect(renderBlock(list(item("first"), item("second")), ctx)).toBe(
            "- first\n- second",
        );
    });

    it("a multi-paragraph item separates its paragraphs", () => {
        expect(renderBlock(list(item("lead para", "follow para")), ctx)).toBe(
            "- lead para\n\n  follow para",
        );
    });

    it("a nested sub-list renders indented under its item", () => {
        const nested = list(item("sub one"), item("sub two"));
        const outer: Node = {
            type: "bulletList",
            content: [
                {
                    type: "listItem",
                    content: [
                        {
                            type: "paragraph",
                            content: [{ type: "text", text: "top" }],
                        },
                        nested,
                    ],
                },
            ],
        };
        expect(renderBlock(outer, ctx)).toBe(
            "- top\n\n  - sub one\n  - sub two",
        );
    });
});

describe("renderBlock orderedList", () => {
    const item = (...texts: string[]): Node => ({
        type: "listItem",
        content: texts.map((tx) => ({
            type: "paragraph",
            content: [{ type: "text", text: tx }],
        })),
    });
    const list = (attrs: Node["attrs"], ...items: Node[]): Node => ({
        type: "orderedList",
        ...(attrs !== undefined ? { attrs } : {}),
        content: items,
    });

    it("items number sequentially from one", () => {
        expect(
            renderBlock(list(undefined, item("first"), item("second")), ctx),
        ).toBe("1. first\n2. second");
    });

    it("numbering starts at the order attribute", () => {
        expect(
            renderBlock(list({ order: 3 }, item("first"), item("second")), ctx),
        ).toBe("3. first\n4. second");
    });

    it("a multi-paragraph item aligns under its marker", () => {
        expect(
            renderBlock(list(undefined, item("lead para", "follow para")), ctx),
        ).toBe("1. lead para\n\n   follow para");
    });
});

describe("renderBlock table", () => {
    const cell = (kind: string, text: string, attrs?: Node["attrs"]): Node => ({
        type: kind,
        ...(attrs !== undefined ? { attrs } : {}),
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const row = (...cells: Node[]): Node => ({
        type: "tableRow",
        content: cells,
    });
    const th = (text: string, attrs?: Node["attrs"]): Node =>
        cell("tableHeader", text, attrs);
    const td = (text: string, attrs?: Node["attrs"]): Node =>
        cell("tableCell", text, attrs);

    it("a colspan cell marks the columns it covers", () => {
        const tbl: Node = {
            type: "table",
            content: [row(th("A"), th("B")), row(td("wide", { colspan: 2 }))],
        };
        expect(renderBlock(tbl, ctx)).toBe(
            "| A    | B |\n|------|---|\n| wide | « |",
        );
    });

    it("a rowspan cell marks the rows below it", () => {
        const tbl: Node = {
            type: "table",
            content: [
                row(th("A"), th("B")),
                row(td("tall", { rowspan: 2 }), td("x")),
                row(td("y")),
            ],
        };
        expect(renderBlock(tbl, ctx)).toBe(
            "| A    | B |\n|------|---|\n| tall | x |\n| «    | y |",
        );
    });

    it("an escaped cell pipe is not a column break", () => {
        const status: Node = {
            type: "status",
            attrs: { text: "In progress", color: "blue", style: "bold" },
        };
        const statusCell: Node = {
            type: "tableCell",
            content: [{ type: "paragraph", content: [status] }],
        };
        const tbl: Node = {
            type: "table",
            content: [row(th("State"), statusCell)],
        };
        // The directive's `|` is escaped so the row keeps two cells; the status
        // renders in its `adf:` span carrier. col0 fits `**State**` (9), col1
        // the 41-wide escaped span.
        const c1 = "`adf:!In progress\\|color=blue;style=bold`";
        expect(renderBlock(tbl, ctx)).toBe(
            [
                `|${" ".repeat(11)}|${" ".repeat(43)}|`,
                `|${"-".repeat(11)}|${"-".repeat(43)}|`,
                `| **State** | ${c1} |`,
            ].join("\n"),
        );
    });

    it("a key/value table: blank header, bold keys", () => {
        const tbl: Node = {
            type: "table",
            content: [
                row(th("Name"), td("Widget")),
                row(th("Type"), td("Gadget")),
            ],
        };
        expect(renderBlock(tbl, ctx)).toBe(
            "|          |        |\n" +
                "|----------|--------|\n" +
                "| **Name** | Widget |\n" +
                "| **Type** | Gadget |",
        );
    });
});

describe("renderBlock codeBlock", () => {
    it("renders a fenced block with its language", () => {
        const nod: Node = {
            type: "codeBlock",
            attrs: { language: "go" },
            content: [{ type: "text", text: "a := 1\nb := 2" }],
        };
        expect(renderBlock(nod, ctx)).toBe("```go\na := 1\nb := 2\n```");
    });

    it("renders a fence with no language when unset", () => {
        const nod: Node = {
            type: "codeBlock",
            content: [{ type: "text", text: "plain" }],
        };
        expect(renderBlock(nod, ctx)).toBe("```\nplain\n```");
    });
});
