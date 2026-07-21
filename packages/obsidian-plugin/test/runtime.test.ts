// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { buildConfig } from "@cfsync/core";
import { describe, expect, it } from "vitest";
// Imports the pure ../src/runtime-dirs.ts, not ../src/runtime.ts: the latter
// also defines buildRuntime, which imports obsidian VALUES (requestUrl,
// parseYaml). obsidian ships types only ("main": ""), so once a module holds
// such an import, resolving that module fails for every test regardless of
// which export is reached — see runtime-dirs.ts's header.
import { runtimeDirs } from "../src/runtime-dirs.ts";

describe("runtimeDirs", () => {
    it("derives cache, assets, and links paths under the sync root", () => {
        const config = buildConfig(
            { pages: {}, folders: {}, spaces: {} },
            { site: "ex", account: "a@b.c", token: "t", syncRoot: "Notes" },
        );
        const d = runtimeDirs(config);
        expect(d.cacheDir).toBe("Notes/.adf_cache");
        expect(d.assetsDir).toBe("Notes/_cfsync-media");
        expect(d.linksPath).toBe("Notes/.adf_cache/links.json");
    });

    it("uses the vault root when the sync root is '.'", () => {
        const config = buildConfig(
            { pages: {}, folders: {}, spaces: {} },
            { site: "ex", account: "a@b.c", token: "t", syncRoot: "." },
        );
        const d = runtimeDirs(config);
        expect(d.cacheDir).toBe(".adf_cache");
        expect(d.linksPath).toBe(".adf_cache/links.json");
    });

    it("roots cache and links at an explicit cacheRoot, leaving assets under the sync root", () => {
        const config = buildConfig(
            { pages: {}, folders: {}, spaces: {} },
            { site: "ex", account: "a@b.c", token: "t", syncRoot: "Notes" },
        );
        const root = "/home/u/.cache/cfsync/vault-abc123";
        const d = runtimeDirs(config, root);
        expect(d.cacheDir).toBe(root);
        expect(d.linksPath).toBe(`${root}/links.json`);
        expect(d.assetsDir).toBe("Notes/_cfsync-media");
    });

    it("falls back to the sync-root cache when cacheRoot is empty", () => {
        const config = buildConfig(
            { pages: {}, folders: {}, spaces: {} },
            { site: "ex", account: "a@b.c", token: "t", syncRoot: "Notes" },
        );
        const d = runtimeDirs(config, "");
        expect(d.cacheDir).toBe("Notes/.adf_cache");
        expect(d.linksPath).toBe("Notes/.adf_cache/links.json");
    });
});
