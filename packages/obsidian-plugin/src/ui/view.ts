// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The right-side dock panel: the operation surface for pull/push. It builds the
// runtime per run, drives the core through a PanelReporter, renders the live
// RunState, and for a push shows a version-checked, selectable preview before
// committing. All logic lives in operations.ts / run-state.ts; this file is the
// DOM shell.

import type { PreflightEntry } from "@cfsync/core";
import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type cfsyncPlugin from "../main.ts";
import { buildRuntime, type PluginRuntime } from "../runtime.ts";
import {
    preflight,
    pullNote,
    pullVault,
    pushSelected,
    type Scope,
    toDest,
} from "./operations.ts";
import { PanelReporter, type RunState } from "./run-state.ts";

export const VIEW_TYPE = "cfsync-panel";

export class cfsyncView extends ItemView {
    // Named opScope, not scope: obsidian's View already declares a `scope`
    // property (its own Scope class, for hotkeys) that this would clash with.
    private opScope: Scope = "vault";
    private busy = false;
    // previewPending is true while a selectable push preview is open. The
    // preview shows with busy=false (the commit re-guards via run()), so this
    // separate flag protects the open preview from being wiped by a stray
    // setScope/render(null) and refuses a new run until it is resolved.
    private previewPending = false;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: cfsyncPlugin,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE;
    }
    getDisplayText(): string {
        return "cfsync";
    }
    override getIcon(): string {
        return "arrow-down-up";
    }

    override async onOpen(): Promise<void> {
        this.render(null);
    }

    /** setScope sets the active pull/push scope and repaints. Called by commands. */
    setScope(scope: Scope): void {
        this.opScope = scope;
        // A repaint would wipe an open push preview (and the user's selection).
        // Leave it standing; the pending run is refused until it is resolved.
        if (this.previewPending) return;
        this.render(null);
    }

    /** runPull runs a one-click pull for the current scope and streams progress. */
    async runPull(): Promise<void> {
        if (this.refusePending()) return;
        await this.run("pulling", async (rt, reporter) => {
            if (this.opScope === "current") {
                const dest = this.activeDest();
                if (dest === null) throw new Error("no active note");
                const state = await pullNote(rt, reporter, dest);
                reporter.setCounts(
                    state === "pulled"
                        ? { ok: 1, warn: 0, err: 0 }
                        : { ok: 0, warn: 1, err: 0 },
                );
            } else {
                const outcome = await pullVault(rt, reporter);
                for (const e of outcome.errors) reporter.fail(e);
                reporter.setCounts({
                    ok: outcome.stats.pulled,
                    warn: outcome.stats.unchanged + outcome.stats.rendered,
                    err: outcome.errors.length,
                });
            }
        });
    }

    /** runPush pre-flights (guarded), shows the selectable preview, then pushes
     * the chosen notes under a fresh guarded run. */
    async runPush(): Promise<void> {
        if (this.refusePending()) return;
        if (this.busy) return;
        this.busy = true;
        this.render(null); // disable the header buttons during pre-flight
        let entries: PreflightEntry[];
        try {
            const rt = buildRuntime(
                this.app,
                this.plugin.settings,
                this.plugin.token,
            );
            entries = await preflight(rt, this.opScope, this.activeDest());
        } catch (err) {
            new Notice(`cfsync: ${message(err)}`);
            this.busy = false;
            this.render(null);
            return;
        }
        this.busy = false; // the preview screen is shown; the commit re-guards via run()
        const pushable = entries.filter((e) => e.cls !== "skip");
        if (pushable.length === 0) {
            new Notice("cfsync: nothing to push");
            this.render(null);
            return;
        }
        this.renderPreview(entries, (chosen) =>
            this.run("pushing", async (rt, reporter) => {
                const outcome = await pushSelected(rt, reporter, chosen);
                for (const e of outcome.errors) reporter.fail(e);
                reporter.setCounts({
                    ok: outcome.pushed,
                    warn: outcome.unchanged,
                    err: outcome.errors.length,
                });
            }),
        );
    }

    /** run executes one operation under a fresh reporter, guarding against a
     * concurrent run and re-enabling the panel (re-render) when it finishes. */
    private async run(
        verb: string,
        op: (rt: PluginRuntime, reporter: PanelReporter) => Promise<void>,
    ): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        const reporter = new PanelReporter(verb, (s) => this.render(s));
        try {
            const rt = buildRuntime(
                this.app,
                this.plugin.settings,
                this.plugin.token,
            );
            await op(rt, reporter);
            reporter.finish();
        } catch (err) {
            // Finish the run into the error phase rather than blanking the
            // panel: it keeps the accumulated log/counts of pages that already
            // succeeded and stops the progress bar from freezing mid-flight.
            reporter.error(message(err));
            new Notice(`cfsync: ${message(err)}`);
        }
        this.busy = false;
        this.render(reporter.state());
    }

    /** activeDest returns the active note's dest, or null when none is open. */
    private activeDest(): string | null {
        const file = this.app.workspace.getActiveFile();
        return file === null ? null : toDest(file.path);
    }

    /** render paints the header, action groups, progress, log, and footer from a
     * RunState. It always fully rebuilds the panel: PanelReporter mutates and
     * re-emits a single shared RunState, so a diff render would show stale rows. */
    private render(state: RunState | null): void {
        const root = this.contentEl;
        root.empty();
        root.addClass("cfsync-panel");

        this.renderTitle(root, "arrow-down-up", "cfsync");

        const pullGroup = this.group(root, "Pull from Confluence");
        this.action(pullGroup, "arrow-down", "Whole vault", false, () => {
            this.opScope = "vault";
            void this.runPull();
        });
        this.action(pullGroup, "file-down", "Current note", false, () => {
            this.opScope = "current";
            void this.runPull();
        });

        const pushGroup = this.group(root, "Push to Confluence");
        this.action(pushGroup, "arrow-up", "Whole vault", true, () => {
            this.opScope = "vault";
            void this.runPush();
        });
        this.action(pushGroup, "file-up", "Current note", true, () => {
            this.opScope = "current";
            void this.runPush();
        });

        if (state === null) {
            root.createDiv({
                cls: "cfsync-hint",
                text: "Pull pages down as Markdown, or push your edits back. Push shows a preview first.",
            });
            return;
        }

        // The bar only belongs to an in-flight run: a done or errored run is
        // finished, so drawing it would leave a frozen partial bar on screen.
        if (state.phase !== "done" && state.phase !== "error") {
            this.renderProgress(root, state);
        }
        this.renderLog(root, state);
        if (state.phase === "error") {
            this.renderError(root, state);
        } else if (state.phase === "done") {
            const foot = root.createDiv({ cls: "cfsync-footer" });
            // Label the tally by run kind: a pull "pulled"/"failed", a push
            // "pushed"/"refused" — the hardcoded push wording misreports pulls.
            const push = state.verb === "pushing";
            this.badge(
                foot,
                "ok",
                "check",
                state.counts.ok,
                push ? "pushed" : "pulled",
            );
            this.badge(foot, "warn", "minus", state.counts.warn, "unchanged");
            this.badge(
                foot,
                "err",
                "x",
                state.counts.err,
                push ? "refused" : "failed",
            );
        }
    }

    /** renderProgress draws the bar and caption for an in-flight run. */
    private renderProgress(root: HTMLElement, state: RunState): void {
        const prog = root.createDiv({ cls: "cfsync-progress" });
        const track = prog.createDiv({ cls: "cfsync-bar" });
        const fill = track.createDiv({ cls: "cfsync-bar-fill" });
        if (state.phase === "discovering") {
            track.addClass("is-indeterminate");
            prog.createDiv({
                cls: "cfsync-caption",
                text: `Discovering… ${state.found} found`,
            });
        } else {
            const pct =
                state.total > 0
                    ? Math.min(100, Math.round((state.pos / state.total) * 100))
                    : 0;
            fill.style.width = `${pct}%`;
            const cap = prog.createDiv({ cls: "cfsync-caption" });
            cap.createSpan({
                cls: "cfsync-caption-count",
                text: `${state.pos}/${state.total}`,
            });
            cap.createSpan({
                cls: "cfsync-caption-name",
                text: `${state.verb} ${state.current}`,
            });
        }
    }

    /** renderLog draws the per-page result rows. */
    private renderLog(root: HTMLElement, state: RunState): void {
        if (state.rows.length === 0) return;
        const log = root.createDiv({ cls: "cfsync-log" });
        for (const row of state.rows) {
            const r = log.createDiv({ cls: `cfsync-row cfsync-${row.kind}` });
            r.createSpan({ cls: "cfsync-dot" });
            r.createSpan({ cls: "cfsync-row-text", text: row.text });
        }
    }

    /** renderError draws the fatal-run banner beneath the preserved log. */
    private renderError(root: HTMLElement, state: RunState): void {
        const banner = root.createDiv({ cls: "cfsync-error" });
        setIcon(
            banner.createSpan({ cls: "cfsync-error-ico" }),
            "alert-triangle",
        );
        banner.createSpan({
            cls: "cfsync-error-text",
            text: state.errorText || `${state.verb} failed`,
        });
    }

    /** renderPreview shows one selectable row per candidate before a push. */
    private renderPreview(
        entries: PreflightEntry[],
        commit: (chosen: string[]) => Promise<void>,
    ): void {
        const root = this.contentEl;
        root.empty();
        root.addClass("cfsync-panel");
        // The preview is now the live surface; guard it until commit or cancel.
        this.previewPending = true;

        this.renderTitle(root, "arrow-up", "Review push");
        const pushable = entries.filter((e) => e.cls !== "skip");
        root.createDiv({
            cls: "cfsync-sub",
            text: `${pushable.length} of ${entries.length} note${
                entries.length === 1 ? "" : "s"
            } ready to push`,
        });

        const chosen = new Set(pushable.map((e) => e.dest));
        const list = root.createDiv({ cls: "cfsync-preview" });
        for (const e of entries) {
            const row = list.createEl("label", {
                cls: `cfsync-prow cfsync-${chipKind(e)}`,
            });
            const box = row.createEl("input", { type: "checkbox" });
            box.checked = chosen.has(e.dest);
            box.disabled = e.cls === "skip";
            box.onchange = () => {
                if (box.checked) chosen.add(e.dest);
                else chosen.delete(e.dest);
            };
            const main = row.createDiv({ cls: "cfsync-prow-main" });
            main.createDiv({ cls: "cfsync-prow-name", text: e.name });
            main.createDiv({ cls: "cfsync-prow-note", text: versionNote(e) });
        }

        const actions = root.createDiv({ cls: "cfsync-preview-actions" });
        const go = actions.createEl("button", {
            cls: "cfsync-action cfsync-push",
            text: "Push selected",
        });
        go.onclick = () => {
            this.previewPending = false;
            void commit([...chosen]);
        };
        const cancel = actions.createEl("button", {
            cls: "cfsync-action",
            text: "Cancel",
        });
        cancel.onclick = () => {
            this.previewPending = false;
            this.render(null);
        };
    }

    /** refusePending blocks a new run while a push preview is open, nudging the
     * user to resolve it first, and reports whether the run was refused. */
    private refusePending(): boolean {
        if (!this.previewPending) return false;
        new Notice("cfsync: finish or cancel the pending push preview");
        return true;
    }

    /** renderTitle draws the panel's icon + title header row. */
    private renderTitle(root: HTMLElement, icon: string, text: string): void {
        const title = root.createDiv({ cls: "cfsync-title" });
        setIcon(title.createSpan({ cls: "cfsync-title-ico" }), icon);
        title.createSpan({ cls: "cfsync-title-text", text });
    }

    /** group starts a labelled action group and returns its button row. */
    private group(root: HTMLElement, label: string): HTMLElement {
        const g = root.createDiv({ cls: "cfsync-group" });
        g.createDiv({ cls: "cfsync-group-label", text: label });
        return g.createDiv({ cls: "cfsync-btn-row" });
    }

    /** action appends one icon+label button to a group row. */
    private action(
        row: HTMLElement,
        icon: string,
        label: string,
        push: boolean,
        onclick: () => void,
    ): void {
        const btn = row.createEl("button", {
            cls: push ? "cfsync-action cfsync-push" : "cfsync-action",
        });
        setIcon(btn.createSpan({ cls: "cfsync-action-ico" }), icon);
        btn.createSpan({ text: label });
        btn.disabled = this.busy;
        btn.onclick = onclick;
    }

    /** badge appends one count pill to the footer. */
    private badge(
        foot: HTMLElement,
        kind: string,
        icon: string,
        count: number,
        title: string,
    ): void {
        const b = foot.createDiv({ cls: `cfsync-badge cfsync-${kind}` });
        b.setAttribute("aria-label", `${count} ${title}`);
        setIcon(b.createSpan({ cls: "cfsync-badge-ico" }), icon);
        b.createSpan({ text: String(count) });
    }
}

/** chipKind maps a preflight class to a row style. */
function chipKind(e: PreflightEntry): string {
    if (e.cls === "remote-moved") return "warn";
    if (e.cls === "skip") return "err";
    return "info";
}

/** versionNote renders the base→remote version delta for a preview row. */
function versionNote(e: PreflightEntry): string {
    if (e.cls === "new") return "(new — will be created)";
    if (e.cls === "skip") return `(skipped — ${e.reason})`;
    if (e.cls === "remote-moved")
        return `⚠ based on v${e.localBase} → remote v${e.remoteVersion}`;
    return `v${e.localBase}`;
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
