// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/markdown_test.go — the inline-directive cases
// (Test_Node_renderDirective_tabular, Test_Node_renderInline_generic,
// Test_Node_renderMention, Test_Node_renderInlineCard), re-baselined to the
// Obsidian dialect. Only the OUTER carrier changes: Go's `[[…]]` becomes an
// `adf:` inline code span; the inner sigil / `|` / `;` grammar, canonical attr
// order and quoting port verbatim. The content/attr terminator is now the
// span's closing backtick, so the backslash-escape set swaps `]` for a backtick
// and the read-only placeholder swaps Go's `<!-- … -->` for a `%%adf:…%%`
// comment.

import { describe, expect, it } from "vitest";
import type { Links } from "../../../src/adf/links.ts";
import {
    renderDirective,
    renderInlineCard,
    renderMention,
} from "../../../src/adf/render/directives.ts";
import { renderInline } from "../../../src/adf/render/markdown.ts";
import type { Node } from "../../../src/models/adf.ts";

describe("renderDirective", () => {
    const tt: Array<{ testN: string; nod: Node; want: string }> = [
        {
            testN: "status with color and style",
            nod: {
                type: "status",
                attrs: { text: "APPROVED", color: "green", style: "bold" },
            },
            want: "`adf:!APPROVED|color=green;style=bold`",
        },
        {
            testN: "status defaults a missing color to neutral",
            nod: { type: "status", attrs: { text: "TODO" } },
            want: "`adf:!TODO|color=neutral`",
        },
        {
            testN: "a default style is omitted",
            nod: {
                type: "status",
                attrs: { text: "OK", color: "blue", style: "default" },
            },
            want: "`adf:!OK|color=blue`",
        },
        {
            testN: "a backtick in the label is escaped",
            nod: { type: "status", attrs: { text: "a`b", color: "grey" } },
            // The span terminator is a backtick, so it is what gets escaped
            // (Go escaped the `]` that closed a `[[…]]` directive).
            want: "`adf:!a\\`b|color=grey`",
        },
        {
            testN: "date shows the human day with ts authoritative",
            nod: { type: "date", attrs: { timestamp: "1720224000000" } },
            want: "`adf:#2024-07-06|ts=1720224000000`",
        },
        {
            testN: "a numeric timestamp is accepted",
            nod: { type: "date", attrs: { timestamp: 1720224000000 } },
            want: "`adf:#2024-07-06|ts=1720224000000`",
        },
        {
            testN: "emoji shows the shortName with id",
            nod: {
                type: "emoji",
                attrs: { shortName: ":smile:", id: "1f604", text: "😄" },
            },
            want: "`adf::smile|id=1f604`",
        },
        {
            testN: "emoji without an id omits it",
            nod: { type: "emoji", attrs: { shortName: ":wave:", text: "👋" } },
            want: "`adf::wave`",
        },
        {
            testN: "an attribute key with a separator is quoted",
            nod: { type: "wibble", attrs: { text: "x", "a;b": "c" } },
            want: '`adf:*wibble:x|"a;b"=c`',
        },
    ];

    for (const tc of tt) {
        it(tc.testN, () => {
            expect(renderDirective(tc.nod)).toBe(tc.want);
        });
    }
});

describe("renderInline generic", () => {
    it("an unknown all-string node renders as a directive", () => {
        const nod: Node = {
            type: "mediaInline",
            attrs: { id: "m1", collection: "c", localId: "drop" },
        };

        // attrs sorted by key, text content empty, localId dropped.
        expect(renderInline(nod, {})).toBe(
            "`adf:*mediaInline:|collection=c;id=m1`",
        );
    });

    it("a non-string attr keeps the placeholder", () => {
        const nod: Node = {
            type: "inlineExtension",
            attrs: { extensionKey: "x", localId: "e1", parameters: { a: "b" } },
        };

        expect(renderInline(nod, {})).toBe(
            `%%adf:inlineExtension localId="e1"%%`,
        );
    });
});

describe("renderMention", () => {
    it("an unambiguous mention renders as an adf mention span", () => {
        const nod: Node = {
            type: "mention",
            attrs: { id: "acc-1", text: "@Rafal" },
        };

        expect(renderMention(nod, {})).toBe("`adf:@Rafal`");
    });

    it("an ambiguous name carries the id inline", () => {
        const nod: Node = {
            type: "mention",
            attrs: { id: "acc-1", text: "@Rafal" },
        };
        const ctx = { ambig: { Rafal: true } };

        expect(renderMention(nod, ctx)).toBe("`adf:@Rafal|id=acc-1`");
    });
});

describe("renderInlineCard", () => {
    it("renders as an autolink", () => {
        const nod: Node = {
            type: "inlineCard",
            attrs: { url: "https://example.com/x", localId: "c" },
        };

        expect(renderInline(nod, {})).toBe("<https://example.com/x>");
    });

    it("a url with a space falls back to a placeholder", () => {
        const nod: Node = {
            type: "inlineCard",
            attrs: { url: "https://example.com/a b", localId: "c" },
        };

        expect(renderInline(nod, {})).toBe(`%%adf:inlineCard localId="c"%%`);
    });

    it("a url with an angle bracket or CR falls back to a placeholder", () => {
        for (const url of ["https://x/<y>", "https://x/a\rb"]) {
            const nod: Node = {
                type: "inlineCard",
                attrs: { url, localId: "c" },
            };
            expect(renderInline(nod, {})).toBe(
                `%%adf:inlineCard localId="c"%%`,
            );
        }
    });

    it("a card targeting a pulled page becomes a local link", () => {
        const nod: Node = {
            type: "inlineCard",
            attrs: { url: "https://x/wiki/page/42", localId: "c" },
        };
        const links: Links = {
            toLocal: (href) =>
                href === "https://x/wiki/page/42"
                    ? { target: "docs/note.md", label: "The Note" }
                    : undefined,
            toRemote: () => undefined,
        };

        expect(renderInlineCard(nod, { links })).toBe(
            "[The Note](docs/note.md)",
        );
    });
});
