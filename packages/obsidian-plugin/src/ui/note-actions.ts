// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Which cfsync actions a note's tab-header context menu offers. Obsidian-free,
// so it unit-tests on a plain frontmatter object.

import { parseMeta } from "@cfsync/core";

/** NoteAction is one cfsync action offered on a note's tab-header menu. */
export type NoteAction = "pull" | "push" | "overwrite";

/**
 * noteActions returns the actions for a note with frontmatter `fm`, in menu
 * order. Only a note pulled from Confluence (it carries a page id) gets any; an
 * `ignore-push` note gets no push.
 */
export function noteActions(fm: unknown): NoteAction[] {
    if (fm === null || fm === undefined) return [];
    const meta = parseMeta(fm);
    if (meta.pageId === "" || meta.local) return [];
    return meta.ignorePush
        ? ["pull", "overwrite"]
        : ["pull", "push", "overwrite"];
}
