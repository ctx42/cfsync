// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Put lens re-anchors a Confluence inline comment (an `annotation` mark)
// onto the reparsed text when the user edits a paragraph that carried one. The
// Markdown cannot express the comment, so a rendered body drops it; without
// re-anchoring an edited paragraph would silently detach the comment. These
// tests state the contract: the comment survives when its commented text still
// appears in the edit — at the occurrence best matching its original spot when
// the text now occurs more than once — and is dropped only when the edit changed
// that text away. The render emits nothing for an annotation, so a
// re-anchor never changes the body and the PutGet law still holds.

import { describe, expect, it } from "vitest";
import {
    collectDocAnnotationRuns,
    graftComments,
    relocateComments,
} from "../../../src/adf/lens/annotate.ts";
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

    it("keeps the comment when the edit only changes the text's case", () => {
        const base = newADF(commented);
        const body = renderBody(base).replace(
            "data type name",
            "Data Type Name",
        );
        const have = put(base, body, null, null, null);
        expect(renderBody(have)).toBe(body);
        expect(commentText(have, "c1")).toBe("Data Type Name");
    });

    it("keeps the comment on a near-match of the edited text", () => {
        const base = newADF(commented);
        // One changed character in fourteen is within the near-match bound.
        const body = renderBody(base).replace(
            "data type name",
            "data-type name",
        );
        const have = put(base, body, null, null, null);
        expect(renderBody(have)).toBe(body);
        expect(commentText(have, "c1")).toBe("data-type name");
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

    it("keeps the comment on its original spot when the text is repeated", () => {
        const twice = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "a ", "marks": [
                 { "type": "annotation", "attrs": { "id": "c3" } } ] },
              { "type": "text", "text": "and a here." } ] } ] } }`;
        const base = newADF(twice);
        // The comment covers the leading "a ", which occurs twice after the
        // edit; the occurrence whose surroundings still match is the original.
        const body = renderBody(base).replace("and a here", "and a there");
        const have = put(base, body, null, null, null);
        expect(renderBody(have)).toBe(body);
        expect(comments(have)).toEqual([{ id: "c3", text: "a " }]);
        const first = have.doc.content?.[0]?.content?.[0];
        expect(first?.text).toBe("a "); // the leading run, not the later one
    });
});

// A push grafts the live page's inline-comment marks onto the outgoing body so
// a comment is never dropped when the local reconstruct fails to carry it — the
// live page is the authoritative source of the anchors Confluence owns.
describe("graftComments: preserving live comments on push", () => {
    // plain is the same document as `commented` but with the annotation stripped,
    // standing in for a rebuilt push body that lost the comment.
    const plain = `{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
          { "type": "text", "text": "Change data type name on the screen." }
       ] } ] } }`;

    it("re-anchors a live comment the rebuilt body dropped", () => {
        const live = newADF(commented);
        const doc = newADF(plain).doc;
        graftComments(doc, collectDocAnnotationRuns(live.doc));
        const have: ADF = { ...newADF(plain), doc };
        expect(commentText(have, "c1")).toBe("data type name");
    });

    it("leaves an already-anchored comment untouched (no duplicate)", () => {
        const live = newADF(commented);
        const doc = newADF(commented).doc;
        graftComments(doc, collectDocAnnotationRuns(live.doc));
        const have: ADF = { ...newADF(commented), doc };
        // Still exactly one annotated run, unchanged.
        expect(comments(have)).toEqual([{ id: "c1", text: "data type name" }]);
    });

    it("drops a comment whose text no longer occurs in the body", () => {
        const live = newADF(commented);
        const edited = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "Change the field label on the screen." }
           ] } ] } }`;
        const doc = newADF(edited).doc;
        graftComments(doc, collectDocAnnotationRuns(live.doc));
        expect(comments({ ...newADF(edited), doc })).toHaveLength(0);
    });

    /** annotatedBlocks lists the index of each top-level block carrying id. */
    function annotatedBlocks(adf: ADF, id: string): number[] {
        const out: number[] = [];
        (adf.doc.content ?? []).forEach((blk, i) => {
            const hit = (blk.content ?? []).some((n) =>
                (n.marks ?? []).some(
                    (m) => m.type === "annotation" && m.attrs?.["id"] === id,
                ),
            );
            if (hit) {
                out.push(i);
            }
        });
        return out;
    }

    it("keeps a comment whose text now also occurs in another block", () => {
        const live = newADF(commented);
        // "data type name" now appears in a new first paragraph too; the
        // comment stays on its original block, found by its localId.
        const twice = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "new" }, "content": [
              { "type": "text", "text": "Change data type name here." } ] },
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "Change data type name on the screen." }
           ] } ] } }`;
        const doc = newADF(twice).doc;
        graftComments(doc, collectDocAnnotationRuns(live.doc));
        const have: ADF = { ...newADF(twice), doc };
        expect(comments(have)).toEqual([{ id: "c1", text: "data type name" }]);
        expect(annotatedBlocks(have, "c1")).toEqual([1]);
    });

    it("picks the occurrence with matching surroundings without localIds", () => {
        const live = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "content": [
              { "type": "text", "text": "Intro." } ] },
           { "type": "paragraph", "content": [
              { "type": "text", "text": "Change " },
              { "type": "text", "text": "data type name", "marks": [
                 { "type": "annotation", "attrs": { "id": "c1" } } ] },
              { "type": "text", "text": " on the screen." } ] } ] } }`);
        // The commented block moved below a new block with the same words;
        // its unchanged surroundings, not the block order, identify it.
        const moved = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "content": [
              { "type": "text", "text": "Intro." } ] },
           { "type": "paragraph", "content": [
              { "type": "text", "text": "Rename data type name first." } ] },
           { "type": "paragraph", "content": [
              { "type": "text", "text": "Change data type name on the screen." }
           ] } ] } }`;
        const doc = newADF(moved).doc;
        graftComments(doc, collectDocAnnotationRuns(live.doc));
        const have: ADF = { ...newADF(moved), doc };
        expect(comments(have)).toEqual([{ id: "c1", text: "data type name" }]);
        expect(annotatedBlocks(have, "c1")).toEqual([2]);
    });

    it("re-anchors a near-match only in the comment's own block", () => {
        const live = newADF(commented);
        // The own block (localId p) now reads "data-type name"; the new block
        // holds "data type names" — a near-match too, but not the comment's
        // block, so the comment goes to p.
        const src = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "q" }, "content": [
              { "type": "text", "text": "Many data type names." } ] },
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "Change data-type name on the screen." }
           ] } ] } }`;
        const doc = newADF(src).doc;
        graftComments(doc, collectDocAnnotationRuns(live.doc));
        const have: ADF = { ...newADF(src), doc };
        expect(comments(have)).toEqual([{ id: "c1", text: "data-type name" }]);
        expect(annotatedBlocks(have, "c1")).toEqual([1]);
    });

    it("never near-matches in a block other than the comment's own", () => {
        const live = newADF(commented);
        const src = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "q" }, "content": [
              { "type": "text", "text": "Change data-type name here." } ] }
           ] } }`;
        const doc = newADF(src).doc;
        graftComments(doc, collectDocAnnotationRuns(live.doc));
        expect(comments({ ...newADF(src), doc })).toHaveLength(0);
    });

    it("anchors a repeated comment text within one block by its offset", () => {
        const live = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "x and " },
              { "type": "text", "text": "x", "marks": [
                 { "type": "annotation", "attrs": { "id": "c4" } } ] },
              { "type": "text", "text": " end" } ] } ] } }`);
        const plainX = `{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "x and x end" } ] } ] } }`;
        const doc = newADF(plainX).doc;
        graftComments(doc, collectDocAnnotationRuns(live.doc));
        const para = doc.content?.[0]?.content ?? [];
        expect(para.map((n) => n.text)).toEqual(["x and ", "x", " end"]);
        expect(para[1]?.marks?.[0]?.attrs?.["id"]).toBe("c4");
    });
});

