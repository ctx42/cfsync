// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Put lens, ported from `pkg/adf/reconstruct.go`. Put back-ports the edits an
// edited Markdown body expresses onto the cached ADF: it diffs the edited blocks
// against the render baseline, rewrites each modified block in a deep clone while
// copying everything the Markdown cannot express untouched, and validates both
// lens laws before returning. A change it cannot represent losslessly is refused,
// never guessed.
//
// The leaf machinery (M4.2) — paragraphs, headings, the `N>` indent marker, and
// structural insert/delete/reorder — sits above; the container rebuilders (M4.3)
// — bullet and ordered lists, panels, expands, blockquotes and tables — freeze
// each container's structure and rebuild only the changed nested leaves, in the
// section below. Inserted structured blocks are built by `build.ts`.

import {
    type ADF,
    attrInt,
    attrStr,
    type Mark,
    type Node,
} from "../../models/adf.ts";
import type { Links } from "../links.ts";
import {
    isBlankLine,
    isSeparatorRow,
    leadingHashes,
    type MdBlock,
    newBlock,
    normalizeBlock,
    normalizeInlineText,
    orderedMarkerWidth,
    segmentBody,
    splitTableRow,
} from "../parse/blocks.ts";
import { codeFenceEnd, type ParseCtx, parseInline } from "../parse/inline.ts";
import { inlineRoundTrips } from "../parse/selfcheck.ts";
import { ambiguousMentions } from "../render/frontmatter.ts";
import {
    basename,
    indentMarkerLen,
    inlineSegments,
    inlineString,
    listItemBody,
    type MdCtx,
} from "../render/markdown.ts";
import { buildTableGrid, rowAllHeader, spanMarker } from "../render/table.ts";
import { buildBlock, healAdfCodeBlock } from "./build.ts";
import { diffBlocks, type Edit } from "./diff.ts";
import { baselineBlocks, type Origin } from "./sourcemap.ts";

/**
 * NewImage describes a user-added local image to splice into the document on
 * push: the Markdown path as it appears in the edited body, the alt text, and
 * the attributes of the Confluence attachment it was uploaded as. Each inserted
 * `![alt](path)` block whose target is a NewImage becomes a mediaSingle+media
 * node; any other inserted image is rejected, as it has no attachment to point
 * at. (Image splicing itself lands in M4.3.)
 */
export interface NewImage {
    /** The `![](path)` target as written in the Markdown. */
    path: string;
    /** The `![alt]` text. */
    alt: string;
    /** Attachment fileId → media `attrs.id`. */
    fileId: string;
    /** Minted node localId. */
    localId: string;
    /** Media `attrs.collection`, e.g. `contentId-<pageID>`. */
    collection: string;
}

/**
 * put back-ports the edits expressed in an edited Markdown body into the cached
 * document and returns the new document, ready to push. It is the lens put of
 * the push design: the result is what the edited Markdown expresses combined
 * with everything else copied untouched from the cached ADF, so nothing the
 * Markdown cannot express (localId, panel types, macros, table structure) is
 * lost.
 *
 * `body` is the edited Markdown body only, with the frontmatter already
 * stripped; `mentions` is the display-name→account-id map from that frontmatter,
 * used to resolve `@name` mentions; `assets` is the same media map used to
 * render the page on pull, so baseline blocks match. The result is a fresh
 * document; the input is not modified. It throws when a change would be lossy
 * rather than guessing.
 */
export function put(
    adf: ADF,
    body: string,
    mentions: Record<string, string> | null,
    assets: Record<string, string> | null,
    images: NewImage[] | null,
): ADF {
    return putLinks(adf, body, mentions, assets, images, null);
}

/**
 * putLinks is {@link put} with a {@link Links} that maps local Markdown links in
 * the edited body back to the Confluence hrefs to push, and renders the baseline
 * with the same mapping so an unedited cross-linked block is not seen as a
 * change. A null `links` behaves exactly like {@link put}.
 *
 * `force`, when true, re-derives every editable block (not just a modified one)
 * from its own Markdown, so a change in the current MD→ADF conversion — such as
 * a link href re-resolved through `links` — reaches the push even for an
 * unedited block; a non-editable block (a macro, a read-only node) is still kept
 * verbatim rather than rejected. Defaults to `false`, the ordinary push path.
 */
export function putLinks(
    adf: ADF,
    body: string,
    mentions: Record<string, string> | null,
    assets: Record<string, string> | null,
    images: NewImage[] | null,
    links: Links | null,
    force = false,
): ADF {
    const pc: ParseCtx = { mentions: mentions ?? {}, links };
    const base = assets ?? {};
    const [baseBlocks, origins] = baselineBlocks(adf, base, links);
    const userBlocks = segmentBody(body);
    const edits = diffBlocks(baseBlocks, userBlocks);

    const out = clone(adf);
    healMacros(out);

    // A user-added image is spliced in as a media node that renders like any
    // resolved media, so index the new images by the `![[…]]` embed target they
    // render to (the path's basename) and add each to the assets map used to
    // render and validate the rebuilt document, keyed by its minted localId.
    // baseBlocks keep the original assets: the baseline has no new image, and an
    // unchanged block never references one.
    const imgByTarget: Record<string, NewImage> = {};
    const imgs = images ?? [];
    let full = base;
    if (imgs.length > 0) {
        full = { ...base };
        for (const img of imgs) {
            imgByTarget[imageTarget(img.path)] = img;
            full[img.localId] = img.path;
        }
    }

    const ctx: MdCtx = { assets: full, ambig: ambiguousMentions(adf), links };
    if (hasStructural(edits)) {
        applyStructural(
            out,
            origins,
            userBlocks,
            edits,
            ctx,
            pc,
            imgByTarget,
            force,
        );
    } else {
        applyInPlace(out, origins, userBlocks, edits, ctx, pc, force);
    }

    validatePut(out, baseBlocks, userBlocks, edits, full, links);
    return out;
}

