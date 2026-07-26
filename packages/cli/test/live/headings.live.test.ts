// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live round-trip matrix suite for HEADINGS. Seeds throwaway pages carrying
// heading nodes at every level, drives the real CLI pull/push against the test
// space, and asserts the feature survives: each level renders to the right run
// of `#`, a text edit keeps the block a heading of the same (frozen) level, and
// an inline mark inside a heading survives the trip. Every seeded page and temp
// dir is cleaned up on test finish by the shared helpers.

import { attrInt, type Node } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { liveConfigured, requireEnv, seedClient } from "./support/live-env.ts";
import { collectTypes, docText, firstNode } from "./support/probe.ts";
import { livePull, liveRoundTrip } from "./support/roundtrip.ts";

/** headingsByLevel collects every heading node, in document order, with its level. */
function headingsByLevel(root: Node): { node: Node; level: number }[] {
    const out: { node: Node; level: number }[] = [];
    const walk = (n: Node): void => {
        if (n.type === "heading") {
            out.push({ node: n, level: attrInt(n.attrs, "level") });
        }
        for (const c of n.content ?? []) {
            walk(c);
        }
    };
    walk(root);
    return out;
}

/** headingDoc builds a doc ADF with one heading per level 1..6, text `word N`. */
function headingDoc(word: string): string {
    const names = ["one", "two", "three", "four", "five", "six"];
    const blocks = names.map(
        (name, i) =>
            `{"type":"heading","attrs":{"level":${i + 1}},"content":` +
            `[{"type":"text","text":"${word} ${name}"}]}`,
    );
    return `{"type":"doc","content":[${blocks.join(",")}]}`;
}

describe.skipIf(!liveConfigured())("live headings", () => {
    const env = requireEnv();
    const client = seedClient(env);

    it("levels 1..6 render to the right number of '#'", async () => {
        const { md } = await livePull(
            env,
            client,
            "heading-render",
            headingDoc("heading"),
        );
        expect(md).toContain("# heading one");
        expect(md).toContain("## heading two");
        expect(md).toContain("### heading three");
        expect(md).toContain("#### heading four");
        expect(md).toContain("##### heading five");
        expect(md).toContain("###### heading six");
    });

    it("each level round-trips and its level is frozen on a text edit", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "heading-levels",
            headingDoc("heading"),
            // Rewrite the body of every heading while keeping its `#` prefix, so
            // the level attribute must survive unchanged. The trailing space
            // scopes the rename to the heading bodies (`heading one`), leaving
            // the page title in the frontmatter (`heading-levels`) untouched.
            (_d, md) => md.replaceAll("heading ", "topic "),
        );

        const headings = headingsByLevel(doc);
        expect(headings.length).toBe(6);
        expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);

        const text = docText(doc);
        for (const name of ["one", "two", "three", "four", "five", "six"]) {
            expect(text).toContain(`topic ${name}`);
        }
        expect(text).not.toContain("heading one");
    });

    it("editing a heading's text pushes the new text and keeps it a heading", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "heading-edit",
            '{"type":"doc","content":[{"type":"heading","attrs":{"level":3},' +
                '"content":[{"type":"text","text":"before edit"}]}]}',
            (_d, md) => {
                expect(md).toContain("### before edit");
                return md.replace("before edit", "after edit");
            },
        );

        const heading = firstNode(doc, "heading");
        expect(heading).toBeDefined();
        expect(attrInt(heading?.attrs, "level")).toBe(3);
        const text = docText(doc);
        expect(text).toContain("after edit");
        expect(text).not.toContain("before edit");
    });

    it("a heading with a strong inline mark round-trips", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "heading-mark",
            '{"type":"doc","content":[{"type":"heading","attrs":{"level":2},' +
                '"content":[' +
                '{"type":"text","text":"plain "},' +
                '{"type":"text","text":"bold","marks":[{"type":"strong"}]}]}]}',
            (_d, md) => {
                expect(md).toContain("## plain **bold**");
                return md.replace("plain", "PLAIN");
            },
        );

        const heading = firstNode(doc, "heading");
        expect(heading).toBeDefined();
        expect(attrInt(heading?.attrs, "level")).toBe(2);

        const types: Record<string, number> = {};
        const marks: Record<string, number> = {};
        collectTypes(doc, types, marks);
        expect(types["heading"]).toBe(1);
        expect(marks["strong"]).toBeGreaterThanOrEqual(1);

        const bold = firstNode(doc, "heading")?.content?.find((c) =>
            (c.text ?? "").includes("bold"),
        );
        expect((bold?.marks ?? []).some((m) => m.type === "strong")).toBe(true);

        const text = docText(doc);
        expect(text).toContain("PLAIN");
        expect(text).toContain("bold");
    });
});
