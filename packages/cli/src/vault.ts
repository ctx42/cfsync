// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Vault mode: when the CLI runs inside an Obsidian vault with the cfsync plugin,
// it takes its config from the plugin instead of `.cfsync.yaml` + `.env`, so the
// two hosts cannot drift. The shareable settings come from the plugin's
// `data.json`; the cache home and API token come from this device's pointer file
// (see core `config/device.ts`), so the CLI and the plugin share one ADF cache and
// link index. A pointer that is missing or written for another device is refused,
// never guessed around. File reads go through the injected FileSystem; the
// device name and path canonicalization are injected through {@link VaultHost}.

import {
    buildPluginConfig,
    type Config,
    type FileSystem,
    parsePointer,
    parseSettings,
    pointerPath,
    posixDir,
    posixJoin,
    SettingsVersionError,
    TOKEN_FILE,
} from "@cfsync/core";

/** PLUGIN_DIR is the cfsync plugin's folder, relative to the vault root. */
export const PLUGIN_DIR = ".obsidian/plugins/cfsync";
/** DATA_FILE is the plugin's settings file, under {@link PLUGIN_DIR}. */
export const DATA_FILE = "data.json";

/** VaultHost is the device-specific input vault mode needs. */
export interface VaultHost {
    /** This device's name, matching the plugin's (`os.hostname()`). */
    device: string;
    /** realpath canonicalizes an absolute path (resolving symlinks). */
    realpath(path: string): Promise<string>;
}

/** VaultConfig is a resolved vault-mode configuration. */
export interface VaultConfig {
    /** The vault root (absolute). */
    vault: string;
    /** The `data.json` schema version read. */
    schemaVersion: number;
    /** The plugin's out-of-vault cache home for this vault on this device. */
    cacheDir: string;
    config: Config;
}

/**
 * findVault walks up from the absolute directory `start` and returns the first
 * directory holding the cfsync plugin's `data.json`, or null when no ancestor
 * does. A vault with a renamed Obsidian config folder is not detected.
 */
export async function findVault(
    fs: FileSystem,
    start: string,
): Promise<string | null> {
    let dir = start;
    for (;;) {
        if (await fs.exists(posixJoin(dir, `${PLUGIN_DIR}/${DATA_FILE}`))) {
            return dir;
        }
        const parent = posixDir(dir);
        if (parent === dir || parent === "" || parent === ".") {
            return null;
        }
        dir = parent;
    }
}

/**
 * loadVaultConfig resolves the vault at `vault` into a {@link VaultConfig}: the
 * settings from `data.json` (refusing a newer schema), the cache home from this
 * device's pointer, and the token from the token file there. The sync root is
 * `<vault>/<syncRoot>`. It throws, naming the problem, on any missing or invalid
 * piece.
 */
export async function loadVaultConfig(
    fs: FileSystem,
    host: VaultHost,
    vault: string,
): Promise<VaultConfig> {
    const dataPath = posixJoin(vault, `${PLUGIN_DIR}/${DATA_FILE}`);
    let settings: ReturnType<typeof parseSettings>;
    try {
        settings = parseSettings(JSON.parse(await fs.readText(dataPath)));
    } catch (err) {
        if (err instanceof SettingsVersionError) {
            throw new Error(
                `${dataPath}: schema version ${err.version} is newer than this ` +
                    `CLI supports (${err.supported}); upgrade the CLI`,
            );
        }
        throw new Error(`reading ${dataPath}: ${message(err)}`);
    }

    const cacheDir = await pointedCacheDir(fs, host, vault);

    const token = await readTokenFile(fs, cacheDir);
    if (token === "") {
        throw new Error(
            "no API token on this device; set it in the cfsync plugin settings",
        );
    }

    const syncRoot = posixJoin(vault, settings.syncRoot || ".");
    return {
        vault,
        schemaVersion: settings.schemaVersion,
        cacheDir,
        config: buildPluginConfig({ ...settings, syncRoot }, token),
    };
}

/**
 * pointedCacheDir reads this device's pointer and returns its cache home,
 * refusing a pointer that is missing, invalid, or written for another device or
 * another vault path.
 */
async function pointedCacheDir(
    fs: FileSystem,
    host: VaultHost,
    vault: string,
): Promise<string> {
    const refuse = (why: string): Error =>
        new Error(
            `${why}; open the vault in Obsidian on this device once so the ` +
                "cfsync plugin records where its cache lives",
        );
    const path = pointerPath(posixJoin(vault, PLUGIN_DIR), host.device);
    if (!(await fs.exists(path))) {
        throw refuse(`no cfsync device pointer for "${host.device}"`);
    }
    let pointer: ReturnType<typeof parsePointer>;
    try {
        pointer = parsePointer(await fs.readText(path));
    } catch (err) {
        throw refuse(`${path}: ${message(err)}`);
    }
    if (pointer.device !== host.device) {
        throw refuse(
            `${path} was written on "${pointer.device}", not "${host.device}"`,
        );
    }
    if (!(await samePath(host, pointer.vaultPath, vault))) {
        throw refuse(`${path} was written for vault ${pointer.vaultPath}`);
    }
    return pointer.cacheDir;
}

/** samePath reports whether two paths name the same directory after realpath. */
async function samePath(
    host: VaultHost,
    a: string,
    b: string,
): Promise<boolean> {
    try {
        return (await host.realpath(a)) === (await host.realpath(b));
    } catch {
        return false; // a recorded path that no longer exists is not this vault
    }
}

/** readTokenFile returns the token under the cache home, or `""` when absent. */
async function readTokenFile(
    fs: FileSystem,
    cacheDir: string,
): Promise<string> {
    const path = posixJoin(cacheDir, TOKEN_FILE);
    if (!(await fs.exists(path))) {
        return "";
    }
    return (await fs.readText(path)).trim();
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
