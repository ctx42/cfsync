// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Command dispatch, flag parsing, and config setup, ported from `cli.go` +
// `cmd/cfsync/main.go`. `main` reads the command and flags, loads the config and
// `.env` (secrets from the environment, never the YAML), assembles the core
// orchestrators over the Node adapters, runs the command, and routes its result:
// stdout for output, stderr for errors, an integer process code. It touches no
// globals directly — streams, env, filesystem, clock, and the TTY check all come
// in through `MainCtx`, so the whole CLI is driven end-to-end in tests.

import { randomUUID } from "node:crypto";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
    type Clock,
    type Config,
    ConfluenceClient,
    type FileSystem,
    type HttpClient,
    markIgnorePush,
    NoopReporter,
    type Reporter,
    type Streams,
    type Yaml,
} from "@cfsync/core";
import type { NodeEnv } from "./adapters/env.ts";
import { FetchHttpClient } from "./adapters/http.ts";
import { bunYaml } from "./adapters/yaml.ts";
import {
    type CliDeps,
    type CommandResult,
    runClean,
    runGc,
    runPull,
    runPush,
    runStatus,
    runTest,
} from "./commands.ts";
import {
    ENV_SYNC_ROOT,
    envFilePath,
    loadConfig,
    loadEnvFile,
    runtimeDirs,
} from "./config-load.ts";
import { confirmCreates, confirmOverwrite, confirmStale } from "./prompt.ts";
import { newReporter } from "./reporter.ts";
import { type KeySource, runSelect } from "./select.ts";
import { VERSION } from "./version.ts";

/** Process exit codes. */
export const EXIT_OK = 0;
export const EXIT_ERR = 1;

/** The config-reading commands, dispatched through {@link runConfigCommand}. */
type ConfigCommand = "test" | "pull" | "push" | "status" | "gc" | "clean";

/** MainCtx is the injected environment {@link main} runs against. */
export interface MainCtx {
    argv: string[];
    streams: Streams;
    env: NodeEnv;
    fs: FileSystem;
    clock: Clock;
    /** Whether the error stream is an interactive terminal (drives the live view). */
    isTTY: boolean;
    /**
     * Whether the input stream is an interactive terminal — gates the
     * confirmation prompt, which reads stdin (distinct from {@link isTTY},
     * which reflects stderr). Falls back to {@link isTTY} when omitted.
     */
    stdinIsTTY?: boolean;
    /** Reads one line of input for a confirmation prompt. */
    ask: (question: string) => Promise<string>;
    /**
     * Opens a raw keypress source for push's new-page selector. Omitted where
     * no interactive keyboard exists (tests that never reach the selector).
     */
    keys?: () => KeySource;
    /**
     * An HTTP client to use instead of the built-in fetch adapter — injected by
     * tests to drive the CLI against a stub. Omitted in production, where a
     * {@link FetchHttpClient} bounded by the config timeout is built per run.
     */
    httpClient?: HttpClient;
    /**
     * A YAML parser to use instead of {@link bunYaml} — injected by tests, which
     * run under Node (no `Bun`), with the `yaml` package. Omitted in production,
     * where the compiled binary parses with Bun's built-in `Bun.YAML`.
     */
    yaml?: Yaml;
}

/**
 * main dispatches the cfsync command and returns the process exit code. It reads
 * the command name and flags from `ctx.argv` and routes output, errors, and codes
 * through `ctx`.
 */
export async function main(ctx: MainCtx): Promise<number> {
    const [cmd, ...rest] = ctx.argv;
    switch (cmd) {
        case undefined:
            ctx.streams.stderr.write(USAGE);
            return EXIT_ERR;
        case "version":
            ctx.streams.stdout.write(`cfsync ${VERSION}\n`);
            return EXIT_OK;
        case "help":
            return runHelp(ctx, rest);
        case "test":
        case "pull":
        case "push":
        case "status":
        case "gc":
        case "clean":
            return runConfigCommand(ctx, cmd, rest);
        default:
            ctx.streams.stderr.write(`cfsync: unknown command: ${cmd}\n`);
            ctx.streams.stderr.write('Run "cfsync help" for usage.\n');
            return EXIT_ERR;
    }
}

/** The flags a config-reading command accepts. */
interface ConfigFlags {
    config: string;
    env: string;
    syncRoot: string;
    yes: boolean;
    prune: boolean;
    force: boolean;
    dropComments: boolean;
    ignored: boolean;
    overwrite: boolean;
    interactive: boolean;
    page: string;
}

