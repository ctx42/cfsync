// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's settings tab. It edits the shareable settings and the per-device
// token, shows the first `buildConfig` validation error inline (non-blocking, so
// half-finished rows are still saved), and runs a live connection test against
// the Site via the requestUrl adapter and the core's ConfluenceClient. All logic
// worth asserting lives in `model.ts`/`store.ts`/`adapters/http.ts`; this file is
// DOM glue and is verified by typecheck + manual load.

import { homedir } from "node:os";

import { ConfluenceClient, flavorIds, posixDir, siteHost } from "@cfsync/core";
import {
    type App,
    Notice,
    PluginSettingTab,
    parseYaml,
    requestUrl,
    Setting,
    setIcon,
    stringifyYaml,
} from "obsidian";
import { RequestUrlHttpClient } from "../adapters/http.ts";
import type cfsyncPlugin from "../main.ts";
import { type Debounced, debounce } from "./debounce.ts";
import { confirmOverwrite, promptVaultPath } from "./dialogs.ts";
import { buildPluginConfig } from "./model.ts";
import {
    applyImportedMaps,
    expandTilde,
    resolvePortablePath,
    toPortableConfig,
} from "./portable.ts";
import { normalizeConfluenceSource } from "./source.ts";
import { readPath, statPath, writePath } from "./vault-io.ts";

/** errorMessage returns an unknown thrown value's message text. */
function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** A single destination→source row's mutable state within a map editor. */
interface MapEntry {
    dest: string;
    src: string;
    /** Transient UI state: true while this row's fields are being edited. */
    editing: boolean;
}

/**
 * PERSIST_DEBOUNCE_MS coalesces keystrokes into one `data.json` write. Long
 * enough that ordinary typing writes once at the end, short enough that a pause
 * still saves promptly; any tab hide or explicit commit flushes before it lapses.
 */
export const PERSIST_DEBOUNCE_MS = 400;

export class cfsyncSettingTab extends PluginSettingTab {
    private validationEl: HTMLElement | null = null;

    /**
     * persist debounces `data.json` writes so a burst of keystrokes collapses
     * into one write. Its errors surface (console + Notice) instead of being
     * swallowed. It is flushed on {@link hide} and on every map commit so the
     * final keystrokes are never lost.
     */
    private readonly persist: Debounced<[]> = debounce(() => {
        this.plugin.persistSettings().catch((err: unknown) => {
            const msg = errorMessage(err);
            console.error("cfsync: failed to persist settings", err);
            new Notice(`cfsync: failed to save settings: ${msg}`);
        });
    }, PERSIST_DEBOUNCE_MS);

    constructor(
        app: App,
        private readonly plugin: cfsyncPlugin,
    ) {
        super(app, plugin);
    }

    /** hide flushes any pending debounced write so no keystrokes are lost when
     * the settings tab closes. */
    override hide(): void {
        this.persist.flush();
        super.hide();
    }

    /**
     * display builds the settings tab imperatively with the `Setting` API, the
     * form available on every supported Obsidian (unlike the declarative
     * `getSettingDefinitions` API, which is 1.13+ only). Each scalar field writes
     * its change straight back to the settings, schedules a debounced persist, and
     * refreshes the validation line; the token, connection test, map editors, and
     * validation line keep the same imperative helpers. Obsidian calls this on
     * open, and {@link importPortable} calls it to re-render after an import.
     */
    override display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const s = this.plugin.settings;

        // commitScalar writes a scalar field, persists, and revalidates — the
        // work every field's onChange shares.
        const commitScalar = (write: () => void): void => {
            write();
            this.persist();
            this.refreshValidation();
        };

        new Setting(containerEl).setName("Connection").setHeading();

        new Setting(containerEl)
            .setName("Site subdomain")
            .setDesc(
                "Your Atlassian site subdomain — the part before .atlassian.net, e.g. your-site",
            )
            .addText((t) =>
                t
                    .setPlaceholder("your-site")
                    .setValue(s.site)
                    .onChange((v) =>
                        commitScalar(() => {
                            s.site = v.trim();
                        }),
                    ),
            );

