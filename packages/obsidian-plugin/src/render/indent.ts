// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Pure recognition of the core's `N> ` indentation marker. Byte-preserving: the
// plugin decorates the marker visually but never rewrites it, so this only reads
// text. The rule mirrors core's indentMarkerLen (digits + `>` + a space).

/** IndentMarker is a parsed leading indentation marker. */
export interface IndentMarker {
    /** The indentation level (clamped to MAX_INDENT_LEVEL). */
    level: number;
    /** The length of the marker including the trailing space, e.g. `1> ` = 3. */
    markerLen: number;
}

/** MAX_INDENT_LEVEL caps rendered indentation so a bad marker can't run away. */
export const MAX_INDENT_LEVEL = 10;

const MARKER = /^(\d+)>[ \t]/;

/**
 * parseIndentMarker returns the marker at the start of `line`, or null when the
 * line does not begin with one. The escaped `\N>` form is not a marker. A level
 * above MAX_INDENT_LEVEL is clamped to MAX_INDENT_LEVEL by numeric value, so
 * 11, 99, and 999 all clamp to the same cap.
 */
export function parseIndentMarker(line: string): IndentMarker | null {
    const m = MARKER.exec(line);
    if (m === null) {
        return null;
    }
    const digits = m[1] ?? "";
    const level = Math.min(Number.parseInt(digits, 10), MAX_INDENT_LEVEL);
    return { level, markerLen: m[0].length };
}

/**
 * isEscapedMarker reports whether `text` is the escaped literal form `\N>` that
 * the renderer emits for flush-left text that would otherwise look like a marker.
 */
export function isEscapedMarker(text: string): boolean {
    return /^\\\d+>/.test(text);
}

/** IndentDecoration describes how to decorate one source line. */
export interface IndentDecoration {
    /** 0-based line index. */
    line: number;
    /** Indentation level driving the left padding. */
    level: number;
    /** Start offset of the marker glyph to hide (0). */
    markerFrom: number;
    /** End offset of the marker glyph to hide; equals markerFrom when nothing hides. */
    markerTo: number;
    /** Whether to hide the marker glyph (false while the line is edited). */
    hideMarker: boolean;
}

/**
 * planIndentDecorations returns the decorations for every indented paragraph in
 * `lines`. A paragraph's first line carries the `N> ` marker (hidden unless it
 * is in `editingLines`); its wrapped continuation lines — non-blank lines up to
 * the next blank line — inherit the level with no marker to hide. Pure and
 * deterministic so it is unit-testable without a CodeMirror view.
 */
export function planIndentDecorations(
    lines: string[],
    editingLines: ReadonlySet<number>,
): IndentDecoration[] {
    const out: IndentDecoration[] = [];
    let i = 0;
    while (i < lines.length) {
        const marker = parseIndentMarker(lines[i] ?? "");
        if (marker === null) {
            i++;
            continue;
        }
        out.push({
            line: i,
            level: marker.level,
            markerFrom: 0,
            markerTo: marker.markerLen,
            hideMarker: !editingLines.has(i),
        });
        // Continuation lines of the same wrapped paragraph (margin > 0). A
        // line that itself starts with an `N>` marker is a new paragraph, not
        // a continuation of this one, even with no blank line between them.
        let j = i + 1;
        while (j < lines.length) {
            const ln = lines[j] ?? "";
            if (ln.trim() === "" || parseIndentMarker(ln) !== null) {
                break;
            }
            out.push({
                line: j,
                level: marker.level,
                markerFrom: 0,
                markerTo: 0,
                hideMarker: false,
            });
            j++;
        }
        i = j;
    }
    return out;
}
