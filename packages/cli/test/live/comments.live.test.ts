// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live comment round-trips against the real Site (RZTST). A Confluence inline
// comment is an `annotation` mark on the body that Confluence owns and uses as
// the comment's anchor; these seed a page, attach a real inline/footer comment
// via the v2 API, then drive the CLI: a pull must render the `[^cf-…]` anchor and
// `[!comment]` callout, and a push of a body edit must leave the comment intact —
// comments are managed on the Confluence side, so a push never creates, resolves,
// or removes one. This is the suite that would have caught the
// `properties.inlineMarkerRef` mapping bug the stubbed unit tests could not.
// Run: bun run --filter @cfsync/cli test:live

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

    it("push: a body edit keeps the inline comment anchored, and local comment edits are ignored", async () => {
        const seed = await seedPage(
            env,
            client,
            "cmt-preserve",
            PAGE_ADF,
            "comments: true",
        );
        await seedInlineComment(env, seed.id, "Devices", "Which devices?");
        expect((await seed.run(["pull", "--config", seed.cfgPath])).code).toBe(
            0,
        );

        let md = await readFile(seed.dest, "utf8");
        // Edit prose that leaves the commented word "Devices" intact, and add a
        // local reply callout. The push must apply the body edit but leave the
        // comment — anchor, thread, and the would-be reply — entirely to
        // Confluence: the comment must survive the update, not vanish.
        md = md.replace("lives here.", "lives right here.");
        md = md.replace(
            "> Which devices?",
            "> Which devices?\n> > [!comment]\n> > A local reply.",
        );
        await writeFile(seed.dest, md);

        const pushed = await seed.run(["push", "--config", seed.cfgPath]);
        expect(pushed.code, pushed.err).toBe(0);

        // The page body change landed on the next version.
        const page = await client.fetchPage(seed.id);
        expect(docText(parseDoc(page.adf))).toContain("lives right here.");

        // The inline comment still exists, still anchored (never dangling), and
        // no reply was written back — comments are Confluence-managed.
        const remote = await client.fetchComments(seed.id);
        expect(remote.inline).toHaveLength(1);
        const top = remote.inline[0];
        expect(docText(parseDoc(top?.adf ?? ""))).toContain("Which devices?");
        expect(top?.resolution).not.toBe("dangling");
        expect(remote.inline.flatMap((t) => t.replies)).toHaveLength(0);
    });
});
