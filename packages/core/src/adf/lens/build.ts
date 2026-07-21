// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Block construction for inserted Markdown, ported from `pkg/adf/build.go`. When
// the push diff inserts a top-level block, buildBlock builds the ADF node the
// inverse of every shape the renderer emits: a fenced code block (a frozen ```adf
// macro block round-trips here as a read-only code block), a pipe table, a bullet
// or numbered list, a `> `-quoted panel/expand/blockquote, an added image, and
// the plain paragraph or heading fallback. A block that cannot be rebuilt
// losslessly — one nesting another structured block among them — is rejected
// rather than guessed, and the lens laws still gate whatever is built. Shares the
// leaf/split helpers with `reconstruct.ts`.
//
// Divergence from Go: the `[[TOC]]` marker (and the whole `[[…]]` directive
// family) is evicted in the Obsidian dialect, so there is no marker-based
// `buildTOC`. Instead an inserted frozen ```adf``` Table of Contents block is
// rebuilt into a live `toc` macro (buildMacro); other frozen macros stay code
// blocks, as their render dropped attrs the fence cannot recover.

import { attrStr, type Node } from "../../models/adf.ts";
import {
    isBlankLine,
    isFenceLine,
    isListStart,
    leadingHashes,
    orderedMarkerWidth,
} from "../parse/blocks.ts";
import type { ParseCtx } from "../parse/inline.ts";
import { spanMarker } from "../render/table.ts";
import {
    buildListItem,
    insertableAsLeaf,
    type NewImage,
    parseCodeFence,
    parseExpandTitle,
    parseUserTable,
    rebuildInline,
    rebuildLeaf,
    splitBulletItems,
    splitOrderedItems,
    splitQuotedParagraphs,
} from "./reconstruct.ts";

/**
 * panelTypes lists the Confluence panel types an inserted `[!TYPE]` tag may name.
 * A `custom` panel carries color and emoji attributes the Markdown tag cannot
 * express, so it is deliberately absent.
 */
const panelTypes = new Set(["info", "note", "success", "warning", "error"]);

/**
 * buildBlock constructs a new top-level node from an inserted Markdown block. idx
 * names the block in error messages; images resolves an inserted `![](path)` to
 * its uploaded attachment. It throws a `push: cannot insert block N: …` error when
 * the block has no lossless form.
 */
export function buildBlock(
    text: string,
    idx: number,
    pc: ParseCtx,
    images: Record<string, NewImage>,
): Node {
    try {
        return buildDispatch(text, pc, images);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`push: cannot insert block ${idx}: ${reason}`);
    }
}

/**
 * buildDispatch picks the builder matching the inserted block's marker and runs
 * it; see {@link buildBlock} for the shapes. Its errors are bare reasons, left to
 * buildBlock to prefix with the block's position.
 */
function buildDispatch(
    text: string,
    pc: ParseCtx,
    images: Record<string, NewImage>,
): Node {
    const line = text.split("\n")[0] ?? "";
    // Go's `[[TOC]]` marker is evicted in the Obsidian dialect, where a macro
    // renders as a frozen ```adf block. An inserted Table of Contents block is
    // rebuilt into a live `toc` macro (see {@link buildMacro}); every other frozen
    // adf block round-trips losslessly as a read-only code block, since the render
    // dropped attrs it cannot recover.
    if (isFenceLine(line)) {
        return buildMacro(text) ?? buildCodeBlock(text);
    }
    if (line.startsWith("|")) {
        return buildTable(text, pc);
    }
    if (line.startsWith("- ")) {
        return buildBulletList(text, pc);
    }
    if (orderedMarkerWidth(line) > 0) {
        return buildOrderedList(text, pc);
    }
    if (line.startsWith("* ") || line.startsWith("+ ")) {
        throw new Error('write bullet items with a "- " marker');
    }
    if (line.startsWith("> ")) {
        return buildQuoted(text, pc);
    }

    const target = parseImageBlock(text);
    if (target !== null) {
        const found = images[target];
        if (found !== undefined) {
            return mediaSingleNode(found);
        }
        throw new Error(`image "${target}" has no uploaded attachment`);
    }
    if (!insertableAsLeaf(text)) {
        throw new Error(
            "a directive, comment or unsupported marker block cannot be inserted",
        );
    }
    const node: Node = { type: "paragraph" };
    const lvl = leadingHashes(text);
    if (lvl >= 1 && lvl <= 6) {
        node.type = "heading";
    }
    rebuildLeaf(node, text, pc);
    return node;
}

