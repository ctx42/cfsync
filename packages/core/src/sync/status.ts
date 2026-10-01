// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The two-way status report, shared by the CLI `status` command and the
// plugin's status view. It classifies every managed note with the push
// preflight and groups the result the way `git status` does: what a push would
// send, what a pull would bring, and the notes changed on both sides. It is
// read-only towards notes and Confluence; the only write is a missing base
// version the preflight fetches into the cache.

import { mdFilesUnder } from "./fswalk.ts";
import {
    MetaCache,
    managedPushDests,
    type PreflightDeps,
    type PreflightEntry,
    pushPreflight,
    readMeta,
} from "./push.ts";

/** StatusReport is the two-way status of the managed notes, grouped by section. */
export interface StatusReport {
    /** Notes a push would send: `new`, `modified`, and `refused`, in path order. */
    push: PreflightEntry[];
    /** Notes whose remote moved ahead with no local change (`remote-moved`). */
    pull: PreflightEntry[];
    /** Notes changed locally while the remote also moved ahead (`diverged`). */
    diverged: PreflightEntry[];
    /** Notes that could not be checked (`skip`), with the reason. */
    warnings: PreflightEntry[];
    /** Notes push never touches (ignore-push or `cf_local`); filled only on request. */
    ignored: string[];
}

/** StatusOptions narrows and extends a {@link collectStatus} run. */
export interface StatusOptions {
    /** An absolute note or directory path; only notes at or under it are reported. */
    scope?: string;
    /** Also list the notes push never touches in {@link StatusReport.ignored}. */
    ignored?: boolean;
}

/**
 * collectStatus classifies every managed note (see {@link managedPushDests})
 * with {@link pushPreflight} and groups the entries into a {@link StatusReport}.
 * Unchanged notes appear in no section. It throws when Confluence cannot be
 * reached, so a caller never shows a partial report as if it were complete.
 */
export async function collectStatus(
    deps: PreflightDeps,
    opts: StatusOptions = {},
): Promise<StatusReport> {
    const cache = new MetaCache();
    const inScope = scopeFilter(opts.scope);
    const dests = (
        await managedPushDests(deps.fs, deps.yaml, deps.config, cache)
    ).filter(inScope);
    const entries =
        dests.length === 0
            ? []
            : await pushPreflight(deps, dests, cache, { strict: true });

    const report: StatusReport = {
        push: [],
        pull: [],
        diverged: [],
        warnings: [],
        ignored: [],
    };
    for (const e of entries) {
        switch (e.cls) {
            case "new":
            case "modified":
            case "refused":
                report.push.push(e);
                break;
            case "remote-moved":
                report.pull.push(e);
                break;
            case "diverged":
                report.diverged.push(e);
                break;
            case "skip":
                report.warnings.push(e);
                break;
            case "unchanged":
                break;
        }
    }
    if (opts.ignored === true) {
        report.ignored = (await ignoredDests(deps, cache)).filter(inScope);
    }
    return report;
}

/** isClean reports whether the report has nothing pending in any section. */
export function isClean(r: StatusReport): boolean {
    return r.push.length + r.pull.length + r.diverged.length === 0;
}

/**
 * scopeFilter returns a predicate keeping dests at or under `scope`, or every
 * dest when no scope is given.
 */
function scopeFilter(scope: string | undefined): (dest: string) => boolean {
    if (scope === undefined || scope === "") {
        return () => true;
    }
    const dir = scope.endsWith("/") ? scope : `${scope}/`;
    return (dest) => dest === scope || dest.startsWith(dir);
}

/**
 * ignoredDests lists, sorted, the candidate notes {@link managedPushDests}
 * leaves out because they carry `cfsync-plugin: ignore-push` or `cf_local`:
 * configured pages, then `.md` files under the folder and space roots.
 */
async function ignoredDests(
    deps: PreflightDeps,
    cache: MetaCache,
): Promise<string[]> {
    const { fs, yaml, config } = deps;
    const roots = [
        ...Object.keys(config.folders),
        ...Object.keys(config.spaces),
    ];
    const candidates = new Set<string>([
        ...Object.keys(config.pages),
        ...(await mdFilesUnder(fs, roots)),
    ]);
    const out: string[] = [];
    for (const dest of candidates) {
        const meta = await readMeta(cache, fs, yaml, dest);
        if (meta !== null && (meta.ignorePush || meta.local)) {
            out.push(dest);
        }
    }
    return out.sort();
}