/**
 * runConfigCommand parses one config-reading command's flags, loads the config and
 * `.env`, assembles the deps, runs the command, and reports the result.
 */
async function runConfigCommand(
    ctx: MainCtx,
    cmd: ConfigCommand,
    args: string[],
): Promise<number> {
    const parsed = parseFlags(ctx, cmd, args);
    if (parsed === "help") {
        ctx.streams.stdout.write(COMMAND_USAGE[cmd]);
        return EXIT_OK;
    }
    if (parsed === "error") {
        return EXIT_ERR;
    }
    const flags = parsed;
    const yaml = ctx.yaml ?? bunYaml;

    let config: Config;
    try {
        if (flags.syncRoot !== "") {
            ctx.env.set(ENV_SYNC_ROOT, flags.syncRoot);
        }
        const envFile = envFilePath(flags.config, flags.env);
        await loadEnvFile(ctx.fs, ctx.env, envFile.path, envFile.explicit);
        config = await loadConfig(ctx.fs, ctx.env, yaml, flags.config);
    } catch (err) {
        return report(ctx, { out: "", error: asError(err) });
    }

    const reporter: Reporter =
        cmd === "pull" || cmd === "push"
            ? newReporter(
                  ctx.clock,
                  cmd === "pull" ? "pulling" : "pushing",
                  ctx.streams.stderr,
                  ctx.isTTY,
              )
            : new NoopReporter();

    const http =
        ctx.httpClient ?? new FetchHttpClient({ timeoutMs: config.timeoutMs });
    const deps: CliDeps = {
        client: new ConfluenceClient(http, {
            host: config.host,
            account: config.account,
            token: config.token,
        }),
        fs: ctx.fs,
        yaml,
        config,
        reporter,
        dirs: runtimeDirs(config),
        mintLocalId: () => randomUUID(),
    };

    let result: CommandResult;
    try {
        result = await runCommand(ctx, cmd, deps, flags);
    } catch (err) {
        result = { out: "", error: asError(err) };
    } finally {
        reporter.finish();
    }
    return report(ctx, result);
}

/** runCommand dispatches to the selected command's orchestration. */
function runCommand(
    ctx: MainCtx,
    cmd: ConfigCommand,
    deps: CliDeps,
    flags: ConfigFlags,
): Promise<CommandResult> {
    const promptOpts = {
        syncRoot: deps.config.syncRoot,
        isTTY: ctx.stdinIsTTY ?? ctx.isTTY,
        yes: flags.yes,
        err: (t: string) => ctx.streams.stderr.write(t),
        ask: ctx.ask,
        keys:
            ctx.keys ??
            ((): KeySource => {
                throw new Error("no interactive keyboard input available");
            }),
        markNever: (dest: string) => markIgnorePush(deps.fs, dest),
    };
    switch (cmd) {
        case "test":
            return runTest(deps);
        case "pull":
            return runPull(
                deps,
                flags.page,
                flags.overwrite
                    ? (names) => confirmOverwrite(names, promptOpts)
                    : null,
            );
        case "push":
            return runPush(
                deps,
                flags.page,
                (cands) => confirmCreates(cands, promptOpts),
                flags.force,
                flags.dropComments,
            );
        case "status":
            return runStatus(
                deps,
                flags.page,
                flags.ignored,
                flags.interactive
                    ? {
                          select: (rows) => {
                              if (!promptOpts.isTTY) {
                                  throw new Error(
                                      "status -i needs an interactive terminal",
                                  );
                              }
                              return runSelect(
                                  rows,
                                  promptOpts.keys(),
                                  promptOpts.err,
                              );
                          },
                          confirm: (names) =>
                              confirmOverwrite(names, promptOpts),
                      }
                    : null,
            );
        case "gc":
            return runGc(deps, flags.prune);
        case "clean":
            return runClean(deps, (items) => confirmStale(items, promptOpts));
    }
}

/**
 * parseFlags parses a command's flags into {@link ConfigFlags}, or returns `"help"`
 * when `-h/--help` was given and `"error"` (message already on stderr) on a bad
 * flag or too many page arguments.
 */
