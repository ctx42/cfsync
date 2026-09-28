// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Annotation re-anchoring for the Put lens. A Confluence inline comment is an
// `annotation` mark on a run of text; Markdown cannot express it, so a rendered
// body drops it. When the user edits a paragraph that carried one, the reparse
// produces plain text with no annotation, which would silently detach the
// comment. reanchorAnnotations weaves each annotation back onto the reparsed
// text: it finds the exact commented substring in the new content and re-applies
// the mark. When that text now occurs more than once, the occurrence whose
// surroundings best match the original is chosen, so an ambiguous anchor never
// costs a comment. Only a comment whose text the edit changed away no longer
// matches and is dropped — the one unavoidable loss the design accepts (see the
// "preserve when the text survives" contract). The render emits no delimiter
// for an annotation, so re-anchoring never changes the rebuilt body and the
// PutGet law still holds.

import { attrStr, type Mark, type Node } from "../../models/adf.ts";

/**
 * OBJ stands in for a non-text inline node (a mention, a hard break) in a leaf's
 * flat text. Commented text never contains it, so a search of the flat text never
 * matches across such a node, where a comment cannot live.
 */
const OBJ = "￼";

/**
 * AnnRun is one inline comment recovered from a leaf's original content: the
 * exact text the annotation covered, the mark to re-apply, and where the run sat,
 * which picks the right spot when the text later occurs more than once.
 * Consecutive text nodes sharing an annotation id form a single run, so a comment
 * split across a formatting boundary (part bold, say) is still one contiguous
 * target.
 */
interface AnnRun {
    /** The concatenated text the annotation covered, its re-anchor target. */
    text: string;
    /** The annotation mark to re-apply to the matching span. */
    mark: Mark;
    /** Offset of the run in its leaf's flat text (see {@link flatText}). */
    offset: number;
    /** The leaf's flat text before the run. */
    before: string;
    /** The leaf's flat text after the run. */
    after: string;
    /** Document-order index of the run's leaf; 0 for a lone leaf's runs. */
    leaf: number;
    /** The localId of the run's leaf; "" when it has none or is unknown. */
    leafId: string;
}

/**
 * collectAnnotationRuns extracts the inline-comment annotations from a leaf's
 * content, in document order, before the leaf is rebuilt. Each maximal run of
 * consecutive text nodes carrying an annotation of the same id becomes one run
 * whose text is their concatenation; a break in that id (a plain node, a
 * non-text node, or the same id reappearing after a gap) ends the run. Marks
 * other than the annotation are ignored — they are recovered from the Markdown
 * on reparse and need no carrying.
 */
export function collectAnnotationRuns(content: Node[]): AnnRun[] {
    const runs: AnnRun[] = [];
    const open = new Map<string, AnnRun>();
    let pos = 0;
    for (const nod of content) {
        const seen = new Set<string>();
        if (nod.type === "text") {
            for (const m of nod.marks ?? []) {
                if (m.type !== "annotation") {
                    continue;
                }
                const id = attrStr(m.attrs, "id");
                seen.add(id);
                let run = open.get(id);
                if (run === undefined) {
                    run = {
                        text: "",
                        mark: m,
                        offset: pos,
                        before: "",
                        after: "",
                        leaf: 0,
                        leafId: "",
                    };
                    open.set(id, run);
                    runs.push(run);
                }
                run.text += nod.text ?? "";
            }
        }
        pos += nod.type === "text" ? (nod.text ?? "").length : 1;
        // An id the current node does not carry has ended its contiguous run.
        for (const id of [...open.keys()]) {
            if (!seen.has(id)) {
                open.delete(id);
            }
        }
    }
    const flat = flatText(content);
    for (const run of runs) {
        run.before = flat.slice(0, run.offset);
        run.after = flat.slice(run.offset + run.text.length);
    }
    return runs;
}

/**
 * reanchorAnnotations re-applies each recovered annotation to newly reparsed
 * content and returns the result. A run is re-anchored wherever its covered text
 * occurs in the content (within a single run of adjacent text nodes); when it
 * occurs more than once, the occurrence best matching the run's original
 * position is chosen (see {@link bestHit}). Only a run whose text occurs nowhere
 * — the edit changed it away — is dropped. Runs are applied in order; splitting a
 * text node preserves its other marks, so a comment on bold text keeps the bold.
 */
