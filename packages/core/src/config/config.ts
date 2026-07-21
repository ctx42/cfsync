// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The configuration model, redesigned from `pkg/cfsync/config.go` for the
// Obsidian-native layout. It is a pure, runtime-neutral transform: an adapter
// (the plugin from `data.json` + per-device localStorage, the CLI from its own
// config file + `.env`) parses its own source and hands `buildConfig` a plain
// file-config object plus the injected {@link Secrets}; this module validates,
// resolves, and hard-scope-guards it into a {@link Config}, or throws. It reads
// no files and no environment, so it works identically on both hosts and stays
// mobile-safe.
//
// Every mapped destination resolves to a cleaned POSIX path under the sync root;
// resolution never yields a path outside it (the hard scope guard). Source
// strings (a Confluence page/folder/space link) are opaque here — their format
// is validated by the Confluence client in M6.2. File/`.env`/localStorage reading
// lives in the adapters (M8.2/M10.1).

import { DEFAULT_FLAVOR, resolveFlavor } from "../flavor/flavor.ts";
import { isAbsPosix, posixClean, posixExt, posixJoin } from "../util/path.ts";

/** DEFAULT_TIMEOUT_MS bounds a single HTTP request when the config sets none. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * FORBIDDEN_KEYS are the keys the file config must never set: the credentials and
 * sync root are injected as {@link Secrets}, never stored in the shared config.
 * The Site key (`site`) and every name for the sync root — the new (`sync_root`)
 * and legacy (`host`, `work_dir`) snake_case forms plus the camelCase
 * (`syncRoot`, `workDir`) forms an accidental spread of a {@link Secrets}-shaped
 * source could carry — are rejected, defence in depth against a leak.
 */
const FORBIDDEN_KEYS = [
    "site",
    "host",
    "account",
    "token",
    "sync_root",
    "work_dir",
    "syncRoot",
    "workDir",
];

/**
 * RawConfig is the shape of the shared file config an adapter parses (from YAML
 * for the CLI, from `data.json` for the plugin) before secrets are merged in.
 * Every field is optional; `buildConfig` reads them defensively from a plain
 * object.
 */
export interface RawConfig {
    /** Per-request HTTP timeout in milliseconds; 0 or unset selects the default. */
    timeoutMs?: number;
    /**
     * The column at which to hard-wrap Markdown block text (the `markdown.margin`
     * setting). 0 or unset means no wrapping — Obsidian soft-wraps in the editor.
     */
    margin?: number;
    /** The Markdown flavor id (the `markdown.flavor` setting); default `obsidian`. */
    flavor?: string;
    /** Destination `*.md` file (relative to the sync root) → Confluence page/folder source. */
    pages?: Record<string, string>;
    /** Destination directory → Confluence folder source. */
    folders?: Record<string, string>;
    /** Destination directory → Confluence space root source. */
    spaces?: Record<string, string>;
}

/**
 * Secrets are the values injected per run, never stored in the shared file
 * config: the Site credentials and the sync-root folder. The CLI assembles them
 * from the environment and `.env`; the plugin from `data.json` (site/account) and
 * per-device localStorage (token). The sync root is the single folder every
 * mapped destination is resolved under.
 */
export interface Secrets {
    /** The bare Atlassian Site subdomain, e.g. `your-site` (no scheme). */
    site: string;
    account: string;
    token: string;
    syncRoot: string;
}

/**
 * Config is a validated, resolved configuration ready to drive a run. The three
 * maps are keyed by the cleaned POSIX path under the sync root (not the raw
 * relative destination), so downstream code works in resolved paths only.
 */
export interface Config {
    host: string;
    account: string;
    token: string;
    /** The cleaned sync-root path every destination resolves under. */
    syncRoot: string;
    /** The Site host without its scheme, e.g. `ex.atlassian.net`; stamped as `cf_domain`. */
    domain: string;
    /** The resolved per-request HTTP timeout in milliseconds. */
    timeoutMs: number;
    /**
     * The column at which to hard-wrap Markdown block text; 0 means no wrapping
     * (the default, since Obsidian soft-wraps in the editor).
     */
    margin: number;
    /** The resolved Markdown flavor id driving ADF↔Markdown conversion. */
    flavor: string;
    /** Resolved path → source, for pages, folders, and spaces respectively. */
    pages: Record<string, string>;
    folders: Record<string, string>;
    spaces: Record<string, string>;
}

