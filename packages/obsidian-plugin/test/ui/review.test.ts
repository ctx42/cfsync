// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { PreflightEntry, StatusReport } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import {
    type NewChoice,
    reviewCommit,
    reviewModel,
    statusSections,
} from "../../src/ui/review.ts";

const entry = (
    name: string,
    cls: PreflightEntry["cls"],
    reason = "",
): PreflightEntry => ({
    dest: `/v/${name}`,
    name,
    pageId: "1",
    localBase: 3,
    remoteVersion: cls === "diverged" || cls === "remote-moved" ? 5 : 3,
    cls,
    reason,
    resolves: [],
});

describe("reviewModel", () => {
    it("hides notes a push would not change and locks refused ones", () => {
        const have = reviewModel([
            entry("same.md", "unchanged"),
            entry("behind.md", "remote-moved"),
            entry("edited.md", "modified"),
            entry("both.md", "diverged"),
            entry("new.md", "new"),
            entry("bad.md", "refused", "conflict markers"),
        ]);

        expect(have.hidden).toBe(2);
        expect(have.rows.map((r) => [r.entry.name, r.control])).toEqual([
            ["edited.md", "pick"],
            ["both.md", "pick"],
            ["new.md", "new"],
            ["bad.md", "locked"],
        ]);
        expect(have.rows[3]?.note).toContain("conflict markers");
    });
});

describe("reviewCommit", () => {
    it("pushes ticked notes and created new ones, marking never ones", () => {
        const answers = new Map<string, NewChoice>([
            ["/v/a.md", "create"],
            ["/v/b.md", "never"],
            ["/v/c.md", "later"],
        ]);

        const have = reviewCommit(new Set(["/v/edited.md"]), answers);

        expect(have).toEqual({
            push: ["/v/edited.md", "/v/a.md"],
            never: ["/v/b.md"],
        });
    });

    it("creates nothing for new notes left untouched", () => {
        const have = reviewCommit(new Set(), new Map());

        expect(have).toEqual({ push: [], never: [] });
    });
});

describe("statusSections", () => {
    const report: StatusReport = {
        push: [entry("new.md", "new"), entry("bad.md", "refused", "why")],
        pull: [entry("behind.md", "remote-moved")],
        diverged: [],
        warnings: [],
        ignored: ["/v/mine.md"],
    };

    it("lists non-empty sections in order, hiding ignored by default", () => {
        const have = statusSections(report, "/v", false);

        expect(have.map((s) => s.title)).toEqual(["To push", "To pull"]);
        expect(have[0]?.lines[1]).toEqual({
            name: "bad.md",
            word: "refused",
            detail: "why",
        });
        expect(have[1]?.lines[0]?.detail).toBe("local v3 → remote v5");
    });

    it("lists ignored notes when asked", () => {
        const have = statusSections(report, "/v", true);

        expect(have.map((s) => s.title)).toContain("Ignored");
        expect(have.find((s) => s.title === "Ignored")?.lines[0]?.name).toBe(
            "mine.md",
        );
    });
});
