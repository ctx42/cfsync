// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Table rendering, ported from the table half of `pkg/adf/markdown.go`. An ADF
// table renders as a column-aligned GitHub-flavored Markdown table — dialect-
// stable, so this ports 1:1. Cell spans degrade to a visible marker, a
// key/value table (no header row) renders under a blank header with bolded
// keys, and cell text is escaped so a literal `|` never reads as a column break.

import { attrInt, type Node } from "../../models/adf.ts";
import { stringWidth } from "../../textwrap/textwrap.ts";
import type { MdCtx } from "./markdown.ts";
import { cellText } from "./markdown.ts";

/**
 * spanMarker fills a table position covered by a neighboring cell's colspan or
 * rowspan. GFM has no cell spans, so the origin cell keeps the value and every
 * other position it covers shows this marker instead of a silent empty cell.
 */
export const spanMarker = "«";

/**
 * cellPad is the display width a rendered cell adds around its content — the
 * single space on each side of the `| a |` layout — so a column's separator
 * dashes span the full cell, not just the content.
 */
const cellPad = 2;

/** fillRight pads s with spaces on the right until its display width reaches width. */
function fillRight(s: string, width: number): string {
    const w = stringWidth(s);
    return w >= width ? s : s + " ".repeat(width - w);
}

/**
 * renderTable renders the node as a column-aligned GitHub-flavored Markdown
 * table. Cell padding and separator dashes are sized to each column's widest
 * cell. A table whose first row is entirely tableHeader cells uses that row as
 * the GFM header. A key/value table (a tableHeader in the first column of every
 * row, no header row) has no GFM equivalent, so it renders with a blank header
 * row and its header cells bolded inline. Cell spans degrade via {@link spanMarker}.
 */
export function renderTable(nod: Node, ctx: MdCtx): string {
    const { text, head } = buildTableGrid(nod, ctx);
    const firstRow = text[0];
    if (firstRow === undefined || firstRow.length === 0) {
        return "";
    }
    const cols = firstRow.length;

    // The first row is the GFM header only when every one of its cells is a
    // header; otherwise header cells are bolded as data under a blank header.
    const headerRow = rowAllHeader(head[0] ?? []);

    const display: string[][] = text.map((row, r) =>
        row.map((cellVal, c) => {
            const v = escapeTableCell(cellVal);
            if (
                (head[r]?.[c] ?? false) &&
                !(headerRow && r === 0) &&
                v !== "" &&
                v !== spanMarker
            ) {
                return `**${v}**`;
            }
            return v;
        }),
    );

    const widths = new Array<number>(cols).fill(0);
    for (const row of display) {
        row.forEach((cell, j) => {
            widths[j] = Math.max(widths[j] ?? 0, stringWidth(cell));
        });
    }

    const parts: string[] = [];
    const writeRow = (cells: string[]): void => {
        let line = "";
        for (let j = 0; j < cols; j++) {
            line += `| ${fillRight(cells[j] ?? "", widths[j] ?? 0)} `;
        }
        parts.push(`${line}|`);
    };

    let data = display;
    if (headerRow) {
        writeRow(display[0] ?? []);
        data = display.slice(1);
    } else {
        writeRow(new Array<string>(cols).fill("")); // blank synthetic header
    }
    let sep = "";
    for (let j = 0; j < cols; j++) {
        sep += `|${"-".repeat((widths[j] ?? 0) + cellPad)}`;
    }
    parts.push(`${sep}|`);
    for (const cells of data) {
        writeRow(cells);
    }
    return parts.join("\n");
}

/**
 * escapeTableCell escapes a cell's rendered text so it survives transport in a
 * `|`-delimited GFM table row: a backslash becomes `\\` and a `|` becomes `\|`.
 * Escaping the backslash too keeps the split unambiguous, since directive
 * content can itself emit `\\`.
 */
export function escapeTableCell(s: string): string {
    return s.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

/**
 * buildTableGrid lays an ADF table out as a rectangular grid: cell text by row
 * and column, positions covered by a colspan or rowspan filled with
 * {@link spanMarker}, and a parallel grid recording which positions came from a
 * tableHeader cell. The row and column counts follow the spans, so a spanning
 * cell widens or deepens the grid rather than displacing its neighbors.
 */
export function buildTableGrid(
    nod: Node,
    ctx: MdCtx,
): { text: string[][]; head: boolean[][] } {
    interface Cell {
        text: string;
        head: boolean;
    }
    const placed = new Map<number, Map<number, Cell>>();
    const put = (r: number, c: number, v: Cell): void => {
        let row = placed.get(r);
        if (row === undefined) {
            row = new Map<number, Cell>();
            placed.set(r, row);
        }
        row.set(c, v);
    };
    const taken = (r: number, c: number): boolean =>
        placed.get(r)?.has(c) ?? false;

    let maxRow = -1;
    let maxCol = -1;
    for (const [r, row] of (nod.content ?? []).entries()) {
        let c = 0;
        for (const cel of row.content ?? []) {
            while (taken(r, c)) {
                // skip positions held by a rowspan from above
                c++;
            }
            const cs = Math.max(attrInt(cel.attrs, "colspan"), 1);
            const rs = Math.max(attrInt(cel.attrs, "rowspan"), 1);
            const val = cellText(cel, ctx);
            const isHead = cel.type === "tableHeader";
            for (let dr = 0; dr < rs; dr++) {
                for (let dc = 0; dc < cs; dc++) {
                    const v: Cell =
                        dr !== 0 || dc !== 0
                            ? { text: spanMarker, head: isHead }
                            : { text: val, head: isHead };
                    put(r + dr, c + dc, v);
                    maxRow = Math.max(maxRow, r + dr);
                    maxCol = Math.max(maxCol, c + dc);
                }
            }
            c += cs;
        }
    }
    if (maxRow < 0 || maxCol < 0) {
        return { text: [], head: [] };
    }

    const rows = maxRow + 1;
    const cols = maxCol + 1;
    const text: string[][] = [];
    const head: boolean[][] = [];
    for (let r = 0; r < rows; r++) {
        const trow = new Array<string>(cols).fill("");
        const hrow = new Array<boolean>(cols).fill(false);
        for (let c = 0; c < cols; c++) {
            const v = placed.get(r)?.get(c);
            if (v !== undefined) {
                trow[c] = v.text;
                hrow[c] = v.head;
            }
        }
        text.push(trow);
        head.push(hrow);
    }
    return { text, head };
}

/**
 * rowAllHeader reports whether every cell in a materialized table row came from
 * a tableHeader (an empty row is not a header row).
 */
export function rowAllHeader(row: boolean[]): boolean {
    return row.length > 0 && row.every((h) => h);
}