/**
 * buildConfig validates and resolves a shared file config plus injected secrets
 * into a {@link Config}, or throws an `Error` naming the first problem. It rejects
 * a file config that sets a credential or the sync root, requires the secrets, and
 * resolves every mapped destination to a cleaned path under the sync root — never
 * outside it. Source strings are not parsed here (that is the client's job in
 * M6.2); only that a source is non-empty is checked.
 */
export function buildConfig(
    raw: Record<string, unknown>,
    secrets: Secrets,
): Config {
    rejectEnvKeys(raw);
    validateSecrets(secrets);

    const syncRoot = posixClean(secrets.syncRoot);
    // registry maps every resolved destination to a human label naming its config
    // key, shared across pages, folders, and spaces so the same path cannot be
    // claimed twice.
    const registry: Record<string, string> = {};
    // roots holds only the folder and space destinations — the subtrees clean
    // walks recursively. rejectNested checks nesting among these alone; a page is
    // a leaf dest and may legitimately sit under a folder root (a pull collision,
    // not a config error), so pages are excluded from the nesting check.
    const roots: Record<string, string> = {};
    const pages = resolvePages(syncRoot, readStringMap(raw, "pages"), registry);
    const folders = resolveRootMap(
        syncRoot,
        readStringMap(raw, "folders"),
        "folder",
        registry,
        roots,
    );
    const spaces = resolveRootMap(
        syncRoot,
        readStringMap(raw, "spaces"),
        "space",
        registry,
        roots,
    );
    rejectNested(roots);

    return {
        host: siteHost(secrets.site),
        account: secrets.account,
        token: secrets.token,
        syncRoot,
        domain: siteDomain(secrets.site),
        timeoutMs: reqTimeout(readNumber(raw, "timeoutMs")),
        margin: readMargin(raw),
        flavor: readFlavor(raw),
        pages,
        folders,
        spaces,
    };
}

/**
 * rejectEnvKeys throws when the file config sets a key that must instead be
 * injected as a secret — a credential or the sync root — keeping them out of the
 * shared config, which the plugin syncs and the CLI may commit.
 */
export function rejectEnvKeys(raw: Record<string, unknown>): void {
    for (const key of FORBIDDEN_KEYS) {
        if (key in raw) {
            throw new Error(
                `config: "${key}" must not be set in the config file`,
            );
        }
    }
}

/**
 * validateSecrets throws when a required credential or the sync root is missing,
 * or when the Site is not a bare subdomain.
 */
export function validateSecrets(s: Secrets): void {
    if (s.site === "") {
        throw new Error("config: site is required");
    }
    if (s.account === "") {
        throw new Error("config: account is required");
    }
    if (s.token === "") {
        throw new Error("config: token is required");
    }
    if (s.syncRoot === "") {
        throw new Error("config: sync root is required");
    }
    validateSite(s.site);
}

/** ATLASSIAN_SUFFIX is the Cloud host suffix every Site subdomain expands under. */
const ATLASSIAN_SUFFIX = ".atlassian.net";

/**
 * siteHost expands a bare Site subdomain into the Site base URL the Confluence
 * client prepends to every endpoint, e.g. `your-site` →
 * `https://your-site.atlassian.net`.
 */
export function siteHost(site: string): string {
    return `https://${site}${ATLASSIAN_SUFFIX}`;
}

/**
 * siteDomain returns the scheme-less Site host stamped as `cf_domain`, e.g.
 * `your-site` → `your-site.atlassian.net`.
 */
export function siteDomain(site: string): string {
    return `${site}${ATLASSIAN_SUFFIX}`;
}

/**
 * validateSite throws unless site is a bare Atlassian subdomain — a single DNS
 * label of letters, digits, and internal hyphens, not a URL. The Site is
 * configured as just the part before `.atlassian.net` (e.g. `your-site`),
 * so a scheme, dot, slash, or other separator is rejected with a message that
 * shows the expected form.
 */
export function validateSite(site: string): void {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(site)) {
        throw new Error(
            `config: site "${site}" must be a bare subdomain like ` +
                '"your-site" (the part before .atlassian.net), not a URL',
        );
    }
}

