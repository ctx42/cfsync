// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The device files the Obsidian plugin leaves for the CLI, so a CLI run inside a
// vault shares the plugin's device-local state. The plugin resolves its cache
// home outside the vault (a per-vault key the CLI cannot reliably recompute) and
// records it in a per-device *pointer* file inside its plugin folder; the API
// token sits in a file in that cache home. The plugin folder may be synced
// between devices, so there is one pointer per device and each records the
// device and vault path it was written for — a reader refuses a pointer that is
// not its own. This module only names and (de)serializes; hosts do the I/O.

import { posixJoin } from "../util/path.ts";

/** POINTER_VERSION is the pointer-file format version this build reads and writes. */
export const POINTER_VERSION = 1;

/** DEVICES_DIR holds the per-device pointer files, under the plugin folder. */
export const DEVICES_DIR = "devices";

/** TOKEN_FILE is the API-token file's name, under the cache home. */
export const TOKEN_FILE = "token";

/** DevicePointer records where one device keeps the plugin's state for a vault. */
export interface DevicePointer {
    /** The pointer-file format version; see {@link POINTER_VERSION}. */
    version: number;
    /** The device (host) name the pointer was written on. */
    device: string;
    /** The vault's absolute path as the plugin saw it on that device. */
    vaultPath: string;
    /** The absolute cache home: ADF cache, link index, and the token file. */
    cacheDir: string;
}

/**
 * deviceKey turns a device name into a filename-safe key: lower-cased, runs of
 * anything but `[a-z0-9]` collapsed to `-`, and trimmed; `device` when nothing
 * is left.
 */
export function deviceKey(device: string): string {
    return (
        device
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "device"
    );
}

/** pointerPath returns the pointer file for `device` under `pluginDir`. */
export function pointerPath(pluginDir: string, device: string): string {
    return posixJoin(
        posixJoin(pluginDir, DEVICES_DIR),
        `${deviceKey(device)}.json`,
    );
}

/** formatPointer serializes a pointer as stable, human-readable JSON. */
export function formatPointer(p: DevicePointer): string {
    const out: DevicePointer = {
        version: p.version,
        device: p.device,
        vaultPath: p.vaultPath,
        cacheDir: p.cacheDir,
    };
    return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * parsePointer parses pointer-file text, throwing when it is not JSON, lacks a
 * non-empty string field, or carries a version other than
 * {@link POINTER_VERSION}. Whether the pointer belongs to this device and vault
 * is the reader's check.
 */
export function parsePointer(text: string): DevicePointer {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        throw new Error(`pointer: invalid JSON: ${message(err)}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("pointer: not a JSON object");
    }
    const obj = raw as Record<string, unknown>;
    if (obj["version"] !== POINTER_VERSION) {
        throw new Error(
            `pointer: unsupported version ${JSON.stringify(obj["version"])}`,
        );
    }
    const field = (key: string): string => {
        const v = obj[key];
        if (typeof v !== "string" || v === "") {
            throw new Error(`pointer: missing "${key}"`);
        }
        return v;
    };
    return {
        version: POINTER_VERSION,
        device: field("device"),
        vaultPath: field("vaultPath"),
        cacheDir: field("cacheDir"),
    };
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
