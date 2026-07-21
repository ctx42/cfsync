// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/build_test.go — the insert builders driven through `put`.
// Each case inserts a block into an empty document and asserts it round-trips:
// `renderBody(out)` equals the inserted body (the PutGet lens law, enforced by
// validatePut) and the built node has the expected type. This is the M4.4
// validation coverage for inserts; the reject table is the "frozen/lossy edit is
// refused with a named reason" half.
//
// Dialect divergences from Go: an image inserts as an Obsidian embed `![[…]]`
// (not `![alt](path)`); the `[[TOC]]` marker is evicted, so there is no toc-macro
// insert (a frozen ```adf block round-trips losslessly as a read-only code
// block). Everything else is dialect-stable and ports 1:1.

import { describe, expect, it } from "vitest";
import { put } from "../../../src/adf/lens/reconstruct.ts";
import { marshallMarkdownMapped } from "../../../src/index.ts";
import { type ADF, attrInt, attrStr, newADF } from "../../../src/models/adf.ts";

// emptyDoc is a baseline with no content, the shape a page create starts from.
const emptyDoc = `{ "adf": { "type": "doc", "content": [] } }`;

/** renderBody renders adf and returns its body without frontmatter or the trailing newline. */
function renderBody(adf: ADF): string {
    const [md, sm] = marshallMarkdownMapped(adf, {});
    return md.slice(sm.bodyStart).replace(/\n$/, "");
}

/** insert puts body into an empty document and returns the rebuilt document. */
const insert = (body: string): ADF =>
    put(newADF(emptyDoc), body, null, null, null);

describe("put insert round-trip (tabular)", () => {
    const cases: Array<{ name: string; body: string; wantType: string }> = [
        {
            name: "code block with language",
            body: "```go\nx := 1\n```",
            wantType: "codeBlock",
        },
        {
            name: "code block without language",
            body: "```\nplain\n```",
            wantType: "codeBlock",
        },
        {
            name: "code block with blank lines and pipes",
            body: "```plaintext\n| a |\n\n| b |\n```",
            wantType: "codeBlock",
        },
        { name: "bullet list", body: "- one\n- two", wantType: "bulletList" },
        {
            name: "bullet list with inline formatting",
            body: "- `ID` is a **code**\n- plain",
            wantType: "bulletList",
        },
        {
            name: "ordered list",
            body: "1. one\n2. two",
            wantType: "orderedList",
        },
        {
            name: "ordered list starting past one",
            body: "3. three\n4. four",
            wantType: "orderedList",
        },
        { name: "blockquote", body: "> hello", wantType: "blockquote" },
        {
            name: "blockquote with two paragraphs",
            body: "> alpha\n>\n> beta",
            wantType: "blockquote",
        },
        { name: "note panel", body: "> [!NOTE]\n> body", wantType: "panel" },
        {
            name: "warning panel",
            body: "> [!WARNING]\n> body",
            wantType: "panel",
        },
        {
            name: "expand with title",
            body: "> [!EXPAND] More detail\n> body",
            wantType: "expand",
        },
        {
            name: "expand without title",
            body: "> [!EXPAND]\n> body",
            wantType: "expand",
        },
        {
            name: "table with header row",
            body: "| a | b |\n|---|---|\n| 1 | 2 |",
            wantType: "table",
        },
        {
            name: "table without header row",
            body: "|   |   |\n|---|---|\n| k | v |",
            wantType: "table",
        },
        {
            name: "table with escaped pipe",
            body: "| a \\| b |\n|--------|\n| c      |",
            wantType: "table",
        },
    ];

    for (const tc of cases) {
        it(tc.name, () => {
            const out = insert(tc.body);
            expect(renderBody(out)).toBe(tc.body);
            expect(out.doc.content?.[0]?.type).toBe(tc.wantType);
        });
    }
});

