// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from space_live_test.go. Pull the whole test space, then edit and push
// a throwaway page created for the test, and confirm the edit is live at v2.

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import {
    liveConfigured,
    makeRun,
    requireEnv,
    seedClient,
} from "./support/live-env.ts";
import { docText, parseDoc, uniqueTitle } from "./support/probe.ts";

/** mdFilesUnder lists every .md file under root, skipping the .adf_cache dir. */
async function mdFilesUnder(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (e.name === ".adf_cache") {
                    continue;
                }
                await walk(join(d, e.name));
            } else if (e.name.endsWith(".md")) {
                out.push(join(d, e.name));
            }
        }
    };
    await walk(root);
    return out;
}

describe.skipIf(!liveConfigured())("live whole-space round-trip", () => {
    const env = requireEnv();
    const client = seedClient(env);
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "cfsync-live-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("pulls the space, edits and pushes one page to v2", async () => {
        const run = makeRun(env, dir);
        const seed = "space round trip seed";
        const spaceId = (await client.resolveSpace(env.space)).id;
        const { id } = await client.createPage({
            spaceId,
            title: uniqueTitle("space-rt"),
            parentId: env.folder,
            docJSON: `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${seed}"}]}]}`,
        });
        onTestFinished(async () => {
            await client.deletePage(id).catch(() => {});
        });

        const cfgPath = join(dir, ".cfsync.yaml");
        // Pull the whole space into a subdir of the sync root.
        await writeFile(
            cfgPath,
            `spaces:\n  space: /wiki/spaces/${env.space}\n`,
        );
        const pulled = await run(["pull", "--config", cfgPath]);
        expect(pulled.code, pulled.err).toBe(0);

        // Find the pulled file whose frontmatter page_id is our throwaway page.
        let dest = "";
        for (const p of await mdFilesUnder(dir)) {
            const text = await readFile(p, "utf8");
            if (text.includes(`page_id: "${id}"`)) {
                dest = p;
                break;
            }
        }
        expect(dest, "seeded page was pulled").not.toBe("");

        const md = await readFile(dest, "utf8");
        const edited = md.replace(seed, `${seed} EDITED`);
        expect(edited).not.toBe(md);
        await writeFile(dest, edited);

        const pushed = await run(["push", "--config", cfgPath]);
        expect(pushed.code, pushed.err).toBe(0);
        expect(pushed.out).toContain("ok (v2)");

        const fetched = await client.fetchPage(id);
        expect(fetched.version).toBe(2);
        expect(docText(parseDoc(fetched.adf))).toContain(`${seed} EDITED`);
    });
});
