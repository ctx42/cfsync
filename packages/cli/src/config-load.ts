// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Configuration loading for the CLI, ported from the file/env half of
// `pkg/cfsync/config.go` and adapted to the cfsync-native naming. The shared,
// committable config lives in `.cfsync.yaml` (timeout + the page/folder/space
// maps); the secrets — Site subdomain, account, API token, and the sync-root folder —
// come only from the environment or a `.env` file, never the YAML, so the config
// can be shared while the credentials stay per-device. This module reads and maps
// those sources, then hands the pure {@link buildConfig} a `RawConfig` plus the
// injected {@link Secrets}; validation, resolution, and the scope guard are its
// job. File reads go through the injected {@link FileSystem} so it stays testable.

import {
    buildConfig,
    type Config,
    type FileSystem,
    posixClean,
    posixDir,
    posixJoin,
    type Yaml,
} from "@cfsync/core";
import type { NodeEnv } from "./adapters/env.ts";

/** The config file read when `--config` is absent. */
export const CONFIG_FILE = ".cfsync.yaml";
/** The dotenv file read when `--env` is absent. */
export const ENV_FILE = ".env";
/** The device-local ADF cache directory, under the sync root. */
export const CACHE_DIR = ".adf_cache";
/** The shared image-assets directory, under the sync root. */
export const ASSETS_DIR = "_cfsync-media";
/** The link-index file, under the cache directory. */
export const LINKS_FILE = "links.json";

/** The environment variables carrying the injected secrets. */
export const ENV_SITE = "CFSYNC_SITE";
export const ENV_ACCOUNT = "CFSYNC_ACCOUNT";
export const ENV_TOKEN = "CFSYNC_TOKEN";
export const ENV_SYNC_ROOT = "CFSYNC_ROOT";

/** The YAML keys that must never appear in the shared config file. */
const FORBIDDEN_KEYS = [
    "site",
    "host",
    "account",
    "token",
    "sync_root",
    "work_dir",
];

/** RuntimeDirs are the derived per-run paths under the sync root. */
export interface RuntimeDirs {
    /** The ADF cache directory (`<syncRoot>/.adf_cache`). */
    cacheDir: string;
    /** The shared assets directory (`<syncRoot>/_cfsync-media`). */
    assetsDir: string;
    /** The link-index path (`<cacheDir>/links.json`). */
    linksPath: string;
}

/**
 * runtimeDirs derives the ADF cache, assets, and link-index paths a run needs from
 * a resolved {@link Config}. They are fixed sub-paths of the sync root, so every
 * command computes them the same way.
 */
export function runtimeDirs(config: Config): RuntimeDirs {
    const cacheDir = posixJoin(config.syncRoot, CACHE_DIR);
    return {
        cacheDir,
        assetsDir: posixJoin(config.syncRoot, ASSETS_DIR),
        linksPath: posixJoin(cacheDir, LINKS_FILE),
    };
}

/**
 * loadConfig reads the YAML config at `configPath` (or {@link CONFIG_FILE} when
 * empty), rejects any secret key set there, gathers the secrets from `env`, and
 * builds a resolved {@link Config}. The YAML text is parsed through the injected
 * {@link Yaml} port (Bun's parser in the binary, the `yaml` package in tests). A
 * relative sync root anchors to the config file's directory, matching how page
 * paths resolve against it. It throws, naming the first problem, on a
 * missing/invalid file or an invalid config.
 */
export async function loadConfig(
    fs: FileSystem,
    env: NodeEnv,
    yaml: Yaml,
    configPath: string,
): Promise<Config> {
    const path = configPath || CONFIG_FILE;

    let text: string;
    try {
        text = await fs.readText(path);
    } catch (err) {
        throw new Error(`reading config: ${message(err)}`);
    }

    let raw: unknown;
    try {
        raw = yaml.parse(text);
    } catch (err) {
        throw new Error(`parsing config: ${message(err)}`);
    }
    const obj = isObject(raw) ? raw : {};
    rejectForbiddenKeys(obj);

    const syncRoot = resolveSyncRoot(env.get(ENV_SYNC_ROOT), path);
    const markdown = isObject(obj["markdown"]) ? obj["markdown"] : {};
    return buildConfig(
        {
            timeoutMs: durationMs(obj["timeout"]),
            margin: markdown["margin"],
            flavor: markdown["flavor"],
            pages: obj["pages"],
            folders: obj["folders"],
            spaces: obj["spaces"],
        },
        {
            site: env.get(ENV_SITE),
            account: env.get(ENV_ACCOUNT),
            token: env.get(ENV_TOKEN),
            syncRoot,
        },
    );
}

