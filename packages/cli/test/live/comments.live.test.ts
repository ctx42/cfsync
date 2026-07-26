// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live comment round-trips against the real Site (RZTST). Comments are not part
// of the page body ADF, so these seed a page, attach a real inline/footer comment
// via the v2 API, then drive the CLI: a pull must render the `[^cf-…]` anchor and
// `[!comment]` callout, and a push must write a typed reply and a resolution
// back. This is the suite that would have caught the `properties.inlineMarkerRef`
// mapping bug the stubbed unit tests could not. Run: bun run --filter @cfsync/cli test:live

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
    seedFooterComment,
    seedInlineComment,
} from "./support/comment-seed.ts";
import { liveConfigured, requireEnv, seedClient } from "./support/live-env.ts";
import { docText, parseDoc } from "./support/probe.ts";
import { seedPage } from "./support/roundtrip.ts";

// A page body containing the word the inline comment anchors to ("Devices").
const PAGE_ADF =
    '{"type":"doc","content":[{"type":"paragraph","content":[' +
    '{"type":"text","text":"The Devices list lives here."}]}]}';

describe.skipIf(!liveConfigured())("live comments", () => {
    const env = requireEnv();
    const client = seedClient(env);

    it("pull: an inline comment renders as an anchor + callout", async () => {
        const seed = await seedPage(
            env,
            client,
            "cmt-inline",
            PAGE_ADF,
            "comments: true",
        );
        const c = await seedInlineComment(
            env,
            seed.id,
            "Devices",
            "Which devices exactly?",
        );
        const pulled = await seed.run(["pull", "--config", seed.cfgPath]);
        expect(pulled.code, pulled.err).toBe(0);

        const md = await readFile(seed.dest, "utf8");
        expect(md).toContain(`[^cf-${c.markerRef}]`);
        expect(md).toContain("[!comment]");
        expect(md).toContain("Which devices exactly?");
    });

    it("pull: a footer comment renders in the trailing section", async () => {
        const seed = await seedPage(
            env,
            client,
            "cmt-footer",
            PAGE_ADF,
            "comments: true",
        );
        await seedFooterComment(env, seed.id, "A page-level footer note.");
        const pulled = await seed.run(["pull", "--config", seed.cfgPath]);
        expect(pulled.code, pulled.err).toBe(0);

        const md = await readFile(seed.dest, "utf8");
        expect(md).toContain("## Comments");
        expect(md).toContain("A page-level footer note.");
    });

    it("re-pull over an existing comment-free note adds the decorations", async () => {
        // The regression that shipped comment-free notes: the note was first
        // pulled with comments OFF, so it exists comment-free; enabling comments
        // and re-pulling the SAME note must decorate it (the merge base must be
        // the previous render, not the freshly-rewritten cache).
        const seed = await seedPage(env, client, "cmt-repull", PAGE_ADF);
        await seedInlineComment(env, seed.id, "Devices", "A late inline note.");

        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );
        expect(await readFile(seed.dest, "utf8")).not.toContain("[!comment]");

        const cfg = await readFile(seed.cfgPath, "utf8");
        await writeFile(seed.cfgPath, `comments: true\n${cfg}`);
        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );

        const md = await readFile(seed.dest, "utf8");
        expect(md).toContain("[!comment]");
        expect(md).toContain("A late inline note.");
    });

    it("push: an untagged nested reply is created on Confluence", async () => {
        const seed = await seedPage(
            env,
            client,
            "cmt-reply",
            PAGE_ADF,
            "comments: true",
        );
        await seedInlineComment(env, seed.id, "Devices", "Which devices?");
        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );

        let md = await readFile(seed.dest, "utf8");
        // Append an id-less nested reply inside the callout (contiguous `>` lines).
        md = md.replace(
            "> Which devices?",
            "> Which devices?\n> > [!comment]\n> > Answer: all of them.",
        );
        await writeFile(seed.dest, md);

        const pushed = await seed.run(["push", "--config", seed.cfgPath]);
        expect(pushed.code, pushed.err).toBe(0);

        const remote = await client.fetchComments(seed.id);
        const replyTexts = remote.inline
            .flatMap((t) => t.replies)
            .map((r) => docText(parseDoc(r.adf)));
        expect(replyTexts.join(" ")).toContain("Answer: all of them.");
    });

    it("push: flipping the resolution token warns (API cannot resolve)", async () => {
        const seed = await seedPage(
            env,
            client,
            "cmt-resolve",
            PAGE_ADF,
            "comments: true",
        );
        await seedInlineComment(env, seed.id, "Devices", "Please resolve.");
        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );

        let md = await readFile(seed.dest, "utf8");
        expect(md).toContain(" · open");
        md = md.replace(" · open", " · resolved");
        await writeFile(seed.dest, md);

        // Confluence exposes no stable REST endpoint to resolve an inline comment,
        // so the push succeeds, warns, and the thread stays open — cfsync never
        // claims a resolution it cannot actually write.
        const pushed = await seed.run(["push", "--config", seed.cfgPath]);
        expect(pushed.code, pushed.err).toBe(0);
        expect(`${pushed.out}${pushed.err}`).toContain("not supported");

        const remote = await client.fetchComments(seed.id);
        expect(remote.inline[0]?.resolution).toBe("open");
    });
});
