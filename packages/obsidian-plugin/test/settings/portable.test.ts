// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    type cfsyncSettings,
    DEFAULT_SETTINGS,
} from "../../src/settings/model.ts";
import {
    applyImportedMaps,
    expandTilde,
    PORTABLE_FILE,
    resolvePortablePath,
    toPortableConfig,
} from "../../src/settings/portable.ts";

function settings(over: Partial<cfsyncSettings> = {}): cfsyncSettings {
    return { ...DEFAULT_SETTINGS, ...over };
}

describe("toPortableConfig", () => {
    it("shapes the shareable config and formats the timeout as seconds", () => {
        const out = toPortableConfig(
            settings({
                timeoutSeconds: 45,
                flavor: "gfm",
                margin: 80,
                pages: { "a.md": "/wiki/p" },
                folders: { docs: "/wiki/f" },
                spaces: { team: "/wiki/s" },
            }),
        );
        expect(out).toEqual({
            timeout: "45s",
            markdown: { flavor: "gfm", margin: 80 },
            pages: { "a.md": "/wiki/p" },
            folders: { docs: "/wiki/f" },
            spaces: { team: "/wiki/s" },
        });
    });

    it("never emits secret keys", () => {
        const out = toPortableConfig(settings({ site: "x", account: "y" }));
        expect(Object.keys(out)).toEqual([
            "timeout",
            "markdown",
            "pages",
            "folders",
            "spaces",
        ]);
    });

    it("copies the maps rather than aliasing the settings", () => {
        const s = settings({ pages: { "a.md": "/wiki/p" } });
        const out = toPortableConfig(s);
        out.pages["b.md"] = "/wiki/q";
        expect(s.pages).toEqual({ "a.md": "/wiki/p" });
    });
});

describe("resolvePortablePath", () => {
    it("appends the file name when the target is a folder", () => {
        expect(resolvePortablePath("sync", true)).toBe(`sync/${PORTABLE_FILE}`);
    });

    it("appends the file name for a trailing-slash input", () => {
        expect(resolvePortablePath("sync/", false)).toBe(
            `sync/${PORTABLE_FILE}`,
        );
    });

    it("uses a file path as given (trimmed)", () => {
        expect(resolvePortablePath("  sync/my.yaml  ", false)).toBe(
            "sync/my.yaml",
        );
    });

    it("resolves a '.' folder to the bare file name", () => {
        expect(resolvePortablePath(".", true)).toBe(PORTABLE_FILE);
    });
});

describe("expandTilde", () => {
    it("expands a '~/…' path to the home directory", () => {
        expect(expandTilde("~/sync/.cfsync.yaml", "/home/thor")).toBe(
            "/home/thor/sync/.cfsync.yaml",
        );
    });

    it("expands a bare '~' to the home directory", () => {
        expect(expandTilde("~", "/home/thor")).toBe("/home/thor");
    });

    it("expands a Windows-style '~\\…' path", () => {
        expect(expandTilde("~\\sync", "C:\\Users\\thor")).toBe(
            "C:\\Users\\thor\\sync",
        );
    });

    it("trims surrounding whitespace before expanding", () => {
        expect(expandTilde("  ~/sync  ", "/home/thor")).toBe("/home/thor/sync");
    });

    it("leaves another user's '~name/…' home untouched", () => {
        expect(expandTilde("~other/sync", "/home/thor")).toBe("~other/sync");
    });

    it("leaves an absolute or vault-relative path untouched (trimmed)", () => {
        expect(expandTilde("  /etc/x  ", "/home/thor")).toBe("/etc/x");
        expect(expandTilde("sync/x.yaml", "/home/thor")).toBe("sync/x.yaml");
    });
});

describe("applyImportedMaps", () => {
    it("merges the three maps with incoming winning on a duplicate", () => {
        const base = settings({
            pages: { "a.md": "/old", "keep.md": "/keep" },
            folders: { docs: "/old-folder" },
        });
        const { settings: next, imported } = applyImportedMaps(base, {
            pages: { "a.md": "/new", "b.md": "/added" },
            folders: { docs: "/new-folder" },
            spaces: { team: "/space" },
        });
        expect(next.pages).toEqual({
            "a.md": "/new",
            "keep.md": "/keep",
            "b.md": "/added",
        });
        expect(next.folders).toEqual({ docs: "/new-folder" });
        expect(next.spaces).toEqual({ team: "/space" });
        expect(imported).toBe(4);
    });

    it("drops non-string entries and ignores non-map values", () => {
        const { settings: next, imported } = applyImportedMaps(settings(), {
            pages: { "a.md": "/ok", "bad.md": 7, nested: { x: 1 } },
            folders: "not-a-map",
        });
        expect(next.pages).toEqual({ "a.md": "/ok" });
        expect(next.folders).toEqual({});
        expect(imported).toBe(1);
    });

    it("returns an unchanged copy for a non-object parsed value", () => {
        const base = settings({ pages: { "a.md": "/p" } });
        const { settings: next, imported } = applyImportedMaps(base, "nope");
        expect(next.pages).toEqual({ "a.md": "/p" });
        expect(imported).toBe(0);
        expect(next).not.toBe(base);
    });

    it("leaves flavor, margin, timeout, and secrets untouched", () => {
        const base = settings({
            flavor: "gfm",
            margin: 80,
            timeoutSeconds: 45,
            site: "acme",
            account: "me@ex.com",
        });
        const { settings: next } = applyImportedMaps(base, {
            markdown: { flavor: "obsidian", margin: 0 },
            timeout: "1s",
            pages: { "a.md": "/p" },
        });
        expect(next.flavor).toBe("gfm");
        expect(next.margin).toBe(80);
        expect(next.timeoutSeconds).toBe(45);
        expect(next.site).toBe("acme");
        expect(next.account).toBe("me@ex.com");
    });
});