/**
 * buildCodeBlock constructs a codeBlock from an inserted fenced block, the inverse
 * of the code-block render: the language comes off the opening fence and the body
 * is kept literal, fences stripped. A body whose own text breaks the fence shape
 * cannot re-render to the user's block, so the lens laws reject it downstream.
 */
function buildCodeBlock(text: string): Node {
    const { language, body } = parseCodeFence(text);
    const node: Node = { type: "codeBlock" };
    if (language !== "") {
        node.attrs = { language };
    }
    if (body !== "") {
        node.content = [{ type: "text", text: body }];
    }
    return node;
}

/**
 * buildMacro rebuilds a Confluence macro node from an inserted frozen ```adf```
 * fence, or returns null when it is an ordinary code block or a macro this lens
 * cannot reconstruct (see {@link macroFromAdf}). It lets an inserted Table of
 * Contents block push as a live macro instead of a literal code fence.
 */
function buildMacro(text: string): Node | null {
    const { language, body } = parseCodeFence(text);
    return macroFromAdf(language, body);
}

/**
 * healAdfCodeBlock upgrades a stale frozen-macro code block — one an earlier
 * insert wrote as a `codeBlock` under the reserved `adf` language before macros
 * were rebuilt (or one a pre-fix push froze on the Site) — into its live macro
 * node, or returns null for an ordinary code block. Only the Table of Contents is
 * healed. The healed node re-renders to the same `adf` fence, so an unchanged
 * block still reads as a keep and the upgrade rides through the push. It lets a
 * TOC that was frozen as a code block become a real macro on the next push
 * without any edit to the note.
 */
export function healAdfCodeBlock(node: Node): Node | null {
    if (node.type !== "codeBlock") {
        return null;
    }
    let body = "";
    for (const child of node.content ?? []) {
        if (child.type === "text") {
            body += child.text ?? "";
        }
    }
    return macroFromAdf(attrStr(node.attrs, "language"), body);
}

/**
 * macroFromAdf rebuilds a Confluence macro node from a frozen adf block's language
 * and YAML body, or returns null when the block is not an `adf` fence or names a
 * macro this lens cannot reconstruct faithfully. Only `type: toc` is rebuilt: its
 * render carries every field the node needs, so the added `extensionType`/`layout`
 * are not re-emitted and PutGet still holds. Any other frozen macro dropped
 * non-string attrs on render that the body cannot recover, so it stays null.
 */
function macroFromAdf(language: string, body: string): Node | null {
    if (language !== "adf") {
        return null;
    }
    const fields = parseMacroBody(body);
    if (fields["type"] !== "toc") {
        return null;
    }
    const attrs: Record<string, unknown> = {
        layout: "default",
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey: "toc",
    };
    const localId = fields["localId"];
    if (localId !== undefined && localId !== "") {
        attrs["localId"] = localId;
    }
    return { type: "extension", attrs };
}

/**
 * parseMacroBody reads a frozen adf block's YAML body into a flat field map,
 * inverting the renderer's `key: value` lines: a double-quoted value (the escaped
 * form emitted for an ambiguous scalar) is JSON-decoded, a bare one is taken as
 * is. A line without a `: ` separator is skipped.
 */
function parseMacroBody(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of body.split("\n")) {
        const sep = line.indexOf(": ");
        if (sep < 0) {
            continue;
        }
        const key = line.slice(0, sep);
        const raw = line.slice(sep + 2);
        out[key] = raw.startsWith('"') ? decodeScalar(raw) : raw;
    }
    return out;
}

/**
 * decodeScalar JSON-decodes a double-quoted YAML scalar, falling back to the raw
 * text when it is not valid JSON (so a malformed fence degrades rather than throws).
 */
function decodeScalar(raw: string): string {
    try {
        const v: unknown = JSON.parse(raw);
        return typeof v === "string" ? v : raw;
    } catch {
        return raw;
    }
}

/**
 * buildBulletList constructs a bullet list from an inserted `- `-marked block, the
 * inverse of the bullet-list render: one single-paragraph item per marker (see
 * {@link buildListItem}).
 */
