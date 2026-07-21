// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The live-test harness, ported from live_test.go. It loads the CFSYNC_TEST_*
// credentials (from the environment, then the repo-root .env), gates the suites
// so they skip when unset, builds a ConfluenceClient for seeding/verification,
// and drives the CLI main() against the real Site exactly as e2e.test.ts drives
// it against the MSW fake.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfluenceClient, type Streams } from "@cfsync/core";
import { parse as parseYaml } from "yaml";
import { NodeEnv } from "../../../src/adapters/env.ts";
import { NodeFS } from "../../../src/adapters/fs.ts";
import { FetchHttpClient } from "../../../src/adapters/http.ts";
import { main } from "../../../src/main.ts";

/** LiveEnv is the live-test target read from the environment. */
export interface LiveEnv {
    host: string;
    account: string;
    token: string;
    /** Space key the mutating tests create/delete throwaway pages in. */
    space: string;
    /** Optional parent folder id; "" parents created pages to the space root. */
    folder: string;
    /** Optional comma-separated page ids for the read-only explore probe. */
    explore: string;
}

const REPO_ROOT = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "..",
);

/**
 * siteFromHost reduces the live target's Site base URL (the `CFSYNC_TEST_HOST`
 * full URL the harness reads) to the bare subdomain the production `CFSYNC_SITE`
 * now expects, e.g. `https://ex.atlassian.net` → `ex`. seedClient still uses the
 * full URL, so the live-test contract and the repo `.env` stay unchanged.
 */
function siteFromHost(host: string): string {
    return host.replace(/^https?:\/\//, "").replace(/\.atlassian\.net.*$/, "");
}

/** stripQuotes removes one layer of surrounding single or double quotes. */
function stripQuotes(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        if ((first === '"' || first === "'") && s[s.length - 1] === first) {
            return s.slice(1, -1);
        }
    }
    return s;
}

/**
 * dotenv reads the repo-root .env into a key→value map. Missing file yields an
 * empty map. It is a minimal synchronous reader (not the CLI's async loadEnvFile)
 * because the skip gate must resolve at collection time.
 */
function dotenv(): Record<string, string> {
    const out: Record<string, string> = {};
    let text: string;
    try {
        text = readFileSync(join(REPO_ROOT, ".env"), "utf8");
    } catch {
        return out;
    }
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const eq = line.indexOf("=");
        if (eq < 0) {
            continue;
        }
        out[line.slice(0, eq).trim()] = stripQuotes(line.slice(eq + 1).trim());
    }
    return out;
}

/** value reads a var from the process env, falling back to the .env map. */
function value(
    key: string,
    env: NodeJS.ProcessEnv,
    file: Record<string, string>,
): string {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv !== "") {
        return fromEnv;
    }
    return file[key] ?? "";
}

/**
 * loadLiveEnv reads the CFSYNC_TEST_* target from the environment, then the
 * repo-root .env (an exported value wins). It returns null — the signal to skip —
 * when host, account, token, or space is unset.
 */
export function loadLiveEnv(): LiveEnv | null {
    const file = dotenv();
    const host = value("CFSYNC_TEST_HOST", process.env, file);
    const account = value("CFSYNC_TEST_ACCOUNT", process.env, file);
    const token = value("CFSYNC_TEST_TOKEN", process.env, file);
    const space = value("CFSYNC_TEST_SPACE", process.env, file);
    if (host === "" || account === "" || token === "" || space === "") {
        return null;
    }
    return {
        host,
        account,
        token,
        space,
        folder: value("CFSYNC_TEST_FOLDER", process.env, file),
        explore: value("CFSYNC_TEST_EXPLORE_PAGES", process.env, file),
    };
}

/** liveConfigured reports whether the live credentials are present. */
export function liveConfigured(): boolean {
    return loadLiveEnv() !== null;
}

/**
 * requireEnv returns the live target for a suite guarded by
 * `describe.skipIf(!liveConfigured())`. When the credentials are absent it
 * returns a placeholder with empty fields rather than throwing: Vitest runs a
 * `describe` body at collection time even when `skipIf` will skip every test in
 * it, so throwing here would fail collection instead of skipping. The
 * placeholder only ever feeds `seedClient` (a side-effect-free constructor) and
 * never reaches a network call, because the guard skips all the suite's tests.
 */
export function requireEnv(): LiveEnv {
    return (
        loadLiveEnv() ?? {
            host: "",
            account: "",
            token: "",
            space: "",
            folder: "",
            explore: "",
        }
    );
}

/** seedClient builds a ConfluenceClient for seeding, teardown, and verification. */
export function seedClient(env: LiveEnv): ConfluenceClient {
    return new ConfluenceClient(new FetchHttpClient({ timeoutMs: 60_000 }), {
        host: env.host,
        account: env.account,
        token: env.token,
    });
}

/** RunResult is a CLI invocation's exit code and captured streams. */
export interface RunResult {
    code: number;
    out: string;
    err: string;
}

/**
 * makeRun returns an e2e-style driver that runs the CLI main() with the real
 * fetch adapter against the live Site, mapping the CFSYNC_TEST_* credentials
 * onto the production CFSYNC_* names and rooting the sync at `dir`.
 */
export function makeRun(
    env: LiveEnv,
    dir: string,
): (argv: string[]) => Promise<RunResult> {
    return async (argv) => {
        let out = "";
        let err = "";
        const streams: Streams = {
            stdin: { readAll: () => "" },
            stdout: {
                write: (t) => {
                    out += t;
                },
            },
            stderr: {
                write: (t) => {
                    err += t;
                },
            },
        };
        const nodeEnv = new NodeEnv({
            CFSYNC_SITE: siteFromHost(env.host),
            CFSYNC_ACCOUNT: env.account,
            CFSYNC_TOKEN: env.token,
            CFSYNC_ROOT: dir,
        });
        const code = await main({
            argv,
            streams,
            env: nodeEnv,
            fs: new NodeFS(),
            clock: () => new Date(1_000_000),
            isTTY: false,
            ask: () => Promise.resolve("y"),
            yaml: { parse: parseYaml },
        });
        return { code, out, err };
    };
}

/** mustValue returns a non-null value or throws a labelled error. */
export function mustValue<T>(v: T | null | undefined, what: string): T {
    if (v === null || v === undefined) {
        throw new Error(`live setup: ${what} was empty`);
    }
    return v;
}
