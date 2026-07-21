// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/merge_test.go. The three-way merge works on rendered block
// texts, so it is dialect-independent and ports 1:1; Go's `ErrMergeConflict`
// sentinel (checked with errors.Is) becomes a MergeConflictError class checked
// with instanceof.

import { describe, expect, it } from "vitest";
import { MergeConflictError, merge3 } from "../../../src/adf/lens/merge.ts";
import { put } from "../../../src/adf/lens/reconstruct.ts";
import { marshallMarkdownMapped } from "../../../src/index.ts";
import { type ADF, attrStr, newADF } from "../../../src/models/adf.ts";

/** renderBody renders adf and returns its body without frontmatter or trailing newline. */
function renderBody(adf: ADF): string {
    const [md, sm] = marshallMarkdownMapped(adf, {});
    return md.slice(sm.bodyStart).replace(/\n$/, "");
}

/** doc builds a two-paragraph document with stable localIds. */
function doc(a: string, b: string): ADF {
    return newADF(`{ "adf": { "type": "doc", "content": [
       { "type": "paragraph", "attrs": { "localId": "p1" },
         "content": [ { "type": "text", "text": "${a}" } ] },
       { "type": "paragraph", "attrs": { "localId": "p2" },
         "content": [ { "type": "text", "text": "${b}" } ] } ] } }`);
}

describe("merge3", () => {
    it("disjoint edits merge onto the remote", () => {
        const base = doc("alpha", "beta");
        const remote = doc("alpha", "beta remote");
        const local = renderBody(base).replace("alpha", "alpha local");

        const merged = merge3(base, remote, local, null);

        expect(merged).toBe("alpha local\n\nbeta remote");
        const out = put(remote, merged, null, null, null);
        expect(out.doc.content?.[0]?.content?.[0]?.text).toBe("alpha local");
        expect(out.doc.content?.[1]?.content?.[0]?.text).toBe("beta remote");
        expect(attrStr(out.doc.content?.[0]?.attrs, "localId")).toBe("p1");
    });

    it("the same edit on both sides is concordant", () => {
        const base = doc("alpha", "beta");
        const remote = doc("alpha edited", "beta");
        const local = renderBody(base).replace("alpha", "alpha edited");

        expect(merge3(base, remote, local, null)).toBe("alpha edited\n\nbeta");
    });

    it("incompatible edits to one block conflict", () => {
        const base = doc("alpha", "beta");
        const remote = doc("alpha remote", "beta");
        const local = renderBody(base).replace("alpha", "alpha local");

        let err: unknown;
        try {
            merge3(base, remote, local, null);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(MergeConflictError);
        expect((err as Error).message).toContain("merge conflict at block 0");
    });

    it("a local insert lands alongside a remote edit", () => {
        const base = doc("alpha", "beta");
        const remote = doc("alpha", "beta remote");
        const local = `${renderBody(base)}\n\ngamma added`;

        expect(merge3(base, remote, local, null)).toBe(
            "alpha\n\nbeta remote\n\ngamma added",
        );
    });

    it("a local delete drops the block on the merged side", () => {
        const base = doc("alpha", "beta");
        const remote = doc("alpha", "beta remote");
        const local = "beta"; // only the 2nd paragraph remains

        expect(merge3(base, remote, local, null)).toBe("beta remote");
    });

    it("both sides inserting at the same place conflict", () => {
        const base = doc("alpha", "beta");
        const remote = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p1" },
             "content": [ { "type": "text", "text": "alpha" } ] },
           { "type": "paragraph", "attrs": { "localId": "p2" },
             "content": [ { "type": "text", "text": "beta" } ] },
           { "type": "paragraph", "attrs": { "localId": "pr" },
             "content": [ { "type": "text", "text": "remote tail" } ] } ] } }`);
        const local = `${renderBody(base)}\n\nlocal tail`;

        let err: unknown;
        try {
            merge3(base, remote, local, null);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(MergeConflictError);
        expect((err as Error).message).toContain("both sides inserted");
    });

    it("both sides inserting the same block collapses to one, not a conflict", () => {
        const base = doc("alpha", "beta");
        // Both remote and local append an identical tail paragraph. That is one
        // edit made twice, so the merge keeps a single copy rather than raising a
        // conflict; a soft-wrap-only difference still counts as the same insert.
        const remote = newADF(`{ "adf": { "type": "doc", "content": [
           { "type": "paragraph", "attrs": { "localId": "p1" },
             "content": [ { "type": "text", "text": "alpha" } ] },
           { "type": "paragraph", "attrs": { "localId": "p2" },
             "content": [ { "type": "text", "text": "beta" } ] },
           { "type": "paragraph", "attrs": { "localId": "pr" },
             "content": [ { "type": "text", "text": "shared tail" } ] } ] } }`);
        const local = `${renderBody(base)}\n\nshared tail`;

        expect(merge3(base, remote, local, null)).toBe(
            "alpha\n\nbeta\n\nshared tail",
        );
    });
});

describe("merge3 fuzz-seed invariants (FuzzMerge3)", () => {
    // A fixed baseline and a remote that diverged from it; Merge3 must never throw
    // a non-conflict error, and a successful merge must Put against remote without
    // throwing a non-lens error.
    const base = newADF(`{ "adf": { "type": "doc", "content": [
       { "type": "heading", "attrs": { "level": 2, "localId": "h" },
         "content": [ { "type": "text", "text": "Title" } ] },
       { "type": "paragraph", "attrs": { "localId": "p1" },
         "content": [ { "type": "text", "text": "alpha" } ] },
       { "type": "paragraph", "attrs": { "localId": "p2" },
         "content": [ { "type": "text", "text": "beta" } ] } ] } }`);
    const remote = newADF(`{ "adf": { "type": "doc", "content": [
       { "type": "heading", "attrs": { "level": 2, "localId": "h" },
         "content": [ { "type": "text", "text": "Title" } ] },
       { "type": "paragraph", "attrs": { "localId": "p1" },
         "content": [ { "type": "text", "text": "alpha" } ] },
       { "type": "paragraph", "attrs": { "localId": "p2" },
         "content": [ { "type": "text", "text": "beta remote" } ] } ] } }`);

    const self = renderBody(base);
    const seeds = [
        self,
        self.replace("alpha", "alpha local"),
        self.replace("beta", "beta local"),
        `${self}\n\ninserted`,
        "",
    ];

    it("a merge either conflicts or Puts against remote without a foreign throw", () => {
        for (const body of seeds) {
            let merged: string | undefined;
            try {
                merged = merge3(base, remote, body, null);
            } catch (e) {
                // A conflict is a valid, safe outcome; any other class is not.
                expect(e).toBeInstanceOf(MergeConflictError);
                continue;
            }
            // A successful merge must reconstruct against remote; it may reject
            // (a lens-law failure), but only ever as an Error.
            try {
                put(remote, merged, null, null, null);
            } catch (e) {
                expect(e).toBeInstanceOf(Error);
            }
        }
    });
});
