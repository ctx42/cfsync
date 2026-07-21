// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The pure, derived-paths half of the plugin's runtime. Split out of
// runtime.ts so it carries no `obsidian` import at all (not even type-only
// mixed into a value-import statement) and can be unit-tested directly:
// `runtime.ts` imports obsidian VALUES (`requestUrl`, `parseYaml`) for
// `buildRuntime`, and once a module contains such an import, bundler/vitest
// module resolution fails for the whole file — obsidian ships types only
// (`"main": ""`) — regardless of which export a test actually reaches for.
// `runtime.ts` re-exports everything here so its public API is unchanged.

import { type Config, posixJoin } from "@cfsync/core";

/** The device-local ADF cache directory, under the sync root. */
export const CACHE_DIR = ".adf_cache";
/** The shared image-assets directory, under the sync root. */
export const ASSETS_DIR = "_cfsync-media";
/** The link-index file, under the cache directory. */
export const LINKS_FILE = "links.json";

/** RuntimeDirs are the derived per-run paths under the sync root. */
export interface RuntimeDirs {
    cacheDir: string;
    assetsDir: string;
    linksPath: string;
}

/**
 * runtimeDirs derives the cache, assets, and link-index paths from a config. When
 * `cacheRoot` is given (a non-empty absolute path), the device-local cache and its
 * link index live there — outside the vault — instead of under the sync root; the
 * shared assets stay under the sync root either way. An empty or absent `cacheRoot`
 * keeps the legacy `<syncRoot>/.adf_cache` layout.
 */
export function runtimeDirs(config: Config, cacheRoot?: string): RuntimeDirs {
    const cacheDir =
        cacheRoot !== undefined && cacheRoot !== ""
            ? cacheRoot
            : posixJoin(config.syncRoot, CACHE_DIR);
    return {
        cacheDir,
        assetsDir: posixJoin(config.syncRoot, ASSETS_DIR),
        linksPath: posixJoin(cacheDir, LINKS_FILE),
    };
}
