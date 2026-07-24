// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Annotation re-anchoring for the Put lens. A Confluence inline comment is an
// `annotation` mark on a run of text; Markdown cannot express it, so a rendered
// body drops it. When the user edits a paragraph that carried one, the reparse
// produces plain text with no annotation, which would silently detach the
// comment. reanchorAnnotations weaves each annotation back onto the reparsed
// text: it finds the exact commented substring in the new content and re-applies
// the mark. A comment whose text the edit changed away no longer matches and is
// dropped — the one unavoidable loss the design accepts (see the "preserve when
// the text survives" contract). The render emits no delimiter for an annotation,
// so re-anchoring never changes the rebuilt body and the PutGet law still holds.

import { attrStr, type Mark, type Node } from "../../models/adf.ts";

/**
 * AnnRun is one inline comment recovered from a leaf's original content: the
 * exact text the annotation covered and the mark to re-apply. Consecutive text
 * nodes sharing an annotation id form a single run, so a comment split across a
 * formatting boundary (part bold, say) is still one contiguous target.
 */
interface AnnRun {
    /** The concatenated text the annotation covered, its re-anchor target. */
    text: string;
    /** The annotation mark to re-apply to the matching span. */
    mark: Mark;
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
                    run = { text: "", mark: m };
                    open.set(id, run);
                    runs.push(run);
                }
                run.text += nod.text ?? "";
            }
        }
        // An id the current node does not carry has ended its contiguous run.
        for (const id of [...open.keys()]) {
            if (!seen.has(id)) {
                open.delete(id);
            }
        }
    }
    return runs;
}

/**
 * reanchorAnnotations re-applies each recovered annotation to newly reparsed
 * content and returns the result. A run is re-anchored only when its covered
 * text appears exactly once across the content (as a substring of a single run
 * of adjacent text nodes); a run that matches zero times — its text was edited
 * away — or more than once — an ambiguous anchor the design will not guess — is
 * dropped. Runs are applied in order; splitting a text node preserves its other
 * marks, so a comment on bold text keeps the bold.
 */
export function reanchorAnnotations(content: Node[], runs: AnnRun[]): Node[] {
    let out = content;
    for (const run of runs) {
        if (run.text !== "") {
            out = applyAnnotation(out, run.text, run.mark);
        }
    }
    return out;
}

/** Band is a maximal run of adjacent text nodes, with their concatenated text. */
interface Band {
    /** Index of the first text node of the band in the content array. */
    start: number;
    /** Index just past the last text node of the band. */
    end: number;
    /** The concatenation of the band's node texts. */
    text: string;
}

/**
 * applyAnnotation re-applies mark to the single occurrence of target in content,
 * or returns content unchanged when target does not occur exactly once. The
 * search is confined to a band (a run of adjacent text nodes) so an annotation is
 * never stretched across an intervening non-text inline node or hard break, where
 * the comment cannot live.
 */
function applyAnnotation(content: Node[], target: string, mark: Mark): Node[] {
    const bands = bandsOf(content);
    let hitBand: Band | undefined;
    let hitOffset = -1;
    let count = 0;
    for (const band of bands) {
        for (
            let idx = band.text.indexOf(target);
            idx !== -1;
            idx = band.text.indexOf(target, idx + target.length)
        ) {
            count++;
            hitBand = band;
            hitOffset = idx;
        }
    }
    if (count !== 1 || hitBand === undefined) {
        return content;
    }
    const marked = applyToBand(
        content.slice(hitBand.start, hitBand.end),
        hitOffset,
        hitOffset + target.length,
        mark,
    );
    return [
        ...content.slice(0, hitBand.start),
        ...marked,
        ...content.slice(hitBand.end),
    ];
}

/** bandsOf partitions content into its maximal runs of adjacent text nodes. */
function bandsOf(content: Node[]): Band[] {
    const bands: Band[] = [];
    let i = 0;
    while (i < content.length) {
        if (content[i]?.type !== "text") {
            i++;
            continue;
        }
        let j = i;
        let text = "";
        while (j < content.length && content[j]?.type === "text") {
            text += content[j]?.text ?? "";
            j++;
        }
        bands.push({ start: i, end: j, text });
        i = j;
    }
    return bands;
}

/**
 * applyToBand rebuilds a band of adjacent text nodes so that the character range
 * [start, end) carries mark, splitting the boundary nodes as needed. A node fully
 * outside the range is copied unchanged; a node overlapping it is cut into its
 * before / inside / after pieces, and the inside piece gains a fresh copy of the
 * mark on top of the node's existing marks.
 */
function applyToBand(
    nodes: Node[],
    start: number,
    end: number,
    mark: Mark,
): Node[] {
    const out: Node[] = [];
    let pos = 0;
    for (const nod of nodes) {
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
