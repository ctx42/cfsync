// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    buildPluginConfig,
    type cfsyncSettings,
    DEFAULT_SETTINGS,
} from "../../src/settings/model.ts";

function valid(overrides: Partial<cfsyncSettings> = {}): cfsyncSettings {
    return {
        ...DEFAULT_SETTINGS,
        site: "ex",
        account: "you@example.com",
        ...overrides,
    };
}

describe("buildPluginConfig", () => {
    it("maps defaults and injects the token", () => {
        const config = buildPluginConfig(valid(), "secret-token");
        expect(config.host).toBe("https://ex.atlassian.net");
        expect(config.account).toBe("you@example.com");
        expect(config.token).toBe("secret-token");
        expect(config.flavor).toBe("obsidian");
        expect(config.margin).toBe(0);
    });

    it("resolves an empty sync root to the vault root", () => {
        const config = buildPluginConfig(valid({ syncRoot: "" }), "t");
        expect(config.syncRoot).toBe(".");
    });

    it("converts timeout seconds to milliseconds", () => {
        const config = buildPluginConfig(valid({ timeoutSeconds: 45 }), "t");
        expect(config.timeoutMs).toBe(45_000);
    });

    it("resolves page destinations under the sync root", () => {
        const config = buildPluginConfig(
            valid({ pages: { "notes/a.md": "/wiki/spaces/T/pages/1" } }),
            "t",
        );
        expect(config.pages["notes/a.md"]).toBe("/wiki/spaces/T/pages/1");
    });

    it("propagates an invalid site subdomain error", () => {
        expect(() =>
            buildPluginConfig(valid({ site: "https://ex.atlassian.net" }), "t"),
        ).toThrow(/bare subdomain/);
    });

    it("propagates a duplicate-destination error", () => {
        expect(() =>
            buildPluginConfig(
                valid({ pages: { "a.md": "s1", "./a.md": "s2" } }),
                "t",
            ),
        ).toThrow(/same destination/);
    });

    it("propagates an unknown-flavor error", () => {
        expect(() => buildPluginConfig(valid({ flavor: "nope" }), "t")).toThrow(
            /flavor/,
        );
    });
});
