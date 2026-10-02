// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Per-row actions on the two-way status report, shared by `cfsync status -i`
// and the plugin's status view. Each status row offers the actions that make
// sense for its kind (see rowActions), every row starting at skip; the chosen
// actions are applied in a fixed order — pulls and overwrites first, then the
// never-push / stop-ignoring markers, then creates and pushes — so a pull a
// push depends on lands first. One failing note never stops the rest; each
// note's outcome is returned.

import type { Config } from "../config/config.ts";
import type { ConfluenceClient } from "../confluence/client.ts";
import type { Flavor } from "../flavor/flavor.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Reporter } from "../ports/progress.ts";
import type { Yaml } from "../ports/yaml.ts";
import { clearIgnorePush, markIgnorePush } from "./create.ts";
import type { MintLocalId } from "./images.ts";
import { openLinkIndex, pageName } from "./linkindex.ts";
import { Puller, resolvePageSource } from "./pull.ts";
import { Pusher, planCreates } from "./push.ts";
import type { StatusReport } from "./status.ts";

/** RowKind is the kind of a status row, which decides its actions. */
export type RowKind =
    | "new"
    | "modified"
    | "refused"
    | "remote"
    | "diverged"
    | "ignored";

/** RowAction is one action a status row can be given. */
export type RowAction =
    | "skip"
    | "create"
    | "never"
    | "push"
    | "pull"
    | "overwrite"
    | "unignore";

/** ACTIONS lists each row kind's actions, skip first (the default). */
const ACTIONS: Record<RowKind, RowAction[]> = {
    new: ["skip", "create", "never"],
    modified: ["skip", "push", "overwrite"],
    refused: ["skip", "overwrite"],
    remote: ["skip", "pull"],
    diverged: ["skip", "push", "pull", "overwrite"],
    ignored: ["skip", "unignore"],
};

/** rowActions returns the actions a row of `kind` offers, skip first. */
export function rowActions(kind: RowKind): RowAction[] {
    return ACTIONS[kind];
}

/** ACTION_LABELS are the human labels of the actions. */
export const ACTION_LABELS: Record<RowAction, string> = {
    skip: "skip",
    create: "create",
    never: "never push",
    push: "push",
    pull: "pull",
    overwrite: "overwrite from Confluence",
    unignore: "stop ignoring",
};

/** StatusRow is one actionable row of a status report. */
export interface StatusRow {
    dest: string;
    /** The syncRoot-relative page name. */
    name: string;
    kind: RowKind;
    /** The status detail shown after the name (versions or a reason). */
    detail: string;
}

/**
 * statusRows flattens a status report into its actionable rows, in section
 * order: to push, to pull, diverged, then ignored. Notes that could not be
 * checked carry no action and are left out.
 */
export function statusRows(r: StatusReport, syncRoot: string): StatusRow[] {
    const versions = (local: number, remote: number): string =>
        `local v${local} -> remote v${remote}`;
    const rows: StatusRow[] = [];
    for (const e of r.push) {
        rows.push({
            dest: e.dest,
            name: e.name,
            kind:
                e.cls === "new"
                    ? "new"
                    : e.cls === "refused"
                      ? "refused"
                      : "modified",
            detail: e.cls === "refused" ? e.reason : "",
        });
    }
    for (const e of r.pull) {
        rows.push({
            dest: e.dest,
            name: e.name,
            kind: "remote",
            detail: versions(e.localBase, e.remoteVersion),
        });
    }
    for (const e of r.diverged) {
        rows.push({
            dest: e.dest,
            name: e.name,
            kind: "diverged",
            detail: `${versions(e.localBase, e.remoteVersion)}, local edits`,
        });
    }
    for (const dest of r.ignored) {
        rows.push({
            dest,
            name: pageName(syncRoot, dest),
            kind: "ignored",
            detail: "",
        });
    }
    return rows;
}

/** Choice is one row given an action. */
export interface Choice {
    row: StatusRow;
    action: RowAction;
}

/**
 * overwrites returns the rows whose chosen action discards local edits — the
 * notes a caller must confirm before {@link applyActions} runs.
 */
export function overwrites(choices: Choice[]): StatusRow[] {
    return choices.filter((c) => c.action === "overwrite").map((c) => c.row);
}