function parseFlags(
    ctx: MainCtx,
    cmd: ConfigCommand,
    args: string[],
): ConfigFlags | "help" | "error" {
    const withPage = cmd === "pull" || cmd === "push" || cmd === "status";
    const withSyncRoot = cmd !== "test";
    // Register only the flags the command documents, so an irrelevant flag
    // (e.g. `gc --yes`, `pull --force`) is rejected rather than silently ignored.
    const options: ParseArgsOptionsConfig = {
        config: { type: "string" },
        env: { type: "string" },
        help: { type: "boolean", short: "h" },
    };
    if (withSyncRoot) {
        options["sync-root"] = { type: "string" };
    }
    if (cmd === "push" || cmd === "clean" || cmd === "pull") {
        options["yes"] = { type: "boolean" };
    }
    if (cmd === "pull") {
        options["overwrite"] = { type: "boolean" };
    }
    if (cmd === "push") {
        options["force"] = { type: "boolean" };
        options["drop-comments"] = { type: "boolean" };
    }
    if (cmd === "gc") {
        options["prune"] = { type: "boolean" };
    }
    if (cmd === "status") {
        options["ignored"] = { type: "boolean" };
        options["interactive"] = { type: "boolean", short: "i" };
        options["yes"] = { type: "boolean" };
    }
    try {
        const { values, positionals } = parseArgs({
            args,
            allowPositionals: true,
            options,
        });
        // The conditional `options` widens `values` to the loose index-signature
        // shape; narrow it back to the flags this command may set.
        const v = values as {
            config?: string;
            env?: string;
            "sync-root"?: string;
            yes?: boolean;
            prune?: boolean;
            force?: boolean;
            "drop-comments"?: boolean;
            ignored?: boolean;
            overwrite?: boolean;
            interactive?: boolean;
            help?: boolean;
        };
        if (v.help === true) {
            return "help";
        }
        if (positionals.length > (withPage ? 1 : 0)) {
            ctx.streams.stderr.write(
                `cfsync: ${cmd} accepts at most one page\n`,
            );
            return "error";
        }
        return {
            config: v.config ?? "",
            env: v.env ?? "",
            syncRoot: withSyncRoot ? (v["sync-root"] ?? "") : "",
            yes: v.yes === true,
            prune: v.prune === true,
            force: cmd === "push" ? v.force === true : false,
            dropComments: cmd === "push" ? v["drop-comments"] === true : false,
            ignored: v.ignored === true,
            overwrite: v.overwrite === true,
            interactive: v.interactive === true,
            page: withPage ? (positionals[0] ?? "") : "",
        };
    } catch (err) {
        ctx.streams.stderr.write(`cfsync: ${asError(err).message}\n`);
        return "error";
    }
}

/** runHelp prints the top-level usage, or a command's usage, to stdout. */
function runHelp(ctx: MainCtx, args: string[]): number {
    const topic = args[0];
    if (topic === undefined) {
        ctx.streams.stdout.write(USAGE);
        return EXIT_OK;
    }
    const usage = (COMMAND_USAGE as Record<string, string>)[topic];
    if (usage === undefined) {
        ctx.streams.stderr.write(`cfsync: unknown command: ${topic}\n`);
        return EXIT_ERR;
    }
    ctx.streams.stdout.write(usage);
    return EXIT_OK;
}

/**
 * report writes a command's output to stdout and its error to stderr, and returns
 * the process code: {@link EXIT_ERR} when the command errored, else {@link EXIT_OK}.
 */
function report(ctx: MainCtx, result: CommandResult): number {
    if (result.out !== "") {
        ctx.streams.stdout.write(result.out);
    }
    if (result.error !== null) {
        ctx.streams.stderr.write(`cfsync: ${result.error.message}\n`);
        return EXIT_ERR;
    }
    return EXIT_OK;
}

/** asError coerces an unknown thrown value to an Error. */
function asError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// Usage text (cfsync-native naming).
// ---------------------------------------------------------------------------

const FLAGS_CONFIG_ENV =
    "  --config <path>     Configuration file path (default ./.cfsync.yaml).\n" +
    "  --env <path>        Path to the .env file (default ./.env).\n";

const FLAGS_COMMON =
    FLAGS_CONFIG_ENV +
    "  --sync-root <path>  Folder pages sync under; overrides CFSYNC_ROOT.\n";

const USAGE =
    "cfsync — sync Confluence content to local Markdown files.\n" +
    "\n" +
    "Usage:\n" +
    "  cfsync <command> [flags] [page]\n" +
    "\n" +
    "Commands:\n" +
    "  test      Verify authenticated access to the Atlassian Site.\n" +
    "  pull      Pull configured pages, folders, and spaces into the cache.\n" +
    "  push      Push edited Markdown back to Confluence.\n" +
    "  status    Show what a push would send and a pull would bring.\n" +
    "  gc        List orphaned files in the shared _cfsync-media directory.\n" +
    "  clean     Remove local files no longer in Confluence.\n" +
    "  version   Print the program version.\n" +
    "  help      Print this help, or help for a command.\n" +
    "\n" +
    'Run "cfsync help <command>" for a command\'s details and flags.\n';