function buildBulletList(text: string, pc: ParseCtx): Node {
    checkListNesting(text, (ln) => ln.startsWith("- "));
    const node: Node = { type: "bulletList", content: [] };
    splitBulletItems(text).forEach((item, i) => {
        node.content?.push(buildListItem(item, i, pc));
    });
    return node;
}

/**
 * buildOrderedList constructs a numbered list from an inserted `N. `-marked block,
 * the inverse of the ordered-list render: one single-paragraph item per marker.
 * The renderer regenerates the numbers from the start recorded in the `order`
 * attribute, so the items must be numbered sequentially; the attribute is set only
 * for a start past one, matching the render's default.
 */
function buildOrderedList(text: string, pc: ParseCtx): Node {
    checkListNesting(text, (ln) => orderedMarkerWidth(ln) > 0);
    const start = listStartNumber(text);
    const node: Node = { type: "orderedList" };
    if (start !== 1) {
        node.attrs = { order: start };
    }
    node.content = [];
    splitOrderedItems(text).forEach((item, i) => {
        node.content?.push(buildListItem(item, i, pc));
    });
    return node;
}

/**
 * checkListNesting rejects an inserted list block whose continuation line begins a
 * structured block of its own — a nested list, table, quote or code fence. Such a
 * line's indentation is exactly what the flat item split discards, so building it
 * would silently flatten the nesting; isItem recognizes the lines that start a new
 * item and are exempt.
 */
function checkListNesting(text: string, isItem: (ln: string) => boolean): void {
    for (const ln of text.split("\n")) {
        if (isItem(ln) || isBlankLine(ln)) {
            continue;
        }
        const trimmed = ln.replace(/^ +/, "");
        if (
            isListStart(trimmed) ||
            trimmed.startsWith("|") ||
            trimmed.startsWith("> ") ||
            trimmed.startsWith("```")
        ) {
            throw new Error("a nested block cannot be inserted");
        }
    }
}

/**
 * listStartNumber reads the numbers off the block's `N. ` item markers, verifies
 * they run sequentially — the renderer regenerates them from the start, so any
 * other numbering cannot round-trip — and returns the first as the list's start,
 * at least one.
 */
function listStartNumber(text: string): number {
    let start = 0;
    let prev = 0;
    let first = true;
    for (const ln of text.split("\n")) {
        const w = orderedMarkerWidth(ln);
        if (w === 0) {
            continue;
        }
        const n = Number.parseInt(ln.slice(0, w - ". ".length), 10);
        if (Number.isNaN(n)) {
            throw new Error("parsing an item number");
        }
        if (first) {
            start = n;
            prev = n;
            first = false;
            continue;
        }
        if (n !== prev + 1) {
            throw new Error("items must be numbered sequentially");
        }
        prev = n;
    }
    return Math.max(start, 1);
}

/**
 * buildQuoted constructs the node for an inserted `> `-quoted block, keyed by its
 * first line's tag: `[!EXPAND]` is an expand whose tag line carries the title,
 * another `[!TYPE]` tag is a panel of that type, and no tag is a plain blockquote.
 */
function buildQuoted(text: string, pc: ParseCtx): Node {
    const lines = text.split("\n");
    const first = (lines[0] ?? "").replace(/^> /, "");
    if (first.startsWith("[!EXPAND]")) {
        return buildExpand(lines, pc);
    }
    if (first.startsWith("[!")) {
        return buildPanel(lines, first, pc);
    }
    return {
        type: "blockquote",
        content: buildQuotedParagraphs(lines, "a blockquote", pc),
    };
}

/**
 * buildExpand constructs an expand from its quoted lines, the inverse of the
 * expand render: the title comes off the `[!EXPAND]` tag line and is recorded only
 * when present, so a bare tag re-renders bare.
 */
function buildExpand(lines: string[], pc: ParseCtx): Node {
    const paras = buildQuotedParagraphs(lines.slice(1), "an expand", pc);
    const node: Node = { type: "expand", content: paras };
    const title = parseExpandTitle(lines[0] ?? "");
    if (title !== "") {
        node.attrs = { title };
    }
    return node;
}

/**
 * buildPanel constructs a panel from its quoted lines and its already unquoted
 * `[!TYPE]` tag, the inverse of the panel render. The tag must name a type from
 * {@link panelTypes}; anything else — a malformed tag included — is rejected
 * rather than guessed.
 */
