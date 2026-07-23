// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/reconstruct_test.go. The first half is the M4.2 subset: the
// leaf machinery (paragraphs, headings, the `N>` indent marker), structural
// insert/delete/reorder of leaves, and the GetPut no-op law where a container
// block is copied verbatim. The second half (from "put nestedBlocks" on) is M4.3:
// the container rebuilders (bullet/ordered lists, panels, expands, blockquotes,
// tables), structured and image inserts, and the FuzzMerge invariants. The
// dedicated validatePut property test is M4.4.
//
// Directive bodies are re-baselined to the `adf:` carrier (Go's `[[…]]` → an
// `adf:…` inline code span); the inner sigil/`|`/`;` grammar is unchanged, and
// the toc macro renders as a frozen ```adf block, so its bodies derive from the
// live render rather than a `[[TOC]]` literal.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    type NewImage,
    put,
    putLinks,
} from "../../../src/adf/lens/reconstruct.ts";
import type { Links } from "../../../src/adf/links.ts";
import { indentLevel } from "../../../src/adf/render/markdown.ts";
import {
    marshallMapped,
    marshallMarkdownAssets,
    marshallMarkdownMapped,
    orderedMarkerWidth,
} from "../../../src/index.ts";
import {
    type ADF,
    attrInt,
    attrStr,
    type Node,
    newADF,
} from "../../../src/models/adf.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** renderBody renders adf and returns its body without frontmatter or the trailing newline. */
function renderBody(adf: ADF, assets: Record<string, string> = {}): string {
    const [md, sm] = marshallMarkdownMapped(adf, assets);
    return md.slice(sm.bodyStart).replace(/\n$/, "");
}

/** json is the canonical string used to assert byte-identical documents (GetPut). */
const json = (adf: ADF): string => JSON.stringify(adf);

/** texts returns the first text child of each top-level node. */
const texts = (adf: ADF): string[] =>
    (adf.doc.content ?? []).map((n) => n.content?.[0]?.text ?? "");

/** find returns the first descendant-less lookup: the first child of `type`. */
const childOfType = (nodes: Node[], type: string): Node | undefined =>
    nodes.find((n) => n.type === type);

describe("put GetPut (tabular)", () => {
    // GetPut: pushing the body back unchanged must yield a byte-identical
    // document — no edit means no change.
    const cases: Array<{ name: string; data: string }> = [
        {
            name: "paragraphs and a heading",
            data: `{ "title": "T", "id": "1", "version": 3, "space_id": "9",
               "adf": { "type": "doc", "content": [
                  { "type": "heading", "attrs": { "level": 2, "localId": "h" },
                    "content": [ { "type": "text", "text": "Head" } ] },
                  { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
                     { "type": "text", "text": "hello " },
                     { "type": "text", "text": "world", "marks": [ { "type": "strong" } ] } ] }
               ] } }`,
        },
        {
            name: "a non-breaking-space spacer paragraph survives",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "paragraph", "attrs": { "localId": "p1" },
                 "content": [ { "type": "text", "text": "before" } ] },
               { "type": "paragraph", "attrs": { "localId": "sp" },
                 "content": [ { "type": "text", "text": " " } ] },
               { "type": "paragraph", "attrs": { "localId": "p2" },
                 "content": [ { "type": "text", "text": "after" } ] } ] } }`,
        },
        {
            name: "a table is copied verbatim",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "paragraph", "attrs": { "localId": "p" },
                 "content": [ { "type": "text", "text": "intro" } ] },
               { "type": "table", "attrs": { "localId": "t" }, "content": [
                  { "type": "tableRow", "content": [
                     { "type": "tableCell", "content": [ { "type": "paragraph",
                       "content": [ { "type": "text", "text": "A" } ] } ] },
                     { "type": "tableCell", "content": [ { "type": "paragraph",
                       "content": [ { "type": "text", "text": "B" } ] } ] } ] } ] } ] } }`,
        },
        {
            name: "a block alignment mark survives a no-op",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "paragraph", "attrs": { "localId": "p" },
                 "marks": [ { "type": "alignment", "attrs": { "align": "center" } } ],
                 "content": [ { "type": "text", "text": "centered" } ] } ] } }`,
        },
        {
            name: "a panel breakout mark survives a no-op",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
                 "marks": [ { "type": "breakout", "attrs": { "mode": "wide" } } ],
                 "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "wide note" } ] } ] } ] } }`,
        },
    ];

    for (const tc of cases) {
        it(tc.name, () => {
            const base = newADF(tc.data);
            const body = renderBody(base);
            const out = put(base, body, null, null, null);
            expect(json(out)).toBe(json(base));
        });
    }
});