export function reanchorAnnotations(content: Node[], runs: AnnRun[]): Node[] {
    let out = content;
    for (const run of runs) {
        if (run.text === "") {
            continue;
        }
        const flat = flatText(out);
        const hits = occurrences(flat, run.text).map((offset) => ({
            leaf: 0,
            leafId: "",
            flat,
            offset,
        }));
        const hit = bestHit(hits, run);
        if (hit !== undefined) {
            out = applyAt(
                out,
                hit.offset,
                hit.offset + run.text.length,
                run.mark,
            );
        }
    }
    return out;
}

/**
 * collectDocAnnotationRuns collects every inline-comment annotation run across a
 * whole document, not just one leaf: it visits each node and reads the runs from
 * its direct text children (see {@link collectAnnotationRuns}), which is a no-op
 * on a container's leaf children, so every run is gathered exactly once. Each run
 * records its leaf's document-order index and localId, the same leaf numbering
 * {@link graftComments} uses. It is the input to graftComments, which re-anchors
 * the live page's comments onto a rebuilt push body.
 */
export function collectDocAnnotationRuns(doc: Node): AnnRun[] {
    const runs: AnnRun[] = [];
    let leaf = 0;
    const walk = (nod: Node): void => {
        if (isLeaf(nod)) {
            for (const run of collectAnnotationRuns(nod.content ?? [])) {
                run.leaf = leaf;
                run.leafId = attrStr(nod.attrs, "localId");
                runs.push(run);
            }
            leaf++;
        }
        for (const child of nod.content ?? []) {
            walk(child);
        }
    };
    walk(doc);
    return runs;
}

/**
 * graftComments re-anchors the inline-comment annotations in `runs` — typically
 * the *live* Confluence body's, the authoritative source — onto `doc` in place,
 * so a rebuilt push body never detaches a comment whose anchored text still
 * exists. Confluence owns these marks (it injects one when a comment is created
 * and uses it as the anchor), so a PUT that drops one makes the comment vanish;
 * grafting them back guarantees a push leaves comments intact.
 *
 * A run whose id is already present in `doc` is left alone (the rebuild kept it).
 * Otherwise every occurrence of its covered text across the whole document is a
 * candidate, and the one best matching the run's original block and surroundings
 * is anchored (see {@link bestHit}), so text that now also appears elsewhere on
 * the page does not cost the comment. Only a run whose text occurs nowhere — the
 * edit rewrote the commented words — is dropped.
 */
export function graftComments(doc: Node, runs: AnnRun[]): void {
    const present = new Set<string>();
    const leaves: Node[] = [];
    const scan = (nod: Node): void => {
        if (nod.type === "text") {
            for (const m of nod.marks ?? []) {
                if (m.type === "annotation") {
                    present.add(attrStr(m.attrs, "id"));
                }
            }
        }
        if (isLeaf(nod)) {
            leaves.push(nod);
        }
        for (const child of nod.content ?? []) {
            scan(child);
        }
    };
    scan(doc);

    for (const run of runs) {
        const id = attrStr(run.mark.attrs, "id");
        if (id === "" || run.text === "" || present.has(id)) {
            continue;
        }
        const hits: Hit[] = [];
        leaves.forEach((nod, leaf) => {
            const flat = flatText(nod.content ?? []);
            const leafId = attrStr(nod.attrs, "localId");
            for (const offset of occurrences(flat, run.text)) {
                hits.push({ leaf, leafId, flat, offset });
            }
        });
        const hit = bestHit(hits, run);
        const target = hit === undefined ? undefined : leaves[hit.leaf];
        if (hit === undefined || target === undefined) {
            continue; // the commented text is gone — nowhere to anchor
        }
        target.content = applyAt(
            target.content ?? [],
            hit.offset,
            hit.offset + run.text.length,
            run.mark,
        );
        present.add(id);
    }
}

/** isLeaf reports whether nod holds inline text directly (a comment's host). */
function isLeaf(nod: Node): boolean {
    return (nod.content ?? []).some((c) => c.type === "text");
}

/**
 * flatText concatenates a leaf's inline content into one string: a text node
 * contributes its text and any other inline node the single {@link OBJ}
 * character, so offsets into it map back onto the content by walking it.
 */
function flatText(content: Node[]): string {
    return content
        .map((nod) => (nod.type === "text" ? (nod.text ?? "") : OBJ))
        .join("");
}

/** occurrences lists every offset at which target occurs in flat, overlaps included. */
function occurrences(flat: string, target: string): number[] {
    const out: number[] = [];
    for (
        let idx = flat.indexOf(target);
        idx !== -1;
        idx = flat.indexOf(target, idx + 1)
    ) {
        out.push(idx);
    }
    return out;
}

