// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { noteActions } from "../../src/ui/note-actions.ts";

describe("noteActions", () => {
    it("offers pull, push, and overwrite on a pulled note", () => {
        const fm = { page_id: "42", "cfsync-plugin": "pull" };

        const have = noteActions(fm);

        expect(have).toEqual(["pull", "push", "overwrite"]);
    });

    it("hides push on an ignore-push note", () => {
        const fm = { page_id: "42", "cfsync-plugin": "ignore-push" };

        const have = noteActions(fm);

        expect(have).toEqual(["pull", "overwrite"]);
    });

    it.each([
        ["no frontmatter", undefined],
        ["a never-pushed note", { title: "New" }],
        ["an empty page id", { page_id: "" }],
        ["a local note", { page_id: "42", cf_local: true }],
    ])("offers nothing on %s", (_, fm) => {
        const have = noteActions(fm);

        expect(have).toEqual([]);
    });
});
