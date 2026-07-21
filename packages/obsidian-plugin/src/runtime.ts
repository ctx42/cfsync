// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Assembles the ports, config, and derived paths one pull/push run needs — the
// plugin's analog of the CLI's CliDeps (minus the reporter, injected per run).
// buildRuntime imports obsidian values, so it stays a thin assembler with no
// logic; the pure runtimeDirs is unit-tested (from ./runtime-dirs.ts — see
// that module's header for why it had to move out of this file).

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import process from "node:process";
import {
    type Config,
    ConfluenceClient,
    type FileSystem,
    siteHost,
    type Yaml,
} from "@cfsync/core";
import { type App, FileSystemAdapter, parseYaml, requestUrl } from "obsidian";
import { NodeFileSystem } from "./adapters/fs-node.ts";
import { SplitFileSystem } from "./adapters/fs-split.ts";
import { VaultFileSystem } from "./adapters/fs-vault.ts";
import { RequestUrlHttpClient } from "./adapters/http.ts";
import { cacheHome } from "./cache-home.ts";
import { type RuntimeDirs, runtimeDirs } from "./runtime-dirs.ts";
import { buildPluginConfig, type cfsyncSettings } from "./settings/model.ts";

export type { RuntimeDirs } from "./runtime-dirs.ts";
export {
    ASSETS_DIR,
    CACHE_DIR,
    LINKS_FILE,
    runtimeDirs,
} from "./runtime-dirs.ts";

/** PluginRuntime is everything a pull/push run needs bar the per-run reporter. */
export interface PluginRuntime {
    client: ConfluenceClient;
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
    dirs: RuntimeDirs;
    mintLocalId: () => string;
}

/**
 * buildRuntime resolves the settings + token into a validated config and assembles
 * the client, filesystem, and derived paths. It throws the first config problem
 * (via buildPluginConfig) so the caller can surface it before starting a run.
 */
export function buildRuntime(
    app: App,
    settings: cfsyncSettings,
    token: string,
): PluginRuntime {
    const config = buildPluginConfig(settings, token);
    const client = new ConfluenceClient(new RequestUrlHttpClient(requestUrl), {
        host: siteHost(settings.site),
        account: settings.account,
        token,
    });
    const cacheRoot = resolveCacheRoot(app);
    const vault = new VaultFileSystem(app.vault.adapter);
    return {
        client,
        fs:
            cacheRoot === ""
                ? vault
                : new SplitFileSystem(vault, new NodeFileSystem(), cacheRoot),
        yaml: { parse: (text: string) => parseYaml(text) },
        config,
        dirs: runtimeDirs(config, cacheRoot),
        mintLocalId: () => randomUUID(),
    };
}

/**
 * resolveCacheRoot returns the absolute, out-of-vault cache directory for this
 * vault, or `""` to keep the legacy in-vault layout when the vault path is not
 * available on disk (only possible off desktop; the plugin is desktop-only).
 */
function resolveCacheRoot(app: App): string {
    const adapter = app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
        return "";
    }
    return cacheHome({
        platform: process.platform,
        home: homedir(),
        env: process.env,
        vaultName: app.vault.getName(),
        vaultPath: adapter.getBasePath(),
        hash: (input) => createHash("sha256").update(input).digest("hex"),
    });
}