describe("put modify", () => {
    it("edits paragraph text and keeps the localId", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p1" },
             "content": [ { "type": "text", "text": "hello" } ] } ] } }`);
        const out = put(base, "goodbye", null, null, null);
        const para = out.doc.content?.[0];
        expect(para?.type).toBe("paragraph");
        expect(attrStr(para?.attrs, "localId")).toBe("p1");
        expect(para?.content?.length).toBe(1);
        expect(para?.content?.[0]?.text).toBe("goodbye");
    });

    it("detects and applies an edit to whitespace inside a code span", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p1" }, "content": [
              { "type": "text", "text": "a  b",
                "marks": [ { "type": "code" } ] } ] } ] } }`);
        expect(renderBody(base)).toBe("`a  b`");
        // The double space is significant: a keep leaves it, an edit to a single
        // space is seen and applied rather than silently collapsed.
        expect(json(put(base, "`a  b`", null, null, null))).toBe(json(base));
        const out = put(base, "`a b`", null, null, null);
        const t = out.doc.content?.[0]?.content?.[0];
        expect(t?.text).toBe("a b");
        expect(t?.marks?.[0]?.type).toBe("code");
    });

    it("edits a paragraph, keeping underline and color", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "keep " },
              { "type": "text", "text": "styled",
                "marks": [ { "type": "underline" },
                  { "type": "textColor", "attrs": { "color": "#ff0000" } } ] } ] } ] } }`);
        const self = renderBody(base);
        expect(self).toContain(
            '<span style="color:#ff0000"><u>styled</u></span>',
        );
        const out = put(base, self.replace("keep", "KEEP"), null, null, null);

        const styled = out.doc.content?.[0]?.content?.[1];
        expect(styled?.text).toBe("styled");
        let hasU = false;
        let hasC = false;
        for (const m of styled?.marks ?? []) {
            hasU = hasU || m.type === "underline";
            if (m.type === "textColor") {
                hasC = attrStr(m.attrs, "color") === "#ff0000";
            }
        }
        expect(hasU).toBe(true);
        expect(hasC).toBe(true);
    });

    it("editing keeps the block alignment mark", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" },
             "marks": [ { "type": "alignment", "attrs": { "align": "center" } } ],
             "content": [ { "type": "text", "text": "before" } ] } ] } }`);
        const out = put(base, "after", null, null, null);
        const para = out.doc.content?.[0];
        expect(para?.content?.[0]?.text).toBe("after");
        expect(para?.marks?.length).toBe(1);
        expect(para?.marks?.[0]?.type).toBe("alignment");
        expect(attrStr(para?.marks?.[0]?.attrs, "align")).toBe("center");
    });

    it("adds a strong mark from the edited text", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p1" },
             "content": [ { "type": "text", "text": "plain here" } ] } ] } }`);
        const out = put(base, "plain **here**", null, null, null);
        const para = out.doc.content?.[0];
        expect(para?.content?.length).toBe(2);
        expect(para?.content?.[1]?.text).toBe("here");
        expect(para?.content?.[1]?.marks?.[0]?.type).toBe("strong");
    });

    it("edits a heading keeping its level", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "heading", "attrs": { "level": 3, "localId": "h" },
             "content": [ { "type": "text", "text": "Old" } ] } ] } }`);
        const out = put(base, "### New Title", null, null, null);
        const h = out.doc.content?.[0];
        expect(h?.type).toBe("heading");
        expect(attrInt(h?.attrs, "level")).toBe(3);
        expect(h?.content?.[0]?.text).toBe("New Title");
    });

    it("changes a heading level from the hashes", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "heading", "attrs": { "level": 2, "localId": "h" },
             "content": [ { "type": "text", "text": "Title" } ] } ] } }`);
        const out = put(base, "### Title", null, null, null);
        expect(attrInt(out.doc.content?.[0]?.attrs, "level")).toBe(3);
    });

    it("keeps a mention id when editing around it", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "see " },
              { "type": "mention", "attrs": { "id": "A", "text": "@Ann" } } ] } ] } }`);
        const out = put(base, "see `adf:@Ann` now", { Ann: "A" }, null, null);
        const men = childOfType(out.doc.content?.[0]?.content ?? [], "mention");
        expect(attrStr(men?.attrs, "id")).toBe("A");
    });

    it("indentation survives a text edit", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" },
             "marks": [ { "type": "indentation", "attrs": { "level": 1 } } ],
             "content": [ { "type": "text", "text": "old text",
               "marks": [ { "type": "indentation", "attrs": { "level": 1 } } ] } ] } ] } }`);
        const out = put(base, "1> new text", null, null, null);
        const para = out.doc.content?.[0];
        expect(indentLevel(para ?? { type: "" })).toBe(1);
        expect(para?.content?.[0]?.text).toBe("new text");
    });

    it("marker change re-indents, removal de-indents", () => {
        const data = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" },
             "marks": [ { "type": "indentation", "attrs": { "level": 1 } } ],
             "content": [ { "type": "text", "text": "text",
               "marks": [ { "type": "indentation", "attrs": { "level": 1 } } ] } ] } ] } }`;
        const up = put(newADF(data), "3> text", null, null, null);
        expect(indentLevel(up.doc.content?.[0] ?? { type: "" })).toBe(3);
        const flat = put(newADF(data), "text", null, null, null);
        expect(indentLevel(flat.doc.content?.[0] ?? { type: "" })).toBe(0);
    });

    it("keeps an inlineCard when editing around it", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "ticket " },
              { "type": "inlineCard", "attrs": {
                "url": "https://example.com/DOC-42", "localId": "c" } } ] } ] } }`);
        const out = put(
            base,
            "the ticket <https://example.com/DOC-42>",
            null,
            null,
            null,
        );
        const card = childOfType(
            out.doc.content?.[0]?.content ?? [],
            "inlineCard",
        );
        expect(attrStr(card?.attrs, "url")).toBe("https://example.com/DOC-42");
    });

    it("keeps date and emoji when editing around them", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "due " },
              { "type": "date", "attrs": { "timestamp": "1720224000000" } },
              { "type": "text", "text": " " },
              { "type": "emoji", "attrs": {
                "shortName": ":smile:", "id": "1f604", "text": "😄" } } ] } ] } }`);
        const body =
            "shipped due `adf:#2024-07-06|ts=1720224000000` `adf::smile|id=1f604`";
        const out = put(base, body, null, null, null);
        const content = out.doc.content?.[0]?.content ?? [];
        const date = childOfType(content, "date");
        const emoji = childOfType(content, "emoji");
        expect(attrStr(date?.attrs, "timestamp")).toBe("1720224000000");
        expect(attrStr(emoji?.attrs, "shortName")).toBe(":smile:");
    });

    it("keeps a toc macro across a neighbor edit", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "extension", "attrs": {
             "extensionKey": "toc", "localId": "e1" } },
           { "type": "paragraph", "attrs": { "localId": "p" },
             "content": [ { "type": "text", "text": "intro" } ] } ] } }`);
        const body = renderBody(base).replace("intro", "rewritten intro");
        const out = put(base, body, null, null, null);
        const ext = out.doc.content?.[0];
        expect(ext?.type).toBe("extension");
        expect(attrStr(ext?.attrs, "extensionKey")).toBe("toc");
        expect(attrStr(ext?.attrs, "localId")).toBe("e1");
    });

    it("heals a toc frozen as a code block into a live macro", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "codeBlock", "attrs": { "language": "adf" },
             "content": [ { "type": "text",
               "text": "type: toc\\nlocalId: c1e7a4d9b206" } ] },
           { "type": "paragraph", "attrs": { "localId": "p" },
             "content": [ { "type": "text", "text": "intro" } ] } ] } }`);
        const body = renderBody(base).replace("intro", "rewritten intro");
        const out = put(base, body, null, null, null);
        const ext = out.doc.content?.[0];
        expect(ext?.type).toBe("extension");
        expect(attrStr(ext?.attrs, "extensionKey")).toBe("toc");
        expect(attrStr(ext?.attrs, "extensionType")).toBe(
            "com.atlassian.confluence.macro.core",
        );
        expect(attrStr(ext?.attrs, "localId")).toBe("c1e7a4d9b206");
    });

    it("leaves an ordinary code block untouched", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "codeBlock", "attrs": { "language": "go" },
             "content": [ { "type": "text", "text": "x := 1" } ] },
           { "type": "paragraph", "attrs": { "localId": "p" },
             "content": [ { "type": "text", "text": "intro" } ] } ] } }`);
        const body = renderBody(base).replace("intro", "rewritten intro");
        const out = put(base, body, null, null, null);
        expect(out.doc.content?.[0]?.type).toBe("codeBlock");
    });

    it("keeps status color and style across an edit", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "state " },
              { "type": "status", "attrs": {
                "text": "OK", "color": "green", "style": "bold" } } ] } ] } }`);
        const body = "reviewed state `adf:!OK|color=green;style=bold`";
        const out = put(base, body, null, null, null);
        const sta = childOfType(out.doc.content?.[0]?.content ?? [], "status");
        expect(attrStr(sta?.attrs, "text")).toBe("OK");
        expect(attrStr(sta?.attrs, "color")).toBe("green");
        expect(attrStr(sta?.attrs, "style")).toBe("bold");
    });
});

describe("put rejects (tabular)", () => {
    const cases: Array<{
        name: string;
        data: string;
        edit: (body: string) => string;
        want: string;
    }> = [
        {
            name: "editing a toc macro marker is rejected",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "extension", "attrs": {
                 "extensionKey": "toc", "localId": "e1" } } ] } }`,
            edit: (b) => b.replace("type: toc", "type: xyz"),
            want: "only paragraph and heading text is editable",
        },
        {
            name: "editing text next to a non-string-attr node is rejected",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
                  { "type": "text", "text": "hi " },
                  { "type": "inlineExtension", "attrs": {
                    "extensionKey": "x",
                    "parameters": { "a": "b" } } } ] } ] } }`,
            edit: (b) => `changed ${b}`,
            want: "cannot express",
        },
        {
            name: "editing text with an unsupported mark is rejected",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
                  { "type": "text", "text": "hi",
                    "marks": [ { "type": "backgroundColor",
                      "attrs": { "color": "#ff0" } } ] } ] } ] } }`,
            edit: (b) => `changed ${b}`,
            want: "cannot express",
        },
        {
            name: "deleting a read-only block is rejected",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "paragraph", "attrs": { "localId": "p" },
                 "content": [ { "type": "text", "text": "keep" } ] },
               { "type": "table", "attrs": { "localId": "t" }, "content": [
                  { "type": "tableRow", "content": [
                     { "type": "tableCell", "content": [ { "type": "paragraph",
                       "content": [ { "type": "text", "text": "A" } ] } ] } ] } ] } ] } }`,
            edit: () => "keep",
            want: "only paragraph and heading blocks can be deleted",
        },
    ];

    for (const tc of cases) {
        it(tc.name, () => {
            const base = newADF(tc.data);
            const body = tc.edit(renderBody(base));
            expect(() => put(base, body, null, null, null)).toThrow(tc.want);
        });
    }
});