/**
 * loadEnvFile reads `KEY=VALUE` lines from the dotenv file at `path` (or
 * {@link ENV_FILE} when empty) into `env`, setting only variables `env` does not
 * already have a non-empty value for, so a process-environment value always wins.
 * A missing file is an error only when `explicit`; otherwise it is ignored so the
 * secrets may come from the process environment. Blank lines and `#` comments are
 * skipped, the value is split on the first `=`, and surrounding quotes are stripped.
 */
export async function loadEnvFile(
    fs: FileSystem,
    env: NodeEnv,
    path: string,
    explicit: boolean,
): Promise<void> {
    const file = path || ENV_FILE;

    let text: string;
    try {
        text = await fs.readText(file);
    } catch (err) {
        if (!explicit && !(await fs.exists(file))) {
            return; // default file absent: fall back to the process environment
        }
        throw new Error(`reading env file: ${message(err)}`);
    }

    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const eq = line.indexOf("=");
        if (eq < 0) {
            continue;
        }
        const key = line.slice(0, eq).trim();
        const val = stripQuotes(line.slice(eq + 1).trim());
        if (key !== "") {
            env.setDefault(key, val);
        }
    }
}

/**
 * envFilePath returns the dotenv path to load and whether it was requested
 * explicitly. A non-empty `envPath` (the `--env` flag) is used as given and is
 * explicit, so a missing file is an error. Otherwise the default `.env` sits
 * beside the config file — where `configPath` is empty it is {@link CONFIG_FILE} —
 * so it resolves against the config the way the sync root and page paths do; that
 * default is not explicit, so a missing file is ignored.
 */
export function envFilePath(
    configPath: string,
    envPath: string,
): { path: string; explicit: boolean } {
    if (envPath !== "") {
        return { path: envPath, explicit: true };
    }
    const base = configPath || CONFIG_FILE;
    return { path: posixJoin(posixDir(base), ENV_FILE), explicit: false };
}

/** resolveSyncRoot cleans the sync root, anchoring a relative value to the config dir. */
function resolveSyncRoot(value: string, configPath: string): string {
    if (value === "") {
        return ""; // buildConfig reports the missing secret
    }
    if (value.startsWith("/")) {
        return posixClean(value);
    }
    return posixClean(posixJoin(posixDir(configPath), value));
}

/** rejectForbiddenKeys throws when the config file sets a secret key. */
function rejectForbiddenKeys(obj: Record<string, unknown>): void {
    for (const key of FORBIDDEN_KEYS) {
        if (key in obj) {
            throw new Error(
                `config: "${key}" must not be set in the config file`,
            );
        }
    }
}

/**
 * durationMs parses a Go-style duration string (`"30s"`, `"1m30s"`, `"500ms"`) to
 * milliseconds. A bare number is read as seconds. `0`/absent/unparseable yields 0,
 * which selects the default timeout downstream.
 */
function durationMs(value: unknown): number {
    if (typeof value === "number") {
        return Math.max(0, Math.trunc(value * 1000));
    }
    if (typeof value !== "string" || value.trim() === "") {
        return 0;
    }
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
    const units: Record<string, number> = {
        ms: 1,
        s: 1000,
        m: 60_000,
        h: 3_600_000,
    };
    let total = 0;
    let matched = false;
    for (const m of value.matchAll(re)) {
        matched = true;
        total += Number(m[1]) * (units[m[2] ?? ""] ?? 0);
    }
    return matched ? Math.trunc(total) : 0;
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

/** isObject narrows a parsed YAML value to a plain record. */
function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
