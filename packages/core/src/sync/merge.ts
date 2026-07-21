// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A vendored, dependency-free three-way line merge (the diff3 algorithm), used
// by the pull to fold remote changes into a note without clobbering unpushed
// local edits. Given a common `base`, the `local` note, and the `remote` render,
// it emits the merged text and reports whether any region genuinely conflicts.
// Non-overlapping changes from the two sides merge silently; only regions both
// sides changed differently get git-style conflict markers, so the note stays
// resolvable in place (VS Code shows a merge UI; Obsidian shows plain markers).
//
// The engine is line-based (matching how the flavor renderer emits Markdown) and
// operates on plain strings with no filesystem, git, or YAML knowledge, so it is
// identical in the CLI and the Obsidian plugin and is unit-tested on its own. It
// is deliberately compact rather than optimal: the LCS is a quadratic DP, which
// is ample for note-sized inputs.

/** MergeLabels name the two sides in the conflict markers this merge emits. */
export interface MergeLabels {
    /** Label after `<<<<<<<` — the local side (the user's edits). */
    local: string;
    /** Label after `>>>>>>>` — the remote side (Confluence). */
    remote: string;
}

/** MergeResult is a three-way merge's output text and whether it conflicts. */
export interface MergeResult {
    /** The merged body, with git-style markers around any conflicting region. */
    text: string;
    /** True when at least one region conflicted and carries markers. */
    conflict: boolean;
}

/** The marker lines a conflict region is wrapped in. */
const OURS = "<<<<<<<";
const SPLIT = "=======";
const THEIRS = ">>>>>>>";

/**
 * hasConflictMarkers reports whether `text` still carries an unresolved conflict
 * marker. It keys off the `<<<<<<<`/`>>>>>>>` lines only, never the `=======`
 * separator, because a bare line of `=` is a valid Markdown setext heading — the
 * angle-bracket markers have no Markdown meaning and so are unambiguous.
 */
export function hasConflictMarkers(text: string): boolean {
    return /^<<<<<<< /m.test(text) || /^>>>>>>> /m.test(text);
}

/**
 * mergeThreeWay merges `local` and `remote` against their common `base`,
 * line by line. A region only one side changed is taken from that side; a region
 * both changed identically is taken once; a region both changed differently is
 * wrapped in conflict markers labelled with `labels`. Passing an empty `base`
 * degrades to a two-way merge: any difference between the sides is one conflict
 * spanning the whole body (used when no cached base is available).
 */
export function mergeThreeWay(
    base: string,
    local: string,
    remote: string,
    labels: MergeLabels,
): MergeResult {
    const o = splitLines(base);
    const a = splitLines(local);
    const b = splitLines(remote);
    const lh = hunks(o, a);
    const rh = hunks(o, b);

    const out: string[] = [];
    let conflict = false;
    let bi = 0; // base cursor
    let li = 0; // index into lh
    let ri = 0; // index into rh

    while (li < lh.length || ri < rh.length || bi < o.length) {
        const nextL = li < lh.length ? (lh[li]?.bStart ?? Infinity) : Infinity;
        const nextR = ri < rh.length ? (rh[ri]?.bStart ?? Infinity) : Infinity;
        const nextStart = Math.min(nextL, nextR);

        // Stable stretch before the next change: copy base lines verbatim.
        if (bi < nextStart) {
            const end = Math.min(nextStart, o.length);
            for (; bi < end; bi++) {
                out.push(o[bi] ?? "");
            }
            continue;
        }

        // A change starts here. Seed the combined range with every hunk that
        // starts exactly at `bi`, then absorb only hunks that strictly overlap
        // it — adjacent (touching) changes stay separate so they merge cleanly.
        const usedL: Hunk[] = [];
        const usedR: Hunk[] = [];
        let rangeEnd = bi;
        while (li + usedL.length < lh.length) {
            const h = lh[li + usedL.length];
            if (h !== undefined && h.bStart === bi) {
                usedL.push(h);
                rangeEnd = Math.max(rangeEnd, h.bEnd);
            } else {
                break;
            }
        }
        while (ri + usedR.length < rh.length) {
            const h = rh[ri + usedR.length];
            if (h !== undefined && h.bStart === bi) {
                usedR.push(h);
                rangeEnd = Math.max(rangeEnd, h.bEnd);
            } else {
                break;
            }
        }
        let grew = true;
        while (grew) {
            grew = false;
            while (li + usedL.length < lh.length) {
                const h = lh[li + usedL.length];
                if (h !== undefined && h.bStart < rangeEnd) {
                    usedL.push(h);
                    rangeEnd = Math.max(rangeEnd, h.bEnd);
                    grew = true;
                } else {
                    break;
                }
            }
            while (ri + usedR.length < rh.length) {
                const h = rh[ri + usedR.length];
                if (h !== undefined && h.bStart < rangeEnd) {
                    usedR.push(h);
                    rangeEnd = Math.max(rangeEnd, h.bEnd);
                    grew = true;
                } else {
                    break;
                }
            }
        }

        if (usedR.length === 0) {
            out.push(...sideOf(bi, rangeEnd, usedL, a, o));
        } else if (usedL.length === 0) {
            out.push(...sideOf(bi, rangeEnd, usedR, b, o));
        } else {
            const left = sideOf(bi, rangeEnd, usedL, a, o);
            const right = sideOf(bi, rangeEnd, usedR, b, o);
            if (linesEqual(left, right)) {
                out.push(...left);
            } else {
                conflict = true;
                out.push(`${OURS} ${labels.local}`);
                out.push(...left);
                out.push(SPLIT);
                out.push(...right);
                out.push(`${THEIRS} ${labels.remote}`);
            }
        }

        li += usedL.length;
        ri += usedR.length;
        bi = rangeEnd;
    }

    return { text: out.join("\n"), conflict };
}

