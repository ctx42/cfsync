// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live round-trip tests for nested / mixed lists against the real Atlassian
// Site. Each seeds a throwaway page whose ADF holds a nested list (a bullet list
// inside a bullet item, an ordered list inside an ordered item, a bullet under an
// ordered item, or a multi-paragraph item), pulls it, edits a *sibling* or leaf
// item's text — the reconstruct lens freezes an item that itself holds a nested
// list, so a sibling edit is the one that pushes — and re-fetches, asserting the
// nesting survived the trip. Run with: bun run --filter @cfsync/cli test:live

import { describe, expect, it } from "vitest";
import { liveConfigured, requireEnv, seedClient } from "./support/live-env.ts";
import {
    collectTypes,
    docText,
    firstNode,
    histogram,
    textNodeWith,
} from "./support/probe.ts";
import { livePull, liveRoundTrip } from "./support/roundtrip.ts";

describe.skipIf(!liveConfigured())("live nested lists", () => {
    const env = requireEnv();
    const client = seedClient(env);

    // A bullet list whose first item holds a nested bullet list, plus a plain
    // sibling item. Editing the sibling keeps the nested item (a keep), so the
    // inner bulletList rides through untouched.
    const nestedBullet =
        '{"type":"doc","content":[{"type":"bulletList","content":[' +
        '{"type":"listItem","content":[' +
        '{"type":"paragraph","content":[{"type":"text","text":"outer one"}]},' +
        '{"type":"bulletList","content":[{"type":"listItem","content":[' +
        '{"type":"paragraph","content":[{"type":"text","text":"nested a"}]}]}]}]},' +
        '{"type":"listItem","content":[' +
        '{"type":"paragraph","content":[{"type":"text","text":"sibling item"}]}]}]}]}';

    it("pull: a nested bullet renders as an indented item", async () => {
        const { md } = await livePull(env, client, "nb-pull", nestedBullet);
        expect(md).toContain("- outer one");
        // The nested item is indented two columns under its parent's text.
        expect(md).toContain("  - nested a");
        expect(md).toContain("- sibling item");
    });

    it("bullet-in-bullet: sibling edit, nested list survives", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "nb-rt",
            nestedBullet,
            (_d, md) => md.replace("sibling item", "sibling edited"),
        );
        const types: Record<string, number> = {};
        collectTypes(doc, types, {});
        // Two bulletLists (outer + nested) must survive the round trip.
        expect(types["bulletList"], histogram(types)).toBeGreaterThanOrEqual(2);
        const text = docText(doc);
        expect(text).toContain("outer one");
        expect(text).toContain("nested a");
        expect(text).toContain("sibling edited");
        expect(text).not.toContain("sibling item");
        expect(textNodeWith(doc, "nested a")).toBeDefined();
    });

    it("ordered-in-ordered: sibling edit, nesting survives", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "oo-rt",
            '{"type":"doc","content":[{"type":"orderedList","attrs":{"order":1},"content":[' +
                '{"type":"listItem","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"step one"}]},' +
                '{"type":"orderedList","attrs":{"order":1},"content":[{"type":"listItem","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"sub step"}]}]}]}]},' +
                '{"type":"listItem","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"step two"}]}]}]}]}',
            (_d, md) => {
                // The nested ordered item is re-numbered from its own order=1.
                expect(md).toContain("   1. sub step");
                return md.replace("step two", "step two done");
            },
        );
        const types: Record<string, number> = {};
        collectTypes(doc, types, {});
        expect(types["orderedList"], histogram(types)).toBeGreaterThanOrEqual(
            2,
        );
        const text = docText(doc);
        expect(text).toContain("step one");
        expect(text).toContain("sub step");
        expect(text).toContain("step two done");
    });

    it("bullet under an ordered item: both list types survive", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "mix-rt",
            '{"type":"doc","content":[{"type":"orderedList","attrs":{"order":1},"content":[' +
                '{"type":"listItem","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"task one"}]},' +
                '{"type":"bulletList","content":[{"type":"listItem","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"a note"}]}]}]}]},' +
                '{"type":"listItem","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"task two"}]}]}]}]}',
            (_d, md) => md.replace("task two", "task two edited"),
        );
        const types: Record<string, number> = {};
        collectTypes(doc, types, {});
        // The mix is preserved: an orderedList still carries a nested bulletList.
        expect(types["orderedList"], histogram(types)).toBeGreaterThanOrEqual(
            1,
        );
        expect(types["bulletList"], histogram(types)).toBeGreaterThanOrEqual(1);
        expect(firstNode(doc, "orderedList")).toBeDefined();
        expect(firstNode(doc, "bulletList")).toBeDefined();
        const text = docText(doc);
        expect(text).toContain("task one");
        expect(text).toContain("a note");
        expect(text).toContain("task two edited");
    });

    it("multi-paragraph item: edit one paragraph, both survive", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "mp-rt",
            '{"type":"doc","content":[{"type":"bulletList","content":[' +
                '{"type":"listItem","content":[' +
                '{"type":"paragraph","content":[{"type":"text","text":"lead para"}]},' +
                '{"type":"paragraph","content":[{"type":"text","text":"tail para"}]}]}]}]}',
            (_d, md) => {
                // The item's second paragraph is indented under its bullet.
                expect(md).toContain("- lead para");
                expect(md).toContain("  tail para");
                return md.replace("tail para", "tail rewritten");
            },
        );
        const item = firstNode(doc, "listItem");
        expect(item).toBeDefined();
        // The item keeps both of its paragraphs (structure frozen).
        expect(item?.content?.length).toBe(2);
        const text = docText(doc);
        expect(text).toContain("lead para");
        expect(text).toContain("tail rewritten");
        expect(text).not.toContain("tail para");
    });
});
