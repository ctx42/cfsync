// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/parse_inline_test.go (Test_inlineRoundTrips, FuzzInline).
// The corpus is ADF nodes, so it is dialect-independent — the self-check renders
// then reparses, and holds iff render and parse are inverse. The fuzz seeds are
// re-baselined to the Obsidian carriers where they spelled a directive.

import { describe, expect, it } from "vitest";
import type { Links } from "../../../src/adf/links.ts";
import { parseInline } from "../../../src/adf/parse/inline.ts";
import {
    inlineRoundTrips,
    inlineSig,
    sigEqual,
} from "../../../src/adf/parse/selfcheck.ts";
import { inlineString, type MdCtx } from "../../../src/adf/render/markdown.ts";
import type { Node } from "../../../src/models/adf.ts";

// slugDropLinks is a many-to-one Links mirroring the real mapper: toLocal maps a
// pulled page URL to a local target dropping the host and title slug, so
// toRemote(toLocal(href)) !== href.
const slugDropLinks: Links = {
    toLocal: (href) =>
        href.includes("/pages/1")
            ? { target: "page.md", label: "P" }
            : undefined,
    toRemote: (target) =>
        target.split("#")[0] === "page.md"
            ? "/wiki/spaces/X/pages/1"
            : undefined,
};

const ctx: MdCtx = {};
const pc = { mentions: { Ann: "A" } };

