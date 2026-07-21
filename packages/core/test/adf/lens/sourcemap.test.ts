// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/sourcemap_test.go (Test_ADF_MarshallMarkdownMapped) and
// the blocks_test.go cases that depend on the source map
// (Test_segmentBody_matches_render, Test_ADF_baselineBlocks), deferred here from
// M3.3. Offsets are string indices rather than Go byte offsets, used
// consistently for both the spans and the slices that read them.

import { describe, expect, it } from "vitest";
import {
    baselineBlocks,
    marshallMarkdownAssets,
    marshallMarkdownMapped,
} from "../../../src/adf/lens/sourcemap.ts";
import { segmentBody } from "../../../src/adf/parse/blocks.ts";
import { newADF } from "../../../src/models/adf.ts";

describe("marshallMarkdownMapped", () => {
    it("output is byte-identical to MarshallMarkdown", () => {
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "heading", "attrs": { "level": 2, "localId": "h1" },
                "content": [ { "type": "text", "text": "Title" } ] },
              { "type": "paragraph", "attrs": { "localId": "p1" },
                "content": [ { "type": "text", "text": "Hello world" } ] }
           ] }
        }`;
        const adf = newADF(data);
        const [mapped] = marshallMarkdownMapped(adf, {});
        expect(mapped).toBe(marshallMarkdownAssets(adf, {}));
    });

    it("each top-level block maps to its source node", () => {
        // An empty paragraph between blocks renders to nothing, so it is skipped
        // and leaves a gap in the node indices.
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "heading", "attrs": { "level": 2, "localId": "h1" },
                "content": [ { "type": "text", "text": "Title" } ] },
              { "type": "paragraph", "attrs": { "localId": "p1" },
                "content": [ { "type": "text", "text": "Hello world" } ] },
              { "type": "paragraph", "attrs": { "localId": "pEmpty" } },
              { "type": "paragraph", "attrs": { "localId": "p2" },
                "content": [ { "type": "text", "text": "Second" } ] }
           ] }
        }`;
        const [md, sm] = marshallMarkdownMapped(newADF(data), {});

        expect(sm.origins.map((o) => [o.nodeIndex, o.type, o.localId])).toEqual(
            [
                [0, "heading", "h1"],
                [1, "paragraph", "p1"],
                [3, "paragraph", "p2"],
            ],
        );

        const span = (i: number): string =>
            md.slice(sm.origins[i]?.span.start, sm.origins[i]?.span.end);
        expect(span(0)).toBe("## Title");
        expect(span(1)).toBe("Hello world");
        expect(span(2)).toBe("Second");
    });

    it("spans are ordered and in bounds", () => {
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "paragraph", "content": [ { "type": "text", "text": "one" } ] },
              { "type": "paragraph", "content": [ { "type": "text", "text": "two" } ] },
              { "type": "paragraph", "content": [ { "type": "text", "text": "three" } ] }
           ] }
        }`;
        const [md, sm] = marshallMarkdownMapped(newADF(data), {});

        expect(sm.origins[0]?.span.start).toBe(sm.bodyStart);
        let prevEnd = sm.bodyStart;
        for (const [i, o] of sm.origins.entries()) {
            expect(o.span.start).toBeGreaterThanOrEqual(prevEnd);
            expect(o.span.end).toBeLessThanOrEqual(md.length);
            expect(o.span.end).toBeGreaterThan(o.span.start);
            if (i > 0) {
                const gap = md.slice(sm.origins[i - 1]?.span.end, o.span.start);
                expect(gap).toBe("\n\n");
            }
            prevEnd = o.span.end;
        }
        expect(md.slice(sm.bodyStart - 2, sm.bodyStart)).toBe("\n\n");
    });

    it("bodyless doc reports body start at end", () => {
        const data = `{ "adf": { "type": "doc", "content": [ { "type": "paragraph" } ] } }`;
        const [md, sm] = marshallMarkdownMapped(newADF(data), {});
        expect(sm.origins).toHaveLength(0);
        expect(sm.bodyStart).toBe(md.length - 1);
    });

    it("a non-doc root errors", () => {
        const adf = newADF(`{ "adf": { "type": "paragraph" } }`);
        expect(() => marshallMarkdownMapped(adf, {})).toThrow(
            'root node is "paragraph", want doc',
        );
    });
});

describe("segmentBody matches the render", () => {
    it("recovers exactly the blocks the renderer emitted", () => {
        const words = "word ".repeat(30);
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "heading", "attrs": { "level": 1, "localId": "h" },
                "content": [ { "type": "text", "text": "Heading" } ] },
              { "type": "paragraph", "attrs": { "localId": "p" }, "content": [
                 { "type": "text", "text": "${words}" } ] },
              { "type": "bulletList", "content": [
                 { "type": "listItem", "content": [ { "type": "paragraph", "content": [
                    { "type": "text", "text": "item one" } ] } ] },
                 { "type": "listItem", "content": [ { "type": "paragraph", "content": [
                    { "type": "text", "text": "item two" } ] } ] } ] }
           ] }
        }`;
        const [md, sm] = marshallMarkdownMapped(newADF(data), {});
        const body = md.slice(sm.bodyStart).replace(/\n$/, "");

        const have = segmentBody(body);
        expect(have).toHaveLength(sm.origins.length);
        for (const [i, o] of sm.origins.entries()) {
            expect(have[i]?.text).toBe(md.slice(o.span.start, o.span.end));
        }
    });
});

describe("baselineBlocks", () => {
    it("pairs each block with its source-node origin", () => {
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "paragraph", "attrs": { "localId": "p1" },
                "content": [ { "type": "text", "text": "alpha" } ] },
              { "type": "paragraph", "attrs": { "localId": "p2" },
                "content": [ { "type": "text", "text": "beta" } ] }
           ] }
        }`;
        const [blocks, origins] = baselineBlocks(newADF(data), {}, null);
        expect(blocks.map((b) => b.text)).toEqual(["alpha", "beta"]);
        expect(origins.map((o) => o.localId)).toEqual(["p1", "p2"]);
    });
});