        new Setting(containerEl)
            .setName("Account")
            .setDesc("Atlassian account email (Basic-auth username).")
            .addText((t) =>
                t
                    .setPlaceholder("you@example.com")
                    .setValue(s.account)
                    .onChange((v) =>
                        commitScalar(() => {
                            s.account = v.trim();
                        }),
                    ),
            );

        new Setting(containerEl)
            .setName("API token")
            .setDesc("Stored on this device only, never in data.json.")
            .addText((t) => {
                t.inputEl.type = "password";
                t.setPlaceholder("Atlassian API token")
                    .setValue(this.plugin.token)
                    .onChange((v) => {
                        this.plugin.token = v.trim();
                        this.plugin.persistToken();
                        this.refreshValidation();
                    });
            });

        const test = new Setting(containerEl).setName("Test connection");
        const status = test.descEl.createSpan();
        test.addButton((b) =>
            b.setButtonText("Test").onClick(async () => {
                await this.testConnection(status);
            }),
        );

        new Setting(containerEl).setName("Markdown").setHeading();

        new Setting(containerEl)
            .setName("Flavor")
            .setDesc("Markdown dialect used for pulled/pushed notes.")
            .addDropdown((d) => {
                for (const id of flavorIds()) {
                    d.addOption(id, id);
                }
                d.setValue(s.flavor).onChange((v) =>
                    commitScalar(() => {
                        s.flavor = v;
                    }),
                );
            });

        new Setting(containerEl)
            .setName("Wrap margin")
            .setDesc("Hard-wrap column for block text; 0 disables wrapping.")
            .addText((t) => {
                t.inputEl.type = "number";
                t.setPlaceholder("0")
                    .setValue(String(s.margin))
                    .onChange((v) =>
                        commitScalar(() => {
                            s.margin = Number(v) || 0;
                        }),
                    );
            });

        new Setting(containerEl)
            .setName("Sync-root subfolder")
            .setDesc(
                "Vault-relative folder to sync under; empty = whole vault.",
            )
            .addText((t) =>
                t
                    .setPlaceholder("(vault root)")
                    .setValue(s.syncRoot)
                    .onChange((v) =>
                        commitScalar(() => {
                            s.syncRoot = v.trim();
                        }),
                    ),
            );

        new Setting(containerEl)
            .setName("Request timeout (seconds)")
            .setDesc("Per-request HTTP timeout.")
            .addText((t) => {
                t.inputEl.type = "number";
                t.setPlaceholder("30")
                    .setValue(String(s.timeoutSeconds))
                    .onChange((v) =>
                        commitScalar(() => {
                            s.timeoutSeconds = Number(v) || 0;
                        }),
                    );
            });

        this.renderMaps(containerEl);

