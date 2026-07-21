// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The push diff, ported from `pkg/adf/diff.go`. It aligns the user's edited
// blocks against the baseline blocks and classifies each into an edit op. It
// works on the whitespace-normalized block keys (see normalizeBlock) so reflow
// is not mistaken for an edit, and uses a longest-common-subsequence alignment
// so a moved or inserted block does not cascade every following block into a
// spurious modify.

import {
    leadingHashes,
    type MdBlock,
    orderedMarkerWidth,
} from "../parse/blocks.ts";

/** editKind is the classification of one block in a push diff. */
export type EditKind = "keep" | "modify" | "insert" | "delete";

/**
 * Edit is one entry of a push edit script. `baseIndex` indexes the baseline
 * blocks and `userIndex` the user blocks; the one not applicable to the op is -1.
 */
export interface Edit {
    kind: EditKind;
    baseIndex: number;
    userIndex: number;
}

/**
 * diffBlocks aligns user against base by their normalized keys and returns the
 * edit script in document order. Unchanged blocks become keep; a baseline block
 * replaced in place becomes modify; a block only in user becomes insert and one
 * only in base becomes delete. The alignment is LCS-based, so a single insertion
 * or deletion shifts nothing else.
 */
export function diffBlocks(base: MdBlock[], user: MdBlock[]): Edit[] {
    const n = base.length;
    const m = user.length;
    const baseKeys = base.map((b) => b.key);
    const userKeys = user.map((u) => u.key);

    // lcs[i][j] is the length of the longest common subsequence of base[i:] and
    // user[j:], compared on the normalized keys.
    const lcs: number[][] = Array.from({ length: n + 1 }, () =>
        new Array<number>(m + 1).fill(0),
    );
    const lcsAt = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
    for (let i = n - 1; i >= 0; i--) {
        const row = lcs[i];
        if (row === undefined) {
            continue;
        }
        for (let j = m - 1; j >= 0; j--) {
            row[j] =
                baseKeys[i] === userKeys[j]
                    ? lcsAt(i + 1, j + 1) + 1
                    : Math.max(lcsAt(i + 1, j), lcsAt(i, j + 1));
        }
    }

    const raw: Edit[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (baseKeys[i] === userKeys[j]) {
            raw.push({ kind: "keep", baseIndex: i, userIndex: j });
            i++;
            j++;
        } else if (lcsAt(i + 1, j) >= lcsAt(i, j + 1)) {
            raw.push({ kind: "delete", baseIndex: i, userIndex: -1 });
            i++;
        } else {
            raw.push({ kind: "insert", baseIndex: -1, userIndex: j });
            j++;
        }
    }
    for (; i < n; i++) {
        raw.push({ kind: "delete", baseIndex: i, userIndex: -1 });
    }
    for (; j < m; j++) {
        raw.push({ kind: "insert", baseIndex: -1, userIndex: j });
    }

    return pairModifies(raw, base, user);
}

/**
 * pairModifies rewrites each maximal run of adjacent deletes and inserts (a run
 * bounded by keeps or the ends) into modifies. A delete pairs with an insert
 * only when the two blocks are the same kind (see {@link blockKind}), so an
 * inserted block next to a modified block of another kind is not mispaired into
 * a lossy modify. Within a run the keep, modify and insert edits are emitted in
 * the user's block order; leftover deletes follow at their baseline hole.
 */
function pairModifies(input: Edit[], base: MdBlock[], user: MdBlock[]): Edit[] {
    const out: Edit[] = [];
    let i = 0;
    while (i < input.length) {
        const cur = input[i];
        if (cur === undefined) {
            break;
        }
        if (cur.kind === "keep") {
            out.push(cur);
            i++;
            continue;
        }
        const dels: Edit[] = [];
        const inss: Edit[] = [];
        let jj = i;
        for (; jj < input.length; jj++) {
            const e = input[jj];
            if (e === undefined || e.kind === "keep") {
                break;
            }
            if (e.kind === "delete") {
                dels.push(e);
            } else {
                inss.push(e);
            }
        }
        out.push(...resolveRun(dels, inss, base, user));
        i = jj;
    }
    return out;
}

