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
    ACTION_LABELS,
    applyActions,
    type Choice,
    type Config,
    type ConfluenceClient,
    type CreateInput,
    collectGarbage,
    collectStatus,
    type FileSystem,
    findStale,
    isClean,
    MetaCache,
    managedPushDests,
    openLinkIndex,
    overwrites,
    type PageAction,
    type PreflightEntry,
    Puller,
    Pusher,
    pageLine,
    pageName,
    planCreates,
    pullConfig,
    pullSummary,
    type Reporter,
    readPageMeta,
    removeStale,
    resolveFlavor,
    resolvePagePath,
    resolvePageSource,
    rowActions,
    type StaleItem,
    type StatusOptions,
    type StatusReport,
    statusRows,
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

/** ConfirmOverwrite asks whether to discard the local edits of the named notes. */
export type ConfirmOverwrite = (names: string[]) => Promise<boolean>;

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
    overwrite: ConfirmOverwrite | null = null,
): Promise<CommandResult> {
    if (overwrite !== null) {
        if (selected === "") {
            return {
                out: "",
                error: new Error("--overwrite needs the path of one note"),
            };
        }
        const name = pageName(
            d.config.syncRoot,
            resolvePagePath(d.config.syncRoot, selected),
        );
        if (!(await overwrite([name]))) {
            return { out: "cfsync: nothing overwritten\n", error: null };
        }
        return pullSelected(d, selected, true);
    }
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
    overwrite = false,
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
        overwrite,
    });
    const { state, action, version } = await puller.pullOne(
        dest,
        src,
        spaceKey,
    );
    const line = pageLine(action, state, name, version);
    d.reporter.log(line);
    return { out: streamed(d, line, selectedSummary(action)), error: null };
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
    dropComments: boolean,
): Promise<CommandResult> {
    const { links, healed } = await openLinkIndex(
        d.fs,
        d.dirs.linksPath,
        d.config.syncRoot,
    );
    for (const line of healed) {
        d.reporter.log(line);
    }
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
        dropComments,
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
 * runStatus reports the two-way status of the managed notes, like `git status`:
 * the notes a push would send (new, modified, or refused), the notes a pull
 * would bring new content for, and the notes changed on both sides (see
 * {@link collectStatus}). With `selected` it reports only the note or directory
 * at that path; with `ignored` it also lists the notes push never touches. It
 * fails, reporting nothing, when Confluence cannot be reached.
 */
export async function runStatus(
    d: CliDeps,
    selected: string,
    ignored: boolean,
    interactive: StatusInteractive | null = null,
): Promise<CommandResult> {
    const opts: StatusOptions = { ignored };
    if (selected !== "") {
        opts.scope = resolvePagePath(d.config.syncRoot, selected);
    }
    let report: StatusReport;
    try {
        report = await collectStatus(
            {
                client: d.client,
                fs: d.fs,
                yaml: d.yaml,
                config: d.config,
                cacheDir: d.dirs.cacheDir,
                flavor: resolveFlavor(d.config.flavor),
                links: (
                    await openLinkIndex(
                        d.fs,
                        d.dirs.linksPath,
                        d.config.syncRoot,
                    )
                ).links,
            },
            opts,
        );
    } catch (err) {
        return {
            out: "",
            error: new Error(
                `checking status: ${err instanceof Error ? err.message : String(err)}`,
            ),
        };
    }
    if (interactive === null) {
        return { out: statusReport(report, d.config.syncRoot), error: null };
    }
    return actOnStatus(d, report, interactive);
}

/**
 * StatusInteractive drives `status -i`: `select` shows the rows, each cycling
 * through its action labels, and returns each row's chosen index; `confirm`
 * asks before notes lose their local edits to an overwrite.
 */
export interface StatusInteractive {
    select: (rows: { label: string; options: string[] }[]) => Promise<number[]>;
    confirm: ConfirmOverwrite;
}

/**
 * actOnStatus lets the user pick an action per status row, confirms any
 * overwrite once, then applies the choices (see {@link applyActions}) and
 * reports one line per applied action. Nothing chosen applies nothing; a
 * declined overwrite confirmation applies nothing either. A failed action is
 * reported and fails the command, after the others have run.
 */
async function actOnStatus(
    d: CliDeps,
    report: StatusReport,
    ui: StatusInteractive,
): Promise<CommandResult> {
    const rows = statusRows(report, d.config.syncRoot);
    if (rows.length === 0) {
        return { out: statusReport(report, d.config.syncRoot), error: null };
    }
    const width = Math.max(...rows.map((r) => r.kind.length));
    const picked = await ui.select(
        rows.map((r) => ({
            label: `${r.kind.padEnd(width)}  ${r.name}`,
            options: rowActions(r.kind).map((a) => ACTION_LABELS[a]),
        })),
    );
    const choices: Choice[] = rows.map((row, i) => ({
        row,
        action: rowActions(row.kind)[picked[i] ?? 0] ?? "skip",
    }));
    if (choices.every((c) => c.action === "skip")) {
        return { out: "cfsync: nothing to apply\n", error: null };
    }
    const lose = overwrites(choices).map((r) => r.name);
    if (!(await ui.confirm(lose))) {
        return { out: "cfsync: nothing applied\n", error: null };
    }
    const results = await applyActions(
        {
            client: d.client,
            fs: d.fs,
            yaml: d.yaml,
            config: d.config,
            reporter: d.reporter,
            cacheDir: d.dirs.cacheDir,
            assetsDir: d.dirs.assetsDir,
            linksPath: d.dirs.linksPath,
            mintLocalId: d.mintLocalId,
            flavor: resolveFlavor(d.config.flavor),
        },
        choices,
    );
    let out = "";
    for (const r of results) {
        out += `  ${r.ok ? "ok    " : "failed"}  ${ACTION_LABELS[r.action]}  ${r.name}  (${r.detail})\n`;
    }
    const failed = results.filter((r) => !r.ok).length;
    out += `cfsync: ${results.length - failed} of ${results.length} actions applied\n`;
    return {
        out,
        error: failed > 0 ? new Error(`${failed} action(s) failed`) : null,
    };
}

/** StatusRow is one rendered `status` line: its status word, page, and detail. */
interface StatusRow {
    word: string;
    name: string;
    detail: string;
}

/**
 * statusReport renders a {@link StatusReport}: one headed section per non-empty
 * group (To push, To pull, Diverged, Ignored), each row a status word, the page
 * path, and its detail, with the path column aligned across all sections; then a
 * `warning:` line per page that could not be checked. With nothing pending it
 * says so instead of printing sections.
 */
function statusReport(r: StatusReport, syncRoot: string): string {
    const versions = (e: PreflightEntry): string =>
        `local v${e.localBase} -> remote v${e.remoteVersion}`;
    const sections: Array<[string, StatusRow[]]> = [
        [
            "To push",
            r.push.map((e) => ({
                word: e.cls,
                name: e.name,
                detail: e.cls === "refused" ? `(${firstLine(e.reason)})` : "",
            })),
        ],
        [
            "To pull",
            r.pull.map((e) => ({
                word: "remote",
                name: e.name,
                detail: versions(e),
            })),
        ],
        [
            "Diverged",
            r.diverged.map((e) => ({
                word: "diverged",
                name: e.name,
                detail: `${versions(e)}, local edits`,
            })),
        ],
        [
            "Ignored",
            r.ignored.map((dest) => ({
                word: "ignored",
                name: pageName(syncRoot, dest),
                detail: "",
            })),
        ],
    ];
    const rows = sections.flatMap(([, s]) => s);
    const wordWidth = Math.max(0, ...rows.map((row) => row.word.length)) + 2;
    // Align details on the longest name up to NAME_CAP; a longer name keeps a
    // two-space gap, so one deep path does not push every detail off-screen.
    const fitting = rows
        .filter((row) => row.detail !== "" && row.name.length <= NAME_CAP)
        .map((row) => row.name.length);
    const nameWidth = Math.max(0, ...fitting) + 2;

    const parts: string[] = [];
    for (const [title, section] of sections) {
        if (section.length === 0) {
            continue;
        }
        let out = `${title} (${section.length}):\n`;
        for (const row of section) {
            const line =
                row.detail === ""
                    ? `  ${row.word.padEnd(wordWidth)}${row.name}`
                    : `  ${row.word.padEnd(wordWidth)}` +
                      `${padName(row.name, nameWidth)}${row.detail}`;
            out += `${line}\n`;
        }
        parts.push(out);
    }
    const warnings = r.warnings
        .map((e) => `warning: ${e.name}: could not check (${e.reason})\n`)
        .join("");
    if (isClean(r)) {
        const clean =
            r.warnings.length === 0
                ? "cfsync: everything up to date\n"
                : "cfsync: nothing to push or pull among the checked pages\n";
        parts.push(clean);
    }
    return parts.join("\n") + (warnings === "" ? "" : `\n${warnings}`);
}

/** NAME_CAP is the longest page name `status` aligns details after. */
const NAME_CAP = 60;

/** padName pads `name` to `width`, keeping at least a two-space gap. */
function padName(name: string, width: number): string {
    return name.length + 2 > width ? `${name}  ` : name.padEnd(width);
}

/** firstLine is the first line of a possibly multi-line message. */
function firstLine(s: string): string {
    const nl = s.indexOf("\n");
    return nl < 0 ? s : s.slice(0, nl);
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

/** selectedSummary is the closing summary for a single-page pull. */
function selectedSummary(action: PageAction): string {
    if (action === "added") {
        return "cfsync: 1 page pulled — new note added\n";
    }
    if (action === "updated") {
        return "cfsync: 1 page pulled — note updated\n";
    }
    if (action === "conflict") {
        return (
            "cfsync: 1 page pulled — conflict markers written, resolve them " +
            "before pushing\n"
        );
    }
    return "cfsync: 1 page already up to date — nothing written\n";
}

/**
 * streamed returns the stdout text for a completed command: the summary alone when
 * the reporter already streamed the per-page log itself (the live TTY view),
 * otherwise the buffered log followed by the summary.
 */
function streamed(d: CliDeps, log: string, summary: string): string {
    return d.reporter.streamsLog() ? summary : log + summary;
}
