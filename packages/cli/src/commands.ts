// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The command orchestration, ported from the `pull`/`push`/`gc`/`clean` and
// `connectionTest` glue of `pkg/cfsync`. Each function assembles the core's
// orchestrators over the injected ports and returns a {@link CommandResult}: the
// text to write to stdout plus an optional error. It never prints — the dispatch
// layer routes `out` to stdout and `error` to stderr — so the whole layer stays
// testable with an in-memory HTTP stub and filesystem. The confirmation UX
// (which creates to make, which stale files to remove) is injected as callbacks,
// since it belongs to the terminal, not the sync.

import {
    type Config,
    type ConfluenceClient,
    type CreateInput,
    collectGarbage,
    type FileSystem,
    findStale,
    loadLinkIndex,
    MetaCache,
    managedPushDests,
    type PageState,
    type PreflightEntry,
    Puller,
    Pusher,
    pageName,
    planCreates,
    pullConfig,
    pullSummary,
    pushPreflight,
    type Reporter,
    readPageMeta,
    removeStale,
    resolveFlavor,
    resolvePagePath,
    resolvePageSource,
    type StaleItem,
    type Yaml,
} from "@cfsync/core";
import type { RuntimeDirs } from "./config-load.ts";

/** CommandResult is a command's stdout text plus an optional error for stderr. */
export interface CommandResult {
    out: string;
    error: Error | null;
}

/** CliDeps are the ports, config, and derived paths every command shares. */
export interface CliDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
    reporter: Reporter;
    dirs: RuntimeDirs;
    /** Mints a fresh media-node localId for an uploaded image. */
    mintLocalId: () => string;
}

/** ConfirmCreates decides which create candidates to make (dest → create). */
export type ConfirmCreates = (
    cands: CreateInput[],
) => Promise<Map<string, boolean>>;

/** ConfirmStale selects which stale items to remove from the found set. */
export type ConfirmStale = (items: StaleItem[]) => Promise<StaleItem[]>;

/**
 * runTest verifies authenticated access to the Site by resolving the current
 * account, and reports the connection.
 */
export async function runTest(d: CliDeps): Promise<CommandResult> {
    const account = await d.client.currentAccountID();
    return {
        out: `cfsync: connected to ${d.config.host} as ${account}\n`,
        error: null,
    };
}

/**
 * runPull pulls every configured page and discovered folder/space page into the
 * ADF cache, or only the `selected` page when one is named.
 */
export async function runPull(
    d: CliDeps,
    selected: string,
): Promise<CommandResult> {
    if (selected !== "") {
        return pullSelected(d, selected);
    }
    const outcome = await pullConfig({
        client: d.client,
        fs: d.fs,
        config: d.config,
        reporter: d.reporter,
        cacheDir: d.dirs.cacheDir,
        assetsDir: d.dirs.assetsDir,
        linksPath: d.dirs.linksPath,
    });
    if (outcome.errors.length > 0) {
        return {
            out: streamed(d, outcome.log, ""),
            error: new Error(outcome.errors.join("\n")),
        };
    }
    if (outcome.stats.total === 0) {
        return {
            out: streamed(d, outcome.log, "cfsync: nothing to pull\n"),
            error: null,
        };
    }
    return {
        out: streamed(d, outcome.log, pullSummary(outcome.stats)),
        error: null,
    };
}

/** pullSelected pulls one managed page named by `selected`. */
async function pullSelected(
    d: CliDeps,
    selected: string,
): Promise<CommandResult> {
    const dest = resolvePagePath(d.config.syncRoot, selected);
    const name = pageName(d.config.syncRoot, dest);

    // Announce the one page up front so the reporter sits in its processing
    // phase throughout — any on-demand root discovery inside resolvePageSource
    // then runs under a steady "pulling <name>" bar, not a discovery counter.
    d.reporter.discovered(1);
    d.reporter.item(name);
    const { src, spaceKey, links } = await resolvePageSource(
        {
            client: d.client,
            fs: d.fs,
            config: d.config,
            reporter: d.reporter,
            linksPath: d.dirs.linksPath,
        },
        dest,
    );
    const puller = new Puller({
        client: d.client,
        fs: d.fs,
        config: d.config,
        reporter: d.reporter,
        cacheDir: d.dirs.cacheDir,
        assetsDir: d.dirs.assetsDir,
        links,
        flavor: resolveFlavor(d.config.flavor),
    });
    const { state, version } = await puller.pullOne(dest, src, spaceKey);
    const line = selectedLine(state, name, version);
    d.reporter.log(line);
    return { out: streamed(d, line, selectedSummary(state)), error: null };
}

/**
 * runPush pushes edited notes back to Confluence, creating any confirmed new
 * pages first. With `selected` it pushes only that managed page.
 */
export async function runPush(
    d: CliDeps,
    selected: string,
    confirm: ConfirmCreates,
    force: boolean,
): Promise<CommandResult> {
    const links = await loadLinkIndex(
        d.fs,
        d.dirs.linksPath,
        d.config.syncRoot,
    );
    // One frontmatter cache spans discovery and create-planning so each note is
    // read once, not once per phase.
    const cache = new MetaCache();
    let dests = await managedPushDests(d.fs, d.yaml, d.config, cache);

    if (selected !== "") {
        const sel = resolvePagePath(d.config.syncRoot, selected);
        if (await isLocal(d, sel)) {
            return { out: "", error: new Error(`marked local: ${selected}`) };
        }
        if (!dests.includes(sel)) {
            return {
                out: "",
                error: new Error(`not a managed page: ${selected}`),
            };
        }
        dests = [sel];
    } else if (dests.length === 0) {
        return { out: "cfsync: no pages to push\n", error: null };
    }

    const plan = await planCreates(d, dests, confirm, cache);
    const pusher = new Pusher({
        client: d.client,
        fs: d.fs,
        yaml: d.yaml,
        config: d.config,
        reporter: d.reporter,
        cacheDir: d.dirs.cacheDir,
        assetsDir: d.dirs.assetsDir,
        mintLocalId: d.mintLocalId,
        links,
        flavor: resolveFlavor(d.config.flavor),
        force,
    });
    const outcome = await pusher.pushDests(dests, plan);

    if (outcome.errors.length > 0) {
        const err = new Error(
            `${outcome.errors.length} of ${outcome.total} pages failed:\n` +
                outcome.errors.join("\n"),
        );
        return { out: streamed(d, outcome.log, ""), error: err };
    }
    const summary = `cfsync: ${outcome.pushed} of ${outcome.total} pages pushed\n`;
    return { out: streamed(d, outcome.log, summary), error: null };
}

