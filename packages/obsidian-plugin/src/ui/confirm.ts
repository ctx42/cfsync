// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A yes/no confirmation dialog, used before an apply discards local edits.

import { type App, Modal } from "obsidian";

/**
 * confirmModal shows `title`, `message`, and a list of `items`, resolving true
 * when the user confirms and false when they cancel or close the dialog.
 */
export function confirmModal(
    app: App,
    title: string,
    message: string,
    items: string[],
    confirmText: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        let answered = false;
        const modal = new Modal(app);
        modal.titleEl.setText(title);
        modal.contentEl.createEl("p", { text: message });
        const list = modal.contentEl.createEl("ul");
        for (const item of items) {
            list.createEl("li", { text: item });
        }
        const actions = modal.contentEl.createDiv({
            cls: "cfsync-preview-actions",
        });
        const ok = actions.createEl("button", {
            cls: "mod-warning",
            text: confirmText,
        });
        ok.onclick = () => {
            answered = true;
            resolve(true);
            modal.close();
        };
        const cancel = actions.createEl("button", { text: "Cancel" });
        cancel.onclick = () => modal.close();
        modal.onClose = () => {
            if (!answered) resolve(false);
        };
        modal.open();
    });
}