describe("put structural", () => {
    const twoPara = `{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "attrs": { "localId": "p1" },
         "content": [ { "type": "text", "text": "alpha" } ] },
       { "type": "paragraph", "attrs": { "localId": "p2" },
         "content": [ { "type": "text", "text": "beta" } ] } ] } }`;

    it("inserting a paragraph appends a new node", () => {
        const out = put(
            newADF(twoPara),
            "alpha\n\nbeta\n\ngamma",
            null,
            null,
            null,
        );
        expect(texts(out)).toEqual(["alpha", "beta", "gamma"]);
    });

    it("deleting a paragraph keeps the survivor id", () => {
        const out = put(newADF(twoPara), "alpha", null, null, null);
        expect(texts(out)).toEqual(["alpha"]);
        expect(attrStr(out.doc.content?.[0]?.attrs, "localId")).toBe("p1");
    });

    it("reordering paragraphs swaps them", () => {
        const out = put(newADF(twoPara), "beta\n\nalpha", null, null, null);
        expect(texts(out)).toEqual(["beta", "alpha"]);
    });

    it("splitting a paragraph yields two", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" },
             "content": [ { "type": "text", "text": "one two" } ] } ] } }`);
        const out = put(base, "one\n\ntwo", null, null, null);
        expect(texts(out)).toEqual(["one", "two"]);
    });

    it("an inserted heading gets its level", () => {
        const out = put(
            newADF(twoPara),
            "## New\n\nalpha\n\nbeta",
            null,
            null,
            null,
        );
        const h = out.doc.content?.[0];
        expect(h?.type).toBe("heading");
        expect(attrInt(h?.attrs, "level")).toBe(2);
        expect(h?.content?.[0]?.text).toBe("New");
    });

    it("inserted paragraph carries an indent marker", () => {
        const out = put(
            newADF(twoPara),
            "alpha\n\nbeta\n\n2> deep",
            null,
            null,
            null,
        );
        expect(indentLevel(out.doc.content?.[2] ?? { type: "" })).toBe(2);
    });

    // emptyTail is twoPara with a trailing empty paragraph, the invisible node
    // Confluence appends: it renders to nothing, so it carries no baseline block.
    const emptyTail = `{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "attrs": { "localId": "p1" },
         "content": [ { "type": "text", "text": "alpha" } ] },
       { "type": "paragraph", "attrs": { "localId": "p2" },
         "content": [ { "type": "text", "text": "beta" } ] },
       { "type": "paragraph", "attrs": { "localId": "tail" } } ] } }`;

    it("a trailing non-rendered node survives an insert", () => {
        const out = put(
            newADF(emptyTail),
            "alpha\n\nbeta\n\ngamma",
            null,
            null,
            null,
        );
        expect(renderBody(out)).toBe("alpha\n\nbeta\n\ngamma");
        const last = out.doc.content?.[(out.doc.content?.length ?? 0) - 1];
        expect(last?.type).toBe("paragraph");
        expect(attrStr(last?.attrs, "localId")).toBe("tail");
        expect(last?.content?.length ?? 0).toBe(0);
    });

    it("a trailing non-rendered node survives a delete", () => {
        const out = put(newADF(emptyTail), "alpha", null, null, null);
        expect(renderBody(out)).toBe("alpha");
        const last = out.doc.content?.[(out.doc.content?.length ?? 0) - 1];
        expect(attrStr(last?.attrs, "localId")).toBe("tail");
    });

    it("a non-rendered node between blocks stays anchored", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p1" },
             "content": [ { "type": "text", "text": "alpha" } ] },
           { "type": "paragraph", "attrs": { "localId": "gap" } },
           { "type": "paragraph", "attrs": { "localId": "p2" },
             "content": [ { "type": "text", "text": "beta" } ] } ] } }`);
        const out = put(base, "alpha\n\nbeta\n\ngamma", null, null, null);
        expect(renderBody(out)).toBe("alpha\n\nbeta\n\ngamma");
        expect(attrStr(out.doc.content?.[1]?.attrs, "localId")).toBe("gap");
        expect(out.doc.content?.[2]?.content?.[0]?.text).toBe("beta");
    });

    it("NR predecessor stays before a cross-kind replace", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "gap" } },
           { "type": "paragraph", "attrs": { "localId": "p1" },
             "content": [ { "type": "text", "text": "alpha" } ] },
           { "type": "paragraph", "attrs": { "localId": "p2" },
             "content": [ { "type": "text", "text": "beta" } ] } ] } }`);
        const out = put(base, "# Head\n\nbeta", null, null, null);
        expect(renderBody(out)).toBe("# Head\n\nbeta");
        expect(attrStr(out.doc.content?.[0]?.attrs, "localId")).toBe("gap");
        expect(out.doc.content?.[1]?.type).toBe("heading");
        expect(out.doc.content?.[1]?.content?.[0]?.text).toBe("Head");
        expect(out.doc.content?.[2]?.content?.[0]?.text).toBe("beta");
    });
});

describe("put real page round-trips (GetPut)", () => {
    it("pushes the root page's unchanged body back byte-identically", () => {
        const data = readFileSync(
            `${here}../render/testdata/root_page_1.v5.json`,
            "utf8",
        );
        const base = newADF(data);
        const body = renderBody(base);
        const out = put(base, body, null, null, null);
        expect(json(out)).toBe(json(base));
    });
});

describe("orderedMarkerWidth (tabular)", () => {
    const cases: Array<{ name: string; line: string; want: number }> = [
        { name: "single digit marker", line: "1. item", want: 3 },
        { name: "multi digit marker", line: "10. item", want: 4 },
        { name: "leading zeros count", line: "007. item", want: 5 },
        { name: "no marker", line: "- item", want: 0 },
        { name: "digits without dot", line: "12 item", want: 0 },
        { name: "dot without trailing space", line: "1.item", want: 0 },
        { name: "digits then dot at end", line: "1.", want: 0 },
        { name: "empty line", line: "", want: 0 },
    ];
    for (const tc of cases) {
        it(tc.name, () => {
            expect(orderedMarkerWidth(tc.line)).toBe(tc.want);
        });
    }
});

// --- M4.3: container rebuilders, structured/image inserts, fuzz invariants ---

/** itemTexts returns each list item's first-paragraph text at the given top-level index. */
const itemTexts = (adf: ADF, listIdx = 0): string[] =>
    (adf.doc.content?.[listIdx]?.content ?? []).map(
        (li) => li.content?.[0]?.content?.[0]?.text ?? "",
    );

describe("put nestedBlocks", () => {
    it("a code block round-trips and its body is editable", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" },
             "content": [ { "type": "text", "text": "intro" } ] },
           { "type": "codeBlock", "attrs": { "localId": "cb", "language": "go" },
             "content": [ { "type": "text", "text": "x := 1\\ny := 2" } ] } ] } }`);
        const self = renderBody(base);
        expect(self).toContain("```go\nx := 1\ny := 2\n```");

        // GetPut holds byte-for-byte.
        expect(json(put(base, self, null, null, null))).toBe(json(base));

        // Editing the code body rebuilds the block in place, keeping its type,
        // localId and language; PutGet re-renders to exactly the edited body.
        const edited = self.replace("x := 1", "x := 9");
        const out = put(base, edited, null, null, null);
        const cb = out.doc.content?.[1];
        expect(cb?.type).toBe("codeBlock");
        expect(cb?.attrs?.["localId"]).toBe("cb");
        expect(cb?.attrs?.["language"]).toBe("go");
        expect(cb?.content?.[0]?.text).toBe("x := 9\ny := 2");
        expect(renderBody(out)).toBe(edited);
    });

    it("nested sub-list read-only, sibling item edits", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
              { "type": "listItem", "content": [
                 { "type": "paragraph",
                   "content": [ { "type": "text", "text": "top" } ] },
                 { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [ { "type": "paragraph",
                      "content": [ { "type": "text", "text": "sub one" } ] } ] } ] } ] },
              { "type": "listItem", "content": [ { "type": "paragraph",
                "content": [ { "type": "text", "text": "plain item" } ] } ] } ] } ] } }`);
        const self = renderBody(base);
        expect(self).toContain("  - sub one");

        const out = put(
            base,
            self.replace("plain item", "plain edited"),
            null,
            null,
            null,
        );
        const list = out.doc.content?.[0];
        expect(list?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe(
            "plain edited",
        );
        expect(
            list?.content?.[0]?.content?.[1]?.content?.[0]?.content?.[0]
                ?.content?.[0]?.text,
        ).toBe("sub one");

        expect(() =>
            put(base, self.replace("sub one", "sub X"), null, null, null),
        ).toThrow("list item");
    });
});

describe("put mediaGroup", () => {
    const data = `{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "attrs": { "localId": "p" },
         "content": [ { "type": "text", "text": "intro" } ] },
       { "type": "mediaGroup", "attrs": { "localId": "mg" }, "content": [
          { "type": "media", "attrs": {
            "type": "file", "id": "F1", "localId": "L1", "alt": "a.png" } },
          { "type": "media", "attrs": {
            "type": "file", "id": "F2", "localId": "L2", "alt": "b.png" } } ] } ] } }`;
    const assets = {
        L1: "../_cfsync-media/F1-L1.png",
        L2: "../_cfsync-media/F2-L2.png",
    };

    it("an unchanged mediaGroup round-trips (GetPut)", () => {
        const base = newADF(data);
        const body = renderBody(base, assets);
        expect(json(put(base, body, null, assets, null))).toBe(json(base));
    });

    it("editing a mediaGroup image is rejected", () => {
        // Media renders as an Obsidian embed `![[basename]]`, so edit that.
        const base = newADF(data);
        const body = renderBody(base, assets).replace(
            "![[F1-L1.png]]",
            "![[z.png]]",
        );
        expect(() => put(base, body, null, assets, null)).toThrow(
            "cannot edit mediaGroup",
        );
    });
});

describe("put modify (containers)", () => {
    it("editing keeps the panel breakout mark", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
             "marks": [ { "type": "breakout", "attrs": { "mode": "wide" } } ],
             "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "note body" } ] } ] } ] } }`);
        const body = renderBody(base).replace("note body", "note new");
        const out = put(base, body, null, null, null);
        const panel = out.doc.content?.[0];
        expect(panel?.marks?.length).toBe(1);
        expect(panel?.marks?.[0]?.type).toBe("breakout");
        expect(attrStr(panel?.marks?.[0]?.attrs, "mode")).toBe("wide");
        expect(panel?.content?.[0]?.content?.[0]?.text).toBe("note new");
    });
});