/** Hunk is a base range `[bStart, bEnd)` replaced by side range `[sStart, sEnd)`. */
interface Hunk {
    bStart: number;
    bEnd: number;
    sStart: number;
    sEnd: number;
}

/**
 * hunks diffs `base` against `side` and returns the change hunks between them:
 * the maximal runs where they disagree, each pairing a base range with the side
 * range that replaced it. A deletion has an empty side range; an insertion an
 * empty base range. The gaps between hunks are the lines both share verbatim.
 */
function hunks(base: string[], side: string[]): Hunk[] {
    const matched = lcs(base, side);
    const out: Hunk[] = [];
    let bi = 0;
    let si = 0;
    for (const m of matched) {
        if (m.a > bi || m.b > si) {
            out.push({ bStart: bi, bEnd: m.a, sStart: si, sEnd: m.b });
        }
        bi = m.a + 1;
        si = m.b + 1;
    }
    if (bi < base.length || si < side.length) {
        out.push({
            bStart: bi,
            bEnd: base.length,
            sStart: si,
            sEnd: side.length,
        });
    }
    return out;
}

/**
 * sideOf renders one side's view of the base range `[b0, b1)`: for each `hunk`
 * in the range it emits the side's replacement lines, and for the stable gaps
 * between hunks it copies the base lines (which that side kept verbatim). The
 * hunks must be the subset of that side's hunks lying within `[b0, b1)`.
 */
function sideOf(
    b0: number,
    b1: number,
    hs: Hunk[],
    side: string[],
    base: string[],
): string[] {
    const out: string[] = [];
    let b = b0;
    for (const h of hs) {
        for (let k = b; k < h.bStart; k++) {
            out.push(base[k] ?? "");
        }
        for (let k = h.sStart; k < h.sEnd; k++) {
            out.push(side[k] ?? "");
        }
        b = Math.max(b, h.bEnd);
    }
    for (let k = b; k < b1; k++) {
        out.push(base[k] ?? "");
    }
    return out;
}

/**
 * lcs returns a longest common subsequence of `a` and `b` as index pairs, in
 * increasing order of both indices. It is the standard quadratic DP; note-sized
 * inputs keep it cheap.
 */
function lcs(a: string[], b: string[]): { a: number; b: number }[] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
        new Array<number>(n + 1).fill(0),
    );
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            const row = dp[i];
            const next = dp[i + 1];
            if (row === undefined || next === undefined) {
                continue;
            }
            row[j + 1] = row[j + 1] ?? 0; // keep tsc's noUncheckedIndexedAccess happy
            next[j + 1] = next[j + 1] ?? 0;
            row[j] =
                a[i] === b[j]
                    ? (next[j + 1] ?? 0) + 1
                    : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
        }
    }
    const pairs: { a: number; b: number }[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            pairs.push({ a: i, b: j });
            i++;
            j++;
            continue;
        }
        const down = dp[i + 1]?.[j] ?? 0;
        const right = dp[i]?.[j + 1] ?? 0;
        if (down >= right) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

/** splitLines splits into lines, treating the empty string as zero lines. */
function splitLines(text: string): string[] {
    return text === "" ? [] : text.split("\n");
}

/** linesEqual reports whether two line arrays are identical. */
function linesEqual(x: string[], y: string[]): boolean {
    if (x.length !== y.length) {
        return false;
    }
    for (let i = 0; i < x.length; i++) {
        if (x[i] !== y[i]) {
            return false;
        }
    }
    return true;
}
