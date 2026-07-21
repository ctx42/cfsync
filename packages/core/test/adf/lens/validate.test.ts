// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The lens-law property test for `validatePut` (M4.4). `validatePut` itself is
// ported in reconstruct.ts and runs on every `put`; these cases state its two
// guarantees directly rather than only implicitly through the insert/edit tables:
//
//   GetPut — pushing an unchanged body back yields a byte-identical document, for
//            a document mixing every node kind at once.
//   PutGet — a representable edit round-trips: the rebuilt block re-renders to the
//            user's edit (soft-wrap differences do not count).
//
// and its refusal contract: an edit the Markdown cannot express losslessly — a
// frozen block, or a structural change to a container — is rejected with a named
// reason, never silently pushed.

import { describe, expect, it } from "vitest";
import { put } from "../../../src/adf/lens/reconstruct.ts";
import { marshallMarkdownMapped } from "../../../src/index.ts";
import { type ADF, newADF } from "../../../src/models/adf.ts";

/** renderBody renders adf and returns its body without frontmatter or trailing newline. */
function renderBody(adf: ADF): string {
    const [md, sm] = marshallMarkdownMapped(adf, {});
    return md.slice(sm.bodyStart).replace(/\n$/, "");
}

const json = (adf: ADF): string => JSON.stringify(adf);

// mixed is one document holding every top-level node kind the lens handles, so a
// single no-op push exercises GetPut across all of them at once.
const mixed = `{ "adf": { "type": "doc", "content": [
   { "type": "heading", "attrs": { "level": 2, "localId": "h" },
     "content": [ { "type": "text", "text": "Title" } ] },
   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
      { "type": "text", "text": "plain " },
      { "type": "text", "text": "bold", "marks": [ { "type": "strong" } ] } ] },
   { "type": "bulletList", "attrs": { "localId": "bl" }, "content": [
      { "type": "listItem", "content": [ { "type": "paragraph",
        "content": [ { "type": "text", "text": "item" } ] } ] } ] },
   { "type": "codeBlock", "attrs": { "localId": "cb", "language": "go" },
     "content": [ { "type": "text", "text": "x := 1" } ] },
   { "type": "panel", "attrs": { "panelType": "info", "localId": "pn" },
     "content": [ { "type": "paragraph",
       "content": [ { "type": "text", "text": "note" } ] } ] },
   { "type": "table", "attrs": { "localId": "t" }, "content": [
      { "type": "tableRow", "content": [
         { "type": "tableCell", "content": [ { "type": "paragraph",
           "content": [ { "type": "text", "text": "A" } ] } ] },
         { "type": "tableCell", "content": [ { "type": "paragraph",
           "content": [ { "type": "text", "text": "B" } ] } ] } ] } ] } ] } }`;

describe("validatePut GetPut law", () => {
    it("a mixed document pushes back byte-identically", () => {
        const base = newADF(mixed);
        const out = put(base, renderBody(base), null, null, null);
        expect(json(out)).toBe(json(base));
    });
});

describe("validatePut PutGet law", () => {
    // Each edit changes exactly one block of `mixed`; the rebuilt block must
    // re-render to the edited body.
    const edits: Array<{ name: string; from: string; to: string }> = [
        { name: "heading text", from: "## Title", to: "## Renamed" },
        {
            name: "paragraph text",
            from: "plain **bold**",
            to: "plainer **bold**",
        },
        { name: "list item text", from: "- item", to: "- edited item" },
        { name: "code block body", from: "x := 1", to: "x := 2" },
        {
            name: "panel body text",
            from: "> [!INFO]\n> note",
            to: "> [!INFO]\n> revised note",
        },
        // A width-preserving cell edit keeps the column layout, so the exact
        // render matches; a widening edit is still valid but only normalize-equal.
        { name: "table cell text", from: "| A ", to: "| X " },
    ];

    for (const e of edits) {
        it(`round-trips an edited ${e.name}`, () => {
            const base = newADF(mixed);
            const body = renderBody(base).replace(e.from, e.to);
            expect(body).not.toBe(renderBody(base)); // the edit took effect
            const out = put(base, body, null, null, null);
            // PutGet: the pushed document re-renders to exactly the edited body.
            expect(renderBody(out)).toBe(body);
        });
    }
});

describe("validatePut refusal contract", () => {
    // A lossy edit is refused with a named reason, never guessed.
    const rejects: Array<{
        name: string;
        from: string;
        to: string;
        want: string;
    }> = [
        {
            name: "adding a table column",
            from: "| A | B |",
            to: "| A | B | C |",
            want: "number of table columns",
        },
        {
            name: "deleting a read-only block",
            from: "```go\nx := 1\n```",
            to: "",
            want: "only paragraph and heading blocks can be deleted",
        },
    ];

    for (const r of rejects) {
        it(`refuses ${r.name} with a named reason`, () => {
            const base = newADF(mixed);
            const body = renderBody(base).replace(r.from, r.to);
            expect(() => put(base, body, null, null, null)).toThrow(r.want);
        });
    }
});