/**
 * healMacros upgrades every top-level frozen-macro code block in the cloned output
 * to its live macro node (see {@link healAdfCodeBlock}). A macro a pre-fix push
 * froze as an `adf` code block is thereby restored to a real macro on the next
 * push, even when the block is otherwise unchanged: the healed node renders to the
 * same Markdown, so the diff still pairs the block as a keep and validatePut holds.
 */
function healMacros(out: ADF): void {
    const content = out.doc.content;
    if (content === undefined) {
        return;
    }
    for (let i = 0; i < content.length; i++) {
        const node = content[i];
        if (node === undefined) {
            continue;
        }
        const healed = healAdfCodeBlock(node);
        if (healed !== null) {
            content[i] = healed;
        }
    }
}

/**
 * hasStructural reports whether the edit script inserts or deletes a block, as
 * opposed to only keeping or modifying blocks in place.
 */
function hasStructural(edits: Edit[]): boolean {
    return edits.some((e) => e.kind === "insert" || e.kind === "delete");
}

/**
 * clone returns a deep copy of the document by round-tripping it through JSON, so
 * mutating the copy never affects the input and numbers decode identically to
 * the cached parse.
 */
function clone(adf: ADF): ADF {
    return JSON.parse(JSON.stringify(adf)) as ADF;
}

/**
 * applyInPlace applies a keep/modify-only edit script by rewriting each modified
 * leaf in the cloned tree, leaving every other node — including non-rendered ones
 * with no baseline block — exactly where it was. It is the round-1 path, used
 * whenever no block is inserted or deleted.
 */
function applyInPlace(
    out: ADF,
    origins: Origin[],
    userBlocks: MdBlock[],
    edits: Edit[],
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    const content = out.doc.content ?? [];
    for (const e of edits) {
        // Without force, only a modify rewrites a block; a keep leaves the
        // cloned node untouched. Under force, a keep is re-derived too, so a
        // changed MD→ADF conversion (e.g. a new link href) reaches the push.
        if (e.kind !== "modify" && !(force && e.kind === "keep")) {
            continue;
        }
        const orig = origins[e.baseIndex];
        const node = orig === undefined ? undefined : content[orig.nodeIndex];
        const txt = userBlocks[e.userIndex]?.text;
        if (orig === undefined || node === undefined || txt === undefined) {
            continue;
        }
        editBlock(node, orig, e.baseIndex, txt, ctx, pc, force);
    }
}

/**
 * applyStructural rebuilds the document's top-level content in the user's order
 * from an edit script that inserts, deletes, keeps or modifies blocks. A kept
 * block is copied from the clone verbatim, a modified one is rebuilt in place, an
 * inserted one is built fresh from its Markdown (see {@link buildBlock}), a
 * deleted one is dropped. The read-only lockdown holds for deletes: only a
 * paragraph or heading may be deleted.
 *
 * A non-rendered top-level node (one that renders to nothing, such as the empty
 * trailing paragraph Confluence appends) carries no baseline block, so the edit
 * script never names it. To avoid dropping it, each is anchored to the rendered
 * block it precedes and travels with it, re-emitted verbatim just before that
 * block wherever it lands; the non-rendered nodes after the last rendered block
 * stay at the document's end. A deleted block's leading non-rendered nodes are
 * kept in its place, so the rebuild is never lossy.
 */
function applyStructural(
    out: ADF,
    origins: Origin[],
    userBlocks: MdBlock[],
    edits: Edit[],
    ctx: MdCtx,
    pc: ParseCtx,
    images: Record<string, NewImage>,
    force: boolean,
): void {
    const source = out.doc.content ?? [];
    const [preceding, tail] = nonRenderedGroups(source, origins);

    const content: Node[] = [];
    for (const e of edits) {
        switch (e.kind) {
            case "keep": {
                content.push(...(preceding[e.baseIndex] ?? []));
                const orig = origins[e.baseIndex];
                const node =
                    orig === undefined ? undefined : source[orig.nodeIndex];
                if (node !== undefined) {
                    const txt = userBlocks[e.userIndex]?.text;
                    if (force && orig !== undefined && txt !== undefined) {
                        editBlock(node, orig, e.baseIndex, txt, ctx, pc, force);
                    }
                    content.push(node);
                }
                break;
            }
            case "modify": {
                content.push(...(preceding[e.baseIndex] ?? []));
                const orig = origins[e.baseIndex];
                const node =
                    orig === undefined ? undefined : source[orig.nodeIndex];
                const txt = userBlocks[e.userIndex]?.text;
                if (
                    orig !== undefined &&
                    node !== undefined &&
                    txt !== undefined
                ) {
                    editBlock(node, orig, e.baseIndex, txt, ctx, pc, force);
                    content.push(node);
                }
                break;
            }
            case "insert": {
                const txt = userBlocks[e.userIndex]?.text ?? "";
                content.push(buildBlock(txt, e.userIndex, pc, images));
                break;
            }
            case "delete": {
                const orig = origins[e.baseIndex];
                if (
                    orig !== undefined &&
                    orig.type !== "paragraph" &&
                    orig.type !== "heading"
                ) {
                    throw new Error(
                        `push: cannot delete ${orig.type} block ${e.baseIndex}: ` +
                            "only paragraph and heading blocks can be deleted",
                    );
                }
                // The block is dropped, but its non-rendered anchors are kept.
                content.push(...(preceding[e.baseIndex] ?? []));
                break;
            }
        }
    }
    content.push(...tail);
    out.doc.content = content;
}

/**
 * nonRenderedGroups partitions the top-level nodes that render to nothing (and so
 * have no {@link Origin}) by the rendered block they precede. `preceding[b]`
 * holds the non-rendered nodes lying between rendered block b-1 and rendered
 * block b, anchored to b; `tail` holds those after the last rendered block. Every
 * node not named by origins falls in exactly one group, so
 * {@link applyStructural} can re-emit them without loss when it rebuilds the
 * content in the user's order.
 */
