// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Path-routed file I/O for the settings import/export flow. The plugin is
// desktop-only, so a path the user enters may be an absolute OS path (the CLI's
// `.cfsync.yaml` can live anywhere on disk) or a vault-relative path. Absolute
// paths go through Node's `fs`; vault-relative paths through Obsidian's vault
// adapter, whose methods only accept normalized vault-relative paths — handing
// them an absolute path makes them look under the vault root and report "not
// found". This is glue (Node + `obsidian`), verified by typecheck + manual load,
// not unit-tested.

import { stat as fsStat, readFile, writeFile } from "node:fs/promises";

import { isAbsPosix } from "@cfsync/core";
import type { App } from "obsidian";

/** PathStat is a minimal kind marker, unifying Node's `Stats` and Obsidian's `Stat`. */
export interface PathStat {
    type: "file" | "folder";
}

/**
 * isAbsOsPath reports whether `path` is an absolute OS path that must go through
 * Node's `fs` rather than the vault adapter. It accepts a POSIX root (`/…`), a
 * Windows drive path (`C:\…` or `C:/…`), and a Windows UNC path (`\\server\…`),
 * since the plugin is desktop-only and runs on Windows too.
 */
function isAbsOsPath(path: string): boolean {
    return (
        isAbsPosix(path) ||
        /^[A-Za-z]:[/\\]/.test(path) ||
        path.startsWith("\\\\")
    );
}

/**
 * statPath reports the target's kind, or `null` when it does not exist. An
 * absolute path is stat'd on disk via Node's `fs`; a vault-relative path via the
 * vault adapter.
 */
export async function statPath(
    app: App,
    path: string,
): Promise<PathStat | null> {
    if (isAbsOsPath(path)) {
        try {
            const s = await fsStat(path);
            return { type: s.isDirectory() ? "folder" : "file" };
        } catch {
            return null;
        }
    }
    const s = await app.vault.adapter.stat(path);
    return s === null ? null : { type: s.type };
}

/**
 * readPath reads the file's text — from disk for an absolute path, or from the
 * vault for a vault-relative one. Rejects (caught by the caller) if it is absent.
 */
export function readPath(app: App, path: string): Promise<string> {
    return isAbsOsPath(path)
        ? readFile(path, "utf8")
        : app.vault.adapter.read(path);
}

/**
 * writePath writes the file's text — to disk for an absolute path, or into the
 * vault for a vault-relative one. It never creates parent directories.
 */
export async function writePath(
    app: App,
    path: string,
    data: string,
): Promise<void> {
    if (isAbsOsPath(path)) {
        await writeFile(path, data, "utf8");
        return;
    }
    await app.vault.adapter.write(path, data);
}
