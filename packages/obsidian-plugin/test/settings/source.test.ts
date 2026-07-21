// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { normalizeConfluenceSource } from "../../src/settings/source.ts";

describe("normalizeConfluenceSource", () => {
    it("reduces a full page URL to its /wiki path", () => {
        expect(
            normalizeConfluenceSource(
                "https://your-site.atlassian.net/wiki/spaces/TEAM/pages/12345/Onboarding",
            ),
        ).toBe("/wiki/spaces/TEAM/pages/12345/Onboarding");
    });

    it("drops a query string and fragment", () => {
        expect(
            normalizeConfluenceSource(
                "https://your-site.atlassian.net/wiki/spaces/TEAM/pages/12345/Onboarding?focusedCommentId=9#c9",
            ),
        ).toBe("/wiki/spaces/TEAM/pages/12345/Onboarding");
    });

    it("strips an http (non-https) host too", () => {
        expect(
            normalizeConfluenceSource("http://ex.atlassian.net/wiki/x/AbCdEf"),
        ).toBe("/wiki/x/AbCdEf");
    });

    it("leaves an already-relative path unchanged", () => {
        expect(
            normalizeConfluenceSource("/wiki/spaces/TEAM/folder/67890"),
        ).toBe("/wiki/spaces/TEAM/folder/67890");
    });

    it("trims surrounding whitespace", () => {
        expect(normalizeConfluenceSource("  /wiki/spaces/TEAM  ")).toBe(
            "/wiki/spaces/TEAM",
        );
    });

    it("leaves a non-URL value as-is (trimmed)", () => {
        expect(normalizeConfluenceSource("  glossary  ")).toBe("glossary");
    });

    it("returns a malformed URL unchanged rather than throwing", () => {
        expect(normalizeConfluenceSource("https://")).toBe("https://");
    });
});
