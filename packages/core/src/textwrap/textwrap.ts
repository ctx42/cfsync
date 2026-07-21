// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Reflow a single paragraph of text so no line is wider than a given display
// width, without ever splitting a word or a hyphenated word. Ported from
// `pkg/textwrap/textwrap.go`; `stringWidth` stands in for `go-runewidth`'s
// default (non-East-Asian) condition: wide/fullwidth runes count as two display
// columns, zero-width runes as none, everything else as one.

/**
 * Inclusive code-point ranges that occupy two display columns — the East Asian
 * Wide (W) and Fullwidth (F) blocks. Kept sorted so {@link runeWidth} can binary
 * search.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f], // Hangul Jamo
    [0x2e80, 0x303e], // CJK Radicals, Kangxi Radicals, CJK Symbols
    [0x3041, 0x33ff], // Hiragana, Katakana, CJK symbols and punctuation
    [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
    [0x4e00, 0x9fff], // CJK Unified Ideographs
    [0xa000, 0xa4cf], // Yi Syllables and Radicals
    [0xac00, 0xd7a3], // Hangul Syllables
    [0xf900, 0xfaff], // CJK Compatibility Ideographs
    [0xfe10, 0xfe19], // Vertical Forms
    [0xfe30, 0xfe6f], // CJK Compatibility Forms, Small Form Variants
    [0xff00, 0xff60], // Fullwidth Forms
    [0xffe0, 0xffe6], // Fullwidth signs
    [0x1f300, 0x1f64f], // Miscellaneous Symbols and Pictographs, Emoticons
    [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
    [0x20000, 0x3fffd], // CJK Unified Ideographs Extensions B–F
];

/**
 * Inclusive code-point ranges that occupy no display columns — combining marks,
 * zero-width formatting characters, and C0/C1 control characters.
 */
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x0000, 0x001f], // C0 control
    [0x007f, 0x009f], // DEL and C1 control
    [0x0300, 0x036f], // Combining Diacritical Marks
    [0x0483, 0x0489], // Cyrillic combining
    [0x0591, 0x05bd], // Hebrew combining
    [0x0610, 0x061a], // Arabic combining
    [0x064b, 0x065f], // Arabic combining
    [0x1160, 0x11ff], // Hangul Jungseong/Jongseong (conjoining, zero-width)
    [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
    [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
    [0x200b, 0x200f], // Zero-width space, joiners, direction marks
    [0x2060, 0x2064], // Word joiner and invisible operators
    [0x20d0, 0x20ff], // Combining Diacritical Marks for Symbols
    [0xfe20, 0xfe2f], // Combining Half Marks
    [0xfeff, 0xfeff], // Zero-width no-break space (BOM)
];

/** Return whether `cp` falls in any of the sorted inclusive `ranges`. */
function inRanges(
    cp: number,
    ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const range = ranges[mid];
        if (range === undefined) {
            break;
        }
        const [start, end] = range;
        if (cp < start) {
            hi = mid - 1;
        } else if (cp > end) {
            lo = mid + 1;
        } else {
            return true;
        }
    }
    return false;
}

/** The display width of a single code point, in terminal columns (0, 1, or 2). */
function runeWidth(cp: number): number {
    if (inRanges(cp, ZERO_RANGES)) {
        return 0;
    }
    if (inRanges(cp, WIDE_RANGES)) {
        return 2;
    }
    return 1;
}

/**
 * stringWidth measures `s` in terminal display columns: double-width runes count
 * as two, zero-width runes as none. Iterating with `for…of` walks the string by
 * code point, so astral characters are measured once.
 */
export function stringWidth(s: string): number {
    let width = 0;
    for (const ch of s) {
        width += runeWidth(ch.codePointAt(0) ?? 0);
    }
    return width;
}

/**
 * wrap reflows `s` into lines no wider than `width` display columns and returns
 * the result with lines joined by `\n` and without a trailing newline.
 *
 * Every run of whitespace collapses to a single space, so existing line breaks
 * are treated as soft and the paragraph is re-wrapped from scratch. Words are
 * whitespace-delimited and atomic: a word, including a hyphenated one such as
 * `state-of-the-art`, is never split. A word wider than `width` on its own
 * occupies a line that exceeds the limit rather than being broken. A width `<= 0`
 * means "no limit". Empty or all-whitespace input yields an empty string.
 */
export function wrap(s: string, width: number): string {
    return wrapTokens(fields(s), width);
}

/**
 * wrapTokens greedily packs `words` onto lines no wider than `width` display
 * columns, joining words with a single space, and returns the result with lines
 * joined by `\n` and without a trailing newline.
 *
 * Each element of `words` is atomic and is never split, so a caller can keep a
 * unit that contains spaces (such as a Markdown link) whole by passing it as a
 * single word. A width `<= 0` means "no limit". An empty `words` array yields an
 * empty string.
 */
export function wrapTokens(words: readonly string[], width: number): string {
    if (words.length === 0) {
        return "";
    }
    if (width <= 0) {
        return words.join(" ");
    }

    const first = words[0] ?? "";
    let out = "";
    let line = first;
    let lineWidth = stringWidth(line);
    for (let i = 1; i < words.length; i++) {
        const word = words[i] ?? "";
        const wordWidth = stringWidth(word);
        // The +1 accounts for the single space joining the word to the line.
        if (lineWidth + 1 + wordWidth <= width) {
            line += ` ${word}`;
            lineWidth += 1 + wordWidth;
            continue;
        }
        out += `${line}\n`;
        line = word;
        lineWidth = wordWidth;
    }
    return out + line;
}

/**
 * fields splits `s` into whitespace-delimited tokens, dropping empty tokens —
 * the equivalent of Go's `strings.Fields`.
 */
function fields(s: string): string[] {
    return s.split(/\s+/u).filter((token) => token.length > 0);
}