function nonRenderedGroups(
    content: Node[],
    origins: Origin[],
): [Node[][], Node[]] {
    const preceding: Node[][] = [];
    let prev = 0;
    for (const o of origins) {
        preceding.push(content.slice(prev, o.nodeIndex));
        prev = o.nodeIndex + 1;
    }
    return [preceding, content.slice(prev)];
}

/**
 * insertableAsLeaf reports whether an inserted block can be rebuilt as a plain
 * paragraph or heading. It rejects a block whose first line carries a
 * structured-block marker; top-level, such a block gets its own builder, while
 * inside an inserted container it marks nesting the flat rebuild cannot express.
 */
export function insertableAsLeaf(text: string): boolean {
    const line = (text.split("\n")[0] ?? "").replace(/^ +/, "");
    if (orderedMarkerWidth(line) > 0) {
        return false;
    }
    const markers = ["|", "- ", "* ", "+ ", "> ", "```", "![", "<!--", "[["];
    return !markers.some((p) => line.startsWith(p));
}

/**
 * imageTarget is the `![[…]]` embed target a media path renders to — its final
 * `/`-separated segment, matching the media render. A new image is indexed under
 * this so an inserted embed resolves to its uploaded attachment. It reuses the
 * render's {@link basename} so the two derive the target identically.
 */
function imageTarget(path: string): string {
    return basename(path);
}

/**
 * leafEditable reports whether node is a text leaf whose text can be safely
 * reparsed: a paragraph or heading whose every hard-break segment round-trips. A
 * container (handled by {@link editBlock}), a read-only block, or a leaf holding
 * an inexpressible inline node (an emoji, an unsupported mark) is not editable.
 */
function leafEditable(node: Node, ctx: MdCtx, pc: ParseCtx): boolean {
    if (node.type !== "paragraph" && node.type !== "heading") {
        return false;
    }
    for (const seg of inlineSegmentsOf(node.content ?? [])) {
        if (!inlineRoundTrips(seg, ctx, pc)) {
            return false;
        }
    }
    return true;
}

/**
 * editRejectReason explains, for an error message, why a block is not editable.
 */
function editRejectReason(node: Node): string {
    if (node.type !== "paragraph" && node.type !== "heading") {
        return "only paragraph and heading text is editable so far";
    }
    return "it contains formatting the Markdown cannot express losslessly";
}

/**
 * editBlock applies a modify to a top-level block. It rebuilds an editable leaf
 * (a paragraph or heading) in place, or recurses into an editable container (a
 * bullet list, or a single-paragraph panel) to rebuild only the nested leaves the
 * user changed while freezing the container's structure. Any other block — or a
 * leaf holding inline the Markdown cannot express — is rejected. Both lens laws
 * still gate the result, so a reverse-parse that does not perfectly mirror the
 * render fails safely as a rejection rather than a corrupt push.
 */
function editBlock(
    node: Node,
    orig: Origin,
    baseIdx: number,
    text: string,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    if (leafEditable(node, ctx, pc)) {
        rebuildLeaf(node, text, pc);
        return;
    }
    switch (node.type) {
        case "bulletList":
            rebuildBulletList(node, text, ctx, pc, force);
            return;
        case "orderedList":
            rebuildOrderedList(node, text, ctx, pc, force);
            return;
        case "panel":
            rebuildPanel(node, text, ctx, pc, force);
            return;
        case "blockquote":
            rebuildBlockquote(node, text, ctx, pc, force);
            return;
        case "expand":
            rebuildExpand(node, text, ctx, pc, force);
            return;
        case "table":
            rebuildTable(node, text, ctx, pc, force);
            return;
        case "codeBlock":
            rebuildCodeBlock(node, text);
            return;
        default:
            // Under force, a block we cannot re-derive (a macro, a read-only
            // node) is kept verbatim rather than rejected; the PutGet law still
            // catches a genuine edit to it. Without force this stays a refusal.
            if (force) {
                return;
            }
            throw new Error(
                `push: cannot edit ${orig.type} block ${baseIdx}: ` +
                    editRejectReason(node),
            );
    }
}

/**
 * rebuildLeaf replaces node's inline content with the parse of userText, keeping
 * node's type and attributes (localId and the rest) intact. Hard breaks are
 * recovered from the segment separator appropriate to the node kind, and soft
 * wrapping is undone before each segment is parsed.
 */
