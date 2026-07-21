// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { cacheHome } from "../src/cache-home.ts";

// A fixed hash keeps the derived key deterministic; the per-vault property test
// varies it by input.
const base = {
    vaultName: "My Vault",
    vaultPath: "/home/u/vaults/My Vault",
    hash: () => "deadbeefcafe0000",
};

describe("cacheHome", () => {
    it("uses XDG_CACHE_HOME on linux when set", () => {
        expect(
            cacheHome({
                platform: "linux",
                home: "/home/u",
                env: { XDG_CACHE_HOME: "/xdg" },
                ...base,
            }),
        ).toBe("/xdg/cfsync/my-vault-deadbeefcafe");
    });

    it("falls back to ~/.cache on linux without XDG_CACHE_HOME", () => {
        expect(
            cacheHome({
                platform: "linux",
                home: "/home/u",
                env: {},
                ...base,
            }),
        ).toBe("/home/u/.cache/cfsync/my-vault-deadbeefcafe");
    });

    it("uses ~/Library/Caches on macOS", () => {
        expect(
            cacheHome({
                platform: "darwin",
                home: "/Users/u",
                env: {},
                ...base,
            }),
        ).toBe("/Users/u/Library/Caches/cfsync/my-vault-deadbeefcafe");
    });

    it("uses LOCALAPPDATA on windows, normalized to forward slashes", () => {
        expect(
            cacheHome({
                platform: "win32",
                home: "C:\\Users\\u",
                env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
                ...base,
            }),
        ).toBe("C:/Users/u/AppData/Local/cfsync/my-vault-deadbeefcafe");
    });

    it("keys by vault path so two vaults never collide", () => {
        const mk = (vaultPath: string) =>
            cacheHome({
                platform: "linux",
                home: "/h",
                env: {},
                vaultName: "Same Name",
                vaultPath,
                hash: (s) => (s === "/a" ? "aaaaaaaaaaaa11" : "bbbbbbbbbbbb22"),
            });
        expect(mk("/a")).not.toBe(mk("/b"));
    });

    it("sanitizes the vault name into the key and trims stray dashes", () => {
        expect(
            cacheHome({
                platform: "linux",
                home: "/h",
                env: {},
                vaultName: "Wörk/Notes v2!",
                vaultPath: "/p",
                hash: () => "0123456789abcdef",
            }),
        ).toBe("/h/.cache/cfsync/w-rk-notes-v2-0123456789ab");
    });

    it("uses a stable placeholder when the vault name has no usable characters", () => {
        expect(
            cacheHome({
                platform: "linux",
                home: "/h",
                env: {},
                vaultName: "！！！",
                vaultPath: "/p",
                hash: () => "0123456789abcdef",
            }),
        ).toBe("/h/.cache/cfsync/vault-0123456789ab");
    });
});
