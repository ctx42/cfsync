// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Obsidian plugin's settings model — the shape of its `data.json` — and its
// pure mapping onto `buildConfig`. It lives in core, not the plugin, because the
// CLI reads the same `data.json` when it runs inside a vault: one model and one
// parser keep the two hosts from drifting. `data.json` carries a schema version
// so an older reader refuses a newer file instead of silently misreading it.
// Reads no files and no environment; the hosts supply the parsed JSON.

import { buildConfig, type Config } from "./config.ts";

/**
 * SETTINGS_SCHEMA_VERSION is the `data.json` schema version this build writes and
 * the newest it can read. Bump it on any change an older reader would misread.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * cfsyncSettings is the shareable configuration persisted to the plugin's
 * `data.json`. The API token is NOT part of it — it is a per-device secret kept
 * outside the vault — so this object is safe to sync between devices.
 */
export interface cfsyncSettings {
    /** The `data.json` schema version; see {@link SETTINGS_SCHEMA_VERSION}. */
    schemaVersion: number;
    /** Bare Atlassian Site subdomain, e.g. `your-site` (no scheme). */
    site: string;
    /** Atlassian account email (Basic-auth username). */
    account: string;
    /** Vault-relative sync-root subfolder; `""` means the whole vault (`.`). */
    syncRoot: string;
    /** Per-request HTTP timeout in seconds; mapped to `timeoutMs`. */
    timeoutSeconds: number;
    /** Column to hard-wrap Markdown block text at; 0 means no wrapping. */
    margin: number;
    /** Markdown flavor id driving ADF↔Markdown conversion. */
    flavor: string;
    /**
     * Whether a pull fetches each page's Confluence comments and renders them as
     * `[!comment]` callouts with `[^cf-…]` anchors (and a push writes replies and
     * resolutions back). Off by default.
     */
    comments: boolean;
    /** Destination `*.md` file → Confluence page source. */
    pages: Record<string, string>;
    /** Destination directory → Confluence folder source. */
    folders: Record<string, string>;
    /** Destination directory → Confluence space source. */
    spaces: Record<string, string>;
}

/** DEFAULT_SETTINGS is the configuration a freshly installed plugin starts with. */
export const DEFAULT_SETTINGS: cfsyncSettings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    site: "",
    account: "",
    syncRoot: "",
    timeoutSeconds: 30,
    margin: 0,
    flavor: "obsidian",
    comments: false,
    pages: {},
    folders: {},
    spaces: {},
};

/**
 * mergeSettings layers parsed `data.json` content over {@link DEFAULT_SETTINGS},
 * so a partial or absent file still yields a complete settings object (fields
 * added in later versions default cleanly). A file without `schemaVersion`
 * predates the field and reads as version 1. It does not check the version; see
 * {@link parseSettings}.
 */
export function mergeSettings(data: unknown): cfsyncSettings {
    const obj = isRecord(data) ? (data as Partial<cfsyncSettings>) : {};
    return { ...DEFAULT_SETTINGS, schemaVersion: 1, ...obj };
}

/** SettingsVersionError is thrown for a `data.json` newer than this build reads. */
export class SettingsVersionError extends Error {
    /** The version found in the file. */
    readonly version: number;
    /** The newest version this build reads. */
    readonly supported: number;

    constructor(version: number) {
        super(
            `settings: schema version ${version} is newer than this cfsync ` +
                `supports (${SETTINGS_SCHEMA_VERSION}); upgrade cfsync`,
        );
        this.name = "SettingsVersionError";
        this.version = version;
        this.supported = SETTINGS_SCHEMA_VERSION;
    }
}

/**
 * parseSettings is {@link mergeSettings} plus the schema-version check: it throws
 * when `schemaVersion` is not a positive integer, and throws
 * {@link SettingsVersionError} when it is newer than
 * {@link SETTINGS_SCHEMA_VERSION}. Every older version still parses.
 */
export function parseSettings(data: unknown): cfsyncSettings {
    const settings = mergeSettings(data);
    const v = settings.schemaVersion;
    if (!Number.isInteger(v) || v < 1) {
        throw new Error(`settings: invalid schemaVersion ${JSON.stringify(v)}`);
    }
    if (v > SETTINGS_SCHEMA_VERSION) {
        throw new SettingsVersionError(v);
    }
    return settings;
}

/**
 * buildPluginConfig assembles the settings plus the injected token into the
 * core's `RawConfig` + `Secrets` and resolves them through `buildConfig`,
 * returning the validated {@link Config} or throwing the first problem it names
 * (invalid site subdomain, duplicate/escaping destination, `.md` rule, unknown
 * flavor, missing secret). An empty sync root resolves to the vault root `.`.
 */
export function buildPluginConfig(
    settings: cfsyncSettings,
    token: string,
): Config {
    return buildConfig(
        {
            timeoutMs: settings.timeoutSeconds * 1000,
            margin: settings.margin,
            flavor: settings.flavor,
            comments: settings.comments,
            pages: settings.pages,
            folders: settings.folders,
            spaces: settings.spaces,
        },
        {
            site: settings.site,
            account: settings.account,
            token,
            syncRoot: settings.syncRoot || ".",
        },
    );
}

/** isRecord narrows a value to a plain object (not an array, not null). */
function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
