// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Block segmentation and normalization, ported from `pkg/adf/blocks.go`. A
// rendered Markdown body is a sequence of top-level blocks joined by a blank
// line; push must split an edited body back into the same blocks to diff it
// against the baseline. segmentBody does that split (a fenced code region and a
// list are kept whole even when they hold blank lines), and normalizeBlock
// reduces a block to a whitespace-insensitive key so a reflow is not seen as an
// edit. `baselineBlocks` — which pairs blocks with their source-node origins —
// lands with the source map in M5.2. The table/list scan helpers here are shared
// with the reconstruct lens (M4).

import { codeFenceEnd, scanLink } from "./inline.ts";

/**
 * MdBlock is one top-level Markdown block together with its normalized key. The
 * key collapses runs of whitespace so a block differing only by soft-wrap or
 * reflow compares equal, while a change to the words or structure does not.
 */
export interface MdBlock {
    /** The block's Markdown, without surrounding blank lines. */
    text: string;
    /** The whitespace-normalized form of `text`, used for equality. */
    key: string;
}

/** newBlock builds an {@link MdBlock} from raw block text. */
export function newBlock(text: string): MdBlock {
    return { text, key: normalizeBlock(text) };
}

/**
 * normalizeBlock returns text with cosmetic layout removed so two blocks
 * differing only by soft-wrapping, reflow, or trailing spaces normalize to the
 * same string; a difference in the words, in a hard break (the `\` survives), or
 * in block structure (the `#`/`>`/`-`/`|` markers survive) does not. A table is
 * canonicalized specially (see {@link normalizeTable}).
 */
export function normalizeBlock(text: string): string {
    if (isTableBlock(text)) {
        return normalizeTable(text);
    }
    return normalizeInlineText(text);
}

/**
 * normalizeInlineText collapses cosmetic whitespace — the runs of ASCII spaces,
 * tabs and newlines that a soft-wrap or reflow introduces — to a single space,
 * trimming the ends, so two texts differing only by layout compare equal. Two
 * kinds of whitespace stay significant, because they are content the render
 * emits verbatim and an edit to them must be seen: the internal whitespace of an
 * inline code span (or `adf:` directive) and of a Markdown link `[label](href)`,
 * both of which are copied through untouched. A non-ASCII space such as a
 * non-breaking space is content, not layout, and is likewise preserved — keeping
 * this consistent with {@link isBlankLine}, which does not treat it as blank.
 * It is the shared collapse of the block key and the reconstruct lens's unwrap.
 */
export function normalizeInlineText(s: string): string {
    let out = "";
    let pendingSpace = false;
    const emit = (str: string): void => {
        if (pendingSpace) {
            if (out !== "") {
                out += " ";
            }
            pendingSpace = false;
        }
        out += str;
    };
    let i = 0;
    while (i < s.length) {
        const c = s.charAt(i);
        if (c === " " || c === "\t" || c === "\r" || c === "\n") {
            pendingSpace = true;
            i++;
            continue;
        }
        if (c === "\\") {
            // Keep a backslash escape (e.g. \` or \[) intact so it does not open
            // a code span or link below, but let a bare `\` before whitespace —
            // a hard break — stand alone, so the following newline still folds.
            const next = s.charAt(i + 1);
            if (next !== "" && !isAsciiSpace(next)) {
                emit(c + next);
                i += 2;
            } else {
                emit(c);
                i++;
            }
            continue;
        }
        if (c === "`") {
            const end = codeFenceEnd(s, i);
            if (end !== null) {
                emit(s.slice(i, end));
                i = end;
                continue;
            }
        }
        if (c === "[") {
            const lk = scanLink(s, i);
            if (lk !== null) {
                emit(s.slice(i, lk.end));
                i = lk.end;
                continue;
            }
        }
        emit(c);
        i++;
    }
    return out;
}

/** isAsciiSpace reports whether c is one of the ASCII whitespace characters. */
function isAsciiSpace(c: string): boolean {
    return c === " " || c === "\t" || c === "\r" || c === "\n";
}

/**
 * isTableBlock reports whether a block is a rendered Markdown table: its first
 * non-blank line begins with a `|` pipe.
 */
function isTableBlock(text: string): boolean {
    for (const raw of text.split("\n")) {
        const ln = raw.trim();
        if (ln === "") {
            continue;
        }
        return ln.startsWith("|");
    }
    return false;
}

/**
 * normalizeTable canonicalizes a rendered Markdown table so only its cell
 * contents count for equality, not layout. Each row's cells are trimmed and
 * whitespace-collapsed; the `---` separator row is reduced to a single token, so
 * widening a cell is not mistaken for an edit. Only the row in the separator
 * position — the second non-blank line, where the render always writes it — is
 * treated as a separator, so a single-column data cell that happens to be all
 * `-`/`:` is kept as data rather than collapsed away.
 */
function normalizeTable(text: string): string {
    const rows: string[] = [];
    let lineIdx = 0;
    for (const ln of text.split("\n")) {
        if (ln.trim() === "") {
            continue;
        }
        const cells = splitTableRow(ln);
        if (lineIdx === 1 && isSeparatorRow(cells)) {
            rows.push("|-|");
            lineIdx++;
            continue;
        }
        const collapsed = cells.map((c) => normalizeInlineText(c));
        rows.push(`|${collapsed.join("|")}|`);
        lineIdx++;
    }
    return rows.join(" ");
}

