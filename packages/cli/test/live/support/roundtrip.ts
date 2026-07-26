// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Shared live round-trip driver for the feature-matrix suites. Each helper seeds
// a throwaway page in the test space, drives the real CLI pull/push against it,
// and returns what came back — the ADF re-fetched after a push, or the pulled
// Markdown — so a suite asserts on real Site behavior. Every seeded page is
// deleted when the test finishes. Extracted from roundtrip.live.test.ts so every
// matrix suite shares one driver.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfluenceClient, Node } from "@cfsync/core";
import { onTestFinished } from "vitest";
import { type LiveEnv, makeRun } from "./live-env.ts";
import { parseDoc, uniqueTitle } from "./probe.ts";

/** SeedResult carries the throwaway page's id and the temp sync dir. */
export interface SeedResult {
    id: string;
    dir: string;
    /** Runs the CLI against the seeded page's config; e.g. run(["pull", ...]). */
    run: (
        argv: string[],
    ) => Promise<{ code: number; out: string; err: string }>;
    /** The `.cfsync.yaml` path mapping `page.md` to the seeded page. */
    cfgPath: string;
    /** The pulled note's on-disk path (`<dir>/page.md`). */
    dest: string;
    /** Extra top-level config lines to append (e.g. `comments: true`). */
    configExtra: string;
}

/**
 * seedPage creates a throwaway page from `initialADF` in the test space, writes a
 * one-page `.cfsync.yaml` for it, and returns the handles a suite needs to pull,
 * edit, and push it. `configExtra` is appended verbatim above the `pages:` block
 * (use it for `comments: true`). The page and temp dir are cleaned up on test
 * finish.
 */
export async function seedPage(
    env: LiveEnv,
    client: ConfluenceClient,
    name: string,
    initialADF: string,
    configExtra = "",
): Promise<SeedResult> {
    const dir = await mkdtemp(join(tmpdir(), "cfsync-live-"));
    const run = makeRun(env, dir);
    const spaceId = (await client.resolveSpace(env.space)).id;
    const { id } = await client.createPage({
        spaceId,
        title: uniqueTitle(name),
        parentId: env.folder,
        docJSON: initialADF,
    });
    onTestFinished(async () => {
        await client.deletePage(id).catch(() => {});
        await rm(dir, { recursive: true, force: true });
    });
    const cfgPath = join(dir, ".cfsync.yaml");
    const src = `/wiki/spaces/${env.space}/pages/${id}/it`;
    const extra = configExtra === "" ? "" : `${configExtra}\n`;
    await writeFile(cfgPath, `${extra}pages:\n  page.md: ${src}\n`);
    return { id, dir, run, cfgPath, dest: join(dir, "page.md"), configExtra };
}

/**
 * liveRoundTrip seeds `initialADF`, pulls it, applies `edit` to the pulled
 * Markdown, pushes, and returns the page's ADF re-fetched fresh from the Site —
 * the semantic assertion surface (did the feature survive the trip). It fails the
 * test if either CLI step exits non-zero.
 */
export async function liveRoundTrip(
    env: LiveEnv,
    client: ConfluenceClient,
    name: string,
    initialADF: string,
    edit: (dir: string, md: string) => Promise<string> | string,
    configExtra = "",
): Promise<Node> {
    const seed = await seedPage(env, client, name, initialADF, configExtra);
    const pulled = await seed.run(["pull", "--config", seed.cfgPath]);
    if (pulled.code !== 0) {
        throw new Error(`pull failed: ${pulled.err}`);
    }
    const md = await readFile(seed.dest, "utf8");
    await writeFile(seed.dest, await edit(seed.dir, md));
    const pushed = await seed.run(["push", "--config", seed.cfgPath]);
    if (pushed.code !== 0) {
        throw new Error(`push failed: ${pushed.err}`);
    }
    return parseDoc((await client.fetchPage(seed.id)).adf);
}

/**
 * livePull seeds `initialADF`, pulls it, and returns the pulled Markdown body
 * (frontmatter included) without pushing — for asserting the ADF→Markdown
 * rendering of a feature directly. `configExtra` lets a caller enable options
 * such as `comments: true`.
 */
export async function livePull(
    env: LiveEnv,
    client: ConfluenceClient,
    name: string,
    initialADF: string,
    configExtra = "",
): Promise<{ md: string; seed: SeedResult }> {
    const seed = await seedPage(env, client, name, initialADF, configExtra);
    const pulled = await seed.run(["pull", "--config", seed.cfgPath]);
    if (pulled.code !== 0) {
        throw new Error(`pull failed: ${pulled.err}`);
    }
    return { md: await readFile(seed.dest, "utf8"), seed };
}