/** Hit is one candidate anchor: an occurrence of a run's text in a leaf. */
interface Hit {
    /** Document-order index of the leaf holding the occurrence. */
    leaf: number;
    /** The leaf's localId; "" when it has none. */
    leafId: string;
    /** The leaf's flat text. */
    flat: string;
    /** Offset of the occurrence in flat. */
    offset: number;
}

/**
 * bestHit picks the candidate most likely to be the run's original spot, or
 * undefined when there is none. Candidates are ranked, in order, by: sitting in
 * the block with the run's localId; the length of the surrounding text that
 * still matches the original (characters before plus after the occurrence); the
 * nearness of its block to the original one; and the nearness of its offset
 * within the block. A full tie goes to the first in document order, so the choice
 * is deterministic.
 */
function bestHit(hits: Hit[], run: AnnRun): Hit | undefined {
    let best: Hit | undefined;
    let bestKey: number[] = [];
    for (const hit of hits) {
        const end = hit.offset + run.text.length;
        const key = [
            run.leafId !== "" && hit.leafId === run.leafId ? 1 : 0,
            commonSuffix(hit.flat.slice(0, hit.offset), run.before) +
                commonPrefix(hit.flat.slice(end), run.after),
            -Math.abs(hit.leaf - run.leaf),
            -Math.abs(hit.offset - run.offset),
        ];
        if (best === undefined || outranks(key, bestKey)) {
            best = hit;
            bestKey = key;
        }
    }
    return best;
}

/** outranks reports whether key a is lexicographically greater than key b. */
function outranks(a: number[], b: number[]): boolean {
    for (let i = 0; i < a.length; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) {
            return x > y;
        }
    }
    return false;
}

/** commonPrefix returns the length of the longest common prefix of a and b. */
function commonPrefix(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) {
        n++;
    }
    return n;
}

/** commonSuffix returns the length of the longest common suffix of a and b. */
function commonSuffix(a: string, b: string): number {
    let n = 0;
    while (
        n < a.length &&
        n < b.length &&
        a[a.length - 1 - n] === b[b.length - 1 - n]
    ) {
        n++;
    }
    return n;
}

/**
 * applyAt rebuilds content so that the flat-text range [start, end) carries
 * mark, splitting the boundary text nodes as needed. The range lies within one
 * run of adjacent text nodes (it came from a search of the flat text), so no
 * non-text node is ever covered. A node fully outside the range is copied
 * unchanged; a text node overlapping it is cut into its before / inside / after
 * pieces, and the inside piece gains a fresh copy of the mark on top of the
 * node's existing marks.
 */
function applyAt(
    content: Node[],
    start: number,
    end: number,
    mark: Mark,
): Node[] {
    const out: Node[] = [];
    let pos = 0;
    for (const nod of content) {
        if (nod.type !== "text") {
            out.push(nod);
            pos++;
            continue;
        }
        const text = nod.text ?? "";
        const from = Math.max(start, pos);
        const to = Math.min(end, pos + text.length);
        if (from >= to) {
            out.push(nod);
        } else {
            const lead = from - pos;
            const before = text.slice(0, lead);
            const inside = text.slice(lead, to - pos);
            const after = text.slice(to - pos);
            if (before !== "") {
                out.push(withText(nod, before));
            }
            out.push(addMark(withText(nod, inside), mark));
            if (after !== "") {
                out.push(withText(nod, after));
            }
        }
        pos += text.length;
    }
    return out;
}

/** withText clones a text node with new text and an independent marks array. */
function withText(nod: Node, text: string): Node {
    const copy: Node = { ...nod, text };
    if (nod.marks !== undefined) {
        copy.marks = nod.marks.map(cloneMark);
    }
    return copy;
}

/**
 * addMark appends a clone of mark to a text node's marks unless one with the same
 * annotation id is already present, so an overlapping re-anchor does not duplicate
 * it. The node is mutated in place; it is always a fresh copy from {@link withText}.
 */
function addMark(nod: Node, mark: Mark): Node {
    const id = attrStr(mark.attrs, "id");
    const marks = nod.marks ?? [];
    const dup = marks.some(
        (m) => m.type === "annotation" && attrStr(m.attrs, "id") === id,
    );
    if (!dup) {
        marks.push(cloneMark(mark));
        nod.marks = marks;
    }
    return nod;
}

/** cloneMark deep-copies a mark so a re-applied annotation never aliases attrs. */
function cloneMark(mark: Mark): Mark {
    return {
        type: mark.type,
        ...(mark.attrs === undefined ? {} : { attrs: { ...mark.attrs } }),
    };
}