export function rebuildLeaf(node: Node, userText: string, pc: ParseCtx): void {
    let sep = "\\\n"; // a paragraph hard break: trailing backslash then newline
    let text = userText;
    let level = 0;
    switch (node.type) {
        case "heading": {
            sep = "<br>";
            const lvl = leadingHashes(text);
            if (lvl >= 1 && lvl <= 6) {
                if (node.attrs === undefined) {
                    node.attrs = {};
                }
                node.attrs["level"] = lvl;
            }
            text = text.replace(/^#+/, "").replace(/^ /, "");
            break;
        }
        case "paragraph": {
            [level, text] = stripIndentMarker(text);
            break;
        }
    }

    node.content = parseSegments(text, sep, pc);
    if (node.type === "paragraph") {
        setIndentation(node, level);
    }
}

/**
 * parseCodeFence splits a fenced code block into its language (off the opening
 * fence) and its literal body (the lines between the fences, joined verbatim).
 * It is the shared inverse of the code-block render, used to both build
 * ({@link buildBlock}) and rebuild ({@link rebuildCodeBlock}) a code block.
 */
export function parseCodeFence(text: string): {
    language: string;
    body: string;
} {
    const lines = text.split("\n");
    const language = (lines[0] ?? "")
        .replace(/^ +/, "")
        .replace(/^```/, "")
        .trim();
    const body =
        lines.length > 2 ? lines.slice(1, lines.length - 1).join("\n") : "";
    return { language, body };
}

/**
 * rebuildCodeBlock replaces a code block's language and body in place from the
 * user's edited fenced block, the inverse of the code-block render. The node's
 * other attributes (such as localId) are kept, so the cached node survives apart
 * from what the Markdown expresses; the lens laws still gate the result, so an
 * edit whose body cannot re-render to the user's block fails safely as a
 * rejection rather than a corrupt push.
 */
export function rebuildCodeBlock(node: Node, text: string): void {
    const { language, body } = parseCodeFence(text);
    if (node.attrs === undefined) {
        node.attrs = {};
    }
    if (language !== "") {
        node.attrs["language"] = language;
    } else {
        delete node.attrs["language"];
    }
    if (body !== "") {
        node.content = [{ type: "text", text: body }];
    } else {
        delete node.content;
    }
}

/**
 * parseSegments splits text on the hard-break separator sep and parses each piece
 * into inline nodes, undoing soft wrapping first and inserting a hardBreak node
 * between pieces. It is the shared inline-rebuild core of {@link rebuildLeaf} and
 * {@link rebuildInline}.
 */
function parseSegments(text: string, sep: string, pc: ParseCtx): Node[] {
    const segments = text.split(sep);
    const content: Node[] = [];
    for (const [i, seg] of segments.entries()) {
        if (i > 0) {
            content.push({ type: "hardBreak" });
        }
        content.push(...parseInline(unwrap(seg), pc));
    }
    return content;
}

/**
 * rebuildInline replaces a leaf's inline content with the parse of text,
 * recovering paragraph hard breaks. Unlike {@link rebuildLeaf} it interprets
 * neither a heading level nor an indentation marker, so it suits a paragraph
 * nested in a container, where those markers do not apply.
 */
export function rebuildInline(node: Node, text: string, pc: ParseCtx): void {
    node.content = parseSegments(text, "\\\n", pc);
}

/**
 * stripIndentMarker removes a leading `N>` indentation marker from a paragraph's
 * edited text and returns the level it encodes with the remaining text. A marker
 * escaped as `\N>` is unescaped to literal text at level 0, the inverse of the
 * render's escape. Text with no marker returns level 0 unchanged.
 */
function stripIndentMarker(text: string): [number, string] {
    if (text.startsWith("\\") && indentMarkerLen(text.slice(1)) > 0) {
        return [0, text.slice(1)];
    }
    const n = indentMarkerLen(text);
    if (n === 0) {
        return [0, text];
    }
    // indentMarkerLen guarantees digits then '>'; parseInt can only fail if that
    // invariant is broken, in which case treat the marker as absent.
    const level = Number.parseInt(text.slice(0, n - 1), 10);
    if (Number.isNaN(level)) {
        return [0, text];
    }
    return [level, text.slice(n).replace(/^ /, "")];
}

/**
 * setIndentation rewrites node's indentation to level: it drops any existing
 * indentation mark and, when level is positive, applies a fresh one to the node
 * and to each of its text children, mirroring how Confluence marks an indented
 * paragraph. This makes the `N>` marker the source of truth on push, so changing
 * or removing it re-indents or de-indents the paragraph.
 */
function setIndentation(node: Node, level: number): void {
    const marks = dropIndentation(node.marks);
    if (level <= 0) {
        if (marks.length > 0) {
            node.marks = marks;
        } else {
            delete node.marks;
        }
        return;
    }
    marks.push(indentMark(level));
    node.marks = marks;
    for (const child of node.content ?? []) {
        if (child.type === "text") {
            const childMarks = dropIndentation(child.marks);
            childMarks.push(indentMark(level));
            child.marks = childMarks;
        }
    }
}

/**
 * dropIndentation returns marks with every indentation mark removed, leaving a
 * fresh array so the original is not mutated.
 */
function dropIndentation(marks: Mark[] | undefined): Mark[] {
    const out: Mark[] = [];
    for (const m of marks ?? []) {
        if (m.type !== "indentation") {
            out.push(m);
        }
    }
    return out;
}

/** indentMark builds an indentation mark for the given level. */
function indentMark(level: number): Mark {
    return { type: "indentation", attrs: { level } };
}

/**
 * unwrap collapses a soft-wrapped segment back to one logical line: runs of
 * cosmetic whitespace (the wrap newlines and indentation) become single spaces.
 * It reuses {@link normalizeInlineText}, the same collapse the block key uses, so
 * the internal whitespace of an inline code span or link label is preserved
 * end-to-end — an edit that changes it is a real edit, not undone here.
 */
function unwrap(seg: string): string {
    return normalizeInlineText(seg);
}

/**
 * inlineSegmentsOf splits an inline content slice into segments at hardBreak
 * nodes, dropping the breaks. Each segment is a run the round-trip check and the
 * parser treat as one logical line.
 */
function inlineSegmentsOf(content: Node[]): Node[][] {
    const segs: Node[][] = [];
    let cur: Node[] = [];
    for (const nod of content) {
        if (nod.type === "hardBreak") {
            segs.push(cur);
            cur = [];
            continue;
        }
        cur.push(nod);
    }
    segs.push(cur);
    return segs;
}

/**
 * validatePut checks both lens laws against the rebuilt document and throws
 * identifying the first block that fails. GetPut: a kept block must re-render
 * byte-identically to its cached render. PutGet: every block must re-render to
 * the user's edit (compared normalized, so soft-wrap differences do not count).
 * This is the last gate before a push.
 */
function validatePut(
    out: ADF,
    baseBlocks: MdBlock[],
    userBlocks: MdBlock[],
    edits: Edit[],
    assets: Record<string, string>,
    links: Links | null,
): void {
    const [newBlocks] = baselineBlocks(out, assets, links);
    if (newBlocks.length !== userBlocks.length) {
        throw new Error(
            `push: rebuilt document has ${newBlocks.length} blocks, ` +
                `want ${userBlocks.length} (PutGet failed)`,
        );
    }

    // With only keep/modify edits the new document keeps the baseline order, so
    // new block i corresponds to user block i.
    for (let i = 0; i < newBlocks.length; i++) {
        const nb = newBlocks[i];
        const ub = userBlocks[i];
        if (nb === undefined || ub === undefined) {
            continue;
        }
        if (normalizeBlock(nb.text) !== ub.key) {
            throw new Error(
                `push: block ${i} did not round-trip (PutGet failed)`,
            );
        }
    }
    for (const e of edits) {
        if (e.kind !== "keep") {
            continue;
        }
        const nb = newBlocks[e.userIndex];
        const bb = baseBlocks[e.baseIndex];
        if (nb !== undefined && bb !== undefined && nb.text !== bb.text) {
            throw new Error(
                `push: unchanged block ${e.baseIndex} was altered (GetPut failed)`,
            );
        }
    }
}

// --- M4.3: container rebuilders (lists, panels, expands, blockquotes, tables) ---
// Ported from the second half of `pkg/adf/reconstruct.go`. Each container's
// structure is frozen — copied from the cached ADF — and only the leaf text the
// user changed is rebuilt in place; a change the flat Markdown cannot express
// losslessly is rejected. The top-level lens laws still gate every result.

/**
 * rebuildBulletList back-ports edits into a bullet list; see {@link rebuildList}
 * for the alignment semantics. It splits the edited text into item bodies on the
 * `- ` marker (see {@link splitBulletItems}).
 */
function rebuildBulletList(
    node: Node,
    text: string,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    rebuildList(node, splitBulletItems(text), ctx, pc, force);
}

/**
 * rebuildOrderedList back-ports edits into a numbered list; see
 * {@link rebuildList} for the alignment semantics. It splits the edited text into
 * item bodies on the `N. ` marker (see {@link splitOrderedItems}). The list's
 * `order` start number and its structure are frozen, copied from the cached ADF.
 */
function rebuildOrderedList(
    node: Node,
    text: string,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    rebuildList(node, splitOrderedItems(text), ctx, pc, force);
}

/**
 * rebuildList back-ports edits into a list, item by item, given the edited item
 * bodies already split from the rendered list. It aligns the edited items against
 * the baseline items with the same LCS diff used at the top level (see
 * {@link diffBlocks}), so an item may be kept, modified, inserted or deleted: a
 * kept item is copied verbatim, a modified one has its paragraph rebuilt in place,
 * an inserted one is a fresh single-paragraph item, a deleted one is dropped. A
 * modified or inserted item that is not a single paragraph — one with more than
 * one block, or inline the Markdown cannot express — is rejected. The list's own
 * structure (its nesting) is otherwise frozen, and the top-level PutGet law still
 * gates the rebuilt list.
 */
function rebuildList(
    node: Node,
    items: string[],
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    const content = node.content ?? [];
    const base = content.map((li) => newBlock(listItemBody(li, ctx)));
    const user = items.map((it) => newBlock(it));

    const out: Node[] = [];
    for (const e of diffBlocks(base, user)) {
        switch (e.kind) {
            case "keep": {
                const li = content[e.baseIndex];
                if (li !== undefined) {
                    const body = items[e.userIndex];
                    if (force && body !== undefined) {
                        editListItem(li, body, e.baseIndex, ctx, pc, force);
                    }
                    out.push(li);
                }
                break;
            }
            case "modify": {
                const li = content[e.baseIndex];
                const body = items[e.userIndex];
                if (li !== undefined && body !== undefined) {
                    editListItem(li, body, e.baseIndex, ctx, pc, force);
                    out.push(li);
                }
                break;
            }
            case "insert": {
                const body = items[e.userIndex] ?? "";
                try {
                    out.push(buildListItem(body, e.userIndex, pc));
                } catch (err) {
                    throw new Error(`push: ${errMessage(err)}`);
                }
                break;
            }
            case "delete":
                // The item is dropped by not appending it.
                break;
        }
    }
    node.content = out;
}

/**
 * editListItem rebuilds a modified list item's paragraphs from its edited body,
 * leaving the item's localId and attributes intact. The item's paragraph count is
 * structure and frozen (adding or removing one is rejected, as a merged or split
 * paragraph would not be caught by PutGet — a blank line normalizes to a space); a
 * changed paragraph is rebuilt only if it is a single editable leaf, an unchanged
 * one is left untouched. A non-paragraph child, or inline the Markdown cannot
 * express, is rejected. idx names the item in the error.
 */
function editListItem(
    li: Node,
    body: string,
    idx: number,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    const paras = splitBlankLineParagraphs(body);
    const content = li.content ?? [];
    if (paras.length !== content.length) {
        if (force) {
            return; // keep verbatim
        }
        throw new Error(
            `push: cannot add or remove a paragraph in list item ${idx}`,
        );
    }
    for (let i = 0; i < content.length; i++) {
        const para = content[i];
        const userPara = paras[i];
        if (para === undefined || userPara === undefined) {
            continue;
        }
        if (para.type !== "paragraph") {
            if (force) {
                continue; // keep verbatim
            }
            throw new Error(
                `push: cannot edit list item ${idx} holding a ${para.type}`,
            );
        }
        // Compare in the hard-break form the body was rendered with (\\\n), not
        // inlineString's <br>, so an untouched hard-break sibling is left alone
        // rather than rebuilt.
        const rendered = inlineSegments(para, ctx).join("\\\n");
        if (!force && normalizeBlock(userPara) === normalizeBlock(rendered)) {
            continue; // this paragraph is unchanged
        }
        if (!leafEditable(para, ctx, pc)) {
            if (force) {
                continue; // cannot re-derive; keep verbatim
            }
            throw new Error(
                `push: cannot edit list item ${idx}: it contains formatting ` +
                    "the Markdown cannot express losslessly",
            );
        }
        rebuildInline(para, userPara, pc);
    }
}

/**
 * buildListItem constructs a fresh list item holding a single paragraph parsed
 * from an inserted item body. It carries no localId, so Confluence assigns one on
 * save, as it does for an inserted top-level paragraph. A body that carries a
 * structured-block marker (see {@link insertableAsLeaf}) or spans more than one
 * paragraph has no lossless single-paragraph form and is rejected — a merge would
 * slip past PutGet; idx names the item in the error. The error is a bare reason;
 * each caller prefixes its own context.
 */
export function buildListItem(body: string, idx: number, pc: ParseCtx): Node {
    if (!insertableAsLeaf(body) || splitBlankLineParagraphs(body).length > 1) {
        throw new Error(
            `cannot insert list item ${idx}: only single-paragraph ` +
                "plain-text items can be inserted",
        );
    }
    const para: Node = { type: "paragraph" };
    rebuildInline(para, body, pc);
    return { type: "listItem", content: [para] };
}

/**
 * splitBulletItems splits a rendered bullet list back into its item bodies, the
 * inverse of the list render: a line beginning with a bullet marker (`- `, `* `,
 * or `+ `) starts an item and the following indented or blank lines continue it.
 * Each returned body has its marker and continuation indentation removed but keeps
 * its paragraph-separating blank lines, so a multi-paragraph item survives.
 */
export function splitBulletItems(text: string): string[] {
    const items: string[] = [];
    let cur: string[] = [];
    const flush = (): void => {
        if (cur.length > 0) {
            items.push(cur.join("\n"));
            cur = [];
        }
    };
    for (const ln of text.split("\n")) {
        const body = cutBulletMarker(ln);
        if (body !== null) {
            flush();
            cur.push(body);
        } else if (isBlankLine(ln)) {
            cur.push("");
        } else {
            cur.push(ln.replace(/^ +/, ""));
        }
    }
    flush();
    return items;
}

/** cutBulletMarker strips a leading `- `, `* `, or `+ ` bullet marker, or null. */
function cutBulletMarker(ln: string): string | null {
    for (const m of ["- ", "* ", "+ "]) {
        if (ln.startsWith(m)) {
            return ln.slice(m.length);
        }
    }
    return null;
}

/**
 * splitOrderedItems splits a rendered numbered list back into its item bodies, the
 * inverse of the ordered-list render: a line beginning with an `N. ` marker starts
 * an item and the following indented or blank lines continue it. The numbers
 * themselves are dropped: they are re-derived from the list's frozen `order`
 * attribute on render, never parsed.
 */
export function splitOrderedItems(text: string): string[] {
    const items: string[] = [];
    let cur: string[] = [];
    const flush = (): void => {
        if (cur.length > 0) {
            items.push(cur.join("\n"));
            cur = [];
        }
    };
    for (const ln of text.split("\n")) {
        const w = orderedMarkerWidth(ln);
        if (w > 0) {
            flush();
            cur.push(ln.slice(w));
        } else if (isBlankLine(ln)) {
            cur.push("");
        } else {
            cur.push(ln.replace(/^ +/, ""));
        }
    }
    flush();
    return items;
}

/**
 * rebuildPanel back-ports an edit into a panel's body. The `[!TYPE]` tag line is
 * structure and stays frozen (a changed tag is caught by PutGet and rejected);
 * only the body paragraphs are editable. See {@link rebuildQuotedBody}.
 */
function rebuildPanel(
    node: Node,
    text: string,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    // Drop the frozen "[!TYPE]" tag line; the rest is the quoted body.
    rebuildQuotedBody(node, text.split("\n").slice(1), "panel", ctx, pc, force);
}

/**
 * rebuildExpand back-ports an edit into an expand. Unlike a panel's frozen
 * `[!TYPE]` tag, the `[!EXPAND] title` tag line carries an editable title: the
 * title text is parsed off it and written back to the node, so retitling an expand
 * pushes. The body below the tag is rebuilt like a panel's. The title is left
 * untouched when unchanged, so an absent title is not turned into an empty one by
 * a body-only edit.
 */
function rebuildExpand(
    node: Node,
    text: string,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    const lines = text.split("\n");
    const title = parseExpandTitle(lines[0] ?? "");
    if (title !== attrStr(node.attrs, "title")) {
        if (node.attrs === undefined) {
            node.attrs = {};
        }
        node.attrs["title"] = title;
    }
    rebuildQuotedBody(node, lines.slice(1), "expand", ctx, pc, force);
}

/**
 * parseExpandTitle reads the title off an expand's tag line, the inverse of the
 * tag the expand render emits: the `> ` quote marker and the `[!EXPAND]` token are
 * stripped and the remainder trimmed, so a bare `> [!EXPAND]` yields the empty
 * title.
 */
export function parseExpandTitle(line: string): string {
    const body = line.startsWith("> ") ? line.slice("> ".length) : line;
    const tail = body.startsWith("[!EXPAND]")
        ? body.slice("[!EXPAND]".length)
        : body;
    return tail.trim();
}

/**
 * rebuildQuotedBody back-ports edits into the paragraphs of a `> `-quoted
 * container — a panel's body or a whole blockquote — from its body lines, each
 * still carrying its `> ` (or bare `>`) marker. A paragraph is a run of non-empty
 * quoted lines; a bare `>` line separates two paragraphs. The paragraph count is
 * structure and frozen: adding or removing one is rejected. A changed paragraph is
 * rebuilt only when it is a single editable leaf; an unchanged one is left
 * untouched. kind names the container in error messages.
 */
function rebuildQuotedBody(
    node: Node,
    lines: string[],
    kind: string,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    const userParas = splitQuotedParagraphs(lines);
    const content = node.content ?? [];
    if (userParas.length !== content.length) {
        if (force) {
            return; // keep verbatim
        }
        throw new Error(`push: cannot add or remove a paragraph in a ${kind}`);
    }
    for (let i = 0; i < content.length; i++) {
        const para = content[i];
        const userPara = userParas[i];
        if (para === undefined || userPara === undefined) {
            continue;
        }
        if (para.type !== "paragraph") {
            if (force) {
                continue; // keep verbatim
            }
            throw new Error(
                `push: cannot edit a ${kind} holding a ${para.type}`,
            );
        }
        // Hard-break form matches the quoted body render and rebuildInline.
        const rendered = inlineSegments(para, ctx).join("\\\n");
        if (!force && normalizeBlock(userPara) === normalizeBlock(rendered)) {
            continue; // this paragraph is unchanged
        }
        if (!leafEditable(para, ctx, pc)) {
            if (force) {
                continue; // cannot re-derive; keep verbatim
            }
            throw new Error(
                `push: cannot edit ${kind} text: it contains formatting the ` +
                    "Markdown cannot express losslessly",
            );
        }
        rebuildInline(para, userPara, pc);
    }
}

/**
 * splitQuotedParagraphs turns the body lines of a `> `-quoted container into one
 * unwrapped string per paragraph. Each line's `> ` (or bare `>`) marker is
 * stripped, then the un-marked lines are split into paragraphs on their blank
 * (former bare-`>`) lines.
 */
export function splitQuotedParagraphs(lines: string[]): string[] {
    const plain = lines.map((ln) => {
        if (ln.startsWith("> ")) {
            return ln.slice("> ".length);
        }
        if (ln.startsWith(">")) {
            return ln.slice(">".length);
        }
        return ln;
    });
    return splitBlankLineParagraphs(plain.join("\n"));
}

/**
 * splitBlankLineParagraphs splits text into one unwrapped string per paragraph, a
 * paragraph being a run of non-blank lines and a blank line the separator. Soft
 * wraps collapse to spaces; Markdown hard breaks (a trailing `\`) are kept as
 * `\\\n` so {@link rebuildInline} can recover them.
 */
function splitBlankLineParagraphs(text: string): string[] {
    const paras: string[] = [];
    let cur: string[] = [];
    const flush = (): void => {
        if (cur.length > 0) {
            paras.push(joinSoftWrapLines(cur));
            cur = [];
        }
    };
    for (const ln of text.split("\n")) {
        if (isBlankLine(ln)) {
            flush();
            continue;
        }
        cur.push(ln);
    }
    flush();
    return paras;
}

/**
 * joinSoftWrapLines joins a paragraph's physical lines: soft wraps become spaces,
 * and a trailing backslash hard break is re-emitted as `\\\n` between segments so
 * it matches the render and {@link rebuildInline}.
 */
function joinSoftWrapLines(lines: string[]): string {
    const segs: string[] = [];
    let soft: string[] = [];
    for (const ln of lines) {
        if (hardBreakLine(ln)) {
            soft.push(ln.replace(/\\$/, ""));
            segs.push(unwrap(soft.join(" ")));
            soft = [];
            continue;
        }
        soft.push(ln);
    }
    if (soft.length > 0) {
        segs.push(unwrap(soft.join(" ")));
    }
    return segs.join("\\\n");
}

/**
 * hardBreakLine reports whether ln ends in a Markdown hard break: an odd number of
 * trailing backslashes (a single `\` is the break; `\\` is a literal).
 */
function hardBreakLine(ln: string): boolean {
    let n = 0;
    for (let i = ln.length - 1; i >= 0 && ln.charAt(i) === "\\"; i--) {
        n++;
    }
    return n % 2 === 1;
}

/**
 * rebuildBlockquote back-ports an edit into a blockquote's paragraphs. It is the
 * tag-less sibling of {@link rebuildPanel}: the whole rendered text is the quoted
 * body, with no `[!TYPE]` tag line to drop. See {@link rebuildQuotedBody}.
 */
function rebuildBlockquote(
    node: Node,
    text: string,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    rebuildQuotedBody(node, text.split("\n"), "blockquote", ctx, pc, force);
}

/**
 * rebuildTable back-ports edits into a table cell by cell. The table's shape — its
 * rows, columns, colspans, rowspans and which cells are headers — is structure and
 * stays frozen; only the text inside a cell is editable. It re-derives the same
 * rendered grid the render produced (see {@link buildTableGrid}), parses the
 * user's edited Markdown table back into the same grid, and for every cell whose
 * rendered value changed rebuilds that cell's paragraph in place. A changed cell
 * that is not a single editable paragraph is rejected. Because the render is lossy
 * in several ways — header-column cells are bolded, a blank synthetic header and
 * its separator are injected, and colspan/rowspan-covered positions show the `«`
 * span marker — the reverse parse cannot be perfect in every case; the top-level
 * PutGet law gates the result, so an imperfect reverse parse fails as a safe
 * rejection, never a corrupt push.
 */
function rebuildTable(
    node: Node,
    text: string,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    const grid = buildTableGrid(node, ctx);
    const gridText = grid.text;
    const gridHead = grid.head;
    if (gridText.length === 0 || (gridText[0]?.length ?? 0) === 0) {
        throw new Error("push: cannot edit an empty table");
    }
    const rows = gridText.length;
    const cols = gridText[0]?.length ?? 0;
    const headerRow = rowAllHeader(gridHead[0] ?? []);

    let userGrid: string[][];
    try {
        userGrid = parseUserTable(text);
    } catch (err) {
        throw new Error(`push: ${errMessage(err)}`);
    }
    // A table with no all-header first row renders a blank synthetic header row
    // above the separator; drop it so the remaining rows align to the grid.
    if (!headerRow) {
        userGrid = userGrid.slice(1);
    }
    if (userGrid.length !== rows) {
        throw new Error(
            `push: cannot change the number of table rows ` +
                `(have ${userGrid.length}, want ${rows})`,
        );
    }
    for (const ur of userGrid) {
        if (ur.length !== cols) {
            throw new Error("push: cannot change the number of table columns");
        }
    }

    // Walk the cells in document order, tracking each origin's grid position
    // exactly as buildTableGrid does, and rebuild the ones the user changed.
    const placed = new Map<number, Set<number>>();
    const taken = (r: number, c: number): boolean =>
        placed.get(r)?.has(c) ?? false;
    const mark = (r: number, c: number): void => {
        let row = placed.get(r);
        if (row === undefined) {
            row = new Set<number>();
            placed.set(r, row);
        }
        row.add(c);
    };
    const rowsContent = node.content ?? [];
    for (let r = 0; r < rowsContent.length; r++) {
        const row = rowsContent[r];
        if (row === undefined) {
            continue;
        }
        let c = 0;
        for (const cell of row.content ?? []) {
            while (taken(r, c)) {
                c++; // skip positions held by a rowspan from above
            }
            const cs = Math.max(attrInt(cell.attrs, "colspan"), 1);
            const rs = Math.max(attrInt(cell.attrs, "rowspan"), 1);
            for (let dr = 0; dr < rs; dr++) {
                for (let dc = 0; dc < cs; dc++) {
                    mark(r + dr, c + dc);
                }
            }
            editTableCellIfChanged(
                cell,
                gridText[r]?.[c] ?? "",
                gridHead[r]?.[c] ?? false,
                headerRow && r === 0,
                userGrid[r]?.[c] ?? "",
                r,
                c,
                ctx,
                pc,
                force,
            );
            c += cs;
        }
    }
}

/**
 * editTableCellIfChanged compares a cell's rendered display value against the
 * user's edited value for the same grid position and, when they differ, rebuilds
 * the cell's paragraph. base is the cell's rendered text and head whether it came
 * from a tableHeader; inHeaderRow marks the top row of an all-header-first-row
 * table, whose cells are not bolded. A header cell not in that row is displayed
 * bolded, so the bold wrapping is stripped before the new body is parsed; a cell
 * the user did not touch is left untouched.
 */
function editTableCellIfChanged(
    cell: Node,
    base: string,
    head: boolean,
    inHeaderRow: boolean,
    user: string,
    r: number,
    c: number,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    const bolded = head && !inHeaderRow && base !== "" && base !== spanMarker;
    const display = bolded ? `**${base}**` : base;
    if (!force && user === display) {
        return; // this cell is unchanged
    }
    // Strip the display bold only when the cell is a single bold pair wrapping
    // the whole value — the form the render produced. A value whose outer `**`
    // are two separate bold spans (an interior bold delimiter sits between them)
    // is left for the inline parser instead of being sliced blindly, which would
    // splice the content into a different, wrong shape.
    const body =
        bolded && wrapsInSingleBold(user)
            ? user.slice(2, user.length - 2)
            : user;
    editTableCell(cell, body, r, c, ctx, pc, force);
}

/**
 * wrapsInSingleBold reports whether s is a single `**…**` bold span wrapping its
 * whole content — the shape a bolded header cell renders to. It requires the
 * outer `**` and no further bold delimiter between them; a `**` inside an inline
 * code span is literal, not a delimiter, so it is skipped, and a backslash-
 * escaped `*` never counts.
 */
function wrapsInSingleBold(s: string): boolean {
    if (s.length < 4 || !s.startsWith("**") || !s.endsWith("**")) {
        return false;
    }
    const inner = s.slice(2, s.length - 2);
    let i = 0;
    while (i < inner.length) {
        const c = inner.charAt(i);
        if (c === "\\") {
            i += 2;
            continue;
        }
        if (c === "`") {
            const end = codeFenceEnd(inner, i);
            if (end !== null) {
                i = end;
                continue;
            }
        }
        if (c === "*" && inner.charAt(i + 1) === "*") {
            return false; // an interior bold delimiter: not one wrapping pair
        }
        i++;
    }
    return true;
}