const COMMAND_USAGE: Record<ConfigCommand, string> = {
    test:
        "cfsync test — verify authenticated access to the Atlassian Site.\n" +
        "\nUsage:\n  cfsync test [flags]\n\nFlags:\n" +
        FLAGS_CONFIG_ENV,
    pull:
        "cfsync pull — pull pages into the ADF cache.\n" +
        "\nUsage:\n  cfsync pull [flags] [page]\n" +
        "\n" +
        "Pull configured pages, and the pages of configured folders and spaces,\n" +
        "into the ADF cache. With a [page] argument — a sync-root-relative or\n" +
        "absolute path to one managed .md file — pull only that page.\n" +
        "\n" +
        "Pull never loses a local edit: it three-way merges it with the\n" +
        "Confluence version. With --overwrite and a [page], the note is instead\n" +
        "replaced with its Confluence version, discarding its local edits, after\n" +
        "a confirmation (add --yes to skip it).\n" +
        "\nFlags:\n" +
        FLAGS_COMMON +
        "  --overwrite         Replace [page] with its Confluence version.\n" +
        "  --yes               Overwrite without asking.\n",
    push:
        "cfsync push — push edited Markdown back to Confluence.\n" +
        "\nUsage:\n  cfsync push [flags] [page]\n" +
        "\n" +
        "Push edited Markdown back to Confluence. With a [page] argument, push\n" +
        "only that managed page. A new .md file under a folder or space root\n" +
        "(title but no page_id) is created only when you tick it in a checkbox\n" +
        "list, restricted to you. Each new note starts unticked: mark it create,\n" +
        "leave it to be asked about next push, or mark it never (writes\n" +
        "cfsync-plugin: ignore-push to its frontmatter). Add --yes to create\n" +
        "every new note without the list.\n" +
        "\nFlags:\n" +
        FLAGS_COMMON +
        "  --yes               Create new pages without asking.\n" +
        "  --force             Repush pages whose ADF changed even if the Markdown did not.\n" +
        "  --drop-comments     Detach open inline comments an edit rewrote, not move them.\n",
    status:
        "cfsync status — show what a push would send and a pull would bring.\n" +
        "\nUsage:\n  cfsync status [flags] [path]\n" +
        "\n" +
        "Report every managed page, like git status, in three sections: To push\n" +
        "(new notes, notes whose push would change the page, and notes a push\n" +
        "would refuse, with the reason), To pull (pages Confluence moved ahead of\n" +
        "the local base), and Diverged (both). A note counts as changed only when\n" +
        "a push would actually change its page. With [path] — a note or a\n" +
        "directory under the sync root — report only notes at or under it. A base\n" +
        "version missing from the cache is fetched and cached. Fails when\n" +
        "Confluence cannot be reached; exits 0 otherwise, changes pending or not.\n" +
        "\nFlags:\n" +
        FLAGS_COMMON +
        "  --ignored           Also list notes push never touches (ignore-push).\n" +
        "  -i, --interactive   Pick an action per row, then apply them: push,\n" +
        "                      pull, create, never push, stop ignoring, or\n" +
        "                      overwrite from Confluence (asks first).\n" +
        "  --yes               With -i, overwrite without asking.\n",
    gc:
        "cfsync gc — list orphaned files in the shared _cfsync-media directory.\n" +
        "\nUsage:\n  cfsync gc [flags]\n" +
        "\n" +
        "List orphaned files in the shared _cfsync-media directory (those no page\n" +
        "references), and ADF cache entries of notes that no longer exist (left\n" +
        "by a local move or delete). Add --prune to delete them.\n" +
        "\nFlags:\n" +
        FLAGS_COMMON +
        "  --prune             Delete the orphaned asset and cache files.\n",
    clean:
        "cfsync clean — remove local files no longer in Confluence.\n" +
        "\nUsage:\n  cfsync clean [flags]\n" +
        "\n" +
        "Remove local files under configured folder and space roots that no\n" +
        "longer exist in Confluence. Prompts for confirmation; add --yes to\n" +
        "delete without asking.\n" +
        "\nFlags:\n" +
        FLAGS_COMMON +
        "  --yes               Delete without asking.\n",
};