describe("put rejects (containers)", () => {
    const cases: Array<{
        name: string;
        data: string;
        edit: (body: string) => string;
        want: string;
    }> = [
        {
            name: "merging the paragraphs of a table cell is rejected",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "table", "attrs": { "localId": "t" }, "content": [
                  { "type": "tableRow", "content": [
                     { "type": "tableCell", "content": [
                       { "type": "paragraph",
                         "content": [ { "type": "text", "text": "A" } ] },
                       { "type": "paragraph",
                         "content": [ { "type": "text", "text": "B" } ] } ] } ] } ] } ] } }`,
            edit: (b) => b.replace("A<br>B", "AB"),
            want: "cannot add or remove a paragraph in table cell",
        },
        {
            name: "editing a table cell holding a code block is rejected",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "table", "attrs": { "localId": "t" }, "content": [
                  { "type": "tableRow", "content": [
                     { "type": "tableCell", "content": [
                       { "type": "paragraph",
                         "content": [ { "type": "text", "text": "N" } ] },
                       { "type": "codeBlock",
                         "content": [ { "type": "text", "text": "code" } ] } ] } ] } ] } ] } }`,
            edit: (b) => b.replace("code", "cody"),
            want: "cannot edit a multi-block table cell",
        },
        {
            name: "inserting a table without a separator row is rejected",
            data: `{ "adf": { "type": "doc", "content": [
               { "type": "paragraph", "attrs": { "localId": "p" },
                 "content": [ { "type": "text", "text": "one" } ] } ] } }`,
            edit: (b) => `${b}\n\n| a | b |`,
            want: "needs a header and a separator row",
        },
    ];

    for (const tc of cases) {
        it(tc.name, () => {
            const base = newADF(tc.data);
            const body = tc.edit(renderBody(base));
            expect(() => put(base, body, null, null, null)).toThrow(tc.want);
        });
    }
});