/**
 * reqTimeout returns the per-request HTTP timeout in milliseconds: the configured
 * value, or {@link DEFAULT_TIMEOUT_MS} when it is unset or non-positive.
 */
export function reqTimeout(timeoutMs: number): number {
    return timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

/**
 * validateDest throws unless dest is a valid page destination: a non-empty,
 * relative path ending in `.md` that does not escape the sync root.
 */
export function validateDest(dest: string): void {
    if (dest === "") {
        throw new Error("config: page destination is empty");
    }
    if (isAbsPosix(dest)) {
        throw new Error(`config: page destination "${dest}" must be relative`);
    }
    if (posixExt(dest) !== ".md") {
        throw new Error(`config: page destination "${dest}" must end in .md`);
    }
    if (escapesRoot(dest)) {
        throw new Error(
            `config: page destination "${dest}" escapes the sync root`,
        );
    }
}

/**
 * validateRoot throws unless root is a valid folder or space destination: a
 * non-empty, relative directory path that does not end in `.md` and does not
 * escape the sync root.
 */
export function validateRoot(root: string): void {
    if (root === "") {
        throw new Error("config: root destination is empty");
    }
    if (isAbsPosix(root)) {
        throw new Error(`config: root destination "${root}" must be relative`);
    }
    if (posixExt(root) === ".md") {
        throw new Error(
            `config: root destination "${root}" must not end in .md`,
        );
    }
    if (escapesRoot(root)) {
        throw new Error(
            `config: root destination "${root}" escapes the sync root`,
        );
    }
}

/**
 * resolvePages rewrites each page destination to its cleaned path under the sync
 * root, rejecting an empty source and two destinations that resolve to the same
 * path. It records each resolved path in `registry` (a `page "<dest>"` label) so
 * the cross-map nesting check can see pages too. Source-format and
 * duplicate-page-id checks land with the client in M6.2.
 */
function resolvePages(
    syncRoot: string,
    pages: Record<string, string> | undefined,
    registry: Record<string, string>,
): Record<string, string> {
    const resolved: Record<string, string> = {};
    if (pages === undefined) {
        return resolved;
    }
    const seen: Record<string, string> = {};
    for (const [dest, src] of Object.entries(pages)) {
        validateDest(dest);
        if (src === "") {
            throw new Error(`config: page "${dest}" has an empty source`);
        }
        const path = joinUnderRoot(syncRoot, dest);
        const prev = seen[path];
        if (prev !== undefined) {
            throw new Error(
                `config: pages "${prev}" and "${dest}" ` +
                    "resolve to the same destination",
            );
        }
        seen[path] = dest;
        registry[path] = `page "${dest}"`;
        resolved[path] = src;
    }
    return resolved;
}

/**
 * resolveRootMap rewrites each folder or space destination to its cleaned path
 * under the sync root, rejecting an empty source. `registry` is shared across the
 * page, folder, and space maps so the same destination cannot be claimed twice —
 * whether by two folders, two spaces, or one of each — and so the cross-map
 * nesting check can see every root. kind names the map in errors.
 */
function resolveRootMap(
    syncRoot: string,
    map: Record<string, string> | undefined,
    kind: string,
    registry: Record<string, string>,
    roots: Record<string, string>,
): Record<string, string> {
    const resolved: Record<string, string> = {};
    if (map === undefined) {
        return resolved;
    }
    for (const [root, src] of Object.entries(map)) {
        validateRoot(root);
        if (src === "") {
            throw new Error(`config: ${kind} "${root}" has an empty source`);
        }
        const path = joinUnderRoot(syncRoot, root);
        const prev = registry[path];
        if (prev !== undefined) {
            throw new Error(
                `config: ${prev} and ${kind} "${root}" ` +
                    "resolve to the same destination",
            );
        }
        registry[path] = `${kind} "${root}"`;
        roots[path] = `${kind} "${root}"`;
        resolved[path] = src;
    }
    return resolved;
}

/**
 * rejectNested throws when one folder or space root is an ancestor directory of
 * another. Two roots in an ancestor/descendant relationship would let clean,
 * scanning the outer root's subtree, treat the inner root's managed notes as
 * stale and cross-delete them — so the overlap is rejected even though the paths
 * are not identical (that collision is caught during resolution). Only folder and
 * space roots are checked: a page is a leaf destination that may legitimately sit
 * under a root, where a name clash surfaces as a pull-time collision rather than
 * a config error. `roots` maps each resolved root path to a label naming its
 * config key, so the error names both offenders. Exact duplicates never reach
 * here; every path in `roots` is unique.
 */
function rejectNested(roots: Record<string, string>): void {
    const paths = Object.keys(roots).sort();
    for (let i = 0; i < paths.length; i++) {
        const outer = paths[i] ?? "";
        for (let j = i + 1; j < paths.length; j++) {
            const inner = paths[j] ?? "";
            if (isAncestorPath(outer, inner) || isAncestorPath(inner, outer)) {
                throw new Error(
                    `config: ${roots[outer]} and ${roots[inner]} ` +
                        "overlap: one is nested under the other",
                );
            }
        }
    }
}

/** isAncestorPath reports whether `a` is a strict ancestor directory of `b`. */
function isAncestorPath(a: string, b: string): boolean {
    return b.startsWith(`${a}/`);
}

/**
 * joinUnderRoot resolves a validated relative destination to its cleaned path
 * under syncRoot and asserts it stays within the sync root — the hard scope
 * guard, defence in depth behind {@link validateDest}/{@link validateRoot}. A `.`
 * sync root (the current directory) cleans away in the join, so the guard reduces
 * to the escape check the cleaned path already encodes.
 */
function joinUnderRoot(syncRoot: string, rel: string): string {
    const path = posixJoin(syncRoot, rel);
    if (syncRoot === ".") {
        if (escapesRoot(path)) {
            throw new Error(`config: "${rel}" escapes the sync root`);
        }
        return path;
    }
    const prefix = syncRoot === "/" ? "/" : `${syncRoot}/`;
    if (path !== syncRoot && !path.startsWith(prefix)) {
        throw new Error(`config: "${rel}" escapes the sync root`);
    }
    return path;
}

/**
 * readStringMap reads a string→string map field from a parsed object, rejecting
 * a structurally-invalid source (a non-string value such as a number or nested
 * object) at config-resolution time rather than letting it coerce to a bogus
 * string that only fails, confusingly, at fetch time.
 */
function readStringMap(
    raw: Record<string, unknown>,
    key: string,
): Record<string, string> | undefined {
    const value = raw[key];
    if (value === undefined || value === null || typeof value !== "object") {
        return undefined;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v !== "string") {
            throw new Error(`config: ${key} "${k}" source must be a string`);
        }
        out[k] = v;
    }
    return out;
}

