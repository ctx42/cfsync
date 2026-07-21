// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported 1:1 from pkg/adf/diff_test.go (Test_diffBlocks_tabular). The diff works
// on whitespace-normalized block keys and pairs a delete with an insert only
// when they are the same kind, so it is dialect-independent here.

import { describe, expect, it } from "vitest";
import { diffBlocks, type Edit } from "../../../src/adf/lens/diff.ts";
import { type MdBlock, newBlock } from "../../../src/adf/parse/blocks.ts";

const blocksOf = (...texts: string[]): MdBlock[] => texts.map(newBlock);
const keep = (b: number, u: number): Edit => ({
    kind: "keep",
    baseIndex: b,
    userIndex: u,
});
const modify = (b: number, u: number): Edit => ({
    kind: "modify",
    baseIndex: b,
    userIndex: u,
});
const insert = (u: number): Edit => ({
    kind: "insert",
    baseIndex: -1,
    userIndex: u,
});
const del = (b: number): Edit => ({
    kind: "delete",
    baseIndex: b,
    userIndex: -1,
});

describe("diffBlocks", () => {
    const tt: Array<{
        testN: string;
        base: MdBlock[];
        user: MdBlock[];
        want: Edit[];
    }> = [
        {
            testN: "identical blocks all keep",
            base: blocksOf("a", "b", "c"),
            user: blocksOf("a", "b", "c"),
            want: [keep(0, 0), keep(1, 1), keep(2, 2)],
        },
        {
            testN: "reflow-only change still keeps",
            base: blocksOf("one two three"),
            user: blocksOf("one two\nthree"),
            want: [keep(0, 0)],
        },
        {
            testN: "a changed middle block is a modify",
            base: blocksOf("a", "b", "c"),
            user: blocksOf("a", "B!", "c"),
            want: [keep(0, 0), modify(1, 1), keep(2, 2)],
        },
        {
            testN: "an inserted block",
            base: blocksOf("a", "c"),
            user: blocksOf("a", "b", "c"),
            want: [keep(0, 0), insert(1), keep(1, 2)],
        },
        {
            testN: "a deleted block",
            base: blocksOf("a", "b", "c"),
            user: blocksOf("a", "c"),
            want: [keep(0, 0), del(1), keep(2, 1)],
        },
        {
            testN: "append at the end",
            base: blocksOf("a"),
            user: blocksOf("a", "b"),
            want: [keep(0, 0), insert(1)],
        },
        {
            testN: "everything deleted",
            base: blocksOf("a", "b"),
            user: blocksOf(),
            want: [del(0), del(1)],
        },
        {
            testN: "everything new",
            base: blocksOf(),
            user: blocksOf("a", "b"),
            want: [insert(0), insert(1)],
        },
        {
            testN: "two modifies in a row",
            base: blocksOf("a", "b", "c"),
            user: blocksOf("A", "B", "c"),
            want: [modify(0, 0), modify(1, 1), keep(2, 2)],
        },
        {
            testN: "a delete and a differently-kinded insert do not pair",
            base: blocksOf("para one", "tail"),
            user: blocksOf("- list item", "tail"),
            want: [del(0), insert(0), keep(1, 1)],
        },
        {
            testN: "ordered list and paragraph do not pair",
            base: blocksOf("para one", "tail"),
            user: blocksOf("1. list item", "tail"),
            want: [del(0), insert(0), keep(1, 1)],
        },
        {
            testN: "a run pairs by kind and orders by user position",
            base: blocksOf("- old item", "tail"),
            user: blocksOf("new para", "- new item", "tail"),
            want: [insert(0), modify(0, 1), keep(1, 2)],
        },
    ];

    for (const tc of tt) {
        it(tc.testN, () => {
            expect(diffBlocks(tc.base, tc.user)).toEqual(tc.want);
        });
    }
});