describe("relocateComments: moving a rewritten comment", () => {
    // live holds comment c1 on the middle of three paragraphs.
    const live = newADF(`{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "attrs": { "localId": "a" }, "content": [
          { "type": "text", "text": "Before." } ] },
       { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
          { "type": "text", "text": "Change " },
          { "type": "text", "text": "data type name", "marks": [
             { "type": "annotation", "attrs": { "id": "c1" } } ] },
          { "type": "text", "text": " on the screen." } ] },
       { "type": "paragraph", "attrs": { "localId": "b" }, "content": [
          { "type": "text", "text": "After." } ] } ] } }`);
    const runs = collectDocAnnotationRuns(live.doc);

    /** relocate parses src, relocates c1 onto it, and returns the result. */
    function relocate(src: string, ids = ["c1"]) {
        const doc = newADF(src).doc;
        const moved = relocateComments(doc, runs, new Set(ids));
        return { moved, have: { ...newADF(src), doc } };
    }

    it("moves the comment onto its own rewritten block", () => {
        const { moved, have } = relocate(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "Rename the field label." } ] } ] } }`);

        expect(moved).toEqual(["c1"]);
        expect(comments(have)).toEqual([
            { id: "c1", text: "Rename the field label." },
        ]);
    });

    it("moves the comment to the preceding block when its own is gone", () => {
        const { moved, have } = relocate(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "a" }, "content": [
              { "type": "text", "text": "Before." } ] },
           { "type": "paragraph", "attrs": { "localId": "b" }, "content": [
              { "type": "text", "text": "After." } ] } ] } }`);

        expect(moved).toEqual(["c1"]);
        expect(comments(have)).toEqual([{ id: "c1", text: "Before." }]);
    });

    it("skips a code block for the next nearest block", () => {
        const { have } = relocate(`{ "adf": { "type": "doc", "content": [
           { "type": "codeBlock", "attrs": { "localId": "a" }, "content": [
              { "type": "text", "text": "x := 1" } ] },
           { "type": "paragraph", "attrs": { "localId": "b" }, "content": [
              { "type": "text", "text": "After." } ] } ] } }`);

        expect(comments(have)).toEqual([{ id: "c1", text: "After." }]);
    });

    it("anchors the longest text beside a non-text inline node", () => {
        const { have } = relocate(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
              { "type": "text", "text": "Ask " },
              { "type": "mention", "attrs": { "id": "u" } },
              { "type": "text", "text": " about the field label." } ] } ] } }`);

        expect(comments(have)).toEqual([
            { id: "c1", text: "about the field label." },
        ]);
    });

    it("leaves a comment detached when no block survives", () => {
        const { moved, have } = relocate(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "content": [
              { "type": "text", "text": "New text." } ] } ] } }`);

        expect(moved).toEqual([]);
        expect(comments(have)).toHaveLength(0);
    });

    it("moves only the comments asked for", () => {
        const { moved, have } = relocate(
            `{ "adf": { "type": "doc", "content": [
               { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
                  { "type": "text", "text": "Rewritten." } ] } ] } }`,
            [],
        );

        expect(moved).toEqual([]);
        expect(comments(have)).toHaveLength(0);
    });
});
