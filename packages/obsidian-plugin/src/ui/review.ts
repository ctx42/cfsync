// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The pure model behind the panel's push review and status view: which
// preflight entries a review lists and how each row behaves, and how a status
// report splits into the view's sections. view.ts only draws what these return.

import { type PreflightEntry, pageName, type StatusReport } from "@cfsync/core";

/**
 * ReviewRow is one push-review row. A `pick` row is a checkbox (ticked by
 * default); a `new` row offers later / create / never, starting at later; a
 * `locked` row (refused, or not checkable) is shown but cannot be chosen.
 */
export interface ReviewRow {
    entry: PreflightEntry;
    control: "pick" | "new" | "locked";
    /** The row's style: `info`, `warn` (diverged), or `err` (refused, skipped). */
    kind: "info" | "warn" | "err";
    /** The one-line note under the page name. */
    note: string;
}

/** ReviewModel is the rows a push review lists plus the count it hides. */
export interface ReviewModel {
    rows: ReviewRow[];
    /** Notes left out because a push would not change their page. */
    hidden: number;
}

/**
 * reviewModel builds the push review from a preflight. A note whose push would
 * change nothing — `unchanged`, or `remote-moved` with no local change — is
 * hidden and only counted. Modified and diverged notes are ticked by default
 * (a diverged push three-way-merges, or is refused on a real conflict); new
 * notes start at "later"; refused and skipped notes are locked.
 */
export function reviewModel(entries: PreflightEntry[]): ReviewModel {
    const rows: ReviewRow[] = [];
    let hidden = 0;
    for (const e of entries) {
        switch (e.cls) {
            case "unchanged":
            case "remote-moved":
                hidden++;
                break;
            case "modified":
                rows.push({
                    entry: e,
                    control: "pick",
                    kind: "info",
                    note: `v${e.localBase}`,
                });
                break;
            case "diverged":
                rows.push({
                    entry: e,
                    control: "pick",
                    kind: "warn",
                    note:
                        `⚠ diverged: based on v${e.localBase} → remote ` +
                        `v${e.remoteVersion}; push merges`,
                });
                break;
            case "new":
                rows.push({
                    entry: e,
                    control: "new",
                    kind: "info",
                    note: "new — not on Confluence yet",
                });
                break;
            case "refused":
                rows.push({
                    entry: e,
                    control: "locked",
                    kind: "err",
                    note: `refused — ${e.reason}`,
                });
                break;
            case "skip":
                rows.push({
                    entry: e,
                    control: "locked",
                    kind: "err",
                    note: `skipped — ${e.reason}`,
                });
                break;
        }
    }
    return { rows, hidden };
}

/** NewChoice is a new note's review answer. */
export type NewChoice = "later" | "create" | "never";

/**
 * reviewCommit splits the review's answers into the dests to push (ticked rows
 * and new notes marked create) and the new notes to mark never.
 */
export function reviewCommit(
    picked: Set<string>,
    answers: Map<string, NewChoice>,
): { push: string[]; never: string[] } {
    const push = [...picked];
    const never: string[] = [];
    for (const [dest, choice] of answers) {
        if (choice === "create") push.push(dest);
        if (choice === "never") never.push(dest);
    }
    return { push, never };
}

/** StatusLine is one row of a status-view section. */
export interface StatusLine {
    /** The syncRoot-relative page name. */
    name: string;
    /** The status word: new, modified, refused, remote, diverged, ignored, or warning. */
    word: string;
    /** The detail after the name: versions or a reason; may be empty. */
    detail: string;
}

/** StatusSection is one collapsible group of the status view. */
export interface StatusSection {
    title: string;
    lines: StatusLine[];
}

/**
 * statusSections splits a status report into the view's sections — To push, To
 * pull, Diverged, Ignored (only with `showIgnored`), and Could not check — in
 * that order, omitting empty ones. It mirrors the CLI `status` layout.
 */
export function statusSections(
    r: StatusReport,
    syncRoot: string,
    showIgnored: boolean,
): StatusSection[] {
    const versions = (e: PreflightEntry): string =>
        `local v${e.localBase} → remote v${e.remoteVersion}`;
    const sections: StatusSection[] = [
        {
            title: "To push",
            lines: r.push.map((e) => ({
                name: e.name,
                word: e.cls,
                detail: e.cls === "refused" ? e.reason : "",
            })),
        },
        {
            title: "To pull",
            lines: r.pull.map((e) => ({
                name: e.name,
                word: "remote",
                detail: versions(e),
            })),
        },
        {
            title: "Diverged",
            lines: r.diverged.map((e) => ({
                name: e.name,
                word: "diverged",
                detail: `${versions(e)}, local edits`,
            })),
        },
        {
            title: "Ignored",
            lines: showIgnored
                ? r.ignored.map((dest) => ({
                      name: pageName(syncRoot, dest),
                      word: "ignored",
                      detail: "",
                  }))
                : [],
        },
        {
            title: "Could not check",
            lines: r.warnings.map((e) => ({
                name: e.name,
                word: "warning",
                detail: e.reason,
            })),
        },
    ];
    return sections.filter((s) => s.lines.length > 0);
}
