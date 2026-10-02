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
    /**
     * 1-based line where the block starts in the body it was segmented from.
     * {@link segmentBody} sets it; a synthetic block (a re-rendered baseline row,
     * list item, etc.) has no source position and defaults to 1.
     */
    line: number;
}

/** newBlock builds an {@link MdBlock} from raw block text at an optional line. */
export function newBlock(text: string, line = 1): MdBlock {
    return { text, key: normalizeBlock(text), line };
}

/**
 * normalizeBlock returns text with cosmetic layout removed so two blocks
 * differing only by soft-wrapping, reflow, or trailing spaces normalize to the
 * same string; a difference in the words, in a hard break (the `\` survives), or
 * in block structure (the `#`/`>`/`-`/`|` markers survive) does not. A table is
 * canonicalized specially (see {@link normalizeTable}).
 */
export function normalizeBlock(text: string): string {
    if (isThematicBreak(text)) {
        return "---";
    }
    if (isTableBlock(text)) {
        return normalizeTable(text);
    }
    return normalizeInlineText(text);
}

/**
 * isThematicBreak reports whether a block is a horizontal rule: a single
 * non-blank line of three or more of the same `-`, `*` or `_` marker, spaces
 * between them allowed (the CommonMark thematic break). Every spelling — `---`,
 * `***`, `___`, `- - -`, a longer run — normalizes to the one `---` the rule
 * render emits, so a rule reads as unchanged whichever form the note holds. A
 * bullet marker `- ` carries content and so is never a break.
 */
export function isThematicBreak(text: string): boolean {
    let seen = "";
    for (const raw of text.split("\n")) {
        if (isBlankLine(raw)) {
            continue;
        }
        if (seen !== "") {
            return false; // more than one non-blank line
        }
        seen = raw;
    }
    return /^\s*([-*_])(\s*\1){2,}\s*$/.test(seen);
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
 * (indented) or the next item marker of the same kind; otherwise it ends the list.
 */
export function segmentBody(body: string): MdBlock[] {
    const lines = body.split("\n");
    const blocks: MdBlock[] = [];
    let cur: string[] = [];
    let curStart = 1; // 1-based body line of cur[0]
    let inFence = false;
    let inList = false;
    let kind: ListKind = "bullet";

    // push records the block's start line the moment cur becomes non-empty.
    const push = (i: number, ln: string): void => {
        if (cur.length === 0) {
            curStart = i + 1;
        }
        cur.push(ln);
    };

    const flush = (): void => {
        let start = curStart;
        while (cur.length > 0 && isBlankLine(cur[0] ?? "")) {
            cur = cur.slice(1);
            start++; // a trimmed leading blank shifts the start down
        }
        while (cur.length > 0 && isBlankLine(cur[cur.length - 1] ?? "")) {
            cur = cur.slice(0, -1);
        }
        if (cur.length > 0) {
            blocks.push(newBlock(cur.join("\n"), start));
        }
        cur = [];
        inList = false;
    };

    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i] ?? "";
        if (isFenceLine(ln)) {
            inFence = !inFence;
            push(i, ln);
            continue;
        }
        if (inFence) {
            push(i, ln);
            continue;
        }
        if (isBlankLine(ln)) {
            if (inList && listContinues(lines, i, kind)) {
                push(i, ln); // internal blank of a loose list
                continue;
            }
            flush();
            continue;
        }
        if (cur.length === 0 && isListStart(ln)) {
            inList = true;
            kind = listKind(ln);
        }
        push(i, ln);
    }
    flush();
    return joinCaptions(blocks);
}

/**
 * joinCaptions glues a frozen ` ```adf ` caption fence onto the image block
 * before it. A captioned mediaSingle renders as one block — the embed and its
 * caption on adjacent lines — but notes rendered before that layout carry a
 * blank line between the two, which would split one ADF node into two blocks.
 */
function joinCaptions(blocks: MdBlock[]): MdBlock[] {
    const out: MdBlock[] = [];
    for (const b of blocks) {
        const prev = out[out.length - 1];
        if (
            prev !== undefined &&
            isCaptionFence(b.text) &&
            isImages(prev.text)
        ) {
            out[out.length - 1] = newBlock(
                `${prev.text}\n${b.text}`,
                prev.line,
            );
            continue;
        }
        out.push(b);
    }
    return out;
}

