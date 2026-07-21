// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's pull/push flow layer, the analog of the CLI's commands.ts. Each
// function assembles the core orchestrators over the runtime and a per-run
// reporter, and returns the core outcome. It is obsidian-free (dests are plain
// vault paths), so it unit-tests with the core's MemFS + QueueHttpClient.

import {
    loadLinkIndex,
    MetaCache,
    managedPushDests,
    type PageState,
    type PreflightEntry,
    Puller,
    type PullOutcome,
    Pusher,
    type PushOutcome,
    pageName,
    planCreates,
    posixClean,
    pullConfig,
    pushPreflight,
    type Reporter,
    resolveFlavor,
    resolvePageSource,
} from "@cfsync/core";
import type { PluginRuntime } from "../runtime.ts";

/** Scope selects the breadth of a pull/push: the whole vault or the active note. */
export type Scope = "vault" | "current";

/** toDest cleans an Obsidian active-file path into a core dest path. */
export function toDest(activeFilePath: string): string {
    return posixClean(activeFilePath);
}

/** pullVault pulls every configured page and discovered folder/space page. */
export function pullVault(
    rt: PluginRuntime,
    reporter: Reporter,
): Promise<PullOutcome> {
    return pullConfig({
        client: rt.client,
        fs: rt.fs,
        config: rt.config,
        reporter,
        cacheDir: rt.dirs.cacheDir,
        assetsDir: rt.dirs.assetsDir,
        linksPath: rt.dirs.linksPath,
    });
}

/**
 * pullNote pulls the single managed page at `dest` (an active-note dest). It
 * streams progress through `reporter`; a failure throws rather than returning a
 * per-page outcome, since the view's `guarded()` catches it and there is no
 * batch to fold the result into. Returns the page's pull state.
 */
export async function pullNote(
    rt: PluginRuntime,
    reporter: Reporter,
    dest: string,
): Promise<PageState> {
    // Announce the one page up front so the reporter sits in its processing
    // phase throughout — any on-demand root discovery inside resolvePageSource
    // then runs under a steady "pulling <name>" bar, not a discovery counter.
    const name = pageName(rt.config.syncRoot, dest);
    reporter.discovered(1);
    reporter.item(name);
    const { src, spaceKey, links } = await resolvePageSource(
        {
            client: rt.client,
            fs: rt.fs,
            config: rt.config,
            reporter,
            linksPath: rt.dirs.linksPath,
        },
        dest,
    );
    const puller = new Puller({
        client: rt.client,
        fs: rt.fs,
        config: rt.config,
        reporter,
        cacheDir: rt.dirs.cacheDir,
        assetsDir: rt.dirs.assetsDir,
        links,
        flavor: resolveFlavor(rt.config.flavor),
    });
    const { state, version } = await puller.pullOne(dest, src, spaceKey);
    reporter.log(`pulling ${name} ... ${state} (v${version})\n`);
    return state;
}

/** preflight classifies the push candidates for `scope` against their remote versions. */
export async function preflight(
    rt: PluginRuntime,
    scope: Scope,
    activeDest: string | null,
): Promise<PreflightEntry[]> {
    // One frontmatter cache spans discovery and preflight so each note is read
    // once, not twice.
    const cache = new MetaCache();
    const dests = await pushDestsFor(rt, scope, activeDest, cache);
    return pushPreflight(
        { client: rt.client, fs: rt.fs, yaml: rt.yaml, config: rt.config },
        dests,
        cache,
    );
}

/** pushSelected pushes exactly the given dests, creating any confirmed new pages. */
export async function pushSelected(
    rt: PluginRuntime,
    reporter: Reporter,
    dests: string[],
): Promise<PushOutcome> {
    const links = await loadLinkIndex(
        rt.fs,
        rt.dirs.linksPath,
        rt.config.syncRoot,
    );
    // The user already chose these in the preview, so confirm every create.
    const plan = await planCreates(
        { client: rt.client, fs: rt.fs, yaml: rt.yaml, config: rt.config },
        dests,
        async (cands) => new Map(cands.map((c) => [c.dest, true])),
    );
    const pusher = new Pusher({
        client: rt.client,
        fs: rt.fs,
        yaml: rt.yaml,
        config: rt.config,
        reporter,
        cacheDir: rt.dirs.cacheDir,
        assetsDir: rt.dirs.assetsDir,
        mintLocalId: rt.mintLocalId,
        links,
        flavor: resolveFlavor(rt.config.flavor),
    });
    reporter.discovered(dests.length);
    return pusher.pushDests(dests, plan);
}

/** pushDestsFor resolves the candidate dests for a scope, validating the active note. */
async function pushDestsFor(
    rt: PluginRuntime,
    scope: Scope,
    activeDest: string | null,
    cache?: MetaCache,
): Promise<string[]> {
    const all = await managedPushDests(rt.fs, rt.yaml, rt.config, cache);
    if (scope === "vault") {
        return all;
    }
    if (activeDest === null) {
        throw new Error("no active note to push");
    }
    if (!all.includes(activeDest)) {
        throw new Error(`active note is not a managed page: ${activeDest}`);
    }
    return [activeDest];
}
