// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live round-trip matrix suite for the CODE BLOCK and RULE feature group. Each
// test seeds a throwaway page in the test space, drives the real CLI pull/push,
// and asserts the feature survives the trip: a fenced code block keeps its
// language and literal body (blank lines and markup-looking lines included), a
// language-less block round-trips as a plain fence, and a thematic break stays a
// rule node. Run with: bun run --filter @cfsync/cli test:live

import { attrStr, type Node } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { liveConfigured, requireEnv, seedClient } from "./support/live-env.ts";
import { docText, firstNode } from "./support/probe.ts";
import { livePull, liveRoundTrip } from "./support/roundtrip.ts";

/** codeText returns the concatenated literal text of a codeBlock node's kids. */
function codeText(node: Node | undefined): string {
    let out = "";
    for (const child of node?.content ?? []) {
        if (child.type === "text") {
            out += child.text ?? "";
        }
    }
    return out;
}

describe.skipIf(!liveConfigured())("live codeblock + rule", () => {
    const env = requireEnv();
    const client = seedClient(env);

    // A body that stresses the fence: two non-empty lines separated by a blank
    // line, plus a line that looks like block markup but must stay literal.
    const codeBody = "const x = 1;\n\n<div>## not a heading</div>";
    const codeADF =
        '{"type":"doc","content":[{"type":"codeBlock","attrs":{"language":"javascript"},' +
        `"content":[{"type":"text","text":${JSON.stringify(codeBody)}}]}]}`;

    it("codeBlock: language + multi-line body survive the round trip", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "codeblock",
            codeADF,
            (_d, md) => md, // no edit; pure survival check
        );
        const code = firstNode(doc, "codeBlock");
        expect(code).toBeDefined();
        expect(attrStr(code?.attrs, "language")).toBe("javascript");
        const body = codeText(code);
        expect(body).toContain("const x = 1;");
        expect(body).toContain("<div>## not a heading</div>");
        // The blank line between the two code lines is literal and preserved.
        expect(body).toContain("const x = 1;\n\n<div>");
    });

    it("codeBlock: pulled Markdown is a fenced block with the language", async () => {
        const { md } = await livePull(env, client, "codeblock-md", codeADF);
        expect(md).toContain("```javascript\n");
        expect(md).toContain("const x = 1;");
        expect(md).toContain("<div>## not a heading</div>");
        expect(md).toContain("\n```");
    });

    it("codeBlock: a body edit pushes back, language frozen", async () => {
        const doc = await liveRoundTrip(
            env,
            client,
            "codeblock-edit",
            codeADF,
            (_d, md) => {
                expect(md).toContain("```javascript");
                return md.replace("const x = 1;", "const x = 42;");
            },
        );
        const code = firstNode(doc, "codeBlock");
        expect(code).toBeDefined();
        expect(attrStr(code?.attrs, "language")).toBe("javascript");
        const body = codeText(code);
        expect(body).toContain("const x = 42;");
        expect(body).not.toContain("const x = 1;");
        // The untouched markup-looking line still survives the edit.
        expect(body).toContain("<div>## not a heading</div>");
    });

    it("codeBlock: a block with no language round-trips as a plain fence", async () => {
        const noLangADF =
            '{"type":"doc","content":[{"type":"codeBlock",' +
            '"content":[{"type":"text","text":"plain code line"}]}]}';
        const doc = await liveRoundTrip(
            env,
            client,
            "codeblock-nolang",
            noLangADF,
            (_d, md) => {
                // A language-less block renders as a bare fence, no info string.
                expect(md).toContain("```\nplain code line\n```");
                return md;
            },
        );
        const code = firstNode(doc, "codeBlock");
        expect(code).toBeDefined();
        expect(attrStr(code?.attrs, "language")).toBe("");
        expect(codeText(code)).toContain("plain code line");
    });

    it("rule: a thematic break round-trips as a rule node", async () => {
        const ruleADF =
            '{"type":"doc","content":[' +
            '{"type":"paragraph","content":[{"type":"text","text":"above the line"}]},' +
            '{"type":"rule"},' +
            '{"type":"paragraph","content":[{"type":"text","text":"below the line"}]}]}';
        const doc = await liveRoundTrip(
            env,
            client,
            "rule",
            ruleADF,
            (_d, md) => {
                expect(md).toContain("---");
                return md;
            },
        );
        expect(firstNode(doc, "rule")).toBeDefined();
        const text = docText(doc);
        expect(text).toContain("above the line");
        expect(text).toContain("below the line");
    });
});
