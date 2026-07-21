// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { posixRel } from "../../src/util/path.ts";

describe("posixRel", () => {
    it("relativises a sub-path against a `.` root without a spurious `..`", () => {
        // Regression: a `.` sync root cleaned to one bogus segment, so every
        // destination came back as `../…` and its cache escaped `.adf_cache`.
        expect(posixRel(".", "initiatives/int248/srd.md")).toBe(
            "initiatives/int248/srd.md",
        );
    });

    it("relativises a sub-path against a named root", () => {
        expect(posixRel("docs", "docs/x.md")).toBe("x.md");
    });

    it("relativises a sub-path against an absolute root", () => {
        expect(posixRel("/v", "/v/initiatives/srd.md")).toBe(
            "initiatives/srd.md",
        );
    });

    it("climbs out with `..` when the target is a sibling", () => {
        expect(posixRel("a/b", "a/c/x.md")).toBe("../c/x.md");
    });

    it("returns `.` for identical paths", () => {
        expect(posixRel(".", ".")).toBe(".");
        expect(posixRel("a/b", "a/b")).toBe(".");
    });
});
