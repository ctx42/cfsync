// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { hasConflictMarkers, mergeThreeWay } from "../../src/sync/merge.ts";

const labels = {
    local: "local (your edits)",
    remote: "remote (Confluence v2)",
};
const merge = (base: string, local: string, remote: string) =>
    mergeThreeWay(base, local, remote, labels);

describe("mergeThreeWay", () => {
    it("takes remote when local is unchanged", () => {
        const r = merge("a\nb\nc", "a\nb\nc", "a\nB\nc");
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("a\nB\nc");
    });

    it("keeps local when remote is unchanged", () => {
        const r = merge("a\nb\nc", "a\nX\nc", "a\nb\nc");
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("a\nX\nc");
    });

    it("takes the shared change when both sides changed identically", () => {
        const r = merge("a\nb\nc", "a\nZ\nc", "a\nZ\nc");
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("a\nZ\nc");
    });

    it("merges non-overlapping changes on adjacent lines cleanly", () => {
        // local edits line 2, remote edits line 3 — different base lines.
        const r = merge("a\nb\nc", "a\nX\nc", "a\nb\nY");
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("a\nX\nY");
    });

    it("merges edits in far-apart regions cleanly", () => {
        const base = "h1\np1\np2\np3\nfoot";
        const local = "h1\nP1-edited\np2\np3\nfoot";
        const remote = "h1\np1\np2\nP3-edited\nfoot";
        const r = merge(base, local, remote);
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("h1\nP1-edited\np2\nP3-edited\nfoot");
    });

    it("conflicts when both sides change the same line differently", () => {
        const r = merge("a\nb\nc", "a\nX\nc", "a\nY\nc");
        expect(r.conflict).toBe(true);
        expect(r.text).toBe(
            [
                "a",
                "<<<<<<< local (your edits)",
                "X",
                "=======",
                "Y",
                ">>>>>>> remote (Confluence v2)",
                "c",
            ].join("\n"),
        );
    });

    it("conflicts when both sides insert different lines at the same spot", () => {
        const r = merge("a\nb", "a\nN\nb", "a\nM\nb");
        expect(r.conflict).toBe(true);
        expect(r.text).toBe(
            [
                "a",
                "<<<<<<< local (your edits)",
                "N",
                "=======",
                "M",
                ">>>>>>> remote (Confluence v2)",
                "b",
            ].join("\n"),
        );
    });

    it("merges a one-sided insertion", () => {
        const r = merge("a\nb", "a\nb", "a\nnew\nb");
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("a\nnew\nb");
    });

    it("merges a one-sided append", () => {
        const r = merge("a", "a", "a\ntail");
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("a\ntail");
    });

    it("merges one-sided appends from both ends cleanly", () => {
        const r = merge("mid", "head\nmid", "mid\ntail");
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("head\nmid\ntail");
    });

    it("empty base makes any difference one whole-body conflict", () => {
        const r = merge("", "local body", "remote body");
        expect(r.conflict).toBe(true);
        expect(r.text).toBe(
            [
                "<<<<<<< local (your edits)",
                "local body",
                "=======",
                "remote body",
                ">>>>>>> remote (Confluence v2)",
            ].join("\n"),
        );
    });

    it("empty base with identical sides does not conflict", () => {
        const r = merge("", "same", "same");
        expect(r.conflict).toBe(false);
        expect(r.text).toBe("same");
    });
});

describe("hasConflictMarkers", () => {
    it("detects an unresolved marker block", () => {
        const text = "a\n<<<<<<< local\nX\n=======\nY\n>>>>>>> remote\nb";
        expect(hasConflictMarkers(text)).toBe(true);
    });

    it("ignores a bare separator (a Markdown setext heading underline)", () => {
        expect(hasConflictMarkers("Heading\n=======\ntext")).toBe(false);
    });

    it("is false for clean text", () => {
        expect(hasConflictMarkers("a\nb\nc")).toBe(false);
    });
});
