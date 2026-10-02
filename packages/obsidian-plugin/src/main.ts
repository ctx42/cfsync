// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { hostname } from "node:os";
import { PACKAGE_NAME, posixJoin } from "@cfsync/core";
import {
    FileSystemAdapter,
    MarkdownView,
    type Menu,
    Notice,
    Plugin,
    type TAbstractFile,
    TFile,
} from "obsidian";

import { loadDeviceToken, writePointer, writeToken } from "./device-state.ts";
import { indentViewPlugin } from "./render/indent-livepreview.ts";
import { indentPostProcessor } from "./render/indent-reading.ts";
import { resolveCacheRoot } from "./runtime.ts";
import { type cfsyncSettings, DEFAULT_SETTINGS } from "./settings/model.ts";
import {
    loadSettings,
    loadToken,
    saveSettings,
    saveToken,
} from "./settings/store.ts";
import { cfsyncSettingTab } from "./settings/tab.ts";
import { type NoteAction, noteActions } from "./ui/note-actions.ts";
import { toDest } from "./ui/operations.ts";
import { cfsyncView, VIEW_TYPE } from "./ui/view.ts";

/** NOTE_ITEMS are the tab-header menu items: label, icon, warning styling. */
const NOTE_ITEMS: Record<NoteAction, [string, string, boolean]> = {
    pull: ["Pull from Confluence", "arrow-down", false],
    push: ["Push to Confluence", "arrow-up", false],
    overwrite: ["Overwrite from Confluence…", "alert-triangle", true],
};

/**
 * cfsyncPlugin is the Obsidian plugin entry point. It loads the shareable
 * settings (`data.json`) and the per-device API token (a file in the out-of-vault
 * cache home, migrated from localStorage) on start, records this device's pointer
 * to that cache home for the CLI, registers the settings tab, and keeps settings
 * and token in memory for the settings UI and the pull/push commands to read. The
 * indent renderers register as before.
 */
export default class cfsyncPlugin extends Plugin {
    override settings: cfsyncSettings = { ...DEFAULT_SETTINGS };
    token = "";
    /** The out-of-vault cache home, or `""` when the vault has no disk path. */
    cacheRoot = "";