describe("put insertCodeBlock", () => {
    it("language and body", () => {
        const node = insert("```go\nx := 1\ny := 2\n```").doc.content?.[0];
        expect(node?.type).toBe("codeBlock");
        expect(attrStr(node?.attrs, "language")).toBe("go");
        expect(node?.content?.[0]?.text).toBe("x := 1\ny := 2");
    });

    it("empty body", () => {
        const node = insert("```\n\n```").doc.content?.[0];
        expect(node?.type).toBe("codeBlock");
        expect(node?.content ?? []).toEqual([]);
    });
});

describe("put insertTocMacro", () => {
    it("rebuilds an inserted TOC block into a live toc extension", () => {
        const node = insert("```adf\ntype: toc\nlocalId: e1\n```").doc
            .content?.[0];
        expect(node?.type).toBe("extension");
        expect(attrStr(node?.attrs, "extensionKey")).toBe("toc");
        expect(attrStr(node?.attrs, "extensionType")).toBe(
            "com.atlassian.confluence.macro.core",
        );
        expect(attrStr(node?.attrs, "localId")).toBe("e1");
    });

    it("rebuilds a TOC block that carries no localId", () => {
        const node = insert("```adf\ntype: toc\n```").doc.content?.[0];
        expect(node?.type).toBe("extension");
        expect(attrStr(node?.attrs, "extensionKey")).toBe("toc");
        expect(attrStr(node?.attrs, "localId")).toBe("");
    });

    it("keeps a non-toc frozen macro as a read-only code block", () => {
        const node = insert(
            "```adf\ntype: extension\nextensionKey: chart\nlocalId: e2\n```",
        ).doc.content?.[0];
        expect(node?.type).toBe("codeBlock");
        expect(attrStr(node?.attrs, "language")).toBe("adf");
    });
});

describe("put insertBulletList", () => {
    it("splits items and unwraps a soft-wrapped item", () => {
        const node = insert("- one\n- two wrapped\n  over lines").doc
            .content?.[0];
        expect(node?.type).toBe("bulletList");
        expect(node?.content?.length).toBe(2);
        expect(node?.content?.[0]?.type).toBe("listItem");
        expect(node?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
            "one",
        );
        expect(node?.content?.[1]?.type).toBe("listItem");
    });
});

describe("put insertOrderedList", () => {
    it("starting at one omits the order attribute", () => {
        const node = insert("1. one\n2. two").doc.content?.[0];
        expect(node?.type).toBe("orderedList");
        expect(node?.content?.length).toBe(2);
        expect(node?.attrs).toBeUndefined();
    });

    it("starting past one records the start", () => {
        const node = insert("3. three\n4. four").doc.content?.[0];
        expect(node?.type).toBe("orderedList");
        expect(attrInt(node?.attrs, "order")).toBe(3);
    });
});

describe("put insertPanel", () => {
    it("builds a typed panel with its body paragraphs", () => {
        const node = insert("> [!SUCCESS]\n> alpha\n>\n> beta").doc
            .content?.[0];
        expect(node?.type).toBe("panel");
        expect(attrStr(node?.attrs, "panelType")).toBe("success");
        expect(node?.content?.length).toBe(2);
        expect(node?.content?.[0]?.type).toBe("paragraph");
        expect(node?.content?.[0]?.content?.[0]?.text).toBe("alpha");
    });
});

describe("put insertExpand", () => {
    it("with title", () => {
        const node = insert("> [!EXPAND] More\n> body").doc.content?.[0];
        expect(node?.type).toBe("expand");
        expect(attrStr(node?.attrs, "title")).toBe("More");
    });

    it("without title", () => {
        const node = insert("> [!EXPAND]\n> body").doc.content?.[0];
        expect(node?.type).toBe("expand");
        expect(node?.attrs).toBeUndefined();
    });
});

