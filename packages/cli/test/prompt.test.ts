// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { CreateInput, StaleItem } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import {
    confirmCreates,
    confirmStale,
    type PromptOptions,
} from "../src/prompt.ts";

const cand = (dest: string): CreateInput => ({
    dest,
    title: dest,
    spaceId: "9",
    parentId: "",
    folders: [],
});

/** opts builds PromptOptions with an ask driven by a scripted answer list. */
function opts(
    over: Partial<PromptOptions>,
    answers: string[] = [],
): PromptOptions {
    let i = 0;
    return {
        syncRoot: "/v",
        isTTY: true,
        yes: false,
        err: () => {},
        ask: () => Promise.resolve(answers[i++] ?? ""),
        ...over,
    };
}

describe("confirmCreates", () => {
    it("accepts every candidate with --yes and never prompts", async () => {
        let asked = 0;
        const decided = await confirmCreates(
            [cand("/v/a.md"), cand("/v/b.md")],
            opts({
                yes: true,
                ask: () => {
                    asked++;
                    return Promise.resolve("");
                },
            }),
        );
        expect([...decided.values()]).toEqual([true, true]);
        expect(asked).toBe(0);
    });

    it("applies a sticky 'all' from the first answer to the rest", async () => {
        const decided = await confirmCreates(
            [cand("/v/a.md"), cand("/v/b.md"), cand("/v/c.md")],
            opts({}, ["a"]),
        );
        expect(decided.get("/v/a.md")).toBe(true);
        expect(decided.get("/v/b.md")).toBe(true);
        expect(decided.get("/v/c.md")).toBe(true);
    });

    it("records per-page yes/no answers", async () => {
        const decided = await confirmCreates(
            [cand("/v/a.md"), cand("/v/b.md")],
            opts({}, ["y", "n"]),
        );
        expect(decided.get("/v/a.md")).toBe(true);
        expect(decided.get("/v/b.md")).toBe(false);
    });

    it("refuses to prompt without a terminal", async () => {
        await expect(
            confirmCreates([cand("/v/a.md")], opts({ isTTY: false })),
        ).rejects.toThrow("re-run with --yes");
    });
});

describe("confirmStale", () => {
    const items: StaleItem[] = [
        { path: "/v/a.md", isDir: false },
        { path: "/v/sub", isDir: true },
    ];

    it("removes all with --yes", async () => {
        expect(await confirmStale(items, opts({ yes: true }))).toEqual(items);
    });

    it("removes on y and nothing on n", async () => {
        expect(await confirmStale(items, opts({}, ["y"]))).toEqual(items);
        expect(await confirmStale(items, opts({}, ["n"]))).toEqual([]);
    });

    it("refuses to prompt without a terminal", async () => {
        await expect(
            confirmStale(items, opts({ isTTY: false })),
        ).rejects.toThrow("re-run with --yes");
    });
});