describe("put structural (containers)", () => {
    it("insert next to a modified list pairs by kind", () => {
        // A paragraph precedes a two-item list. The user modifies the paragraph,
        // inserts a new paragraph, and adds a list item. Kind-aware pairing must
        // pair paragraph↔paragraph and list↔list, not mispair list↔paragraph.
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" },
             "content": [ { "type": "text", "text": "intro" } ] },
           { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
              { "type": "listItem", "content": [ { "type": "paragraph",
                "content": [ { "type": "text", "text": "one" } ] } ] },
              { "type": "listItem", "content": [ { "type": "paragraph",
                "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } }`);
        const out = put(
            base,
            "intro now\n\nadded para\n\n- one\n- two\n- three",
            null,
            null,
            null,
        );
        expect(renderBody(out)).toBe(
            "intro now\n\nadded para\n\n- one\n- two\n- three",
        );
        const list = out.doc.content?.[2];
        expect(list?.type).toBe("bulletList");
        expect(attrStr(list?.attrs, "localId")).toBe("bl");
        expect(list?.content?.length).toBe(3);
    });
});

describe("put nested (lists and panels)", () => {
    const bulletBase = `{ "adf": { "type": "doc", "content": [
       { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
          { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
            { "type": "paragraph",
              "content": [ { "type": "text", "text": "one" } ] } ] },
          { "type": "listItem", "attrs": { "localId": "li2" }, "content": [
            { "type": "paragraph",
              "content": [ { "type": "text", "text": "two" } ] } ] },
          { "type": "listItem", "attrs": { "localId": "li3" }, "content": [
            { "type": "paragraph",
              "content": [ { "type": "text", "text": "three" } ] } ] } ] } ] } }`;

    it("editing one list item leaves the others intact", () => {
        const base = newADF(bulletBase);
        const out = put(
            base,
            renderBody(base).replace("two", "TWO now"),
            null,
            null,
            null,
        );
        const list = out.doc.content?.[0];
        expect(list?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
            "one",
        );
        expect(list?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe(
            "TWO now",
        );
        expect(list?.content?.[2]?.content?.[0]?.content?.[0]?.text).toBe(
            "three",
        );
        expect(attrStr(list?.content?.[1]?.attrs, "localId")).toBe("li2");
    });

    it("deleting the last list item drops it", () => {
        const out = put(newADF(bulletBase), "- one\n- two", null, null, null);
        expect(itemTexts(out)).toEqual(["one", "two"]);
    });

    it("deleting a middle item keeps the survivors' ids", () => {
        const out = put(newADF(bulletBase), "- one\n- three", null, null, null);
        const list = out.doc.content?.[0];
        expect(itemTexts(out)).toEqual(["one", "three"]);
        expect(attrStr(list?.content?.[0]?.attrs, "localId")).toBe("li1");
        expect(attrStr(list?.content?.[1]?.attrs, "localId")).toBe("li3");
    });

    it("appending a list item adds a fresh node", () => {
        const out = put(
            newADF(bulletBase),
            "- one\n- two\n- three\n- four",
            null,
            null,
            null,
        );
        const list = out.doc.content?.[0];
        expect(itemTexts(out)).toEqual(["one", "two", "three", "four"]);
        expect(attrStr(list?.content?.[3]?.attrs, "localId")).toBe("");
        expect(list?.content?.[3]?.type).toBe("listItem");
    });

    it("inserting a list item in the middle keeps order", () => {
        const out = put(
            newADF(bulletBase),
            "- one\n- two\n- inserted\n- three",
            null,
            null,
            null,
        );
        expect(itemTexts(out)).toEqual(["one", "two", "inserted", "three"]);
        expect(
            attrStr(out.doc.content?.[0]?.content?.[3]?.attrs, "localId"),
        ).toBe("li3");
    });

    it("modifying and inserting an item together", () => {
        const out = put(
            newADF(bulletBase),
            "- ONE now\n- two\n- added\n- three",
            null,
            null,
            null,
        );
        expect(itemTexts(out)).toEqual(["ONE now", "two", "added", "three"]);
        expect(
            attrStr(out.doc.content?.[0]?.content?.[0]?.attrs, "localId"),
        ).toBe("li1");
    });

    it("edits one paragraph of a list item", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
              { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
                 { "type": "paragraph",
                   "content": [ { "type": "text", "text": "lead para" } ] },
                 { "type": "paragraph",
                   "content": [ { "type": "text", "text": "follow para" } ] } ] },
              { "type": "listItem", "attrs": { "localId": "li2" }, "content": [
                 { "type": "paragraph",
                   "content": [ { "type": "text", "text": "plain" } ] } ] } ] } ] } }`);
        const out = put(
            base,
            renderBody(base).replace("follow para", "FOLLOW"),
            null,
            null,
            null,
        );
        const li1 = out.doc.content?.[0]?.content?.[0];
        expect(attrStr(li1?.attrs, "localId")).toBe("li1");
        expect(li1?.content?.length).toBe(2);
        expect(li1?.content?.[0]?.content?.[0]?.text).toBe("lead para");
        expect(li1?.content?.[1]?.content?.[0]?.text).toBe("FOLLOW");
        expect(
            out.doc.content?.[0]?.content?.[1]?.content?.[0]?.content?.[0]
                ?.text,
        ).toBe("plain");
    });

    it("hard break sibling survives when another item is edited", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
              { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
                 { "type": "paragraph", "content": [
                    { "type": "text", "text": "alpha" },
                    { "type": "hardBreak" },
                    { "type": "text", "text": "beta" } ] } ] },
              { "type": "listItem", "attrs": { "localId": "li2" }, "content": [
                 { "type": "paragraph",
                   "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } }`);
        const out = put(
            base,
            renderBody(base).replace("two", "TWO"),
            null,
            null,
            null,
        );
        const p1 = out.doc.content?.[0]?.content?.[0]?.content?.[0];
        expect(p1?.content?.length).toBe(3);
        expect(p1?.content?.[0]?.text).toBe("alpha");
        expect(p1?.content?.[1]?.type).toBe("hardBreak");
        expect(p1?.content?.[2]?.text).toBe("beta");
        expect(
            out.doc.content?.[0]?.content?.[1]?.content?.[0]?.content?.[0]
                ?.text,
        ).toBe("TWO");
    });

    it("edits list item text while keeping its hard break", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
              { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
                 { "type": "paragraph", "content": [
                    { "type": "text", "text": "alpha" },
                    { "type": "hardBreak" },
                    { "type": "text", "text": "beta" } ] } ] } ] } ] } }`);
        const out = put(
            base,
            renderBody(base).replace("alpha", "ALPHA"),
            null,
            null,
            null,
        );
        const p1 = out.doc.content?.[0]?.content?.[0]?.content?.[0];
        expect(p1?.content?.length).toBe(3);
        expect(p1?.content?.[0]?.text).toBe("ALPHA");
        expect(p1?.content?.[1]?.type).toBe("hardBreak");
        expect(p1?.content?.[2]?.text).toBe("beta");
    });

    it("editing panel body text keeps its type", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
             "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "hello world" } ] } ] } ] } }`);
        const out = put(
            base,
            renderBody(base).replace("hello world", "bye now"),
            null,
            null,
            null,
        );
        const panel = out.doc.content?.[0];
        expect(attrStr(panel?.attrs, "panelType")).toBe("info");
        expect(panel?.content?.[0]?.content?.[0]?.text).toBe("bye now");
    });

    it("editing one paragraph of a multi-paragraph panel", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "panel", "attrs": { "panelType": "warning", "localId": "pn" },
             "content": [
                { "type": "paragraph",
                  "content": [ { "type": "text", "text": "top note" } ] },
                { "type": "paragraph",
                  "content": [ { "type": "text", "text": "low note" } ] } ] } ] } }`);
        const out = put(
            base,
            renderBody(base).replace("low note", "LOW"),
            null,
            null,
            null,
        );
        const panel = out.doc.content?.[0];
        expect(attrStr(panel?.attrs, "panelType")).toBe("warning");
        expect(panel?.content?.length).toBe(2);
        expect(panel?.content?.[0]?.content?.[0]?.text).toBe("top note");
        expect(panel?.content?.[1]?.content?.[0]?.text).toBe("LOW");
    });
});

describe("put orderedList", () => {
    const orderedBase = `{ "adf": { "type": "doc", "content": [
       { "type": "orderedList",
         "attrs": { "localId": "ol", "order": 1 }, "content": [
          { "type": "listItem", "attrs": { "localId": "li1" }, "content": [
            { "type": "paragraph",
              "content": [ { "type": "text", "text": "one" } ] } ] },
          { "type": "listItem", "attrs": { "localId": "li2" }, "content": [
            { "type": "paragraph",
              "content": [ { "type": "text", "text": "two" } ] } ] },
          { "type": "listItem", "attrs": { "localId": "li3" }, "content": [
            { "type": "paragraph",
              "content": [ { "type": "text", "text": "three" } ] } ] } ] } ] } }`;

    it("an unedited list renders as a numbered block", () => {
        expect(renderBody(newADF(orderedBase))).toBe(
            "1. one\n2. two\n3. three",
        );
    });

    it("editing one item leaves the others and ids intact", () => {
        const base = newADF(orderedBase);
        const out = put(
            base,
            renderBody(base).replace("two", "TWO now"),
            null,
            null,
            null,
        );
        expect(itemTexts(out)).toEqual(["one", "TWO now", "three"]);
        expect(
            attrStr(out.doc.content?.[0]?.content?.[1]?.attrs, "localId"),
        ).toBe("li2");
    });

    it("deleting an item renumbers the survivors", () => {
        const out = put(
            newADF(orderedBase),
            "1. one\n2. three",
            null,
            null,
            null,
        );
        expect(itemTexts(out)).toEqual(["one", "three"]);
        expect(renderBody(out)).toBe("1. one\n2. three");
        expect(
            attrStr(out.doc.content?.[0]?.content?.[1]?.attrs, "localId"),
        ).toBe("li3");
    });

    it("inserting an item adds a fresh idless node", () => {
        const out = put(
            newADF(orderedBase),
            "1. one\n2. two\n3. added\n4. three",
            null,
            null,
            null,
        );
        expect(itemTexts(out)).toEqual(["one", "two", "added", "three"]);
        expect(
            attrStr(out.doc.content?.[0]?.content?.[2]?.attrs, "localId"),
        ).toBe("");
    });
});

describe("put image", () => {
    const base = `{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "attrs": { "localId": "p" },
         "content": [ { "type": "text", "text": "intro" } ] } ] } }`;

    it("inserting an uploaded image adds a media node", () => {
        const img: NewImage = {
            path: "pics/new.png",
            alt: "shot",
            fileId: "F9",
            localId: "abc123def456",
            collection: "contentId-42",
        };
        const out = put(newADF(base), "intro\n\n![[new.png]]", null, null, [
            img,
        ]);
        expect(out.doc.content?.length).toBe(2);
        const media = out.doc.content?.[1];
        expect(media?.type).toBe("mediaSingle");
        expect(media?.content?.length).toBe(1);
        const file = media?.content?.[0];
        expect(file?.type).toBe("media");
        expect(attrStr(file?.attrs, "type")).toBe("file");
        expect(attrStr(file?.attrs, "id")).toBe("F9");
        expect(attrStr(file?.attrs, "localId")).toBe("abc123def456");
        expect(attrStr(file?.attrs, "collection")).toBe("contentId-42");
        expect(attrStr(file?.attrs, "alt")).toBe("shot");
    });

    it("inserting an image with no upload is rejected", () => {
        expect(() =>
            put(newADF(base), "intro\n\n![[untracked.png]]", null, null, null),
        ).toThrow('image "untracked.png" has no uploaded attachment');
    });
});

describe("put blockquote", () => {
    const single = `{ "adf": { "type": "doc", "content": [
       { "type": "blockquote", "attrs": { "localId": "bq" }, "content": [
          { "type": "paragraph",
            "content": [ { "type": "text", "text": "hello world" } ] } ] } ] } }`;

    it("editing the body keeps the blockquote type and id", () => {
        const base = newADF(single);
        const out = put(
            base,
            renderBody(base).replace("hello world", "bye now"),
            null,
            null,
            null,
        );
        const bq = out.doc.content?.[0];
        expect(bq?.type).toBe("blockquote");
        expect(attrStr(bq?.attrs, "localId")).toBe("bq");
        expect(bq?.content?.[0]?.content?.[0]?.text).toBe("bye now");
    });

    it("an unedited blockquote round-trips (GetPut)", () => {
        const base = newADF(single);
        expect(json(put(base, renderBody(base), null, null, null))).toBe(
            json(base),
        );
    });

    const multiPara = `{ "adf": { "type": "doc", "content": [
       { "type": "blockquote", "attrs": { "localId": "bq" }, "content": [
          { "type": "paragraph",
            "content": [ { "type": "text", "text": "first para" } ] },
          { "type": "paragraph",
            "content": [ { "type": "text", "text": "second para" } ] } ] } ] } }`;

    it("edits one paragraph of a blockquote", () => {
        const base = newADF(multiPara);
        const out = put(
            base,
            renderBody(base).replace("first para", "FIRST"),
            null,
            null,
            null,
        );
        const bq = out.doc.content?.[0];
        expect(bq?.content?.length).toBe(2);
        expect(bq?.content?.[0]?.content?.[0]?.text).toBe("FIRST");
        expect(bq?.content?.[1]?.content?.[0]?.text).toBe("second para");
    });

    it("adding a paragraph to a blockquote is rejected", () => {
        const base = newADF(multiPara);
        const body = `${renderBody(base)}\n>\n> extra`;
        expect(() => put(base, body, null, null, null)).toThrow(
            "add or remove a paragraph",
        );
    });
});

describe("put expand", () => {
    const single = `{ "adf": { "type": "doc", "content": [
       { "type": "expand", "attrs": { "localId": "x1", "title": "Details" },
         "content": [
          { "type": "paragraph",
            "content": [ { "type": "text", "text": "hello world" } ] } ] } ] } }`;

    it("editing the body keeps the type, id and title", () => {
        const base = newADF(single);
        const out = put(
            base,
            renderBody(base).replace("hello world", "bye now"),
            null,
            null,
            null,
        );
        const exp = out.doc.content?.[0];
        expect(exp?.type).toBe("expand");
        expect(attrStr(exp?.attrs, "localId")).toBe("x1");
        expect(attrStr(exp?.attrs, "title")).toBe("Details");
        expect(exp?.content?.[0]?.content?.[0]?.text).toBe("bye now");
    });

    it("editing the title on the tag line pushes it", () => {
        const base = newADF(single);
        const out = put(
            base,
            renderBody(base).replace("Details", "More"),
            null,
            null,
            null,
        );
        const exp = out.doc.content?.[0];
        expect(attrStr(exp?.attrs, "title")).toBe("More");
        expect(exp?.content?.[0]?.content?.[0]?.text).toBe("hello world");
    });

    it("an unedited expand round-trips (GetPut)", () => {
        const base = newADF(single);
        expect(json(put(base, renderBody(base), null, null, null))).toBe(
            json(base),
        );
    });

    const empty = `{ "adf": { "type": "doc", "content": [
       { "type": "expand", "attrs": { "localId": "x1" }, "content": [
          { "type": "paragraph",
            "content": [ { "type": "text", "text": "body" } ] } ] } ] } }`;

    it("an untitled expand round-trips through a bare tag", () => {
        const base = newADF(empty);
        const body = renderBody(base);
        expect(body).toBe("> [!EXPAND]\n> body");
        const out = put(base, body, null, null, null);
        expect(attrStr(out.doc.content?.[0]?.attrs, "title")).toBe("");
    });

    const multiBlock = `{ "adf": { "type": "doc", "content": [
       { "type": "expand", "attrs": { "localId": "x1", "title": "T" },
         "content": [
          { "type": "paragraph",
            "content": [ { "type": "text", "text": "para one" } ] },
          { "type": "paragraph",
            "content": [ { "type": "text", "text": "para two" } ] } ] } ] } }`;

    it("adding a paragraph to an expand is rejected", () => {
        const base = newADF(multiBlock);
        const body = `${renderBody(base)}\n>\n> extra`;
        expect(() => put(base, body, null, null, null)).toThrow(
            "add or remove a paragraph",
        );
    });
});

describe("put table", () => {
    const headerRow = `{ "adf": { "type": "doc", "content": [
       { "type": "table", "attrs": { "localId": "t" }, "content": [
          { "type": "tableRow", "content": [
             { "type": "tableHeader", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "Key" } ] } ] },
             { "type": "tableHeader", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "Val" } ] } ] } ] },
          { "type": "tableRow", "content": [
             { "type": "tableCell", "attrs": { "localId": "c1" },
               "content": [ { "type": "paragraph",
                 "content": [ { "type": "text", "text": "one" } ] } ] },
             { "type": "tableCell", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } ] } }`;

    const cell = (adf: ADF, row: number, col: number): Node | undefined =>
        adf.doc.content?.[0]?.content?.[row]?.content?.[col];

    it("editing a data cell keeps structure and localId", () => {
        const base = newADF(headerRow);
        const out = put(
            base,
            renderBody(base).replace("one", "ONE"),
            null,
            null,
            null,
        );
        const c1 = cell(out, 1, 0);
        expect(c1?.type).toBe("tableCell");
        expect(attrStr(c1?.attrs, "localId")).toBe("c1");
        expect(c1?.content?.[0]?.content?.[0]?.text).toBe("ONE");
        expect(cell(out, 1, 1)?.content?.[0]?.content?.[0]?.text).toBe("two");
        expect(cell(out, 0, 0)?.content?.[0]?.content?.[0]?.text).toBe("Key");
    });

    it("editing one paragraph of a multi-paragraph cell", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "attrs": { "localId": "c" }, "content": [
                   { "type": "paragraph",
                     "content": [ { "type": "text", "text": "one" } ] },
                   { "type": "paragraph",
                     "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } ] } }`);
        const self = renderBody(base);
        expect(self).toContain("one<br>two");
        const out = put(
            base,
            self.replace("one<br>two", "ONE<br>two"),
            null,
            null,
            null,
        );
        const c = cell(out, 0, 0);
        expect(attrStr(c?.attrs, "localId")).toBe("c");
        expect(c?.content?.length).toBe(2);
        expect(c?.content?.[0]?.content?.[0]?.text).toBe("ONE");
        expect(c?.content?.[1]?.content?.[0]?.text).toBe("two");
    });

    it("editing a header cell adds a strong mark inline", () => {
        const base = newADF(headerRow);
        const out = put(
            base,
            renderBody(base).replace("Key", "Name"),
            null,
            null,
            null,
        );
        const h = cell(out, 0, 0);
        expect(h?.type).toBe("tableHeader");
        expect(h?.content?.[0]?.content?.[0]?.text).toBe("Name");
    });

    it("editing a bold header cell strips the bold", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableHeader", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "RowH" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "v1" } ] } ] } ] } ] } ] } }`);
        const out = put(
            base,
            renderBody(base).replace("**RowH**", "**NewH**"),
            null,
            null,
            null,
        );
        const h = cell(out, 0, 0);
        expect(h?.type).toBe("tableHeader");
        expect(h?.content?.[0]?.content?.length).toBe(1);
        expect(h?.content?.[0]?.content?.[0]?.text).toBe("NewH");
    });

    it("does not blindly strip bold from a header cell with interior bold", () => {
        // The header-column cell "ab" displays as **ab**. Editing it to two
        // separate bold spans must not have its outer ** sliced off blindly
        // (which would splice a wrong shape past PutGet); it is rejected instead.
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableHeader", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "ab" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "v1" } ] } ] } ] } ] } ] } }`);
        const body = renderBody(base).replace("**ab**", "**a** **b**");
        expect(() => put(base, body, null, null, null)).toThrow(
            /did not round-trip/,
        );
    });

    it("editing a spanning cell keeps its colspan", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "attrs": { "colspan": 2 },
                   "content": [ { "type": "paragraph",
                     "content": [ { "type": "text", "text": "wide" } ] } ] } ] },
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "l" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "r" } ] } ] } ] } ] } ] } }`);
        const out = put(
            base,
            renderBody(base).replace("wide", "WIDE"),
            null,
            null,
            null,
        );
        const wide = cell(out, 0, 0);
        expect(attrInt(wide?.attrs, "colspan")).toBe(2);
        expect(wide?.content?.[0]?.content?.[0]?.text).toBe("WIDE");
    });

    it("editing one cell of the real page table", () => {
        const data = readFileSync(
            `${here}../render/testdata/root_page_1.v5.json`,
            "utf8",
        );
        const base = newADF(data);
        const body = renderBody(base).replace("Access window", "Access period");
        const out = put(base, body, null, null, null);
        const md = marshallMarkdownAssets(out, {});
        expect(md).toContain("Access period");
        expect(md).toContain("[the spec](https://example.com/spec)");
        expect(md).toContain("`adf:@Jane Doe`");
    });

    it("a ragged edit (rows of differing widths) is rejected", () => {
        const base = newADF(headerRow);
        // Only the data row gains a cell, so the table is no longer rectangular.
        const body = renderBody(base).replace("| one ", "| one | x ");
        expect(() => put(base, body, null, null, null)).toThrow(
            "differing column counts",
        );
    });

    it("appending a column adds a cell to every row", () => {
        const base = newADF(headerRow);
        const body = renderBody(base)
            .split("\n")
            .map((ln, i) => {
                if (i === 1) {
                    return `${ln}---|`; // separator gains a column
                }
                return ln.replace(/\|\s*$/, `| ${i === 0 ? "Extra" : "x"} |`);
            })
            .join("\n");
        const out = put(base, body, null, null, null);
        const t = out.doc.content?.[0];
        expect(t?.content?.[0]?.content?.length).toBe(3);
        // The new header-row cell is a tableHeader, so the row stays all-header.
        expect(cell(out, 0, 2)?.type).toBe("tableHeader");
        expect(cell(out, 0, 2)?.content?.[0]?.content?.[0]?.text).toBe("Extra");
        expect(cell(out, 1, 2)?.type).toBe("tableCell");
        expect(cell(out, 1, 2)?.content?.[0]?.content?.[0]?.text).toBe("x");
        // The kept cells keep their localId.
        expect(attrStr(cell(out, 1, 0)?.attrs, "localId")).toBe("c1");
    });

    it("deleting a column drops that cell from every row", () => {
        const base = newADF(headerRow);
        // Keep only the first column of each row.
        const body = renderBody(base)
            .split("\n")
            .map((ln, i) => {
                if (i === 1) {
                    return "|---|";
                }
                const first = ln.split("|").filter((x) => x !== "")[0] ?? "";
                return `| ${first.trim()} |`;
            })
            .join("\n");
        const out = put(base, body, null, null, null);
        expect(out.doc.content?.[0]?.content?.[0]?.content?.length).toBe(1);
        expect(cell(out, 0, 0)?.content?.[0]?.content?.[0]?.text).toBe("Key");
        expect(cell(out, 1, 0)?.content?.[0]?.content?.[0]?.text).toBe("one");
        expect(attrStr(cell(out, 1, 0)?.attrs, "localId")).toBe("c1");
    });

    it("changing the column count of a spanned table is rejected", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "attrs": { "colspan": 2 },
                   "content": [ { "type": "paragraph",
                     "content": [ { "type": "text", "text": "wide" } ] } ] } ] },
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "l" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "r" } ] } ] } ] } ] } ] } }`);
        const body = renderBody(base)
            .split("\n")
            .map((ln, i) =>
                i === 1 ? `${ln}---|` : ln.replace(/\|\s*$/, "| z |"),
            )
            .join("\n");
        expect(() => put(base, body, null, null, null)).toThrow(
            "number of table columns",
        );
    });

    it("adds a row and a column in the same push", () => {
        const base = newADF(headerRow);
        // Widen every row with a new column, then append a whole new row.
        const body = `${renderBody(base)
            .split("\n")
            .map((ln, i) =>
                i === 1
                    ? `${ln}---|`
                    : ln.replace(/\|\s*$/, `| ${i === 0 ? "Extra" : "9"} |`),
            )
            .join("\n")}\n| p | q | r |`;
        const out = put(base, body, null, null, null);
        const t = out.doc.content?.[0];
        expect(t?.content?.length).toBe(3); // header + two data rows
        expect(t?.content?.[0]?.content?.length).toBe(3); // three columns
        // The new column's header stays a tableHeader; the original data cell
        // keeps its localId; the appended row and cell are fresh.
        expect(cell(out, 0, 2)?.type).toBe("tableHeader");
        expect(cell(out, 0, 2)?.content?.[0]?.content?.[0]?.text).toBe("Extra");
        expect(attrStr(cell(out, 1, 0)?.attrs, "localId")).toBe("c1");
        expect(cell(out, 1, 2)?.content?.[0]?.content?.[0]?.text).toBe("9");
        expect(cell(out, 2, 0)?.type).toBe("tableCell");
        expect(cell(out, 2, 2)?.content?.[0]?.content?.[0]?.text).toBe("r");
    });

    it("removes a row and a column in the same push, keeping a survivor's localId", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableHeader", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "A" } ] } ] },
                 { "type": "tableHeader", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "B" } ] } ] },
                 { "type": "tableHeader", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "C" } ] } ] } ] },
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "attrs": { "localId": "keep" },
                   "content": [ { "type": "paragraph",
                     "content": [ { "type": "text", "text": "1" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "2" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "3" } ] } ] } ] },
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "4" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "5" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "6" } ] } ] } ] } ] } ] } }`);
        // Keep only columns A and C, and the header plus the first data row.
        const out = put(
            base,
            "| A | C |\n|---|---|\n| 1 | 3 |",
            null,
            null,
            null,
        );
        const t = out.doc.content?.[0];
        expect(t?.content?.length).toBe(2);
        expect(t?.content?.[0]?.content?.length).toBe(2);
        expect(cell(out, 0, 0)?.content?.[0]?.content?.[0]?.text).toBe("A");
        expect(cell(out, 0, 1)?.content?.[0]?.content?.[0]?.text).toBe("C");
        // Column B and the second data row are gone; the kept cell keeps its id.
        expect(cell(out, 1, 0)?.content?.[0]?.content?.[0]?.text).toBe("1");
        expect(cell(out, 1, 1)?.content?.[0]?.content?.[0]?.text).toBe("3");
        expect(attrStr(cell(out, 1, 0)?.attrs, "localId")).toBe("keep");
    });

    it("names the file line of a refused block", () => {
        const base = newADF(headerRow); // the table is the first body block
        // A ragged edit is refused; the message names the block's line.
        const ragged = renderBody(base).replace("| one ", "| one | x ");
        expect(() => put(base, ragged, null, null, null)).toThrow("(line 1)");
        // With a bodyLine offset (as after frontmatter), the reported line shifts.
        expect(() =>
            putLinks(base, ragged, null, null, null, null, false, 42),
        ).toThrow("(line 42)");
    });

    it("appending a data row inserts a fresh tableRow", () => {
        const base = newADF(headerRow);
        const out = put(
            base,
            `${renderBody(base)}\n| aaa | bbb |`,
            null,
            null,
            null,
        );
        const rows = out.doc.content?.[0]?.content ?? [];
        expect(rows.length).toBe(3);
        const added = rows[2];
        expect(added?.content?.[0]?.type).toBe("tableCell");
        expect(added?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
            "aaa",
        );
        expect(added?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe(
            "bbb",
        );
        // The appended cell carries no localId; Confluence assigns one on save.
        expect(attrStr(added?.content?.[0]?.attrs, "localId")).toBe("");
    });

    it("deleting a data row drops that tableRow", () => {
        const base = newADF(headerRow);
        const body = renderBody(base)
            .split("\n")
            .filter((ln) => !ln.includes("one"))
            .join("\n");
        const out = put(base, body, null, null, null);
        const rows = out.doc.content?.[0]?.content ?? [];
        expect(rows.length).toBe(1);
        expect(cell(out, 0, 0)?.content?.[0]?.content?.[0]?.text).toBe("Key");
    });

    it("inserting a row mid-table keeps the surrounding rows' localIds", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableHeader", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "K" } ] } ] },
                 { "type": "tableHeader", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "V" } ] } ] } ] },
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "attrs": { "localId": "a" },
                   "content": [ { "type": "paragraph",
                     "content": [ { "type": "text", "text": "a" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "1" } ] } ] } ] },
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "attrs": { "localId": "b" },
                   "content": [ { "type": "paragraph",
                     "content": [ { "type": "text", "text": "b" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "2" } ] } ] } ] } ] } ] } }`);
        const lines = renderBody(base).split("\n"); // header, sep, a|1, b|2
        lines.splice(3, 0, "| NEW | 9 |"); // between a|1 and b|2
        const out = put(base, lines.join("\n"), null, null, null);
        const rows = out.doc.content?.[0]?.content ?? [];
        expect(rows.length).toBe(4);
        expect(cell(out, 2, 0)?.content?.[0]?.content?.[0]?.text).toBe("NEW");
        expect(attrStr(cell(out, 1, 0)?.attrs, "localId")).toBe("a");
        expect(attrStr(cell(out, 3, 0)?.attrs, "localId")).toBe("b");
    });

    it("a new row in a key/value table gets a tableHeader first cell", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableHeader", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "K1" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "v1" } ] } ] } ] } ] } ] } }`);
        // The header column renders bolded, so the inserted row's key is **K2**.
        const out = put(
            base,
            `${renderBody(base)}\n| **K2** | v2 |`,
            null,
            null,
            null,
        );
        const added = out.doc.content?.[0]?.content?.[1];
        expect(added?.content?.[0]?.type).toBe("tableHeader");
        // The wrapping bold is stripped; the render re-bolds it, so it round-trips.
        expect(added?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
            "K2",
        );
        expect(added?.content?.[1]?.type).toBe("tableCell");
        expect(added?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe(
            "v2",
        );
    });

    it("changing the row count of a spanned table is rejected", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "attrs": { "colspan": 2 },
                   "content": [ { "type": "paragraph",
                     "content": [ { "type": "text", "text": "wide" } ] } ] } ] },
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "l" } ] } ] },
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ { "type": "text", "text": "r" } ] } ] } ] } ] } ] } }`);
        expect(() =>
            put(base, `${renderBody(base)}\n| x | y |`, null, null, null),
        ).toThrow("number of table rows");
    });
});

describe("put fuzz-seed invariants (FuzzMerge)", () => {
    const data = `{ "adf": { "type": "doc", "content": [
       { "type": "heading", "attrs": { "level": 2, "localId": "h" },
         "content": [ { "type": "text", "text": "Title" } ] },
       { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
          { "type": "text", "text": "hello " },
          { "type": "text", "text": "world", "marks": [ { "type": "strong" } ] },
          { "type": "text", "text": " and ",
            "marks": [ { "type": "underline" } ] },
          { "type": "text", "text": "hue", "marks": [
            { "type": "textColor", "attrs": { "color": "#ff0000" } } ] } ] },
       { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
          { "type": "listItem", "content": [
             { "type": "paragraph",
               "content": [ { "type": "text", "text": "alpha" } ] },
             { "type": "paragraph",
               "content": [ { "type": "text", "text": "alpha two" } ] } ] },
          { "type": "listItem", "content": [
             { "type": "paragraph",
               "content": [ { "type": "text", "text": "beta" } ] },
             { "type": "bulletList", "content": [
                { "type": "listItem", "content": [ { "type": "paragraph",
                  "content": [ { "type": "text", "text": "beta sub" } ] } ] } ] } ] } ] },
       { "type": "codeBlock", "attrs": { "localId": "cb", "language": "go" },
         "content": [ { "type": "text", "text": "n := 1\\nm := 2" } ] },
       { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
         "content": [
            { "type": "paragraph",
              "content": [ { "type": "text", "text": "note here" } ] },
            { "type": "paragraph",
              "content": [ { "type": "text", "text": "note two" } ] } ] },
       { "type": "blockquote", "attrs": { "localId": "bq" }, "content": [
          { "type": "paragraph",
            "content": [ { "type": "text", "text": "quoted line" } ] } ] },
       { "type": "table", "attrs": { "localId": "tb" }, "content": [
          { "type": "tableRow", "content": [
             { "type": "tableHeader", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "Key" } ] } ] },
             { "type": "tableHeader", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "Val" } ] } ] } ] },
          { "type": "tableRow", "content": [
             { "type": "tableCell", "content": [
               { "type": "paragraph",
                 "content": [ { "type": "text", "text": "one" } ] },
               { "type": "paragraph",
                 "content": [ { "type": "text", "text": "cell two" } ] } ] },
             { "type": "tableCell", "content": [ { "type": "paragraph",
               "content": [ { "type": "text", "text": "two" } ] } ] } ] } ] } ] } }`;
    const mentions = { Ann: "A" };
    const base = newADF(data);
    const self = renderBody(base);

    const seeds = [
        self,
        "## Title\n\nhello **world**",
        "## Changed\n\nhello **world**",
        "## Title\n\nhello **world** and more",
        self.replace("hue", "COLOR"),
        self.replace("<u> and </u>", " plain "),
        "## Title\n\n1> hello **world**",
        "## Title\n\nhello `adf:!OK|color=green` world",
        "## Title\n\nsee <https://example.com/x> now",
        self.replace("alpha", "ALPHA edited"),
        self.replace("note here", "note edited"),
        self.replace("one", "ONE cell"),
        self.replace("quoted line", "QUOTED"),
        self.replace("alpha two", "ALPHA TWO edited"),
        self.replace("note two", "note two edited"),
        self.replace("one<br>cell two", "ONE<br>cell two"),
        self.replace("one<br>cell two", "merged"),
        self.replace("beta sub", "beta SUB edited"),
        self.replace("n := 1", "n := 9"),
        "",
    ];

    it("put never returns a nullish document without throwing", () => {
        for (const seed of seeds) {
            let out: ADF | undefined;
            let threw: unknown;
            try {
                out = put(base, seed, mentions, null, null);
            } catch (err) {
                threw = err;
            }
            if (threw !== undefined) {
                expect(threw).toBeInstanceOf(Error);
            } else {
                expect(out).toBeTruthy();
            }
        }
    });

    it("GetPut: the unchanged body rebuilds identically", () => {
        expect(json(put(base, self, mentions, null, null))).toBe(json(base));
    });
});

describe("putLinks force (top-level leaves)", () => {
    // A Links whose stored href for the local target changed: the cached ADF
    // holds OLD, the render maps OLD→target, and a re-parse maps target→NEW.
    const OLD = "/wiki/pages/viewpage.action?pageId=42";
    const NEW = "https://ex.atlassian.net/wiki/spaces/X/pages/42/Other";
    const links: Links = {
        toLocal: (href) =>
            href === OLD || href === NEW
                ? { target: "other.md", label: "Other" }
                : undefined,
        toRemote: (target) => (target === "other.md" ? NEW : undefined),
    };

    const doc = (href: string) => `{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
          { "type": "text", "text": "see " },
          { "type": "text", "text": "Other",
            "marks": [ { "type": "link", "attrs": { "href": ${JSON.stringify(href)} } } ] } ] } ] } }`;

    const hrefOf = (adf: ADF): string | undefined =>
        adf.doc.content?.[0]?.content?.[1]?.marks?.[0]?.attrs?.["href"] as
            | string
            | undefined;

    it("regenerates an unedited link href under force", () => {
        const base = newADF(doc(OLD));
        const [md, sm] = marshallMapped(base, {}, links);
        const body = md.slice(sm.bodyStart).replace(/\n$/, "");

        const kept = putLinks(base, body, null, null, null, links, false);
        expect(hrefOf(kept)).toBe(OLD); // no force: block kept verbatim

        const forced = putLinks(base, body, null, null, null, links, true);
        expect(hrefOf(forced)).toBe(NEW); // force: re-parsed via toRemote
        // localId is preserved through the re-derive.
        expect(forced.doc.content?.[0]?.attrs?.["localId"]).toBe("p");
    });

    it("keeps a non-editable leaf verbatim under force", () => {
        // An emoji node is inexpressible in Markdown, so the leaf is not
        // editable; force must keep it, not throw.
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "e" }, "content": [
              { "type": "emoji", "attrs": { "shortName": ":smile:" } } ] } ] } }`);
        const body = renderBody(base);
        expect(() =>
            putLinks(base, body, null, null, null, null, true),
        ).not.toThrow();
    });
});

