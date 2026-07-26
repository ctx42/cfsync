// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live feature-matrix suite for INLINE MARKS on text: strong, em, strike, inline
// code, and link. Each test seeds a page whose body carries a marked text run,
// round-trips it through the real Site (pull -> edit -> push -> re-fetch), and
// asserts the mark survives on a text node in the re-fetched ADF. A livePull
// case pins the rendered Markdown delimiters, a combined case proves strong+em
// coexist on one run, and an edit case proves changing the marked text keeps the
// mark. Run with: bun run --filter @cfsync/cli test:live

import { attrStr, type Node } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { liveConfigured, requireEnv, seedClient } from "./support/live-env.ts";
import { collectTypes, docText, textNodeWith } from "./support/probe.ts";
import { livePull, liveRoundTrip } from "./support/roundtrip.ts";

/** markHistogram tallies every mark type in a parsed doc via collectTypes. */
function markHistogram(doc: Node): Record<string, number> {
    const types: Record<string, number> = {};
    const marks: Record<string, number> = {};
    collectTypes(doc, types, marks);
    return marks;
}

describe.skipIf(!liveConfigured())("live inline-marks", () => {
    const env = requireEnv();
    const client = seedClient(env);

    it("strong: survives the round trip", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "strong",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"keep "},' +
                '{"type":"text","text":"bolded","marks":[{"type":"strong"}]}]}]}',
            (_d, md) => md,
        );
        expect(markHistogram(doc)["strong"] ?? 0).toBeGreaterThan(0);
        const node = textNodeWith(doc, "bolded");
        expect(node).toBeDefined();
        expect((node?.marks ?? []).some((m) => m.type === "strong")).toBe(true);
        expect(docText(doc)).toContain("bolded");
    });

    it("em: survives the round trip", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "em",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"keep "},' +
                '{"type":"text","text":"italicized","marks":[{"type":"em"}]}]}]}',
            (_d, md) => md,
        );
        expect(markHistogram(doc)["em"] ?? 0).toBeGreaterThan(0);
        const node = textNodeWith(doc, "italicized");
        expect((node?.marks ?? []).some((m) => m.type === "em")).toBe(true);
    });

    it("strike: survives the round trip", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "strike",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"keep "},' +
                '{"type":"text","text":"struck","marks":[{"type":"strike"}]}]}]}',
            (_d, md) => md,
        );
        expect(markHistogram(doc)["strike"] ?? 0).toBeGreaterThan(0);
        const node = textNodeWith(doc, "struck");
        expect((node?.marks ?? []).some((m) => m.type === "strike")).toBe(true);
    });

    it("inline code: survives the round trip", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "code",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"run "},' +
                '{"type":"text","text":"codeSpan()","marks":[{"type":"code"}]}]}]}',
            (_d, md) => md,
        );
        expect(markHistogram(doc)["code"] ?? 0).toBeGreaterThan(0);
        const node = textNodeWith(doc, "codeSpan()");
        expect((node?.marks ?? []).some((m) => m.type === "code")).toBe(true);
    });

    it("link: href survives the round trip", async () => {
        const href = "https://example.com/inline-marks";
        const doc = await liveRoundTrip(
            env,
            client,
            "link",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"see "},' +
                '{"type":"text","text":"clickme","marks":[' +
                `{"type":"link","attrs":{"href":"${href}"}}]}]}]}`,
            (_d, md) => md,
        );
        expect(markHistogram(doc)["link"] ?? 0).toBeGreaterThan(0);
        const node = textNodeWith(doc, "clickme");
        expect(node).toBeDefined();
        const link = (node?.marks ?? []).find((m) => m.type === "link");
        expect(link).toBeDefined();
        expect(attrStr(link?.attrs, "href")).toBe(href);
    });

    it("combined: strong+em coexist on one run", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "combo",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"both","marks":[' +
                '{"type":"strong"},{"type":"em"}]}]}]}',
            (_d, md) => {
                // Canonical nesting is em outermost, strong innermost: `***both***`.
                expect(md).toContain("***both***");
                return md;
            },
        );
        const marks = markHistogram(doc);
        expect(marks["strong"] ?? 0).toBeGreaterThan(0);
        expect(marks["em"] ?? 0).toBeGreaterThan(0);
        const node = textNodeWith(doc, "both");
        const kinds = new Set((node?.marks ?? []).map((m) => m.type));
        expect(kinds.has("strong")).toBe(true);
        expect(kinds.has("em")).toBe(true);
    });

    it("edit: changing strong text keeps the strong mark", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "markedit",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"stays "},' +
                '{"type":"text","text":"before","marks":[{"type":"strong"}]}]}]}',
            (_d, md) => {
                expect(md).toContain("**before**");
                return md.replace("before", "after");
            },
        );
        expect(markHistogram(doc)["strong"] ?? 0).toBeGreaterThan(0);
        const node = textNodeWith(doc, "after");
        expect(node).toBeDefined();
        expect((node?.marks ?? []).some((m) => m.type === "strong")).toBe(true);
        const text = docText(doc);
        expect(text).toContain("after");
        expect(text).not.toContain("before");
    });

    it("pull: renders the canonical Markdown delimiters", async () => {
        const { md } = await livePull(
            env,
            client,
            "render",
            '{"type":"doc","content":[{"type":"paragraph","content":[' +
                '{"type":"text","text":"a "},' +
                '{"type":"text","text":"bolded","marks":[{"type":"strong"}]},' +
                '{"type":"text","text":" b "},' +
                '{"type":"text","text":"italicized","marks":[{"type":"em"}]},' +
                '{"type":"text","text":" c "},' +
                '{"type":"text","text":"struck","marks":[{"type":"strike"}]},' +
                '{"type":"text","text":" d "},' +
                '{"type":"text","text":"coded","marks":[{"type":"code"}]},' +
                '{"type":"text","text":" e "},' +
                '{"type":"text","text":"clickme","marks":[' +
                '{"type":"link","attrs":{"href":"https://example.com/x"}}]}]}]}',
        );
        expect(md).toContain("**bolded**");
        expect(md).toContain("*italicized*");
        expect(md).toContain("~~struck~~");
        expect(md).toContain("`coded`");
        expect(md).toContain("[clickme](https://example.com/x)");
    });
});