/**
 * editTableCell rebuilds the changed paragraphs of a table cell from its edited
 * body, the `<br>`-separated inverse of the cell render, leaving the cell's type
 * (tableHeader or tableCell), its span attributes and its localId intact. The
 * cell's paragraph count is structure and frozen. A changed paragraph is rebuilt
 * only when it is a single editable leaf; an unchanged one is left alone. A
 * non-paragraph child (a nested list or code block) is rejected rather than
 * rebuilt lossily; r and c name the cell in the error.
 */
function editTableCell(
    cell: Node,
    body: string,
    r: number,
    c: number,
    ctx: MdCtx,
    pc: ParseCtx,
    force: boolean,
): void {
    const content = cell.content ?? [];
    // A cell holding a nested block (a sub-list or code block) renders that block
    // with its newlines flattened to "<br>", which the per-paragraph split below
    // cannot reverse; freeze the whole cell rather than mis-split it.
    for (const child of content) {
        if (child.type !== "paragraph") {
            if (force) {
                return; // keep verbatim
            }
            throw new Error(
                `push: cannot edit a multi-block table cell (row ${r}, col ${c})`,
            );
        }
    }
    const paras = body.split("<br>");
    if (paras.length !== content.length) {
        if (force) {
            return; // keep verbatim
        }
        throw new Error(
            `push: cannot add or remove a paragraph in table cell ` +
                `(row ${r}, col ${c})`,
        );
    }
    for (let i = 0; i < content.length; i++) {
        const para = content[i];
        const raw = paras[i];
        if (para === undefined || raw === undefined) {
            continue;
        }
        const cellBody = unwrap(raw);
        if (
            !force &&
            normalizeBlock(cellBody) === normalizeBlock(inlineString(para, ctx))
        ) {
            continue; // this paragraph is unchanged
        }
        if (!leafEditable(para, ctx, pc)) {
            if (force) {
                continue; // cannot re-derive; keep verbatim
            }
            throw new Error(
                `push: cannot edit table cell (row ${r}, col ${c}): it ` +
                    "contains formatting the Markdown cannot express losslessly",
            );
        }
        rebuildInline(para, cellBody, pc);
    }
}

/**
 * parseUserTable parses a Markdown table body into a grid of trimmed cell strings,
 * one array per row, dropping the `---` separator row. It is the reverse of the
 * table render's row writer. The separator must be the second line, as the
 * renderer always emits it, so a table missing it is rejected. Errors are bare
 * reasons; each caller prefixes its own context.
 */
export function parseUserTable(text: string): string[][] {
    const lines = text.split("\n").filter((ln) => ln.trim() !== "");
    if (lines.length < 2) {
        throw new Error("a table needs a header and a separator row");
    }
    if (!isSeparatorRow(splitTableRow(lines[1] ?? ""))) {
        throw new Error("the table is missing its '---' separator row");
    }
    const grid: string[][] = [];
    for (let i = 0; i < lines.length; i++) {
        if (i === 1) {
            continue; // the separator row
        }
        grid.push(splitTableRow(lines[i] ?? ""));
    }
    return grid;
}

/** errMessage returns an unknown thrown value's message. */
function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