describe("putLinks force (nested containers)", () => {
    const OLD = "/wiki/pages/viewpage.action?pageId=42";
    const NEW = "https://ex.atlassian.net/wiki/spaces/X/pages/42/Other";
    const links: Links = {
        toLocal: (href) =>
            href === OLD || href === NEW
                ? { target: "other.md", label: "Other" }
                : undefined,
        toRemote: (target) => (target === "other.md" ? NEW : undefined),
    };
    const linkText = (href: string) =>
        `{ "type": "text", "text": "Other", "marks": [ { "type": "link",
           "attrs": { "href": ${JSON.stringify(href)} } } ] }`;

    const forceHrefs = (base: ADF): string[] => {
        const [md, sm] = marshallMapped(base, {}, links);
        const body = md.slice(sm.bodyStart).replace(/\n$/, "");
        const out = putLinks(base, body, null, null, null, links, true);
        const hrefs: string[] = [];
        const walk = (n: Node): void => {
            for (const m of n.marks ?? []) {
                if (m.type === "link") hrefs.push(String(m.attrs?.["href"]));
            }
            for (const c of n.content ?? []) walk(c);
        };
        walk(out.doc);
        return hrefs;
    };

    it("regenerates a link inside a bullet list item under force", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "bulletList", "attrs": { "localId": "l" }, "content": [
              { "type": "listItem", "content": [ { "type": "paragraph",
                "content": [ ${linkText(OLD)} ] } ] } ] } ] } }`);
        expect(forceHrefs(base)).toEqual([NEW]);
    });

    it("regenerates a link inside a table cell under force", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "content": [ { "type": "paragraph",
                   "content": [ ${linkText(OLD)} ] } ] } ] } ] } ] } }`);
        expect(forceHrefs(base)).toEqual([NEW]);
    });

    it("regenerates a link inside a panel under force", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
             "content": [ { "type": "paragraph",
               "content": [ ${linkText(OLD)} ] } ] } ] } }`);
        expect(forceHrefs(base)).toEqual([NEW]);
    });
});

describe("putLinks force (nested containers kept verbatim)", () => {
    // Regression for a Critical bug: under force the "unchanged → skip"
    // early-continue is bypassed, so every nested container gets walked and
    // must hit its own structural guard for a byte-identical body — not just
    // the top-level leafEditable fallback. Before the fix each of these threw
    // even though the body is byte-identical to the cached render.

    it("keeps a bullet list item holding a nested sub-list verbatim, byte-identical", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
              { "type": "listItem", "content": [
                 { "type": "paragraph",
                   "content": [ { "type": "text", "text": "top" } ] },
                 { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [ { "type": "paragraph",
                      "content": [ { "type": "text", "text": "sub one" } ] } ] } ] } ] } ] } ] } }`);
        const body = renderBody(base);
        const out = putLinks(base, body, null, null, null, null, true);
        expect(json(out)).toBe(json(base)); // kept verbatim, not corrupted
    });

    it("keeps a table cell holding a nested bullet list verbatim", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "table", "attrs": { "localId": "t" }, "content": [
              { "type": "tableRow", "content": [
                 { "type": "tableCell", "content": [
                    { "type": "paragraph",
                      "content": [ { "type": "text", "text": "N" } ] },
                    { "type": "bulletList", "content": [
                       { "type": "listItem", "content": [ { "type": "paragraph",
                         "content": [ { "type": "text", "text": "sub" } ] } ] } ] } ] } ] } ] } ] } }`);
        const body = renderBody(base);
        expect(() =>
            putLinks(base, body, null, null, null, null, true),
        ).not.toThrow();
    });

    it("keeps an info panel holding a bullet list verbatim", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
             "content": [
                { "type": "bulletList", "content": [
                   { "type": "listItem", "content": [ { "type": "paragraph",
                     "content": [ { "type": "text", "text": "note" } ] } ] } ] } ] } ] } }`);
        const body = renderBody(base);
        expect(() =>
            putLinks(base, body, null, null, null, null, true),
        ).not.toThrow();
    });

    it("keeps a blockquote holding a fenced code block verbatim", () => {
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "blockquote", "attrs": { "localId": "bq" }, "content": [
              { "type": "codeBlock", "attrs": { "language": "go" },
                "content": [ { "type": "text", "text": "x := 1" } ] } ] } ] } }`);
        const body = renderBody(base);
        expect(() =>
            putLinks(base, body, null, null, null, null, true),
        ).not.toThrow();
    });

    it("regenerates a link in a sibling item while keeping a nested sub-list item, no throw", () => {
        // Mixed case: item 0 is a plain paragraph carrying a link whose href
        // regenerates under force; item 1 holds a nested sub-list that force
        // cannot re-derive and must keep verbatim, in the same list rebuild.
        const OLD = "/wiki/pages/viewpage.action?pageId=42";
        const NEW = "https://ex.atlassian.net/wiki/spaces/X/pages/42/Other";
        const links: Links = {
            toLocal: (href) =>
                href === OLD || href === NEW
                    ? { target: "other.md", label: "Other" }
                    : undefined,
            toRemote: (target) => (target === "other.md" ? NEW : undefined),
        };
        const linkText = `{ "type": "text", "text": "Other", "marks": [ { "type": "link",
           "attrs": { "href": ${JSON.stringify(OLD)} } } ] }`;
        const base = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
              { "type": "listItem", "content": [ { "type": "paragraph",
                "content": [ ${linkText} ] } ] },
              { "type": "listItem", "content": [
                 { "type": "paragraph",
                   "content": [ { "type": "text", "text": "top" } ] },
                 { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [ { "type": "paragraph",
                      "content": [ { "type": "text", "text": "sub one" } ] } ] } ] } ] } ] } ] } }`);
        const [md, sm] = marshallMapped(base, {}, links);
        const body = md.slice(sm.bodyStart).replace(/\n$/, "");

        let out: ADF | undefined;
        expect(() => {
            out = putLinks(base, body, null, null, null, links, true);
        }).not.toThrow();

        const hrefs: string[] = [];
        const walk = (n: Node): void => {
            for (const m of n.marks ?? []) {
                if (m.type === "link") hrefs.push(String(m.attrs?.["href"]));
            }
            for (const c of n.content ?? []) walk(c);
        };
        walk((out as ADF).doc);
        expect(hrefs).toEqual([NEW]);
    });
});