/** readNumber reads a numeric field from a parsed object, or 0 when absent. */
function readNumber(raw: Record<string, unknown>, key: string): number {
    const value = raw[key];
    return typeof value === "number" ? value : 0;
}

/**
 * readMargin reads the Markdown wrap margin (the `markdown.margin` setting the
 * adapter flattens onto `raw`). It defaults to 0 (no wrapping) when unset and
 * throws when the value is not a non-negative integer.
 */
function readMargin(raw: Record<string, unknown>): number {
    const value = raw["margin"];
    if (value === undefined || value === null) {
        return 0;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(
            'config: "markdown.margin" must be a non-negative integer',
        );
    }
    return value;
}

/**
 * readFlavor reads the Markdown flavor id (the `markdown.flavor` setting),
 * defaulting to {@link DEFAULT_FLAVOR}. It validates the id via resolveFlavor,
 * so an unknown flavor fails config resolution with a naming error rather than
 * at render time.
 */
function readFlavor(raw: Record<string, unknown>): string {
    const value = raw["flavor"];
    if (value === undefined || value === null || value === "") {
        return DEFAULT_FLAVOR;
    }
    if (typeof value !== "string") {
        throw new Error('config: "markdown.flavor" must be a string');
    }
    resolveFlavor(value); // throws on unknown id
    return value;
}

/** escapesRoot reports whether a relative path, once cleaned, climbs above `.`. */
function escapesRoot(rel: string): boolean {
    const clean = posixClean(rel);
    return clean === ".." || clean.startsWith("../");
}
