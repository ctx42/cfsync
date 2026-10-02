// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's half of the device files the CLI reads inside a vault (see core
// `config/device.ts`): the per-device pointer to the out-of-vault cache home, and
// the API token kept in that cache home rather than Obsidian's localStorage (the
// CLI cannot read localStorage). Paths are absolute OS paths. Obsidian-free —
// localStorage access is injected — so it unit-tests against a temp directory.

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
    type DevicePointer,
    formatPointer,
    POINTER_VERSION,
    pointerPath,
    posixJoin,
    TOKEN_FILE,
} from "@cfsync/core";

/** TOKEN_MODE keeps the token file readable by its owner only. */
const TOKEN_MODE = 0o600;

/**
 * writePointer records `cacheDir` as this device's cache home for the vault at
 * `vaultPath`, in the pointer file under `pluginDir` (absolute). The file is
 * rewritten only when its content would change, so a synced or git-tracked
 * plugin folder sees no churn on every load.
 */
export async function writePointer(
    pluginDir: string,
    device: string,
    vaultPath: string,
    cacheDir: string,
): Promise<void> {
    const p: DevicePointer = {
        version: POINTER_VERSION,
        device,
        vaultPath,
        cacheDir,
    };
    const path = pointerPath(pluginDir, device);
    const text = formatPointer(p);
    if ((await readOrEmpty(path)) === text) {
        return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
}

/** tokenPath returns the token file under the cache home. */
export function tokenPath(cacheDir: string): string {
    return posixJoin(cacheDir, TOKEN_FILE);
}

/** readToken returns the token stored under `cacheDir`, or `""` when absent. */
export async function readToken(cacheDir: string): Promise<string> {
    return (await readOrEmpty(tokenPath(cacheDir))).trim();
}

/**
 * writeToken stores `token` under `cacheDir` with owner-only permissions, or
 * removes the file when the token is empty so no stale secret lingers.
 */
export async function writeToken(
    cacheDir: string,
    token: string,
): Promise<void> {
    const path = tokenPath(cacheDir);
    if (token === "") {
        await rm(path, { force: true });
        return;
    }
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path, token, { mode: TOKEN_MODE });
    await chmod(path, TOKEN_MODE); // mode applies only on create
}

/** LegacyTokenStore is the localStorage slot the token lived in before. */
export interface LegacyTokenStore {
    load(): string;
    clear(): void;
}

/**
 * loadDeviceToken returns the token for this device, migrating a token still in
 * localStorage into the token file first. localStorage is cleared only after the
 * file write succeeds; on a failed write the localStorage token is kept and
 * returned, so the plugin keeps working and the next load retries.
 */
export async function loadDeviceToken(
    cacheDir: string,
    legacy: LegacyTokenStore,
): Promise<string> {
    const old = legacy.load();
    if (old === "") {
        return readToken(cacheDir);
    }
    try {
        await writeToken(cacheDir, old);
    } catch (err) {
        console.error("cfsync: migrating the API token failed", err);
        return old;
    }
    legacy.clear();
    return old;
}

/** readOrEmpty returns a file's text, or `""` when it cannot be read. */
async function readOrEmpty(path: string): Promise<string> {
    try {
        return await readFile(path, "utf8");
    } catch {
        return "";
    }
}
