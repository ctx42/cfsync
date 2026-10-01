// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's interactive confirmations. Push shows a checkbox list of the new
// pages, each to create, skip this time, or never ask about again (see
// select.ts); clean asks whether to remove the stale files it found. Both refuse
// to prompt when stdin is not a terminal, directing the user to `--yes`, so a
// piped or CI run never blocks. The inputs are injected (`ask`, `keys`) so the
// decision logic is tested without a real TTY; `nodeAsk` wires the real line
// reader over readline.

import { createInterface } from "node:readline/promises";
import { type CreateInput, pageName, type StaleItem } from "@cfsync/core";
import { type KeySource, runSelect } from "./select.ts";

/** PromptOptions are the shared inputs for a confirmation. */
export interface PromptOptions {
    /** The sync root, to render note names relative to it. */
    syncRoot: string;
    /** Whether stdin is an interactive terminal. */
    isTTY: boolean;
    /** Skip the prompt and accept everything (`--yes`). */
    yes: boolean;
    /** Write a line to stderr (the summary and the questions' surrounding text). */
    err: (text: string) => void;
    /** Ask a question and read one line of input. */
    ask: (question: string) => Promise<string>;
    /** Open a raw keypress source for the new-page selector. */
    keys: () => KeySource;
    /** Mark the note at `dest` ignore-push — the selector's "never" answer. */
    markNever: (dest: string) => Promise<void>;
}

/**
 * confirmCreates decides which create candidates to make, the callback push's
 * `planCreates` expects. It prints the summary, then accepts all with `--yes`,
 * refuses to prompt without a terminal, or shows the checkbox selector with
 * every page undecided. A page marked "never" gets the ignore-push marker and is
 * not created; an undecided one is skipped and asked about again next push.
 * Returns each candidate's dest mapped to its create decision.
 */
export async function confirmCreates(
    cands: CreateInput[],
    opts: PromptOptions,
): Promise<Map<string, boolean>> {
    const decided = new Map<string, boolean>();
    if (cands.length === 0) {
        return decided;
    }
    opts.err(createSummary(cands, opts.syncRoot));

    if (opts.yes) {
        for (const c of cands) {
            decided.set(c.dest, true);
        }
        return decided;
    }
    if (!opts.isTTY) {
        throw new Error(
            "refusing to prompt without a terminal; re-run with --yes",
        );
    }

    const labels = cands.map(
        (c) => `${pageName(opts.syncRoot, c.dest)} — "${c.title}"`,
    );
    const choices = await runSelect(labels, opts.keys(), opts.err);
    for (const [i, c] of cands.entries()) {
        const choice = choices[i] ?? "later";
        if (choice === "never") {
            await opts.markNever(c.dest);
        }
        decided.set(c.dest, choice === "create");
    }
    return decided;
}

/**
 * confirmStale selects which stale items to remove, the callback clean expects.
 * With `--yes` it removes everything; without a terminal it refuses; otherwise it
 * lists the items and asks a single y/N, returning all or none.
 */
export async function confirmStale(
    items: StaleItem[],
    opts: PromptOptions,
): Promise<StaleItem[]> {
    if (opts.yes) {
        return items;
    }
    if (!opts.isTTY) {
        throw new Error(
            "refusing to prompt without a terminal; re-run with --yes",
        );
    }
    opts.err(staleSummary(items, opts.syncRoot));
    const line = (await opts.ask(`Remove ${items.length} item(s)? [y/N]: `))
        .trim()
        .toLowerCase();
    return line === "y" || line === "yes" ? items : [];
}

/** createSummary lists the new pages a push would create, one per line. */
function createSummary(cands: CreateInput[], syncRoot: string): string {
    let out = `cfsync: ${cands.length} new page(s) to create:\n`;
    for (const c of cands) {
        out += `  ${pageName(syncRoot, c.dest)} — "${c.title}"\n`;
    }
    return out;
}

/** staleSummary lists the stale files and directories clean found. */
function staleSummary(items: StaleItem[], syncRoot: string): string {
    let out = `cfsync: ${items.length} stale item(s):\n`;
    for (const it of items) {
        const suffix = it.isDir ? "/" : "";
        out += `  ${pageName(syncRoot, it.path)}${suffix}\n`;
    }
    return out;
}

/**
 * nodeAsk returns a line reader over the process stdin, writing each prompt to
 * stderr. The interface is opened and closed per question so a command that never
 * prompts leaves stdin untouched. It rejects on end of input (stdin closed), so a
 * closed or empty stdin can never make `askCreate`'s loop spin forever — matching
 * the Go reader that returns an error on EOF.
 */
export function nodeAsk(question: string): Promise<string> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    return new Promise<string>((resolve, reject) => {
        rl.once("close", () => reject(new Error("prompt: input closed")));
        rl.question(question).then(resolve, reject);
    }).finally(() => rl.close());
}
