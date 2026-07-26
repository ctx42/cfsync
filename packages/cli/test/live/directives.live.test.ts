// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live matrix suite for INLINE DIRECTIVE CARRIERS: the inline ADF nodes that
// have no plain-Markdown form and so render as `adf:` carrier spans — status,
// date, emoji, mention and inlineCard. Each test seeds a page carrying the node
// inside a paragraph, round-trips it through a real pull → edit → push against
// the Site, and asserts the node type SURVIVES (is present in the re-fetched
// ADF). Two pull-only checks pin the rendered carrier form for status and
// mention. Every seeded page + temp dir is cleaned up by the shared helpers.

import { attrStr, type Node } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { liveConfigured, requireEnv, seedClient } from "./support/live-env.ts";
import { collectTypes, firstNode, histogram } from "./support/probe.ts";
import { livePull, liveRoundTrip } from "./support/roundtrip.ts";

/** typeCount tallies node types under `doc` and returns the count for `type`. */
function typeCount(doc: Node, type: string): number {
    const types: Record<string, number> = {};
    const marks: Record<string, number> = {};
    collectTypes(doc, types, marks);
    return types[type] ?? 0;
}

/** typeHistogram renders the node-type histogram of `doc`, for a failure label. */
function typeHistogram(doc: Node): string {
    const types: Record<string, number> = {};
    const marks: Record<string, number> = {};
    collectTypes(doc, types, marks);
    return histogram(types);
}

describe.skipIf(!liveConfigured())("live directives", () => {
    const env = requireEnv();
    const client = seedClient(env);

    it("status: node with color survives the round trip", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "dir-status",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"lead "},' +
                '{"type":"status","attrs":{"text":"Done","color":"green"}},' +
                '{"type":"text","text":" tail"}]}]}',
            (_d, md) => {
                // Confluence adds style=bold + a localId on store, so assert the
                // stable parts of the carrier rather than the whole span.
                expect(md).toContain("adf:!Done");
                expect(md).toContain("color=green");
                return md.replace("lead", "LEAD");
            },
        );
        expect(typeCount(doc, "status"), typeHistogram(doc)).toBeGreaterThan(0);
        const status = firstNode(doc, "status");
        expect(attrStr(status?.attrs, "text")).toBe("Done");
        expect(attrStr(status?.attrs, "color")).toBe("green");
    });

    it("status: renders as an `adf:!` carrier span on pull", async () => {
        const { md } = await livePull(
            env,
            client,
            "dir-status-md",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"status","attrs":{"text":"In Progress","color":"blue"}}]}]}',
        );
        expect(md).toContain("adf:!In Progress");
        expect(md).toContain("color=blue");
    });

    it("date: timestamp node survives the round trip", async () => {
        // Confluence stores a date at UTC-day granularity, so it rounds the
        // seeded epoch-ms down to midnight — assert the rendered day and the
        // node's survival, not the exact seeded timestamp.
        const doc = await liveRoundTrip(
            env,
            client,
            "dir-date",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"due "},' +
                '{"type":"date","attrs":{"timestamp":"1700000000000"}}]}]}',
            (_d, md) => {
                expect(md).toContain("adf:#");
                expect(md).toContain("2023-11-1"); // 13 or 14 depending on rounding
                return md.replace("due", "DUE");
            },
        );
        expect(typeCount(doc, "date"), typeHistogram(doc)).toBeGreaterThan(0);
        const date = firstNode(doc, "date");
        expect(attrStr(date?.attrs, "timestamp")).not.toBe("");
    });

    it("emoji: shortName node survives the round trip", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "dir-emoji",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"react "},' +
                '{"type":"emoji","attrs":{"shortName":":smile:","id":"1f604","text":"\\ud83d\\ude04"}}]}]}',
            (_d, md) => {
                expect(md).toContain("`adf::smile|id=1f604`");
                return md.replace("react", "REACT");
            },
        );
        expect(typeCount(doc, "emoji"), typeHistogram(doc)).toBeGreaterThan(0);
        const emoji = firstNode(doc, "emoji");
        expect(attrStr(emoji?.attrs, "shortName")).toBe(":smile:");
    });

    it("mention: id + text node survives the round trip", async () => {
        // A mention only round-trips to a real account; resolve the id inline
        // via the mentions frontmatter the pull emits.
        const accountId = await client.currentAccountID();
        const doc = await liveRoundTrip(
            env,
            client,
            "dir-mention",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"cc "},' +
                `{"type":"mention","attrs":{"id":${JSON.stringify(accountId)},"text":"@tester"}}]}]}`,
            (_d, md) => {
                // Confluence resolves a mention's display text from the account
                // (here "@Rafal"), so assert the carrier form + a mentions map,
                // not the seeded text. The stable anchor is the account id below.
                expect(md).toContain("adf:@");
                expect(md).toContain("mentions:");
                return md.replace("cc", "CC");
            },
        );
        expect(typeCount(doc, "mention"), typeHistogram(doc)).toBeGreaterThan(
            0,
        );
        const mention = firstNode(doc, "mention");
        expect(attrStr(mention?.attrs, "id")).toBe(accountId);
    });

    it("mention: renders as an `adf:@` carrier with a mentions map on pull", async () => {
        const accountId = await client.currentAccountID();
        const { md } = await livePull(
            env,
            client,
            "dir-mention-md",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                `{"type":"mention","attrs":{"id":${JSON.stringify(accountId)},"text":"@tester"}}]}]}`,
        );
        expect(md).toContain("adf:@");
        expect(md).toContain("mentions:");
        expect(md).toContain(accountId);
    });

    it("inlineCard: url node survives the round trip", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "dir-card",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"see "},' +
                '{"type":"inlineCard","attrs":{"url":"https://example.com/"}}]}]}',
            (_d, md) => {
                expect(md).toContain("<https://example.com/>");
                return md.replace("see", "SEE");
            },
        );
        expect(
            typeCount(doc, "inlineCard"),
            typeHistogram(doc),
        ).toBeGreaterThan(0);
        const card = firstNode(doc, "inlineCard");
        expect(attrStr(card?.attrs, "url")).toBe("https://example.com/");
    });
});
