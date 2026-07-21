// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { Plugin } from "obsidian";
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../../src/settings/model.ts";
import {
    loadSettings,
    loadToken,
    saveSettings,
    saveToken,
    TOKEN_KEY,
} from "../../src/settings/store.ts";

/** fakePlugin is a minimal stand-in for the parts of Plugin the store touches. */
function fakePlugin(data: unknown = null) {
    const local = new Map<string, unknown>();
    let saved: unknown = data;
    const plugin = {
        loadData: async () => saved,
        saveData: async (d: unknown) => {
            saved = d;
        },
        app: {
            loadLocalStorage: (k: string) => local.get(k) ?? null,
            saveLocalStorage: (k: string, v: unknown) => {
                if (v === null) {
                    local.delete(k);
                } else {
                    local.set(k, v);
                }
            },
        },
    };
    return plugin as unknown as Plugin;
}

describe("settings store", () => {
    it("merges saved data over the defaults", async () => {
        const plugin = fakePlugin({ site: "ex", margin: 80 });
        const settings = await loadSettings(plugin);
        expect(settings.site).toBe("ex");
        expect(settings.margin).toBe(80);
        expect(settings.flavor).toBe(DEFAULT_SETTINGS.flavor);
    });

    it("returns the defaults when there is no saved data", async () => {
        const settings = await loadSettings(fakePlugin(null));
        expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("round-trips settings through saveSettings/loadSettings", async () => {
        const plugin = fakePlugin();
        await saveSettings(plugin, { ...DEFAULT_SETTINGS, account: "me@x" });
        expect((await loadSettings(plugin)).account).toBe("me@x");
    });

    it("round-trips the token through localStorage", () => {
        const plugin = fakePlugin();
        expect(loadToken(plugin)).toBe("");
        saveToken(plugin, "abc");
        expect(loadToken(plugin)).toBe("abc");
        expect(TOKEN_KEY).toBe("cfsync-token");
    });

    it("clears the token when saving an empty string", () => {
        const plugin = fakePlugin();
        saveToken(plugin, "abc");
        saveToken(plugin, "");
        expect(loadToken(plugin)).toBe("");
    });
});