/**
 * runStatus lists the managed pages whose Confluence version has moved ahead of
 * the local base — the pages a later pull would bring new content for. It reads
 * every managed note's base version and compares it against the current remote
 * version in one bulk lookup (via {@link pushPreflight}); pages it could not
 * check (unreadable notes, or pages missing/forbidden on the Site) are reported
 * as warnings, never as false "up to date" results.
 */
export async function runStatus(d: CliDeps): Promise<CommandResult> {
    // One frontmatter cache spans discovery and preflight, so each managed note
    // is read once rather than twice.
    const cache = new MetaCache();
    const dests = await managedPushDests(d.fs, d.yaml, d.config, cache);
    if (dests.length === 0) {
        return { out: "cfsync: no pages to check\n", error: null };
    }
    const entries = await pushPreflight(
        { client: d.client, fs: d.fs, yaml: d.yaml, config: d.config },
        dests,
        cache,
    );
    return { out: statusReport(entries), error: null };
}

/**
 * statusReport renders a preflight into the `status` output: a `warning:` line
 * per page that could not be checked, then a headline count and one indented
 * `local vX -> remote vY` line per page whose remote version moved ahead.
 */
function statusReport(entries: PreflightEntry[]): string {
    const moved = entries.filter((e) => e.cls === "remote-moved");
    const skipped = entries.filter((e) => e.cls === "skip");

    let out = skipped
        .map((e) => `warning: ${e.name}: could not check (${e.reason})\n`)
        .join("");
    if (moved.length === 0) {
        return `${out}cfsync: all managed pages are up to date\n`;
    }
    out +=
        `cfsync: ${moved.length} of ${entries.length} pages have newer ` +
        "versions on Confluence\n";
    for (const e of moved) {
        out += `  ${e.name}  local v${e.localBase} -> remote v${e.remoteVersion}\n`;
    }
    return out;
}

/**
 * runGc reports orphaned files in the shared assets directory, deleting them when
 * `prune` is set. It refuses to prune when a managed note is unreadable.
 */
export async function runGc(
    d: CliDeps,
    prune: boolean,
): Promise<CommandResult> {
    const result = await collectGarbage(
        {
            fs: d.fs,
            yaml: d.yaml,
            config: d.config,
            assetsDir: d.dirs.assetsDir,
        },
        prune,
    );
    return { out: result.report, error: null };
}

/**
 * runClean removes local notes under configured folder and space roots that no
 * longer exist in Confluence, plus the directories they empty. The `confirm`
 * callback selects which stale items to remove.
 */
export async function runClean(
    d: CliDeps,
    confirm: ConfirmStale,
): Promise<CommandResult> {
    if (
        Object.keys(d.config.folders).length === 0 &&
        Object.keys(d.config.spaces).length === 0
    ) {
        return { out: "cfsync: nothing to clean\n", error: null };
    }

    const plan = await findStale({
        client: d.client,
        fs: d.fs,
        yaml: d.yaml,
        config: d.config,
        reporter: d.reporter,
    });
    let out = plan.warnings.map((w) => `warning: ${w}\n`).join("");
    if (plan.items.length === 0) {
        return { out: `${out}cfsync: no stale files\n`, error: null };
    }

    const chosen = await confirm(plan.items);
    const removal = await removeStale(d.fs, chosen);
    out += removal.report;
    return { out, error: null };
}

/**
 * isLocal reports whether the note at `dest` carries the `cf_local` marker (a page
 * created locally, never pushed), which push must not treat as a managed page.
 */
async function isLocal(d: CliDeps, dest: string): Promise<boolean> {
    const meta = await readPageMeta(d.fs, d.yaml, dest);
    return meta?.local === true;
}

/** selectedLine formats the per-page progress line for a single pulled page. */
function selectedLine(state: PageState, name: string, ver: number): string {
    if (state === "rerendered") {
        return `pulling ${name} ... skipped (v${ver} cached), md written\n`;
    }
    if (state === "unchanged") {
        return `pulling ${name} ... skipped (v${ver} cached), unchanged\n`;
    }
    return `pulling ${name} ... ok (v${ver})\n`;
}

/** selectedSummary is the closing summary for a single-page pull. */
function selectedSummary(state: PageState): string {
    if (state === "rerendered") {
        return (
            "cfsync: 1 page re-rendered from cache — Markdown rewritten " +
            "from cached ADF, no new version pulled\n"
        );
    }
    if (state === "unchanged") {
        return "cfsync: 1 page already up to date — nothing written\n";
    }
    return "cfsync: 1 page pulled (new version)\n";
}

/**
 * streamed returns the stdout text for a completed command: the summary alone when
 * the reporter already streamed the per-page log itself (the live TTY view),
 * otherwise the buffered log followed by the summary.
 */
function streamed(d: CliDeps, log: string, summary: string): string {
    return d.reporter.streamsLog() ? summary : log + summary;
}
