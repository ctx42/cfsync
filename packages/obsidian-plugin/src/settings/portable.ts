// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The portable-config transforms for import/export of a `.cfsync.yaml` file. This
// module is pure — no `obsidian` runtime, no I/O — so it unit-tests under vitest.
// The glue layer (dialogs + settings tab) does the YAML string step and vault I/O
// and calls these to shape the object out and merge the maps back in. Secrets are
// never part of the portable object, matching the keys the CLI/core forbid in the
// shared config.

import { posixJoin } from "@cfsync/core";
import type { cfsyncSettings } from "./model.ts";

/** The portable config file's name, matching the CLI's `CONFIG_FILE`. */
export const PORTABLE_FILE = ".cfsync.yaml";

/**
 * PortableConfig is the object serialized to `.cfsync.yaml`. It carries only the
 * shareable config — the timeout, the Markdown settings, and the three maps —
 * never the Site credentials or the sync root (the CLI/core reject those keys).
 */
export interface PortableConfig {
    /** Per-request HTTP timeout, formatted as a Go-style duration, e.g. `"30s"`. */
    timeout: string;
    markdown: { flavor: string; margin: number };
    pages: Record<string, string>;
    folders: Record<string, string>;
    spaces: Record<string, string>;
}

/**
 * toPortableConfig builds the exportable object from the current settings. The
 * maps are copied (not aliased), and no secret field is ever included.
 */
export function toPortableConfig(settings: cfsyncSettings): PortableConfig {
    return {
        timeout: `${settings.timeoutSeconds}s`,
        markdown: { flavor: settings.flavor, margin: settings.margin },
        pages: { ...settings.pages },
        folders: { ...settings.folders },
        spaces: { ...settings.spaces },
    };
}

/**
 * expandTilde replaces a leading `~` that stands for the current user's home
 * directory — a bare `~`, or `~/…` (and `~\…` on Windows) — with `home`, so a
 * home-relative path the user types resolves to an absolute OS path. Any other
 * leading `~` (e.g. `~other/…`, naming another user's home the plugin cannot
 * resolve) is left as typed. The result is trimmed of surrounding whitespace.
 */
export function expandTilde(input: string, home: string): string {
    const trimmed = input.trim();
    if (trimmed === "~") {
        return home;
    }
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
        return home + trimmed.slice(1);
    }
    return trimmed;
}

/**
 * resolvePortablePath resolves the user-entered path to the file to read/write.
 * When `isFolder` (the caller stat'd it) or `input` ends with `/`, the file name
 * is joined onto it; otherwise the trimmed input is used as the file path.
 */
export function resolvePortablePath(input: string, isFolder: boolean): string {
    const trimmed = input.trim();
    if (isFolder || trimmed.endsWith("/")) {
        return posixJoin(trimmed, PORTABLE_FILE);
    }
    return trimmed;
}

/** ImportResult is the merged settings plus the count of map entries applied. */
export interface ImportResult {
    settings: cfsyncSettings;
    imported: number;
}

/**
 * applyImportedMaps merges the `pages`/`folders`/`spaces` maps from an arbitrary
 * parsed YAML value into `settings`, returning a new settings object and the count
 * of entries applied. Incoming entries win on a duplicate destination; only
 * string→string entries are kept. A non-object `parsed`, a non-object map, or a
 * non-string value is ignored. flavor, margin, timeout, and the secret fields are
 * left untouched. Never throws.
 */
export function applyImportedMaps(
    settings: cfsyncSettings,
    parsed: unknown,
): ImportResult {
    const obj = isRecord(parsed) ? parsed : {};
    let imported = 0;
    const merge = (
        current: Record<string, string>,
        incoming: unknown,
    ): Record<string, string> => {
        const next = { ...current };
        if (isRecord(incoming)) {
            for (const [dest, src] of Object.entries(incoming)) {
                if (typeof src === "string") {
                    next[dest] = src;
                    imported++;
                }
            }
        }
        return next;
    };
    return {
        settings: {
            ...settings,
            pages: merge(settings.pages, obj["pages"]),
            folders: merge(settings.folders, obj["folders"]),
            spaces: merge(settings.spaces, obj["spaces"]),
        },
        imported,
    };
}

/** isRecord narrows a value to a plain object (not an array, not null). */
function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