/**
 * segmentBody splits a rendered Markdown body into its top-level blocks, in
 * order. Blocks are separated by one or more blank lines, with two regions
 * emitted whole even when they span blank lines: a fenced code region and a list
 * (whose multi-paragraph items are blank-line separated). A blank line inside a
 * list is internal when the next non-blank line is an item continuation
 * (indented) or the next item marker; otherwise it ends the list.
 */
export function segmentBody(body: string): MdBlock[] {
    const lines = body.split("\n");
    const blocks: MdBlock[] = [];
    let cur: string[] = [];
    let inFence = false;
    let inList = false;

    const flush = (): void => {
        while (cur.length > 0 && isBlankLine(cur[0] ?? "")) {
            cur = cur.slice(1);
        }
        while (cur.length > 0 && isBlankLine(cur[cur.length - 1] ?? "")) {
            cur = cur.slice(0, -1);
        }
        if (cur.length > 0) {
            blocks.push(newBlock(cur.join("\n")));
        }
        cur = [];
        inList = false;
    };

    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i] ?? "";
        if (isFenceLine(ln)) {
            inFence = !inFence;
            cur.push(ln);
            continue;
        }
        if (inFence) {
            cur.push(ln);
            continue;
        }
        if (isBlankLine(ln)) {
            if (inList && listContinues(lines, i)) {
                cur.push(ln); // internal blank of a loose list
                continue;
            }
            flush();
            continue;
        }
        if (cur.length === 0 && isListStart(ln)) {
            inList = true;
        }
        cur.push(ln);
    }
    flush();
    return blocks;
}

/**
 * isListStart reports whether ln begins a list item — a `- `, `* ` or `+ `
 * bullet marker, or a `N. ` numbered marker — at the start of the line.
 */
export function isListStart(ln: string): boolean {
    return (
        ln.startsWith("- ") ||
        ln.startsWith("* ") ||
        ln.startsWith("+ ") ||
        orderedMarkerWidth(ln) > 0
    );
}

/**
 * listContinues reports whether the list containing the blank line at index i
 * keeps going: it does when the next non-blank line is an indented item
 * continuation or the next item marker.
 */
function listContinues(lines: string[], i: number): boolean {
    for (let j = i + 1; j < lines.length; j++) {
        const lj = lines[j] ?? "";
        if (isBlankLine(lj)) {
            continue;
        }
        return lj.startsWith(" ") || isListStart(lj);
    }
    return false;
}

/**
 * isBlankLine reports whether ln is a block separator: empty or only ASCII
 * spaces, tabs and carriage returns. It deliberately does NOT treat other
 * Unicode spaces as blank — a paragraph rendering to just a non-breaking space
 * is a real block the renderer keeps.
 */
export function isBlankLine(ln: string): boolean {
    return /^[ \t\r]*$/.test(ln);
}

/**
 * isFenceLine reports whether ln opens or closes a fenced code block: a line
 * whose first non-space run (up to three leading spaces) is three backticks.
 */
export function isFenceLine(ln: string): boolean {
    const trimmed = ln.replace(/^ +/, "");
    if (ln.length - trimmed.length > 3) {
        return false;
    }
    return trimmed.startsWith("```");
}

/**
 * splitTableRow splits a rendered table row into its trimmed cell texts,
 * unescaping `\\` and `\|` so a cell holding a literal pipe (as a directive's
 * `|` separator does) is recovered whole. Shared with the reconstruct lens.
 */
export function splitTableRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith("|")) {
        s = s.slice(1);
    }
    if (s.endsWith("|")) {
        s = s.slice(0, -1);
    }
    const cells: string[] = [];
    let b = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (c === "\\" && i + 1 < s.length) {
            b += s.charAt(i + 1);
            i++;
        } else if (c === "|") {
            cells.push(b.trim());
            b = "";
        } else {
            b += c;
        }
    }
    cells.push(b.trim());
    return cells;
}

/**
 * isSeparatorRow reports whether a row's cells are all a run of `-`/`:` (the GFM
 * header separator), so it is dropped from the normalized key rather than
 * compared as data.
 */
export function isSeparatorRow(cells: string[]): boolean {
    if (cells.length === 0) {
        return false;
    }
    for (const cel of cells) {
        if (cel === "") {
            return false;
        }
        for (const r of cel) {
            if (r !== "-" && r !== ":") {
                return false;
            }
        }
    }
    return true;
}

/** leadingHashes returns the count of `#` characters at the start of s. */
export function leadingHashes(s: string): number {
    let n = 0;
    while (n < s.length && s.charAt(n) === "#") {
        n++;
    }
    return n;
}

/**
 * orderedMarkerWidth returns the byte width of a leading ordered-list marker
 * `N. ` (one or more digits then `. `) at the start of ln, or 0 when ln does not
 * begin with one. Shared with the reconstruct lens.
 */
export function orderedMarkerWidth(ln: string): number {
    let digits = 0;
    while (digits < ln.length) {
        const ch = ln.charCodeAt(digits);
        if (ch < 48 || ch > 57) {
            break;
        }
        digits++;
    }
    if (digits === 0 || !ln.slice(digits).startsWith(". ")) {
        return 0;
    }
    return digits + ". ".length;
}