describe("inlineRoundTrips", () => {
    it("supported runs round-trip", () => {
        const corpus: Node[][] = [
            [{ type: "text", text: "just words" }],
            [{ type: "text", text: "bold", marks: [{ type: "strong" }] }],
            [
                { type: "text", text: "a " },
                { type: "text", text: "b", marks: [{ type: "em" }] },
            ],
            [
                {
                    type: "text",
                    text: "link",
                    marks: [{ type: "link", attrs: { href: "http://x" } }],
                },
            ],
            [{ type: "mention", attrs: { id: "A", text: "@Ann" } }],
            [
                { type: "text", text: "see " },
                { type: "mention", attrs: { id: "A", text: "@Ann" } },
                { type: "text", text: " now" },
            ],
            [
                { type: "text", text: "state: " },
                {
                    type: "status",
                    attrs: { text: "APPROVED", color: "green", style: "bold" },
                },
            ],
            [
                { type: "text", text: "see " },
                { type: "inlineCard", attrs: { url: "https://example.com/x" } },
            ],
            [
                { type: "text", text: "due " },
                { type: "date", attrs: { timestamp: "1720224000000" } },
            ],
            [
                {
                    type: "emoji",
                    attrs: { shortName: ":smile:", id: "1f604", text: "😄" },
                },
            ],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
        }
    });

    it("a link href with balanced parens round-trips", () => {
        const nodes: Node[] = [
            {
                type: "text",
                text: "channel",
                marks: [
                    {
                        type: "link",
                        attrs: { href: "g.md#Channel-(Data-Channel)-(CH)" },
                    },
                ],
            },
        ];
        expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
    });

    it("a link with a normalized remote form round-trips", () => {
        const lc: MdCtx = { links: slugDropLinks };
        const lp = { links: slugDropLinks };
        const nodes: Node[] = [
            {
                type: "text",
                text: "see",
                marks: [
                    {
                        type: "link",
                        attrs: { href: "https://s/wiki/spaces/X/pages/1/Slug" },
                    },
                ],
            },
        ];
        expect(inlineRoundTrips(nodes, lc, lp)).toBe(true);
    });

    it("a status keeping its color is not flattened", () => {
        const green: Node[] = [
            { type: "status", attrs: { text: "OK", color: "green" } },
        ];
        const red: Node[] = [
            { type: "status", attrs: { text: "OK", color: "red" } },
        ];
        expect(inlineRoundTrips(green, ctx, pc)).toBe(true);
        expect(sigEqual(inlineSig(green, null), inlineSig(red, null))).toBe(
            false,
        );
    });

    it("underline and textColor round-trip", () => {
        const corpus: Node[][] = [
            [{ type: "text", text: "u", marks: [{ type: "underline" }] }],
            [
                {
                    type: "text",
                    text: "c",
                    marks: [{ type: "textColor", attrs: { color: "#ff0000" } }],
                },
            ],
            [
                {
                    type: "text",
                    text: "both",
                    marks: [
                        { type: "underline" },
                        { type: "strong" },
                        { type: "textColor", attrs: { color: "#0a0" } },
                    ],
                },
            ],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
        }
    });

    it("a textColor recolor is not silently flattened", () => {
        const red: Node[] = [
            {
                type: "text",
                text: "x",
                marks: [{ type: "textColor", attrs: { color: "#f00" } }],
            },
        ];
        const blue: Node[] = [
            {
                type: "text",
                text: "x",
                marks: [{ type: "textColor", attrs: { color: "#00f" } }],
            },
        ];
        expect(sigEqual(inlineSig(red, null), inlineSig(blue, null))).toBe(
            false,
        );
    });

    it("a node-level layout mark stays read-only", () => {
        const corpus: Node[][] = [
            [
                {
                    type: "text",
                    text: "x",
                    marks: [{ type: "alignment", attrs: { align: "center" } }],
                },
            ],
            [
                {
                    type: "text",
                    text: "x",
                    marks: [
                        { type: "backgroundColor", attrs: { color: "#ff0" } },
                    ],
                },
            ],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(false);
        }
    });

    it("literal underline and color markup round-trips", () => {
        const corpus: Node[][] = [
            [{ type: "text", text: "write <u>tags</u> literally" }],
            [
                {
                    type: "text",
                    text: 'a <span style="color:red">literal</span> tag',
                },
            ],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
        }
    });

    it("a node with a non-string attr stays read-only", () => {
        const nodes: Node[] = [
            {
                type: "inlineExtension",
                attrs: { extensionKey: "x", parameters: { a: "b" } },
            },
        ];
        expect(inlineRoundTrips(nodes, ctx, pc)).toBe(false);
    });

    it("unknown inline node round-trips as a directive", () => {
        const nodes: Node[] = [
            { type: "mediaInline", attrs: { id: "m1", collection: "c" } },
        ];
        expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
    });

    it("literal markup characters round-trip via escaping", () => {
        const corpus: Node[][] = [
            [{ type: "text", text: "2 * 3 = 6" }],
            [{ type: "text", text: "use `code` sparingly" }],
            [{ type: "text", text: "a ~~ b" }],
            [{ type: "text", text: "see [note](x) here" }],
            [{ type: "text", text: "write a [[!status]] tag literally" }],
            [{ type: "text", text: "and a [[@name]] mention verbatim" }],
            [{ type: "text", text: "quote <https://x/y> verbatim" }],
            [{ type: "text", text: String.raw`a backslash \ here` }],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
        }
    });

    it("a clock colon and email at-sign are left clean", () => {
        const corpus: Node[][] = [
            [{ type: "text", text: "meet at 12:30 today" }],
            [{ type: "text", text: "mail me at a@example.com" }],
            [{ type: "text", text: "a < b and c > d" }],
            [{ type: "text", text: "list item [1] not a link" }],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
        }
    });

    it("a code span containing backticks round-trips (variable fence)", () => {
        const corpus: Node[][] = [
            [{ type: "text", text: "a`b", marks: [{ type: "code" }] }],
            [{ type: "text", text: "``x``", marks: [{ type: "code" }] }],
            [{ type: "text", text: "`", marks: [{ type: "code" }] }],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
        }
    });

    it("significant code-span whitespace round-trips and is not flattened", () => {
        const two: Node[] = [
            { type: "text", text: "a  b", marks: [{ type: "code" }] },
        ];
        const one: Node[] = [
            { type: "text", text: "a b", marks: [{ type: "code" }] },
        ];
        expect(inlineRoundTrips(two, ctx, pc)).toBe(true);
        expect(sigEqual(inlineSig(two, null), inlineSig(one, null))).toBe(
            false,
        );
    });

    it("brackets and ]( in a link label round-trip", () => {
        const corpus: Node[][] = [
            [
                {
                    type: "text",
                    text: "see [1]",
                    marks: [{ type: "link", attrs: { href: "x.md" } }],
                },
            ],
            [
                {
                    type: "text",
                    text: "a](b",
                    marks: [{ type: "link", attrs: { href: "u.md" } }],
                },
            ],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
        }
    });

    it("significant link-label whitespace is not flattened", () => {
        const two: Node[] = [
            {
                type: "text",
                text: "a  b",
                marks: [{ type: "link", attrs: { href: "u.md" } }],
            },
        ];
        const one: Node[] = [
            {
                type: "text",
                text: "a b",
                marks: [{ type: "link", attrs: { href: "u.md" } }],
            },
        ];
        expect(inlineRoundTrips(two, ctx, pc)).toBe(true);
        expect(sigEqual(inlineSig(two, null), inlineSig(one, null))).toBe(
            false,
        );
    });

    it("a link destination with a space or unbalanced paren round-trips", () => {
        const corpus: Node[][] = [
            [
                {
                    type: "text",
                    text: "doc",
                    marks: [{ type: "link", attrs: { href: "my file.md" } }],
                },
            ],
            [
                {
                    type: "text",
                    text: "doc",
                    marks: [{ type: "link", attrs: { href: "a)b.md" } }],
                },
            ],
        ];
        for (const nodes of corpus) {
            expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
        }
    });

    it("a directive attribute key with a separator round-trips", () => {
        const nodes: Node[] = [
            { type: "wibble", attrs: { text: "x", "a;b": "c" } },
        ];
        expect(inlineRoundTrips(nodes, ctx, pc)).toBe(true);
    });
});