/** isCaptionFence reports whether text is a frozen ` ```adf ` caption node. */
function isCaptionFence(text: string): boolean {
    return text.startsWith("```adf\ntype: caption\n");
}

/** isImages reports whether every line of text is an image embed. */
function isImages(text: string): boolean {
    return text.split("\n").every((ln) => ln.startsWith("!["));
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
 * splitMergedLists splits each user block that {@link segmentBody} merged from
 * several baseline blocks back into one block per baseline block. The text
 * alone cannot always tell where a list ends: two bullet lists with nothing (or
 * only an empty paragraph, which renders to nothing) between them read as one
 * loose list, and a paragraph whose text starts with spaces reads as a
 * continuation of the list item before it. The baseline blocks (one per
 * rendered node) can. A user list whose lines are exactly those of two or more
 * consecutive baseline blocks (blank lines aside) is cut back into them. An
 * edited list is cut only along a run of two or more adjacent same-kind
 * baseline lists: of the lists carrying the run's total item count, the one
 * sharing the most lines with the run, and at least one, so an unrelated list
 * of the same size elsewhere in the note is never cut. A user block matching neither (an item added or
 * removed) is left whole, for the lens to judge as before.
 */
export function splitMergedLists(user: MdBlock[], base: MdBlock[]): MdBlock[] {
    const split = splitAtBaseline(user, base);
    const runs = mergedListRuns(base);
    if (runs.length === 0) {
        return split;
    }
    const assigned = new Map<number, ListRun>();
    for (const run of runs) {
        let at = -1;
        let best = 0;
        for (const [i, blk] of split.entries()) {
            const first = blk.text.split("\n", 1)[0] ?? "";
            if (
                assigned.has(i) ||
                !isListStart(first) ||
                listKind(first) !== run.kind ||
                itemStarts(blk.text, run.kind).length !== total(run.counts)
            ) {
                continue;
            }
            const shared = contentLines(blk.text).filter((ln) =>
                run.lines.includes(ln),
            ).length;
            if (shared > best) {
                at = i;
                best = shared;
            }
        }
        if (at >= 0) {
            assigned.set(at, run);
        }
    }
    const out: MdBlock[] = [];
    for (const [i, blk] of split.entries()) {
        const run = assigned.get(i);
        if (run === undefined) {
            out.push(blk);
        } else {
            out.push(...cutAtItems(blk, run.kind, run.counts));
        }
    }
    return out;
}

/**
 * splitAtBaseline cuts each user list block whose non-blank lines are exactly
 * those of two or more consecutive `base` blocks, the first a list, into one
 * block per baseline block. A user block equal to a single baseline block, or
 * covering none exactly, is kept whole.
 */
function splitAtBaseline(user: MdBlock[], base: MdBlock[]): MdBlock[] {
    const baseLines = base.map((b) => contentLines(b.text));
    const out: MdBlock[] = [];
    for (const blk of user) {
        const cover = isListStart(blk.text.split("\n", 1)[0] ?? "")
            ? baselineCover(contentLines(blk.text), baseLines)
            : null;
        if (cover === null) {
            out.push(blk);
            continue;
        }
        // Map each non-blank line to its raw line, then emit one block per
        // covered baseline block, from its first to its last non-blank line.
        const raw = blk.text.split("\n");
        const rows = raw.flatMap((ln, i) => (isBlankLine(ln) ? [] : [i]));
        let at = 0;
        for (const n of cover) {
            const from = rows[at] ?? 0;
            const to = rows[at + n - 1] ?? from;
            out.push(
                newBlock(raw.slice(from, to + 1).join("\n"), blk.line + from),
            );
            at += n;
        }
    }
    return out;
}

/**
 * baselineCover returns the line counts of the consecutive baseline blocks
 * whose lines, in order, are exactly `lines` — two or more of them, the first
 * starting a list — or null when no such run exists or one block alone equals
 * `lines`.
 */
function baselineCover(lines: string[], base: string[][]): number[] | null {
    if (base.some((b) => sameLines(b, lines))) {
        return null;
    }
    for (const [j, first] of base.entries()) {
        if (first.length === 0 || !isListStart(first[0] ?? "")) {
            continue;
        }
        const counts: number[] = [];
        let pos = 0;
        for (let k = j; k < base.length && pos < lines.length; k++) {
            const b = base[k] ?? [];
            if (
                b.length === 0 ||
                !sameLines(b, lines.slice(pos, pos + b.length))
            ) {
                break;
            }
            counts.push(b.length);
            pos += b.length;
        }
        if (pos === lines.length && counts.length >= 2) {
            return counts;
        }
    }
    return null;
}

/**
 * ListRun is a run of adjacent same-kind baseline lists: their item counts and
 * their non-blank lines, in order.
 */
interface ListRun {
    kind: ListKind;
    counts: number[];
    lines: string[];
}

/** mergedListRuns finds the runs of two or more adjacent same-kind lists in `base`. */
function mergedListRuns(base: MdBlock[]): ListRun[] {
    const runs: ListRun[] = [];
    let cur: ListRun | null = null;
    for (const b of base) {
        const first = b.text.split("\n", 1)[0] ?? "";
        const kind = isListStart(first) ? listKind(first) : null;
        if (kind !== null && cur !== null && cur.kind === kind) {
            cur.counts.push(itemStarts(b.text, kind).length);
            cur.lines.push(...contentLines(b.text));
            continue;
        }
        if (cur !== null && cur.counts.length > 1) {
            runs.push(cur);
        }
        cur =
            kind === null
                ? null
                : {
                      kind,
                      counts: [itemStarts(b.text, kind).length],
                      lines: contentLines(b.text),
                  };
    }
    if (cur !== null && cur.counts.length > 1) {
        runs.push(cur);
    }
    return runs;
}

/** contentLines returns the non-blank lines of `text`. */
function contentLines(text: string): string[] {
    return text.split("\n").filter((ln) => !isBlankLine(ln));
}

/** sameLines reports whether two line lists are equal. */
function sameLines(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((ln, i) => ln === b[i]);
}

/** total sums item counts. */
function total(counts: number[]): number {
    return counts.reduce((a, b) => a + b, 0);
}

/** itemStarts returns the line indices of the top-level item markers of `kind` in a list. */
function itemStarts(text: string, kind: ListKind): number[] {
    const out: number[] = [];
    for (const [i, ln] of text.split("\n").entries()) {
        if (isListStart(ln) && listKind(ln) === kind) {
            out.push(i);
        }
    }
    return out;
}

/** cutAtItems splits a list block into consecutive lists of `counts` items each. */
function cutAtItems(blk: MdBlock, kind: ListKind, counts: number[]): MdBlock[] {
    const lines = blk.text.split("\n");
    const starts = itemStarts(blk.text, kind);
    const out: MdBlock[] = [];
    let item = 0;
    for (const n of counts) {
        const from = starts[item] ?? lines.length;
        item += n;
        const to = starts[item] ?? lines.length;
        let end = to;
        while (end > from && isBlankLine(lines[end - 1] ?? "")) {
            end--;
        }
        out.push(newBlock(lines.slice(from, end).join("\n"), blk.line + from));
    }
    return out;
}

/** ListKind is the marker family of a top-level list. */
type ListKind = "bullet" | "ordered";

/** listKind returns the marker family of the list item starting ln. */
function listKind(ln: string): ListKind {
    return orderedMarkerWidth(ln) > 0 ? "ordered" : "bullet";
}

/**
 * listContinues reports whether the list of `kind` containing the blank line at
 * index i keeps going: it does when the next non-blank line is an indented item
 * continuation or the next item marker of the same kind. A marker of the other
 * kind starts a new list, as in CommonMark — the renderer emits adjacent
 * numbered and bullet lists as separate blocks, and treating them as one would
 * pair the merged text with a single list node and refuse an unedited note.
 */
function listContinues(lines: string[], i: number, kind: ListKind): boolean {
    for (let j = i + 1; j < lines.length; j++) {
        const lj = lines[j] ?? "";
        if (isBlankLine(lj)) {
            continue;
        }
        return lj.startsWith(" ") || (isListStart(lj) && listKind(lj) === kind);
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
