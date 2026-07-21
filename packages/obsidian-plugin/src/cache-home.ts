// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Resolves the device-local cache home OUTSIDE the vault, so the ADF cache and
// link index never land in the vault — and therefore never in another plugin's
// reach (e.g. obsidian-git's working tree) or a sync set. The directory is the
// OS per-user cache location, namespaced per vault by an injected hash of the
// vault's absolute path, so two vaults on one machine never collide. Pure and
// obsidian-free (platform, home, env, and hash are injected) so it unit-tests
// directly; the plugin's buildRuntime feeds it `process`/`os`/`node:crypto`.

import { posixJoin } from "@cfsync/core";

/** CacheHomeInput is the injected environment cacheHome derives a path from. */
export interface CacheHomeInput {
    /** The Node platform string (`process.platform`): `win32`, `darwin`, … */
    platform: string;
    /** The current user's home directory (`os.homedir()`). */
    home: string;
    /** The process environment (`process.env`). */
    env: Record<string, string | undefined>;
    /** The vault's display name, slugged into the per-vault directory. */
    vaultName: string;
    /** The vault's absolute path; hashed to key the directory. */
    vaultPath: string;
    /** A hex-string hash of its input; keys the directory by vault path. */
    hash: (input: string) => string;
}

/**
 * cacheHome returns the absolute, forward-slash cache directory for one vault:
 * the OS per-user cache root (`$XDG_CACHE_HOME` or `~/.cache` on Linux,
 * `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows) joined with `cfsync`
 * and a per-vault key (`<name-slug>-<vault-path-hash>`).
 */
export function cacheHome(i: CacheHomeInput): string {
    const base = baseDir(i).replace(/\\/g, "/");
    return posixJoin(posixJoin(base, "cfsync"), vaultKey(i));
}

/** baseDir returns the OS per-user cache root for the platform. */
function baseDir(i: CacheHomeInput): string {
    if (i.platform === "win32") {
        // `||` not `??`: an exported-but-empty env var must fall back too,
        // otherwise the cache would resolve to the filesystem root.
        return i.env["LOCALAPPDATA"] || `${i.home}/AppData/Local`;
    }
    if (i.platform === "darwin") {
        return `${i.home}/Library/Caches`;
    }
    return i.env["XDG_CACHE_HOME"] || `${i.home}/.cache`;
}

/** vaultKey builds the per-vault directory name: a name slug plus a path hash. */
function vaultKey(i: CacheHomeInput): string {
    const slug =
        i.vaultName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "vault";
    return `${slug}-${i.hash(i.vaultPath).slice(0, 12)}`;
}
