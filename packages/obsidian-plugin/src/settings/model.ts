// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's configuration model and its pure mapping onto the core's
// `buildConfig`. This module reads no files, no environment, and no Obsidian
// runtime — the settings tab and store supply the persisted values, and this
// module only shapes them into a `RawConfig` + `Secrets` and validates via the
// core. Kept free of `obsidian` value imports so it unit-tests under vitest.

import { buildConfig, type Config } from "@cfsync/core";

/**
 * cfsyncSettings is the shareable configuration persisted to the plugin's
 * `data.json`. The API token is NOT part of it — it is a per-device secret held
 * in localStorage — so this object is safe to sync between devices.
 */
export interface cfsyncSettings {
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
    /** Destination `*.md` file → Confluence page source. */
    pages: Record<string, string>;
    /** Destination directory → Confluence folder source. */
    folders: Record<string, string>;
    /** Destination directory → Confluence space source. */
    spaces: Record<string, string>;
}

/** DEFAULT_SETTINGS is the configuration a freshly installed plugin starts with. */
export const DEFAULT_SETTINGS: cfsyncSettings = {
    site: "",
    account: "",
    syncRoot: "",
    timeoutSeconds: 30,
    margin: 0,
    flavor: "obsidian",
    pages: {},
    folders: {},
    spaces: {},
};

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
