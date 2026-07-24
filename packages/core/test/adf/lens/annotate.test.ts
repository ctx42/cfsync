// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Put lens re-anchors a Confluence inline comment (an `annotation` mark)
// onto the reparsed text when the user edits a paragraph that carried one. The
// Markdown cannot express the comment, so a rendered body drops it; without
// re-anchoring an edited paragraph would silently detach the comment. These
// tests state the contract: the comment survives when its commented text still
// appears in the edit, and is dropped only when the edit changed that text away
// or made it ambiguous. The render emits nothing for an annotation, so a
// re-anchor never changes the body and the PutGet law still holds.

import { describe, expect, it } from "vitest";
import { put } from "../../../src/adf/lens/reconstruct.ts";
import { marshallMarkdownMapped } from "../../../src/index.ts";
import { type ADF, type Node, newADF } from "../../../src/models/adf.ts";

/** renderBody renders adf and returns its body without frontmatter or trailing newline. */
function renderBody(adf: ADF): string {
    const [md, sm] = marshallMarkdownMapped(adf, {});
    return md.slice(sm.bodyStart).replace(/\n$/, "");
}

/** comments walks a document and lists every annotation as {id, text}, in order. */
function comments(adf: ADF): Array<{ id: string; text: string }> {
    const out: Array<{ id: string; text: string }> = [];
    const walk = (nod: Node): void => {
        if (nod.type === "text") {
            for (const m of nod.marks ?? []) {
                if (m.type === "annotation") {
                    out.push({
                        id: String(m.attrs?.["id"] ?? ""),
                        text: nod.text ?? "",
                    });
                }
            }
        }
        for (const c of nod.content ?? []) {
            walk(c);
        }
    };
    walk(adf.doc);
    return out;
}

/** commentText concatenates the text of every annotation sharing id. */
function commentText(adf: ADF, id: string): string {
    return comments(adf)
        .filter((c) => c.id === id)
        .map((c) => c.text)
        .join("");
}

// commented is a document whose one paragraph carries an inline comment on the
// words "data type name"; a leading and trailing plain run surround it.
const commented = `{ "adf": { "type": "doc", "content": [
   { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
      { "type": "text", "text": "Change " },
      { "type": "text", "text": "data type name", "marks": [
         { "type": "annotation", "attrs": {
            "annotationType": "inlineComment", "id": "c1" } } ] },
      { "type": "text", "text": " on the screen." } ] } ] } }`;

describe("annotation re-anchoring", () => {
    it("an unedited commented paragraph pushes back byte-identically", () => {
        const base = newADF(commented);
        const have = put(base, renderBody(base), null, null, null);
        // GetPut: excluding the annotation from the round-trip check must not
        // rewrite the unchanged block; the comment stays exactly where it was.
        expect(JSON.stringify(have)).toBe(JSON.stringify(base));
    });

    it("preserves the comment when an edit keeps the commented text", () => {
        const base = newADF(commented);
        const body = renderBody(base).replace(
            "on the screen",
            "on the main screen",
        );
        const have = put(base, body, null, null, null);
        expect(renderBody(have)).toBe(body); // the edit landed
        expect(commentText(have, "c1")).toBe("data type name"); // comment kept
    });

    it("drops the comment when the edit changes the commented text away", () => {
        const base = newADF(commented);
        const body = renderBody(base).replace(
            "data type name",
            "the field label",
        );
        const have = put(base, body, null, null, null);
        expect(renderBody(have)).toBe(body);
        expect(comments(have)).toHaveLength(0); // nowhere to re-anchor
    });

    it("keeps a comment whose text is split across a bold boundary", () => {
        const split = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "the ", "marks": [
                 { "type": "annotation", "attrs": { "id": "c2" } } ] },
              { "type": "text", "text": "bold", "marks": [
                 { "type": "strong" },
                 { "type": "annotation", "attrs": { "id": "c2" } } ] },
              { "type": "text", "text": " word." } ] } ] } }`;
        const base = newADF(split);
        const body = renderBody(base).replace("word", "term");
        expect(body).toContain("the **bold** term."); // render + edit as expected
        const have = put(base, body, null, null, null);
        expect(renderBody(have)).toBe(body);
        expect(commentText(have, "c2")).toBe("the bold"); // comment re-anchored
    });

    it("drops rather than guesses when the commented text is ambiguous", () => {
        const twice = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "a ", "marks": [
                 { "type": "annotation", "attrs": { "id": "c3" } } ] },
              { "type": "text", "text": "and a here." } ] } ] } }`;
        const base = newADF(twice);
        // The comment covers the leading "a "; after the edit "a " occurs twice,
        // so there is no single anchor and the comment is dropped, not misplaced.
        const body = renderBody(base).replace("and a here", "and a there");
        const have = put(base, body, null, null, null);
        expect(renderBody(have)).toBe(body);
        expect(comments(have)).toHaveLength(0);
    });
});