describe("put insertTable", () => {
    it("header row becomes tableHeader cells", () => {
        const node = insert("| a | b |\n|---|---|\n| 1 | 2 |").doc.content?.[0];
        expect(node?.type).toBe("table");
        expect(node?.content?.length).toBe(2);
        expect(node?.content?.[0]?.content?.[0]?.type).toBe("tableHeader");
        expect(node?.content?.[0]?.content?.[1]?.type).toBe("tableHeader");
        expect(node?.content?.[1]?.content?.[0]?.type).toBe("tableCell");
        expect(
            node?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text,
        ).toBe("1");
    });

    it("blank header row yields no header cells", () => {
        const node = insert("|   |   |\n|---|---|\n| k | v |").doc.content?.[0];
        expect(node?.content?.length).toBe(1);
        expect(node?.content?.[0]?.content?.[0]?.type).toBe("tableCell");
    });

    it("br splits a cell into paragraphs", () => {
        const cell = insert("| h      |\n|--------|\n| a<br>b |").doc
            .content?.[0]?.content?.[1]?.content?.[0];
        expect(cell?.content?.length).toBe(2);
        expect(cell?.content?.[0]?.content?.[0]?.text).toBe("a");
        expect(cell?.content?.[1]?.content?.[0]?.text).toBe("b");
    });

    it("escaped pipe stays inside its cell", () => {
        const cell = insert("| a \\| b |\n|--------|\n| c      |").doc
            .content?.[0]?.content?.[0]?.content?.[0];
        expect(cell?.content?.[0]?.content?.[0]?.text).toBe("a | b");
    });
});

describe("put insertIntoExisting", () => {
    it("inserts a list after a kept paragraph", () => {
        const data = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p1" },
             "content": [ { "type": "text", "text": "alpha" } ] } ] } }`;
        const body = "alpha\n\n- one\n- two";
        const out = put(newADF(data), body, null, null, null);
        expect(renderBody(out)).toBe(body);
        expect(attrStr(out.doc.content?.[0]?.attrs, "localId")).toBe("p1");
        expect(out.doc.content?.[1]?.type).toBe("bulletList");
    });
});

describe("put insert rejects (tabular)", () => {
    const cases: Array<{ name: string; body: string; want: string }> = [
        {
            name: "star bullet marker",
            body: "* one\n* two",
            want: 'write bullet items with a "- " marker',
        },
        {
            name: "plus bullet marker",
            body: "+ one",
            want: 'write bullet items with a "- " marker',
        },
        {
            name: "nested list in a bullet list",
            body: "- one\n  - nested",
            want: "a nested block cannot be inserted",
        },
        {
            name: "nested list in an ordered list",
            body: "1. one\n   - nested",
            want: "a nested block cannot be inserted",
        },
        {
            name: "multi-paragraph list item",
            body: "- one\n\n  two",
            want: "only single-paragraph",
        },
        {
            name: "non-sequential ordered list",
            body: "1. one\n3. three",
            want: "items must be numbered sequentially",
        },
        {
            name: "table without separator row",
            body: "| a | b |",
            want: "needs a header and a separator row",
        },
        {
            name: "table with a malformed separator row",
            body: "| a | b |\n| x | y |\n| 1 | 2 |",
            want: "missing its '---' separator row",
        },
        {
            name: "table with ragged rows",
            body: "| a | b |\n|---|---|\n| 1 |",
            want: "every table row needs 2 cells",
        },
        {
            name: "table with a span marker",
            body: "| a | b |\n|---|---|\n| « | 2 |",
            want: "cell spans cannot be inserted",
        },
        {
            name: "unknown panel tag",
            body: "> [!BOGUS]\n> body",
            want: "unknown panel type",
        },
        {
            name: "custom panel tag",
            body: "> [!CUSTOM]\n> body",
            want: "unknown panel type",
        },
        {
            name: "panel without a body",
            body: "> [!NOTE]",
            want: "needs a body",
        },
        {
            name: "nested block in a blockquote",
            body: "> - item",
            want: "a nested block cannot be inserted",
        },
        {
            name: "wikilink marker block",
            body: "[[TOC]] extra",
            want: "cannot insert block",
        },
        {
            name: "anchor comment",
            body: "<!-- adf:unsupported -->",
            want: "cannot insert block",
        },
        {
            name: "image with no uploaded attachment",
            body: "![[missing.png]]",
            want: "no uploaded attachment",
        },
    ];

    for (const tc of cases) {
        it(tc.name, () => {
            expect(() => insert(tc.body)).toThrow(tc.want);
        });
    }
});
