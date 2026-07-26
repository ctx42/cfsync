// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Comment write-back (Stage 2): the push-side counterpart of the pull's comment
// decoration. It reads the `[!comment]` callouts back out of an edited note
// ({@link parseCommentThreads}), compares them against the live threads fetched
// from Confluence, and applies the two edits Stage 2 supports — a reply the user
// added as an id-less nested callout, and a resolution the user toggled on a
// thread's metadata line. Creating brand-new top-level comments is Stage 3 and is
// left alone here. The sync is best-effort per action: a failed reply or resolve
// becomes a warning rather than sinking the body push it rides along with. A
// reply whose text already exists under its parent is skipped, so a re-push (or a
// push whose post-sync note refresh failed) never double-sends it.

import { parseCommentThreads } from "../adf/render/comments.ts";
import type {
    ConfluenceClient,
    PageComment,
    PageComments,
} from "../confluence/client.ts";
import type { Node } from "../models/adf.ts";

/** CommentSync is the outcome of one page's comment write-back. */
export interface CommentSync {
    /** One line per applied change (a reply created, a thread resolved/reopened). */
    actions: string[];
    /** One line per non-fatal problem (a reply or resolve that failed, a stale id). */
    warnings: string[];
    /** Whether any change was applied — the signal to refresh the note afterwards. */
    changed: boolean;
}

/**
 * syncComments applies the comment edits in the note `body` to page `pageId`. It
 * fetches the live threads, diffs the parsed callouts against them, creates each
 * new reply under its parent (skipping one whose text already exists there), and
 * toggles a changed resolution. It never throws: every failure is captured as a
 * warning, so a comment problem never fails the body push. `body` is the raw note
 * body (comment decorations intact), not the stripped push body.
 */
export async function syncComments(
    client: ConfluenceClient,
    pageId: string,
    body: string,
): Promise<CommentSync> {
    const out: CommentSync = { actions: [], warnings: [], changed: false };
    let remote: PageComments;
    try {
        remote = await client.fetchComments(pageId);
    } catch (err) {
        out.warnings.push(`reading comments: ${message(err)}`);
        return out;
    }
    const index = indexRemote(remote);

    for (const thread of parseCommentThreads(body)) {
        if (thread.id === "") {
            continue; // a brand-new top-level callout — Stage 3, not handled here
        }
        const top = index.get(thread.id);
        if (top === undefined) {
            out.warnings.push(
                `comment ${thread.id} no longer exists on Confluence; ` +
                    "its edits were skipped",
            );
            continue;
        }
        await applyReplies(client, thread.newReplies, index, out);
        applyResolution(thread.id, thread.resolution, top, out);
    }
    return out;
}

/** RemoteComment is the live state of one comment the diff reads. */
interface RemoteComment {
    kind: "inline" | "footer";
    /** The inline resolution (`open`/`resolved`/…); `""` for a footer comment. */
    resolution: string;
    /** The normalized text of each direct reply, for the reply-dedupe guard. */
    childTexts: Set<string>;
}

/**
 * indexRemote flattens the fetched threads into a by-id map of the state the diff
 * needs: each comment's kind, resolution, version, and the normalized text of its
 * direct replies (so an already-sent reply is recognized and not re-created).
 */
function indexRemote(remote: PageComments): Map<string, RemoteComment> {
    const map = new Map<string, RemoteComment>();
    const walk = (comment: PageComment): void => {
        map.set(comment.id, {
            kind: comment.kind,
            resolution: comment.resolution,
            childTexts: new Set(comment.replies.map((r) => plainText(r.adf))),
        });
        for (const reply of comment.replies) {
            walk(reply);
        }
    };
    for (const comment of [...remote.inline, ...remote.footer]) {
        walk(comment);
    }
    return map;
}

/**
 * applyReplies creates each new reply under its parent, skipping one whose parent
 * is gone (a warning) or whose text already exists under that parent (already
 * sent). The reply inherits the parent's kind, so it lands on the right endpoint.
 */
async function applyReplies(
    client: ConfluenceClient,
    replies: { parentId: string; text: string }[],
    index: Map<string, RemoteComment>,
    out: CommentSync,
): Promise<void> {
    for (const reply of replies) {
        const parent = index.get(reply.parentId);
        const text = reply.text.trim();
        if (text === "") {
            continue;
        }
        if (parent === undefined) {
            out.warnings.push(
                `reply parent ${reply.parentId} no longer exists; skipped`,
            );
            continue;
        }
        if (parent.childTexts.has(normalize(text))) {
            continue; // already present on Confluence — never double-send
        }
        try {
            await client.createReply({
                parentId: reply.parentId,
                kind: parent.kind,
                adf: replyADF(text),
            });
            out.actions.push(`replied to comment ${reply.parentId}`);
            out.changed = true;
        } catch (err) {
            out.warnings.push(
                `reply to comment ${reply.parentId} failed: ${message(err)}`,
            );
        }
    }
}

/**
 * applyResolution reports an attempt to change a thread's resolution, for an
 * inline comment only (footer comments do not resolve; an absent or unchanged
 * token is left alone). Confluence exposes no stable REST endpoint to resolve or
 * reopen an inline comment — the v2 update silently ignores `resolutionStatus` —
 * so cfsync cannot write it back. Rather than silently drop the edit or ship a
 * call that does nothing, it warns and points the user at the Confluence UI, and
 * leaves `changed` untouched so a resolution-only edit is not counted as pushed.
 */
function applyResolution(
    id: string,
    token: string,
    remote: RemoteComment,
    out: CommentSync,
): void {
    if (token === "" || remote.kind !== "inline") {
        return;
    }
    const wantResolved = token === "resolved";
    if (wantResolved === (remote.resolution === "resolved")) {
        return;
    }
    out.warnings.push(
        `comment ${id}: changing resolution to "${token}" is not supported ` +
            "via the Confluence API — resolve or reopen it in the Confluence UI",
    );
}

/**
 * replyADF builds a comment-body ADF (a raw `doc` JSON string) from a reply's
 * text: each blank-line-separated chunk becomes a paragraph, its internal
 * newlines flattened to spaces. Confluence needs a document body, so even a
 * one-line reply is wrapped in a paragraph.
 */
function replyADF(text: string): string {
    const content = text
        .split(/\n\s*\n/)
        .map((para) => para.replace(/\s+/g, " ").trim())
        .filter((para) => para !== "")
        .map((para) => ({
            type: "paragraph",
            content: [{ type: "text", text: para }],
        }));
    return JSON.stringify({ type: "doc", content });
}

/**
 * plainText extracts a comment body's text from its ADF (a `doc` JSON string),
 * normalized for the reply-dedupe comparison. A paragraph break becomes a space,
 * so it compares equal to a freshly built reply's normalized text.
 */
function plainText(adf: string): string {
    let out = "";
    try {
        const walk = (node: Node): void => {
            if (node.type === "text") {
                out += node.text ?? "";
            }
            for (const child of node.content ?? []) {
                walk(child);
            }
            if (node.type === "paragraph") {
                out += " ";
            }
        };
        walk(JSON.parse(adf) as Node);
    } catch {
        return "";
    }
    return normalize(out);
}

/** normalize collapses whitespace so two texts differing only by layout compare equal. */
function normalize(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