    override async onload(): Promise<void> {
        this.settings = await loadSettings(this);
        this.cacheRoot = resolveCacheRoot(this.app);
        this.token = await this.loadToken();
        void this.recordPointer();

        this.addSettingTab(new cfsyncSettingTab(this.app, this));
        this.registerEditorExtension(indentViewPlugin);
        this.registerMarkdownPostProcessor(indentPostProcessor);

        this.registerView(VIEW_TYPE, (leaf) => new cfsyncView(leaf, this));

        this.addRibbonIcon("arrow-down-up", "cfsync control center", () => {
            void this.activateView();
        });

        this.addCommand({
            id: "cfsync-open-panel",
            name: "Open control center",
            callback: () => void this.activateView(),
        });
        this.addCommand({
            id: "cfsync-pull-all",
            name: "Pull (whole vault)",
            callback: () =>
                void this.runInView((v) => {
                    v.setScope("vault");
                    return v.runPull();
                }),
        });
        this.addCommand({
            id: "cfsync-pull-current",
            name: "Pull (current note)",
            callback: () =>
                void this.runInView((v) => {
                    v.setScope("current");
                    return v.runPull();
                }),
        });
        this.addCommand({
            id: "cfsync-push-all",
            name: "Push (whole vault)",
            callback: () =>
                void this.runInView((v) => {
                    v.setScope("vault");
                    return v.runPush();
                }),
        });
        this.addCommand({
            id: "cfsync-push-current",
            name: "Push (current note)",
            callback: () =>
                void this.runInView((v) => {
                    v.setScope("current");
                    return v.runPush();
                }),
        });

        this.addCommand({
            id: "cfsync-status",
            name: "Status (whole vault)",
            callback: () => void this.runInView((v) => v.runStatus()),
        });

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file, source) =>
                this.noteMenu(menu, file, source),
            ),
        );

        console.log(`cfsync: loaded (core=${PACKAGE_NAME})`);
    }

    override onunload(): void {
        console.log("cfsync: unloaded");
    }

    /** persistSettings writes the current shareable settings to `data.json`. */
    async persistSettings(): Promise<void> {
        await saveSettings(this, this.settings);
    }

    /**
     * persistToken writes the current API token to the per-device token file in
     * the cache home (localStorage when the vault has no disk path). A failed
     * write is reported as a notice.
     */
    persistToken(): void {
        if (this.cacheRoot === "") {
            saveToken(this, this.token);
            return;
        }
        writeToken(this.cacheRoot, this.token).catch((err: unknown) => {
            console.error("cfsync: saving the API token failed", err);
            new Notice("cfsync: saving the API token failed; see the console.");
        });
    }

    /** loadToken reads the API token, migrating one left in localStorage. */
    private loadToken(): Promise<string> {
        if (this.cacheRoot === "") {
            return Promise.resolve(loadToken(this));
        }
        return loadDeviceToken(this.cacheRoot, {
            load: () => loadToken(this),
            clear: () => saveToken(this, ""),
        });
    }

    /**
     * recordPointer writes this device's pointer to the cache home into the plugin
     * folder, so a CLI run inside the vault shares the plugin's cache and token.
     * Best effort: a failure is logged, and the CLI then refuses to run here.
     */
    private async recordPointer(): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (this.cacheRoot === "" || !(adapter instanceof FileSystemAdapter)) {
            return;
        }
        const vaultPath = adapter.getBasePath();
        const dir =
            this.manifest.dir ??
            `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        try {
            await writePointer(
                posixJoin(vaultPath.replace(/\\/g, "/"), dir),
                hostname(),
                vaultPath,
                this.cacheRoot,
            );
        } catch (err) {
            console.error("cfsync: writing the device pointer failed", err);
        }
    }

    /** activateView reveals the control-center panel in the right sidebar. */
    async activateView(): Promise<cfsyncView> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (leaf === undefined) {
            leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        await workspace.revealLeaf(leaf);
        return leaf.view as cfsyncView;
    }

    /** noteMenu adds the cfsync section (Obsidian separates sections) to a synced note's tab-header context
     * menu, greyed out while the panel is busy or a push preview is pending. */
    private noteMenu(menu: Menu, file: TAbstractFile, source: string): void {
        if (source !== "tab-header" || !(file instanceof TFile)) return;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const actions = noteActions(fm);
        if (actions.length === 0) return;
        const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
        const idle = !(view instanceof cfsyncView) || view.idle();
        for (const a of actions) {
            const [title, icon, warning] = NOTE_ITEMS[a];
            menu.addItem((item) =>
                item
                    .setSection("cfsync")
                    .setTitle(title)
                    .setIcon(icon)
                    .setWarning(warning)
                    .setDisabled(!idle)
                    .onClick(() => void this.noteAction(a, file)),
            );
        }
    }

    /** noteAction saves `file`'s open editors, then runs `action` on it in the
     * panel. Saving first keeps a pending autosave from being lost (pull,
     * push) or from writing stale text over the result (overwrite). */
    private async noteAction(action: NoteAction, file: TFile): Promise<void> {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const v = leaf.view;
            if (v instanceof MarkdownView && v.file?.path === file.path) {
                await v.save();
            }
        }
        const dest = toDest(file.path);
        await this.runInView((v) =>
            action === "pull"
                ? v.runPull(dest)
                : action === "push"
                  ? v.runPush(dest)
                  : v.runOverwrite(dest),
        );
    }

    /** runInView opens the panel and runs `fn` against its view. */
    private async runInView(
        fn: (v: cfsyncView) => Promise<void>,
    ): Promise<void> {
        const view = await this.activateView();
        await fn(view);
    }
}