function buildPanel(lines: string[], tag: string, pc: ParseCtx): Node {
    const inner = tag.replace(/^\[!/, "");
    const ok = inner.endsWith("]");
    const typ = (ok ? inner.slice(0, -1) : inner).toLowerCase();
    if (!ok || !panelTypes.has(typ)) {
        throw new Error(`unknown panel type "${tag}"`);
    }
    return {
        type: "panel",
        attrs: { panelType: typ },
        content: buildQuotedParagraphs(lines.slice(1), "a panel", pc),
    };
}

/**
 * buildQuotedParagraphs constructs the paragraph children of an inserted quoted
 * container from its `> `-marked body lines, one node per blank-separated
 * paragraph. A body is required, and each paragraph must be plain inline text: a
 * nested structured block has no lossless place in a fresh container. kind names
 * the container, article included, in error messages.
 */
function buildQuotedParagraphs(
    lines: string[],
    kind: string,
    pc: ParseCtx,
): Node[] {
    const texts = splitQuotedParagraphs(lines);
    if (texts.length === 0) {
        throw new Error(`${kind} needs a body`);
    }
    return texts.map((txt) => {
        if (!insertableAsLeaf(txt)) {
            throw new Error("a nested block cannot be inserted");
        }
        const para: Node = { type: "paragraph" };
        rebuildInline(para, txt, pc);
        return para;
    });
}

/**
 * buildTable constructs a table from an inserted Markdown pipe table, the inverse
 * of the table render. A first row with any content becomes a row of header cells,
 * the GFM header; an all-blank first row is the synthetic header the renderer
 * writes for a headerless table, and is dropped. Every row must have the same cell
 * count, and a cell showing the `«` span marker is rejected, as GFM cannot express
 * the span behind it.
 */
function buildTable(text: string, pc: ParseCtx): Node {
    let grid = parseUserTable(text);
    const cols = grid[0]?.length ?? 0;
    for (const row of grid) {
        if (row.length !== cols) {
            throw new Error(`every table row needs ${cols} cells`);
        }
        for (const cel of row) {
            if (cel.includes(spanMarker)) {
                throw new Error("cell spans cannot be inserted");
            }
        }
    }

    const header = (grid[0] ?? []).some((cel) => cel !== "");
    if (!header) {
        grid = grid.slice(1);
        if (grid.length === 0) {
            throw new Error("a table needs at least one row");
        }
    }

    const node: Node = { type: "table", content: [] };
    grid.forEach((row, r) => {
        const typ = header && r === 0 ? "tableHeader" : "tableCell";
        const tr: Node = { type: "tableRow", content: [] };
        for (const cel of row) {
            tr.content?.push(buildTableCell(cel, typ, pc));
        }
        node.content?.push(tr);
    });
    return node;
}

/**
 * buildTableCell constructs one cell of an inserted table, of the tableHeader or
 * tableCell type typ, holding one paragraph per `<br>`-separated piece of the cell
 * text — the inverse of the join the cell render produces.
 */
function buildTableCell(text: string, typ: string, pc: ParseCtx): Node {
    const cell: Node = { type: typ, content: [] };
    for (const txt of text.split("<br>")) {
        const para: Node = { type: "paragraph" };
        rebuildInline(para, txt, pc);
        cell.content?.push(para);
    }
    return cell;
}

/**
 * parseImageBlock parses a lone Obsidian image embed `![[target]]` into its embed
 * target, the inverse of a resolved block-level media render. A block that is not
 * exactly one embed reports null. (An `![alt](url)` external image carries its own
 * URL and is not a user upload, so it has no insert form here.)
 */
function parseImageBlock(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("![[") || !trimmed.endsWith("]]")) {
        return null;
    }
    return trimmed.slice("![[".length, -"]]".length);
}

/**
 * mediaSingleNode synthesizes the mediaSingle+media node for a user-added image,
 * mirroring the shape Confluence uses for an uploaded file. The file id,
 * collection, localId and alt come from the upload; the node re-renders through
 * the assets map to the same `![[…]]` embed the user wrote (see the media render).
 */
function mediaSingleNode(img: NewImage): Node {
    return {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [
            {
                type: "media",
                attrs: {
                    type: "file",
                    id: img.fileId,
                    collection: img.collection,
                    localId: img.localId,
                    alt: img.alt,
                },
            },
        ],
    };
}
