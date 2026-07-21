// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from placement_live_test.go. Proves the page-placement pipeline against
// the Site: a title-only Markdown file nested under new local directories pushes
// as new restricted folders plus a restricted page, and a pre-existing folder is
// reused rather than duplicated. Everything created lives under a scratch folder
// deleted (deepest-first) on completion.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveName, deSlugTitle } from "@cfsync/core";
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
import { probeGet, restrictionRead, uniqueTitle } from "./support/probe.ts";

describe.skipIf(!liveConfigured())("live placement", () => {
    const env = requireEnv();
    const client = seedClient(env);
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "cfsync-live-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("creates nested folders and a restricted page, and re-pull converges", async () => {
        const run = makeRun(env, dir);
        const ref = await client.resolveSpace(env.space);
        const spaceId = ref.id;
        const accountId = await client.currentAccountID();

        // Scratch root folder under the space homepage.
        const rootId = await client.createFolder(
            spaceId,
            ref.homepageId,
            uniqueTitle("placement-root"),
        );
        onTestFinished(async () => {
            await client.deleteFolder(rootId).catch(() => {});
        });

        // Seed one page inside the scratch folder.
        const seedId = (
            await client.createPage({
                spaceId,
                title: uniqueTitle("placement-seed"),
                parentId: rootId,
                docJSON:
                    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"placement seed"}]}]}',
            })
        ).id;
        onTestFinished(async () => {
            await client.deletePage(seedId).catch(() => {});
        });

        // Pull the scratch folder into the sync root.
        const cfgPath = join(dir, ".cfsync.yaml");
        await writeFile(
            cfgPath,
            `folders:\n  .: /wiki/spaces/${env.space}/folder/${rootId}\n`,
        );
        expect((await run(["pull", "--config", cfgPath])).code).toBe(0);

        // Author a title-only file two new directories deep. Folder titles are
        // unique per space, so the directory names carry a per-run tag.
        const runTag = Date.now().toString(36);
        const alphaDir = `alpha_beta_${runTag}`;
        const gammaDir = `gamma_delta_${runTag}`;
        const alphaTitle = deSlugTitle(alphaDir);
        const gammaTitle = deSlugTitle(gammaDir);
        const leafTitle = uniqueTitle("placement-leaf");
        // pull names a page file by deriveName(title), so the authored file must
        // use that name for the fresh-pull convergence check below to land on it.
        const leafName = deriveName(leafTitle);

        const pageDir = join(dir, alphaDir, gammaDir);
        await mkdir(pageDir, { recursive: true });
        const leafDest = join(pageDir, `${leafName}.md`);
        await writeFile(
            leafDest,
            `---\ntitle: ${leafTitle}\n---\n\nplacement leaf body\n`,
        );

        // Push: creates two folders and the page, chained + restricted.
        const push1 = await run(["push", "--yes", "--config", cfgPath]);
        expect(push1.code, `${push1.err}${push1.out}`).toBe(0);

        const alphaId = await client.childFolderTitled(rootId, alphaTitle);
        expect(alphaId, `folder ${alphaTitle} under root`).not.toBe("");
        onTestFinished(async () => {
            await client.deleteFolder(alphaId).catch(() => {});
        });
        const gammaId = await client.childFolderTitled(alphaId, gammaTitle);
        expect(gammaId, `folder ${gammaTitle} under alpha`).not.toBe("");
        onTestFinished(async () => {
            await client.deleteFolder(gammaId).catch(() => {});
        });

        // The pushed file was stamped with its new identity on create.
        const leafMd = await readFile(leafDest, "utf8");
        const pageId = /page_id:\s*"?(\d+)"?/.exec(leafMd)?.[1] ?? "";
        expect(pageId).not.toBe("");
        onTestFinished(async () => {
            await client.deletePage(pageId).catch(() => {});
        });
        expect(leafMd).toContain(`parent_id: "${gammaId}"`);

        // The page hangs off the deepest folder, reported as a folder parent.
        const page = await probeGet(env, `/wiki/api/v2/pages/${pageId}`);
        expect(page.status).toBe(200);
        const pageNode = JSON.parse(page.body) as {
            parentId: string;
            parentType: string;
        };
        expect(pageNode.parentId).toBe(gammaId);
        expect(pageNode.parentType).toBe("folder");

        // Both folders and the page are restricted to the author account.
        for (const cid of [alphaId, gammaId, pageId]) {
            const r = await restrictionRead(env, cid);
            expect(r.status).toBe(200);
            expect(r.body, `content ${cid} restricted`).toContain(accountId);
        }

        // A fresh pull reproduces the tree; a second pull rewrites nothing.
        const fresh = await mkdtemp(join(tmpdir(), "cfsync-live-"));
        onTestFinished(async () => {
            await rm(fresh, { recursive: true, force: true });
        });
        const freshCfg = join(fresh, ".cfsync.yaml");
        await writeFile(
            freshCfg,
            `folders:\n  .: /wiki/spaces/${env.space}/folder/${rootId}\n`,
        );
        const freshRun = makeRun(env, fresh);
        expect((await freshRun(["pull", "--config", freshCfg])).code).toBe(0);
        const freshLeaf = join(fresh, alphaDir, gammaDir, `${leafName}.md`);
        const before = await readFile(freshLeaf, "utf8");
        expect(before).toContain(`page_id: "${pageId}"`);
        expect((await freshRun(["pull", "--config", freshCfg])).code).toBe(0);
        expect(await readFile(freshLeaf, "utf8")).toBe(before);
    });

    it("reuses a pre-existing folder instead of duplicating it", async () => {
        const run = makeRun(env, dir);
        const ref = await client.resolveSpace(env.space);
        const spaceId = ref.id;

        const rootId = await client.createFolder(
            spaceId,
            ref.homepageId,
            uniqueTitle("reuse-root"),
        );
        onTestFinished(async () => {
            await client.deleteFolder(rootId).catch(() => {});
        });
        const seedId = (
            await client.createPage({
                spaceId,
                title: uniqueTitle("reuse-seed"),
                parentId: rootId,
                docJSON:
                    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"reuse seed"}]}]}',
            })
        ).id;
        onTestFinished(async () => {
            await client.deletePage(seedId).catch(() => {});
        });

        const runTag = Date.now().toString(36);
        const subDir = `reuse_me_${runTag}`;
        const subTitle = deSlugTitle(subDir);
        const subId = await client.createFolder(spaceId, rootId, subTitle);
        onTestFinished(async () => {
            await client.deleteFolder(subId).catch(() => {});
        });

        const cfgPath = join(dir, ".cfsync.yaml");
        await writeFile(
            cfgPath,
            `folders:\n  .: /wiki/spaces/${env.space}/folder/${rootId}\n`,
        );
        expect((await run(["pull", "--config", cfgPath])).code).toBe(0);

        const pageDir = join(dir, subDir);
        await mkdir(pageDir, { recursive: true });
        const leafTitle = uniqueTitle("reuse-leaf");
        const leafDest = join(pageDir, "reuse_leaf.md");
        await writeFile(
            leafDest,
            `---\ntitle: ${leafTitle}\n---\n\nreuse leaf body\n`,
        );

        const push2 = await run(["push", "--yes", "--config", cfgPath]);
        expect(push2.code, `${push2.err}${push2.out}`).toBe(0);

        const leafMd = await readFile(leafDest, "utf8");
        const pageId = /page_id:\s*"?(\d+)"?/.exec(leafMd)?.[1] ?? "";
        expect(pageId).not.toBe("");
        onTestFinished(async () => {
            await client.deletePage(pageId).catch(() => {});
        });
        // The pre-existing folder was reused: the page parent is subId and the
        // root still has exactly one folder titled subTitle.
        expect(leafMd).toContain(`parent_id: "${subId}"`);
        expect(await client.childFolderTitled(rootId, subTitle)).toBe(subId);
    });
});