describe("parseInline robustness (fuzz seeds)", () => {
    // Seeds ported from Go's FuzzInline; directive seeds re-baselined to `adf:`.
    const seeds = [
        "",
        "plain",
        "**b**",
        "*i*",
        "`c`",
        "~~s~~",
        "[l](u)",
        "`adf:@Ann`",
        "`adf:@Sam|id=S2`",
        "**a *b* c**",
        "unbalanced **",
        "[bad",
        "`open",
        "a*b*c",
        "***",
        "`adf:@`",
        String.raw`\|b|id=c`,
        "[a](b)(c)",
        "`adf:!OK|color=green`",
        "`adf:!a`",
        "`adf:!|color=x;style=y`",
        "`adf:*wibble:x|y=z`",
        "12:30",
        "`adf:!a\\`b|color=grey`",
        '`adf:!x|k="a b"`',
        "`adf:!",
        "[[",
        "`adf:!x|bad",
        "<https://example.com/x>",
        "<br>",
        "<not a url>",
        "<unterminated",
        String.raw`\*`,
        String.raw`\\`,
        "\\",
        String.raw`2 \* 3`,
        String.raw`\[x](y)`,
        String.raw`c:\dir`,
        String.raw`a \~~ b`,
        "`adf:#2024-07-06|ts=1720224000000`",
        "`adf:#|ts=`",
        "`adf:#x`",
        "`adf::smile|id=1f604`",
        "`adf::x`",
        "`adf::`",
        "`adf:*mediaInline:|collection=c;id=m1`",
        "`adf:*foo:bar|a=b;c=d`",
        "`adf:*x:y`",
        "`adf:*3d:x`",
        "[[TOC]]",
        "`adf:*Foo:X`",
        "`adf:*foo:`",
        "<u>x</u>",
        "<u>a **b** c</u>",
        "<u>open",
        "<u></u>",
        '<span style="color:#ff0000">red</span>',
        '<span style="color:">e</span>',
        '<span style="color:a"b">bad</span>',
        '<span style="color:red">no close',
    ];

    for (const s of seeds) {
        it(`does not break the round-trip invariant on ${JSON.stringify(s)}`, () => {
            const nodes = parseInline(s, pc);
            // A run reported round-trippable must re-render to a run with the same
            // signature — the invariant push relies on.
            if (inlineRoundTrips(nodes, ctx, pc)) {
                const rendered = inlineString(
                    { type: "paragraph", content: nodes },
                    ctx,
                );
                const reparsed = parseInline(rendered, pc);
                expect(
                    sigEqual(inlineSig(nodes, null), inlineSig(reparsed, null)),
                ).toBe(true);
            }
        });
    }
});
