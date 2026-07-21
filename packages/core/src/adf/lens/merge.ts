// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The block-level three-way merge, ported from `pkg/adf/merge.go`. When a push
// carries a stale baseline (the remote has moved since the local Markdown was
// pulled), merge3 rebases the local edits onto the remote so non-overlapping
// edits combine and only a block edited on both sides is a conflict. It works on
// the rendered block texts — dialect-stable, so it ports 1:1 — and never mutates
// a document; the merged body is still gated by the lens laws when Put against
// the remote.

import type { ADF } from "../../models/adf.ts";
import type { Links } from "../links.ts";
import { type MdBlock, normalizeBlock, segmentBody } from "../parse/blocks.ts";
import { diffBlocks, type Edit, type EditKind } from "./diff.ts";
import { baselineBlocks } from "./sourcemap.ts";

/**
 * MergeConflictError is thrown by every conflict {@link merge3} raises, so a
 * caller can distinguish a genuine three-way-merge conflict (via `instanceof`)
 * from a lens-law or other push failure. Its message always begins
 * `push: merge conflict`, mirroring Go's `ErrMergeConflict` sentinel.
 */
export class MergeConflictError extends Error {
    constructor(detail: string) {
        super(`push: merge conflict${detail}`);
        this.name = "MergeConflictError";
    }
}

/**
 * BlockOp records how one baseline block fared in a two-way block diff against one
 * side (local or remote): kept, modified (with the new text), or deleted. The
 * default is a keep, matching a block a diff left untouched.
 */
interface BlockOp {
    kind: EditKind;
    text: string;
}

/** keepOp is the default fate — a block no diff touched. */
const keepOp: BlockOp = { kind: "keep", text: "" };

/**
 * classifyEdits reduces a baseline→side edit script to two lookups: how each
 * baseline block fared (kept/modified/deleted), keyed by baseline index, and the
 * block texts inserted after each anchor baseline block (-1 for the slot before
 * the first block), in document order. Every baseline block appears in the first
 * map, since a diff classifies each exactly once.
 */
function classifyEdits(
    edits: Edit[],
    side: MdBlock[],
): [Map<number, BlockOp>, Map<number, string[]>] {
    const ofBase = new Map<number, BlockOp>();
    const insAfter = new Map<number, string[]>();
    let anchor = -1;
    for (const e of edits) {
        switch (e.kind) {
            case "keep":
                ofBase.set(e.baseIndex, { kind: "keep", text: "" });
                anchor = e.baseIndex;
                break;
            case "modify":
                ofBase.set(e.baseIndex, {
                    kind: "modify",
                    text: side[e.userIndex]?.text ?? "",
                });
                anchor = e.baseIndex;
                break;
            case "delete":
                ofBase.set(e.baseIndex, { kind: "delete", text: "" });
                anchor = e.baseIndex;
                break;
            case "insert": {
                const arr = insAfter.get(anchor) ?? [];
                arr.push(side[e.userIndex]?.text ?? "");
                insAfter.set(anchor, arr);
                break;
            }
        }
    }
    return [ofBase, insAfter];
}

/**
 * merge3 performs a block-level three-way merge. `adf` is the common baseline (the
 * cached version the local Markdown was edited from); `remote` is the current live
 * document; `body` is the edited local Markdown. It returns a merged body to Put
 * against remote: a block changed on only one side takes that side's version, a
 * block changed the same way on both sides takes it once, and a block changed
 * incompatibly — or a spot where both sides inserted — throws a
 * {@link MergeConflictError}. The merge is deterministic and never mutates a
 * document; correctness of the resulting ADF is still gated by the lens laws when
 * the merged body is Put.
 */
export function merge3(
    adf: ADF,
    remote: ADF,
    body: string,
    assets: Record<string, string> | null,
): string {
    return merge3Links(adf, remote, body, assets, null);
}

/**
 * merge3Links is {@link merge3} with a {@link Links} so the baseline and remote
 * renders use the same local-link rewriting as the edited body; a null `links`
 * behaves exactly like merge3.
 */
export function merge3Links(
    adf: ADF,
    remote: ADF,
    body: string,
    assets: Record<string, string> | null,
    links: Links | null,
): string {
    const base = assets ?? {};
    const [baseBlocks] = baselineBlocks(adf, base, links);
    const [remoteBlocks] = baselineBlocks(remote, base, links);
    const localBlocks = segmentBody(body);

    const [localOf, localIns] = classifyEdits(
        diffBlocks(baseBlocks, localBlocks),
        localBlocks,
    );
    const [remoteOf, remoteIns] = classifyEdits(
        diffBlocks(baseBlocks, remoteBlocks),
        remoteBlocks,
    );

    const out: string[] = [];
    const emitInserts = (anchor: number): void => {
        const l = localIns.get(anchor) ?? [];
        const r = remoteIns.get(anchor) ?? [];
        if (l.length > 0 && r.length > 0) {
            // Both sides inserted here. When they inserted the same blocks (equal
            // after normalization, so a reflow does not matter), that is one edit
            // made twice, not a conflict: emit it once. Otherwise the two inserts
            // genuinely disagree and cannot be ordered, so it is a conflict.
            if (!sameInserts(l, r)) {
                throw new MergeConflictError(
                    ": both sides inserted a block at the same place",
                );
            }
            out.push(...l);
            return;
        }
        out.push(...l, ...r);
    };

    emitInserts(-1);
    for (let bi = 0; bi < baseBlocks.length; bi++) {
        const baseB = baseBlocks[bi];
        if (baseB === undefined) {
            continue;
        }
        const [text, keep] = mergeBlock(
            baseB,
            localOf.get(bi) ?? keepOp,
            remoteOf.get(bi) ?? keepOp,
            bi,
        );
        if (keep) {
            out.push(text);
        }
        emitInserts(bi);
    }
    return out.join("\n\n");
}

/**
 * sameInserts reports whether two sides inserted the same run of blocks at one
 * anchor: equal count and each pair equal after normalization, so a difference
 * of pure layout (soft-wrap) still counts as the same insert.
 */
function sameInserts(l: string[], r: string[]): boolean {
    if (l.length !== r.length) {
        return false;
    }
    return l.every(
        (text, i) => normalizeBlock(text) === normalizeBlock(r[i] ?? ""),
    );
}

/**
 * mergeBlock combines the local and remote fates of one baseline block. It returns
 * the merged block text and whether the block survives (a delete drops it), or
 * throws a {@link MergeConflictError} when the two sides changed the block
 * incompatibly. A block changed on one side only takes that side's outcome; the
 * same edit on both sides (identical modified text, or a delete on both) is
 * concordant.
 */
function mergeBlock(
    baseB: MdBlock,
    lo: BlockOp,
    ro: BlockOp,
    bi: number,
): [string, boolean] {
    const lChanged = lo.kind === "modify" || lo.kind === "delete";
    const rChanged = ro.kind === "modify" || ro.kind === "delete";
    if (!lChanged && !rChanged) {
        return [baseB.text, true];
    }
    if (lChanged && !rChanged) {
        return [lo.text, lo.kind === "modify"];
    }
    if (!lChanged && rChanged) {
        return [ro.text, ro.kind === "modify"];
    }
    if (
        lo.kind === "modify" &&
        ro.kind === "modify" &&
        normalizeBlock(lo.text) === normalizeBlock(ro.text)
    ) {
        return [lo.text, true]; // the same edit on both sides
    }
    if (lo.kind === "delete" && ro.kind === "delete") {
        return ["", false]; // deleted on both sides
    }
    throw new MergeConflictError(
        ` at block ${bi}: edited both locally and remotely`,
    );
}
