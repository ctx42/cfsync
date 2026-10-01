// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { planResolves, type RecordedThread } from "../../src/sync/comments.ts";

const thread: RecordedThread = {
    id: "C1",
    markerRef: "M1",
    anchorText: "x",
    version: 1,
    replies: [],
};

const callout = "> [!comment] id:C1 · @u · 2026-01-01T00:00:00Z · open\n> Hi";
const anchored = `Text.[^cf-M1]\n\n${callout}`;
const unanchored = `Text.\n\n${callout}`;

describe("planResolves", () => {
    it("refuses a removed anchor the base render drew", () => {
        expect(() => planResolves([thread], unanchored, anchored)).toThrow(
            "id:C1 (anchor removed)",
        );
    });

    it("keeps a comment whose anchor the base render never drew", () => {
        const have = planResolves([thread], unanchored, unanchored);

        expect(have).toEqual([]);
    });

    it("resolves an anchorless comment once its callout is gone", () => {
        const have = planResolves([thread], "Text.", unanchored);

        expect(have).toEqual([thread]);
    });

    it("expects every anchor when the base render is unknown", () => {
        expect(() => planResolves([thread], unanchored, null)).toThrow(
            "anchor removed",
        );
    });
});