/** ActionDeps are the ports and resolved paths {@link applyActions} needs. */
export interface ActionDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
    reporter: Reporter;
    /** Device-local ADF cache dir. */
    cacheDir: string;
    /** Image assets dir, under the sync root. */
    assetsDir: string;
    /** Where the link index is persisted. */
    linksPath: string;
    /** Mints a media-node localId for an uploaded image. */
    mintLocalId: MintLocalId;
    flavor: Flavor;
}

/** ActionResult is one applied action's outcome. */
export interface ActionResult {
    name: string;
    action: RowAction;
    ok: boolean;
    /** What happened (e.g. `updated v5`), or the error when not ok. */
    detail: string;
}

/**
 * applyActions runs every non-skip choice: first pulls and overwrites (one
 * note at a time), then the never-push and stop-ignoring markers, then creates
 * and pushes in one push run. A failure is recorded against its note and the
 * rest still run. Results come back in that execution order. All-skip makes no
 * request at all.
 */
export async function applyActions(
    d: ActionDeps,
    choices: Choice[],
): Promise<ActionResult[]> {
    const chosen = choices.filter((c) => c.action !== "skip");
    const results: ActionResult[] = [];
    const ofKind = (...as: RowAction[]): Choice[] =>
        chosen.filter((c) => as.includes(c.action));

    for (const c of ofKind("pull", "overwrite")) {
        results.push(await pullRow(d, c));
    }
    for (const c of ofKind("never", "unignore")) {
        try {
            await (c.action === "never"
                ? markIgnorePush(d.fs, c.row.dest)
                : clearIgnorePush(d.fs, c.row.dest));
            results.push(result(c, true, "marker updated"));
        } catch (err) {
            results.push(result(c, false, message(err)));
        }
    }
    const pushes = ofKind("create", "push");
    if (pushes.length > 0) {
        results.push(...(await pushRows(d, pushes)));
    }
    return results;
}

/** pullRow pulls (or overwrites) one note from its Confluence page. */
async function pullRow(d: ActionDeps, c: Choice): Promise<ActionResult> {
    try {
        d.reporter.item(c.row.name);
        const { src, spaceKey, links } = await resolvePageSource(
            {
                client: d.client,
                fs: d.fs,
                config: d.config,
                reporter: d.reporter,
                linksPath: d.linksPath,
            },
            c.row.dest,
        );
        const puller = new Puller({
            client: d.client,
            fs: d.fs,
            config: d.config,
            reporter: d.reporter,
            cacheDir: d.cacheDir,
            assetsDir: d.assetsDir,
            links,
            flavor: d.flavor,
            overwrite: c.action === "overwrite",
        });
        const { action, version } = await puller.pullOne(
            c.row.dest,
            src,
            spaceKey,
        );
        return result(c, action !== "conflict", `${action} v${version}`);
    } catch (err) {
        return result(c, false, message(err));
    }
}

/**
 * pushRows creates and pushes the chosen notes in one push run. Every chosen
 * create is confirmed (the row's action is the confirmation); a note is
 * reported failed when the run names it in an error.
 */
async function pushRows(d: ActionDeps, cs: Choice[]): Promise<ActionResult[]> {
    const dests = cs.map((c) => c.row.dest);
    try {
        const plan = await planCreates(d, dests, async (cands) => {
            return new Map(cands.map((cand) => [cand.dest, true]));
        });
        const pusher = new Pusher({
            client: d.client,
            fs: d.fs,
            yaml: d.yaml,
            config: d.config,
            reporter: d.reporter,
            cacheDir: d.cacheDir,
            assetsDir: d.assetsDir,
            mintLocalId: d.mintLocalId,
            links: (await openLinkIndex(d.fs, d.linksPath, d.config.syncRoot))
                .links,
            flavor: d.flavor,
        });
        const outcome = await pusher.pushDests(dests, plan);
        return cs.map((c) => {
            const err = outcome.errors.find((e) =>
                e.startsWith(`${c.row.name}: `),
            );
            return err === undefined
                ? result(c, true, "pushed")
                : result(c, false, err.slice(c.row.name.length + 2));
        });
    } catch (err) {
        return cs.map((c) => result(c, false, message(err)));
    }
}

/** result builds an {@link ActionResult} for a choice. */
function result(c: Choice, ok: boolean, detail: string): ActionResult {
    return { name: c.row.name, action: c.action, ok, detail };
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
