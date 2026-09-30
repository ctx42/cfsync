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
// costs a comment. When it occurs nowhere, the match loosens in two steps —
// ignoring case, then the closest near-match within the comment's own block —
// so a light edit to the commented words keeps the comment. Only a comment whose
// words the edit rewrote beyond that is dropped by the re-anchor; the push then
// moves an open one onto the nearest remaining text rather than detach it (see
// relocateComments and the sync layer). The render emits no delimiter
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
    /**
     * The localIds of the other leaves of the run's document, nearest first (the
     * preceding one on a tie); empty outside {@link collectDocAnnotationRuns}.
     */
    near: string[];
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
                        near: [],
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
 * content and returns the result. The content is the run's own block rebuilt,
 * so the anchor is found by {@link findAnchor} with the near-match allowed. Only
 * a run whose text the edit rewrote beyond a near-match is dropped. Runs are
 * applied in order; splitting a text node preserves its other marks, so a
 * comment on bold text keeps the bold.
 */
export function reanchorAnnotations(content: Node[], runs: AnnRun[]): Node[] {
    let out = content;
    for (const run of runs) {
        if (run.text === "") {
            continue;
        }
        const leaf: Leaf = { leaf: 0, leafId: "", flat: flatText(out) };
        const hit = findAnchor([leaf], run, () => true);
        if (hit !== undefined) {
            out = applyAt(out, hit.offset, hit.end, run.mark);
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
 * {@link graftComments} uses, and the localIds of the leaves around it. It is
 * the input to graftComments, which re-anchors the live page's comments onto a
 * rebuilt push body, and to {@link relocateComments}.
 */
export function collectDocAnnotationRuns(doc: Node): AnnRun[] {
    const runs: AnnRun[] = [];
    const ids: string[] = [];
    const walk = (nod: Node): void => {
        if (isLeaf(nod)) {
            for (const run of collectAnnotationRuns(nod.content ?? [])) {
                run.leaf = ids.length;
                run.leafId = attrStr(nod.attrs, "localId");
                runs.push(run);
            }
            ids.push(attrStr(nod.attrs, "localId"));
        }
        for (const child of nod.content ?? []) {
            walk(child);
        }
    };
    walk(doc);
    for (const run of runs) {
        for (let d = 1; d < ids.length; d++) {
            for (const id of [ids[run.leaf - d], ids[run.leaf + d]]) {
                if (id !== undefined && id !== "") {
                    run.near.push(id);
                }
            }
        }
    }
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
 * is anchored (see {@link findAnchor}), so text that now also appears elsewhere
 * on the page does not cost the comment. The block with the run's localId — the
 * only block known to be the comment's own — is searched first, and the
 * near-match is confined to it. Only a run the edit rewrote beyond that is
 * dropped.
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
        const views: Leaf[] = leaves.map((nod, leaf) => ({
            leaf,
            leafId: attrStr(nod.attrs, "localId"),
            flat: flatText(nod.content ?? []),
        }));
        const hit = findAnchor(
            views,
            run,
            (v) => run.leafId !== "" && v.leafId === run.leafId,
        );
        const target = hit === undefined ? undefined : leaves[hit.leaf];
        if (hit === undefined || target === undefined) {
            continue; // the commented text is gone — nowhere to anchor
        }
        target.content = applyAt(
            target.content ?? [],
            hit.offset,
            hit.end,
            run.mark,
        );
        present.add(id);
    }
}

/**
 * relocateComments moves each comment in `ids` that `doc` no longer anchors
 * onto the nearest text that remains, in place, and returns the ids it moved.
 * It is the last resort for an open comment whose highlighted words the edit
 * rewrote beyond what {@link graftComments} can find: detaching it would make
 * it vanish from the page, while moving it keeps the thread visible next to
 * where it was asked. The comment's own block, found by its localId, is tried
 * first, then the other blocks of the live page nearest first (see
 * {@link AnnRun.near}); the first one still in `doc` with text to hold a
 * comment gets its longest text span (see {@link wholeSpan}). A code block
 * never does, as Confluence allows no comment there. A comment whose runs name
 * no surviving block is left detached and not returned.
 */
export function relocateComments(
    doc: Node,
    runs: AnnRun[],
    ids: ReadonlySet<string>,
): string[] {
    const present = annotationIds(doc);
    const byId = new Map<string, Node>();
    const scan = (nod: Node): void => {
        const id = attrStr(nod.attrs, "localId");
        if (isLeaf(nod) && nod.type !== "codeBlock" && id !== "") {
            byId.set(id, nod);
        }
        for (const child of nod.content ?? []) {
            scan(child);
        }
    };
    scan(doc);

    const moved: string[] = [];
    for (const run of runs) {
        const id = attrStr(run.mark.attrs, "id");
        if (!ids.has(id) || present.has(id)) {
            continue;
        }
        for (const leafId of [run.leafId, ...run.near]) {
            const target = byId.get(leafId);
            const span =
                target === undefined
                    ? undefined
                    : wholeSpan(flatText(target.content ?? []));
            if (target === undefined || span === undefined) {
                continue;
            }
            target.content = applyAt(
                target.content ?? [],
                span[0],
                span[1],
                run.mark,
            );
            present.add(id);
            moved.push(id);
            break;
        }
    }
    return moved;
}

/**
 * wholeSpan returns the [start, end) of the longest stretch of flat text
 * between non-text inline nodes, trimmed of surrounding whitespace, or
 * undefined when the leaf has no text to hold a comment.
 */
function wholeSpan(flat: string): [number, number] | undefined {
    let best: [number, number] | undefined;
    let start = 0;
    for (const part of flat.split(OBJ)) {
        const lead = part.length - part.trimStart().length;
        const len = part.trim().length;
        if (len > 0 && (best === undefined || len > best[1] - best[0])) {
            best = [start + lead, start + lead + len];
        }
        start += part.length + OBJ.length;
    }
    return best;
}

/**
 * annotationIds returns the id of every inline-comment annotation mark in doc.
 * Comparing the live page's set with an outgoing body's names the comments a
 * push would detach.
 */
export function annotationIds(doc: Node): Set<string> {
    const ids = new Set<string>();
    const walk = (nod: Node): void => {
        for (const m of nod.marks ?? []) {
            if (m.type === "annotation") {
                ids.add(attrStr(m.attrs, "id"));
            }
        }
        for (const child of nod.content ?? []) {
            walk(child);
        }
    };
    walk(doc);
    return ids;
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

/**
 * fold lower-cases s one code point at a time, keeping any code point whose
 * lower case has a different length (such as `İ`) as is, so offsets into the
 * folded string are offsets into s.
 */
function fold(s: string): string {
    let out = "";
    for (const ch of s) {
        const low = ch.toLowerCase();
        out += low.length === ch.length ? low : ch;
    }
    return out;
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

/** Leaf is a block that can host a comment, as the anchor search sees it. */
interface Leaf {
    /** Document-order index of the leaf. */
    leaf: number;
    /** The leaf's localId; "" when it has none. */
    leafId: string;
    /** The leaf's flat text (see {@link flatText}). */
    flat: string;
}

/** Hit is one candidate anchor: the span [offset, end) of a leaf's flat text. */
interface Hit extends Leaf {
    /** Offset of the span in flat. */
    offset: number;
    /** Offset just past the span in flat. */
    end: number;
}

/**
 * NEAR_RATIO bounds a near-match: its edit distance from the commented text may
 * be at most this fraction of that text's length, so a short anchor must match
 * (almost) exactly and a sentence tolerates a word's change but not a rewrite.
 */
const NEAR_RATIO = 0.2;

/**
 * findAnchor locates where run's comment belongs among leaves. It searches the
 * comment's own block first — the leaves `home` accepts — for the exact
 * commented text, the same text ignoring case, and then the closest near-match
 * (see {@link nearestSpan}); only when its own block has none of these does it
 * look across all leaves for the exact text, then ignoring case. A near-match is
 * never sought outside the own block, where a similar phrase is not evidence of
 * the comment's spot. Among several occurrences the one best matching the run's
 * original spot wins (see {@link bestHit}). It returns undefined when nothing
 * matches.
 */
function findAnchor(
    leaves: Leaf[],
    run: AnnRun,
    home: (leaf: Leaf) => boolean,
): Hit | undefined {
    const homes = leaves.filter(home);
    const exact = (in_: Leaf[]) => bestHit(hitsOf(in_, run.text, same), run);
    const folded = (in_: Leaf[]) =>
        bestHit(hitsOf(in_, fold(run.text), fold), run);
    return (
        exact(homes) ??
        folded(homes) ??
        nearestSpan(homes, run) ??
        exact(leaves) ??
        folded(leaves)
    );
}

/** same is the identity view of a leaf's flat text. */
function same(s: string): string {
    return s;
}

/** hitsOf lists every occurrence of target in each leaf's flat text as seen by view. */
function hitsOf(
    leaves: Leaf[],
    target: string,
    view: (s: string) => string,
): Hit[] {
    const hits: Hit[] = [];
    for (const leaf of leaves) {
        for (const offset of occurrences(view(leaf.flat), target)) {
            hits.push({ ...leaf, offset, end: offset + target.length });
        }
    }
    return hits;
}

/**
 * nearestSpan finds, across leaves, the span of flat text closest to run's text
 * by case-insensitive edit distance, accepting it only within
 * {@link NEAR_RATIO} of the text's length. A span covering a non-text inline node
 * is never a candidate, since a comment cannot live across one. Ties go to the
 * span starting nearest the run's original offset. The search is the classic
 * approximate substring match: the pattern must be consumed in full, but may
 * start and end anywhere in the flat text.
 */
function nearestSpan(leaves: Leaf[], run: AnnRun): Hit | undefined {
    const limit = Math.floor(run.text.length * NEAR_RATIO);
    if (limit === 0) {
        return undefined; // too short to tolerate any edit; exact already failed
    }
    const pat = fold(run.text);
    let best: Hit | undefined;
    let bestKey: number[] = [];
    for (const leaf of leaves) {
        const text = fold(leaf.flat);
        // dist[j] / from[j]: the least edit distance of the pattern prefix so far
        // against a span of text ending at j, and where that span starts.
        let dist = Array.from({ length: text.length + 1 }, () => 0);
        let from = Array.from({ length: text.length + 1 }, (_, j) => j);
        for (let i = 1; i <= pat.length; i++) {
            const nd = [i];
            const nf = [0];
            for (let j = 1; j <= text.length; j++) {
                const sub =
                    (dist[j - 1] ?? 0) + (pat[i - 1] === text[j - 1] ? 0 : 1);
                const skipPat = (dist[j] ?? 0) + 1;
                const skipText = (nd[j - 1] ?? 0) + 1;
                if (sub <= skipPat && sub <= skipText) {
                    nd.push(sub);
                    nf.push(from[j - 1] ?? 0);
                } else if (skipPat <= skipText) {
                    nd.push(skipPat);
                    nf.push(from[j] ?? 0);
                } else {
                    nd.push(skipText);
                    nf.push(nf[j - 1] ?? 0);
                }
            }
            dist = nd;
            from = nf;
        }
        for (let end = 1; end <= text.length; end++) {
            const d = dist[end] ?? 0;
            const offset = from[end] ?? 0;
            if (d > limit || offset >= end) {
                continue;
            }
            if (leaf.flat.slice(offset, end).includes(OBJ)) {
                continue;
            }
            const key = [-d, -Math.abs(offset - run.offset), end - offset];
            if (best === undefined || outranks(key, bestKey)) {
                best = { ...leaf, offset, end };
                bestKey = key;
            }
        }
    }
    return best;
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
        const end = hit.end;
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