/**
 * resolveRun folds a run's deletes and inserts into an edit list. Each delete is
 * matched to the first not-yet-used insert of the same {@link blockKind}, and
 * the pair becomes a modify; an unmatched delete stays a delete and an unmatched
 * insert stays an insert. Modifies and inserts are ordered by user index;
 * leftover deletes are interleaved by baseline index.
 */
function resolveRun(
    dels: Edit[],
    inss: Edit[],
    base: MdBlock[],
    user: MdBlock[],
): Edit[] {
    const used = new Array<boolean>(inss.length).fill(false);
    const placed: Edit[] = [];
    const leftoverDels: Edit[] = [];
    for (const d of dels) {
        const kind = blockKind(base[d.baseIndex]?.text ?? "");
        let match = -1;
        for (let x = 0; x < inss.length; x++) {
            const ins = inss[x];
            if (
                ins !== undefined &&
                !used[x] &&
                blockKind(user[ins.userIndex]?.text ?? "") === kind
            ) {
                match = x;
                break;
            }
        }
        if (match < 0) {
            leftoverDels.push(d);
            continue;
        }
        used[match] = true;
        const ins = inss[match];
        if (ins !== undefined) {
            placed.push({
                kind: "modify",
                baseIndex: d.baseIndex,
                userIndex: ins.userIndex,
            });
        }
    }
    for (let x = 0; x < inss.length; x++) {
        const ins = inss[x];
        if (ins !== undefined && !used[x]) {
            placed.push(ins);
        }
    }
    placed.sort((a, b) => a.userIndex - b.userIndex);
    leftoverDels.sort((a, b) => a.baseIndex - b.baseIndex);
    return mergeLeftoverDels(placed, leftoverDels);
}

/**
 * mergeLeftoverDels inserts leftover deletes into the user-ordered placed list
 * so each delete lands before the next modify whose baseIndex is greater, or
 * before trailing inserts when no later modify remains.
 */
function mergeLeftoverDels(placed: Edit[], dels: Edit[]): Edit[] {
    if (dels.length === 0) {
        return placed;
    }
    const out: Edit[] = [];
    let di = 0;
    for (let i = 0; i < placed.length; i++) {
        const e = placed[i];
        if (e === undefined) {
            continue;
        }
        let nextMod = -1;
        for (let k = i; k < placed.length; k++) {
            const f = placed[k];
            if (f !== undefined && f.kind === "modify") {
                nextMod = f.baseIndex;
                break;
            }
        }
        while (
            di < dels.length &&
            (nextMod < 0 || (dels[di]?.baseIndex ?? 0) < nextMod)
        ) {
            const d = dels[di];
            if (d !== undefined) {
                out.push(d);
            }
            di++;
        }
        out.push(e);
    }
    for (; di < dels.length; di++) {
        const d = dels[di];
        if (d !== undefined) {
            out.push(d);
        }
    }
    return out;
}

/**
 * blockKind classifies a top-level Markdown block by the marker its first line
 * carries, so the diff pairs a modified block only with an insert of the same
 * shape. The label need not equal the ADF node type; it need only be stable
 * between a block and its edited form. A frozen `adf` fenced block is kept
 * distinct from a real code block, and the `%%adf:` comment is the placeholder.
 */
export function blockKind(text: string): string {
    let line = text.split("\n")[0] ?? "";
    line = line.replace(/^ +/, "");
    const hashes = leadingHashes(line);
    if (hashes >= 1 && hashes <= 6) {
        return "heading";
    }
    if (
        line.startsWith("- ") ||
        line.startsWith("* ") ||
        line.startsWith("+ ") ||
        orderedMarkerWidth(line) > 0
    ) {
        return "list";
    }
    if (line.startsWith("|")) {
        return "table";
    }
    if (line.startsWith("> ")) {
        // A panel, expand, and blockquote share the `> ` marker; the `[!…]` tag
        // on the first line tells them apart.
        const tag = line.slice("> ".length);
        if (tag.startsWith("[!EXPAND]")) {
            return "expand";
        }
        if (tag.startsWith("[!")) {
            return "panel";
        }
        return "quote";
    }
    if (line.startsWith("```adf")) {
        return "macro";
    }
    if (line.startsWith("```")) {
        return "code";
    }
    if (line.startsWith("![")) {
        return "media";
    }
    if (line.startsWith("%%adf")) {
        return "placeholder";
    }
    return "paragraph";
}