        this.validationEl = containerEl.createEl("p", {
            cls: "cfsync-validation",
        });
        this.refreshValidation();
    }

    /** renderMaps draws the three destination→source row editors. */
    private renderMaps(root: HTMLElement): void {
        new Setting(root).setName("Sync map").setHeading();
        this.renderMapSection(
            root,
            "Pages",
            this.plugin.settings.pages,
            (next) => {
                this.plugin.settings.pages = next;
            },
        );
        this.renderMapSection(
            root,
            "Folders",
            this.plugin.settings.folders,
            (next) => {
                this.plugin.settings.folders = next;
            },
        );
        this.renderMapSection(
            root,
            "Spaces",
            this.plugin.settings.spaces,
            (next) => {
                this.plugin.settings.spaces = next;
            },
        );

        new Setting(root)
            .setName("Import / export")
            .setDesc(
                "Share the sync map as a .cfsync.yaml file. Never includes your credentials.",
            )
            .addButton((b) =>
                b.setButtonText("Import").onClick(() => {
                    void this.importPortable();
                }),
            )
            .addButton((b) =>
                b.setButtonText("Export").onClick(() => {
                    void this.exportPortable();
                }),
            );
    }

    /**
     * renderMapSection draws one destination→source map. A saved entry shows as a
     * read-only row of its vault destination and Confluence link with Edit and
     * Delete icons; Edit turns that row's fields into full-width, separately
     * labelled inputs and Done returns it to read-only. "Add" appends a new entry
     * already in edit mode. The persisted record is rebuilt on every change,
     * dropping rows with an empty destination or source so a blank row is never
     * saved. Leaving a link field (or clicking Done) reduces a pasted full
     * Confluence URL to its `/wiki/...` path.
     */
    private renderMapSection(
        root: HTMLElement,
        title: string,
        initial: Record<string, string>,
        assign: (next: Record<string, string>) => void,
    ): void {
        const entries: MapEntry[] = Object.entries(initial).map(
            ([dest, src]) => ({ dest, src, editing: false }),
        );
        const destPlaceholder =
            title === "Pages" ? "path to MD file" : "path to folder";

        // commit rebuilds and assigns the record synchronously (so the in-memory
        // settings are always current), then schedules a debounced write.
        // `immediate` flushes that write now — used for structural actions
        // (Add/Done/Delete) so an explicit commit is durable at once, while
        // per-keystroke input edits coalesce.
        const commit = (immediate = false): void => {
            const record: Record<string, string> = {};
            for (const entry of entries) {
                if (entry.dest !== "" && entry.src !== "") {
                    record[entry.dest] = entry.src;
                }
            }
            assign(record);
            this.persist();
            if (immediate) {
                this.persist.flush();
            }
            this.refreshValidation();
        };

        const rows = document.createElement("div");

        const fieldWrap = (row: HTMLElement, label: string): HTMLElement => {
            const wrap = row.createDiv({ cls: "cfsync-map-field" });
            wrap.createEl("label", { cls: "cfsync-map-label", text: label });
            return wrap;
        };

        const iconButton = (
            parent: HTMLElement,
            icon: string,
            label: string,
            onClick: () => void,
        ): void => {
            const btn = parent.createEl("button", {
                cls: "clickable-icon",
                attr: { "aria-label": label },
            });
            setIcon(btn, icon);
            btn.addEventListener("click", onClick);
        };

        const rerender = (): void => {
            rows.empty();
            entries.forEach((entry, index) => {
                const row = rows.createDiv({ cls: "cfsync-map-row" });
                const controls = (): HTMLElement =>
                    row.createDiv({ cls: "cfsync-map-controls" });

                if (!entry.editing) {
                    fieldWrap(row, "Vault:").createDiv({
                        cls: "cfsync-map-value",
                        text: entry.dest || "(empty)",
                    });
                    fieldWrap(row, "Confluence:").createDiv({
                        cls: "cfsync-map-value",
                        text: entry.src || "(empty)",
                    });
                    const c = controls();
                    iconButton(c, "pencil", "Edit", () => {
                        entry.editing = true;
                        rerender();
                    });
                    iconButton(c, "trash-2", "Delete", () => {
                        entries.splice(index, 1);
                        commit(true);
                        rerender();
                    });
                    return;
                }

                const dest = fieldWrap(row, "Vault:").createEl("input", {
                    cls: "cfsync-map-input",
                    attr: { type: "text", placeholder: destPlaceholder },
                });
                dest.value = entry.dest;
                dest.addEventListener("input", () => {
                    entry.dest = dest.value.trim();
                    commit();
                });

                const src = fieldWrap(row, "Confluence:").createEl("input", {
                    cls: "cfsync-map-input",
                    attr: { type: "text", placeholder: "/wiki/..." },
                });
                src.value = entry.src;
                src.addEventListener("input", () => {
                    entry.src = src.value.trim();
                    commit();
                });
                src.addEventListener("change", () => {
                    const norm = normalizeConfluenceSource(src.value);
                    src.value = norm;
                    entry.src = norm;
                    commit(true);
                });

                const c = controls();
                iconButton(c, "check", "Done", () => {
                    entry.dest = dest.value.trim();
                    entry.src = normalizeConfluenceSource(src.value);
                    if (entry.dest === "" && entry.src === "") {
                        entries.splice(index, 1);
                    } else if (entry.dest !== "" && entry.src !== "") {
                        entry.editing = false;
                    }
                    // A half-filled row (only dest or only src) stays in edit
                    // mode: commit() never persists it, so leaving it read-only
                    // would look saved yet vanish on reopen.
                    commit(true);
                    rerender();
                });
                iconButton(c, "trash-2", "Delete", () => {
                    entries.splice(index, 1);
                    commit(true);
                    rerender();
                });
            });
        };

        new Setting(root).setName(title).addButton((b) =>
            b.setButtonText("Add").onClick(() => {
                entries.push({ dest: "", src: "", editing: true });
                commit(true);
                rerender();
            }),
        );
        root.appendChild(rows);
        rerender();
    }

    /**
     * exportPortable prompts for a path — vault-relative, an absolute OS path, or
     * a `~`-relative one — resolves it (a folder gets the file name appended), and writes the current
     * shareable config as `.cfsync.yaml`.
     * The target's containing folder must already exist — export never creates
     * directories, so a path into a missing folder is rejected. An existing target
     * file is overwritten only after confirmation. Any failure surfaces as a Notice
     * rather than throwing.
     */
    private async exportPortable(): Promise<void> {
        const input = await promptVaultPath(this.app, {
            title: "Export .cfsync.yaml",
            placeholder: this.plugin.settings.syncRoot || "folder or file path",
            cta: "Export",
        });
        if (input === null) {
            return;
        }
        try {
            const expanded = expandTilde(input, homedir());
            const inputStat = await statPath(this.app, expanded);
            const path = resolvePortablePath(
                expanded,
                inputStat?.type === "folder",
            );
            const dir = posixDir(path);
            if (
                dir !== "." &&
                (await statPath(this.app, dir))?.type !== "folder"
            ) {
                new Notice(`cfsync: no such folder: ${dir}`);
                return;
            }
            if ((await statPath(this.app, path)) !== null) {
                if (!(await confirmOverwrite(this.app, path))) {
                    return;
                }
            }
            const text = stringifyYaml(toPortableConfig(this.plugin.settings));
            await writePath(this.app, path, text);
            new Notice(`cfsync: exported to ${path}`);
        } catch (err) {
            new Notice(`cfsync: export failed: ${errorMessage(err)}`);
        }
    }

    /**
     * importPortable prompts for a path — vault-relative, an absolute OS path, or
     * a `~`-relative one — resolves it (a folder gets the file name appended), reads and parses the
     * YAML, merges its page/folder/space maps
     * into the settings (incoming wins), persists, and re-renders. Any failure
     * surfaces as a Notice rather than throwing.
     */
    private async importPortable(): Promise<void> {
        const input = await promptVaultPath(this.app, {
            title: "Import .cfsync.yaml",
            placeholder: this.plugin.settings.syncRoot || "folder or file path",
            cta: "Import",
        });
        if (input === null) {
            return;
        }
        try {
            const expanded = expandTilde(input, homedir());
            const inputStat = await statPath(this.app, expanded);
            const path = resolvePortablePath(
                expanded,
                inputStat?.type === "folder",
            );
            const text = await readPath(this.app, path);
            const { settings, imported } = applyImportedMaps(
                this.plugin.settings,
                parseYaml(text),
            );
            this.plugin.settings = settings;
            await this.plugin.persistSettings();
            this.display();
            new Notice(`cfsync: imported ${imported} mappings from ${path}`);
        } catch (err) {
            new Notice(`cfsync: import failed: ${errorMessage(err)}`);
        }
    }

    /** refreshValidation shows the first buildConfig error, or clears the line. */
    private refreshValidation(): void {
        if (this.validationEl === null) {
            return;
        }
        try {
            buildPluginConfig(this.plugin.settings, this.plugin.token);
            this.validationEl.setText("");
        } catch (err) {
            this.validationEl.setText(errorMessage(err));
        }
    }

    /** testConnection authenticates the current form values against the Site. */
    private async testConnection(status: HTMLElement): Promise<void> {
        status.setText(" Testing…");
        try {
            const client = new ConfluenceClient(
                new RequestUrlHttpClient(requestUrl),
                {
                    host: siteHost(this.plugin.settings.site),
                    account: this.plugin.settings.account,
                    token: this.plugin.token,
                },
            );
            const accountId = await client.currentAccountID();
            status.setText(` Connected as ${accountId}`);
        } catch (err) {
            status.setText(` Failed: ${errorMessage(err)}`);
        }
    }
}
