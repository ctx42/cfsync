// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Small modal dialogs for the settings tab's import/export flow: a vault-relative
// path prompt and an overwrite confirmation. Both wrap an Obsidian `Modal` in a
// promise so the settings tab can `await` a plain result. This is DOM + `obsidian`
// glue (like `tab.ts`), verified by typecheck + manual load, not unit tests.

import { type App, Modal, Setting } from "obsidian";

/** Options controlling the {@link promptVaultPath} modal's copy. */
export interface PromptOptions {
    title: string;
    placeholder: string;
    cta: string;
}

/**
 * promptVaultPath opens a modal with a single text field and resolves the trimmed
 * vault-relative path the user submits, or `null` if they cancel, close it, or
 * submit an empty value.
 */
export function promptVaultPath(
    app: App,
    opts: PromptOptions,
): Promise<string | null> {
    return new Promise((resolve) => {
        new VaultPathModal(app, opts, resolve).open();
    });
}

class VaultPathModal extends Modal {
    private value = "";
    private done = false;

    constructor(
        app: App,
        private readonly opts: PromptOptions,
        private readonly resolve: (path: string | null) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.titleEl.setText(this.opts.title);
        const input = this.contentEl.createEl("input", {
            cls: "cfsync-path-input",
            attr: { type: "text", placeholder: this.opts.placeholder },
        });
        input.addEventListener("input", () => {
            this.value = input.value;
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                this.submit();
            }
        });
        new Setting(this.contentEl)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((b) =>
                b
                    .setButtonText(this.opts.cta)
                    .setCta()
                    .onClick(() => this.submit()),
            );
        input.focus();
    }

    private submit(): void {
        const path = this.value.trim();
        this.finish(path === "" ? null : path);
        this.close();
    }

    private finish(path: string | null): void {
        if (!this.done) {
            this.done = true;
            this.resolve(path);
        }
    }

    override onClose(): void {
        this.contentEl.empty();
        this.finish(null); // cancel / Escape / click-out resolves null
    }
}

/**
 * confirmOverwrite opens a modal asking whether to overwrite `path` and resolves
 * `true` to overwrite or `false` to abort (including on cancel / close).
 */
export function confirmOverwrite(app: App, path: string): Promise<boolean> {
    return new Promise((resolve) => {
        new ConfirmModal(app, path, resolve).open();
    });
}

class ConfirmModal extends Modal {
    private done = false;

    constructor(
        app: App,
        private readonly path: string,
        private readonly resolve: (ok: boolean) => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.titleEl.setText("Overwrite file?");
        this.contentEl.createEl("p", {
            text: `${this.path} already exists. Overwrite it?`,
        });
        new Setting(this.contentEl)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((b) =>
                b
                    .setButtonText("Overwrite")
                    .setDestructive()
                    .onClick(() => this.confirm()),
            );
    }

    private confirm(): void {
        this.finish(true);
        this.close();
    }

    private finish(ok: boolean): void {
        if (!this.done) {
            this.done = true;
            this.resolve(ok);
        }
    }

    override onClose(): void {
        this.contentEl.empty();
        this.finish(false); // cancel / Escape / click-out resolves false
    }
}
