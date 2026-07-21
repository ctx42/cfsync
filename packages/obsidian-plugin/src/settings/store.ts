// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Persistence for the plugin's configuration. The shareable settings live in the
// plugin's `data.json` (via Obsidian's `loadData`/`saveData`); the API token is a
// per-device secret kept out of that file, in per-vault localStorage (via
// `app.loadLocalStorage`/`saveLocalStorage`), so a synced `data.json` never
// carries the credential. Only methods on the injected `plugin` are used, so this
// module needs no Obsidian value import and is testable with a fake.

import type { Plugin } from "obsidian";

import { type cfsyncSettings, DEFAULT_SETTINGS } from "./model.ts";

/** TOKEN_KEY is the per-vault localStorage key the API token is stored under. */
export const TOKEN_KEY = "cfsync-token";

/**
 * loadSettings reads the persisted settings from `data.json` and layers them over
 * {@link DEFAULT_SETTINGS}, so a partial or absent file still yields a complete,
 * valid settings object (new fields added in later versions default cleanly).
 */
export async function loadSettings(plugin: Plugin): Promise<cfsyncSettings> {
    const data = (await plugin.loadData()) as Partial<cfsyncSettings> | null;
    return { ...DEFAULT_SETTINGS, ...(data ?? {}) };
}

/** saveSettings writes the settings to `data.json`. The token is not included. */
export async function saveSettings(
    plugin: Plugin,
    settings: cfsyncSettings,
): Promise<void> {
    await plugin.saveData(settings);
}

/** loadToken reads the API token from per-vault localStorage, or `""` when unset. */
export function loadToken(plugin: Plugin): string {
    const value = plugin.app.loadLocalStorage(TOKEN_KEY);
    return typeof value === "string" ? value : "";
}

/**
 * saveToken writes the API token to per-vault localStorage, clearing the entry
 * (storing `null`) when the token is empty so no stale secret lingers.
 */
export function saveToken(plugin: Plugin, token: string): void {
    plugin.app.saveLocalStorage(TOKEN_KEY, token === "" ? null : token);
}
