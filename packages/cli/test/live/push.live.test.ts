// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from push_live_test.go. A pull refreshes a page's Markdown to its
// baseline, so an immediate push must report no changes and send no update.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { uniqueTitle } from "./support/probe.ts";

describe.skipIf(!liveConfigured())("live push no-op", () => {
    const env = requireEnv();
    const client = seedClient(env);
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "cfsync-live-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("pull then immediate push reports unchanged", async () => {
        const run = makeRun(env, dir);
        const spaceId = (await client.resolveSpace(env.space)).id;
        const { id } = await client.createPage({
            spaceId,
            title: uniqueTitle("push-noop"),
            parentId: env.folder,
            docJSON:
                '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello from cfsync"}]}]}',
        });
        onTestFinished(async () => {
            await client.deletePage(id).catch(() => {});
        });

        const cfgPath = join(dir, ".cfsync.yaml");
        await writeFile(
            cfgPath,
            `pages:\n  page.md: /wiki/spaces/${env.space}/pages/${id}/it\n`,
        );

        const pulled = await run(["pull", "--config", cfgPath]);
        expect(pulled.code, pulled.err).toBe(0);

        const pushed = await run(["push", "--config", cfgPath]);
        expect(pushed.code, pushed.err).toBe(0);
        expect(pushed.out).toContain("unchanged");
    });
});
