// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Comment decoration for the ADF→Markdown render. A Confluence inline comment is
// an `annotation` mark on a run of body text; its thread content lives outside
// the body ADF (fetched separately) and is threaded in through
// {@link MdCtx.comments}. This module draws each thread as a GitHub-style
// `[!comment]` callout: an inline comment's callout is appended after the
// top-level block that carries its marker (the annotated run also gets a
// `[^cf-<markerRef>]` ref, emitted by the inline renderer), and footer comments
// plus any inline thread whose marker was not found in the body collect into a
// trailing `## Comments` section. The decorations are stripped before a push
// reconstruct, so they never reach Confluence (Stage 1 is read-only).

import type { Node } from "../../models/adf.ts";
import { segmentBody } from "../parse/blocks.ts";
import {
    annotationIdsOf,
    type CommentThread,
    type MdCtx,
    type RenderComments,
    renderBlocks,
} from "./markdown.ts";

/** The heading that opens the trailing footer/orphaned-comment section. */
export const TRAILING_COMMENTS_HEADING = "## Comments";

/** Matches a `[^cf-<markerRef>]` inline anchor ref (the namespaced footnote ref). */
const COMMENT_REF_RE = /\[\^cf-[^\]]+\]/g;

/**
 * stripCommentDecorations removes the comment decorations from a note body,
 * recovering the exact comment-free body a push must reconstruct — the inverse of
 * the render's decoration. It drops every `[^cf-…]` anchor ref (each sits at a
 * text-run boundary, so removing it restores the run verbatim) and every
 * top-level `[!comment]` callout block, including the trailing `## Comments`
 * heading and the footer callouts under it. Block segmentation reuses
 * {@link segmentBody}, so a fenced code block that happens to contain a blank
 * line or a `> [!comment]` line is kept whole, never mis-split. The surviving
 * blocks re-join with a blank line, matching how the render lays out top-level
 * blocks, so the result diffs cleanly against the comment-free baseline.
 */
export function stripCommentDecorations(body: string): string {
    const noRefs = body.replace(COMMENT_REF_RE, "");
    const kept = segmentBody(noRefs).filter((b) => !isCommentBlock(b.text));
    return kept.map((b) => b.text).join("\n\n");
}

/**
 * isCommentBlock reports whether a segmented top-level block is comment
 * decoration to drop: a `[!comment]` callout (its first line is the blockquote
 * tag) or the bare `## Comments` heading that opens the trailing section.
 */
function isCommentBlock(text: string): boolean {
    const first = text.split("\n", 1)[0] ?? "";
    return (
        /^>\s*\[!comment\]/i.test(first) ||
        text.trimEnd() === TRAILING_COMMENTS_HEADING
    );
}

/** The resolution tokens a comment metadata line may carry, inline comments only. */
const RESOLUTIONS = new Set(["open", "resolved", "reopened", "dangling"]);

/** NewReply is one reply the user added to a thread, awaiting creation on push. */
export interface NewReply {
    /** The id of the ancestor comment this reply is nested under. */
    parentId: string;
    /** The reply's body text, its paragraphs separated by blank lines. */
    text: string;
}

/**
 * ParsedThread is one `[!comment]` callout read back from an edited note: the
 * top-level comment's id (`""` for a brand-new callout the user wrote, which
 * Stage 2 ignores), the resolution token on its metadata line, and the new
 * (id-less) replies nested anywhere within it. It is the inverse of the render's
 * callout, carrying only what a push needs to diff against the live thread.
 */
export interface ParsedThread {
    /** The top-level comment id, or `""` when the callout carries no `id:`. */
    id: string;
    /** The resolution token on the top metadata line, or `""` when absent. */
    resolution: string;
    /** The id-less replies the user added, flattened with their parent id. */
    newReplies: NewReply[];
}

/**
 * parseCommentThreads reads the `[!comment]` callouts back out of a note body,
 * one {@link ParsedThread} per top-level callout, in document order. It is the
 * inverse of the render's decoration and the input to the push-time comment sync:
 * a reply the user typed as an id-less nested callout surfaces as a
 * {@link NewReply}, and an edited resolution token surfaces as the thread's
 * `resolution`. Block segmentation reuses {@link segmentBody}, so a fenced code
 * block that merely looks like a callout is never mistaken for one; the trailing
 * `## Comments` heading is skipped, its footer callouts parsed like any other.
 */
export function parseCommentThreads(body: string): ParsedThread[] {
    const threads: ParsedThread[] = [];
    for (const block of segmentBody(body)) {
        const first = block.text.split("\n", 1)[0] ?? "";
        if (!/^>\s*\[!comment\]/i.test(first)) {
            continue; // not a callout (the trailing heading, or ordinary content)
        }
        const lines = block.text.split("\n").map(deprefix);
        const meta = parseMetaLine(lines[0] ?? "");
        const thread: ParsedThread = {
            id: meta.id,
            resolution: meta.resolution,
            newReplies: [],
        };
        collectNewReplies(lines.slice(1), meta.id, thread.newReplies);
        threads.push(thread);
    }
    return threads;
}

/**
 * collectNewReplies walks the reply region of a callout — the lines below a
 * comment's metadata line, already de-prefixed to that comment's level — and
 * appends every id-less nested reply to `out`, parented to the nearest ancestor
 * that has an id. Each nested `[!comment]` line opens a reply; a reply with an
 * `id:` is an existing comment whose own nested replies are walked in turn, while
 * an id-less reply is a new one to create (its text collected, its descendants
 * left for a later push, since it has no id to parent them to yet).
 */
function collectNewReplies(
    lines: string[],
    ancestorId: string,
    out: NewReply[],
): void {
    // Split the region into per-reply groups at each nested `[!comment]` line.
    for (const group of splitReplies(lines)) {
        const meta = parseMetaLine(group.meta);
        if (meta.id === "") {
            out.push({ parentId: ancestorId, text: replyText(group.rest) });
            continue;
        }
        collectNewReplies(group.rest, meta.id, out);
    }
}

/** ReplyGroup is one nested reply's metadata line and its de-prefixed remainder. */
interface ReplyGroup {
    /** The reply's `[!comment] …` metadata line, de-prefixed one level. */
    meta: string;
    /** The reply's body and nested replies, de-prefixed to the reply's level. */
    rest: string[];
}

/**
 * splitReplies partitions a comment's reply region into one {@link ReplyGroup}
 * per nested reply. A nested reply is a `>`-prefixed sub-block opening with a
 * `[!comment]` line; the lines are de-prefixed one level as they are grouped, and
 * any leading non-nested lines (the comment's own body text) are dropped.
 */
function splitReplies(lines: string[]): ReplyGroup[] {
    const groups: ReplyGroup[] = [];
    let cur: ReplyGroup | null = null;
    for (const line of lines) {
        if (!line.startsWith(">")) {
            continue; // the comment's own body, not a nested reply
        }
        const inner = deprefix(line);
        if (/^\[!comment\]/i.test(inner)) {
            cur = { meta: inner, rest: [] };
            groups.push(cur);
        } else if (cur !== null) {
            cur.rest.push(inner);
        }
    }
    return groups;
}

/** MetaLine is the parsed content of a `[!comment]` metadata line. */
interface MetaLine {
    /** The `id:` token's value, or `""` when the line carries none. */
    id: string;
    /** The resolution token, or `""` when the line carries none. */
    resolution: string;
}

/** parseMetaLine reads the `id:` and resolution tokens from a `[!comment]` line. */
function parseMetaLine(line: string): MetaLine {
    const id = line.match(/\bid:(\S+)/)?.[1] ?? "";
    let resolution = "";
    for (const token of line.split("·")) {
        const word = token.trim();
        if (RESOLUTIONS.has(word)) {
            resolution = word;
        }
    }
    return { id, resolution };
}

/**
 * replyText joins a new reply's body lines into its text, dropping blank lines at
 * the ends and collapsing the callout's bare `>` separators (de-prefixed to `""`)
 * back into the blank lines that separate paragraphs.
 */
function replyText(lines: string[]): string {
    return lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

/** deprefix strips one blockquote level (`> `, or a bare `>`) from a line. */
function deprefix(line: string): string {
    if (line.startsWith("> ")) {
        return line.slice(2);
    }
    if (line === ">") {
        return "";
    }
    if (line.startsWith(">")) {
        return line.slice(1);
    }
    return line;
}

/**
 * blockComments returns the `[!comment]` callouts for the inline threads
 * anchored within one top-level block `node`, joined by a blank line, or `""`
 * when the block carries none. A thread is matched by the id of an annotation
 * mark anywhere in the block's subtree, in document order; each matched marker is
 * added to `used` so it is neither drawn twice nor repeated in the trailing
 * section. With no comments in the context this returns `""`.
 */
export function blockComments(
    node: Node,
    ctx: MdCtx,
    used: Set<string>,
): string {
    const byMarker = ctx.comments?.byMarker;
    if (byMarker === undefined || byMarker.size === 0) {
        return "";
    }
    const parts: string[] = [];
    for (const id of annotationIdsIn(node)) {
        if (used.has(id)) {
            continue;
        }
        const thread = byMarker.get(id);
        if (thread === undefined) {
            continue;
        }
        used.add(id);
        parts.push(calloutLines(thread, ctx, 0).join("\n"));
    }
    return parts.join("\n\n");
}

/**
 * trailingComments returns the trailing `## Comments` section: the footer
 * comments plus any inline thread whose marker `used` did not cover (its anchor
 * was not found in the body — a dangling comment), each as a `[!comment]`
 * callout. It returns `""` when there is nothing to place there, so a page with
 * only anchored inline comments grows no trailing section.
 */
export function trailingComments(
    comments: RenderComments,
    ctx: MdCtx,
    used: Set<string>,
): string {
    const threads: CommentThread[] = [...comments.trailing];
    for (const [ref, thread] of comments.byMarker) {
        if (!used.has(ref)) {
            threads.push(thread);
        }
    }
    if (threads.length === 0) {
        return "";
    }
    const callouts = threads.map((t) => calloutLines(t, ctx, 0).join("\n"));
    return `${TRAILING_COMMENTS_HEADING}\n\n${callouts.join("\n\n")}`;
}

/**
 * annotationIdsIn returns the inlineComment annotation-mark ids anywhere in
 * `node`'s subtree, in document order (a marker may sit on any inline text,
 * however deeply nested). Duplicates are kept; the caller dedups via `used`.
 */
export function annotationIdsIn(node: Node): string[] {
    const out: string[] = [];
    const walk = (n: Node): void => {
        for (const id of annotationIdsOf(n)) {
            out.push(id);
        }
        for (const child of n.content ?? []) {
            walk(child);
        }
    };
    walk(node);
    return out;
}

/**
 * calloutLines renders one comment thread as the lines of a `[!comment]` callout
 * at nesting `depth` (0 for a top-level comment, +1 per reply level), each line
 * carrying the `> ` blockquote prefix repeated `depth + 1` times so a reply nests
 * inside its parent. The metadata line leads, the comment body (rendered through
 * the normal block dispatch) follows, and each reply is drawn recursively one
 * level deeper. Every line stays `>`-prefixed — no bare blank line — so the whole
 * thread is one contiguous blockquote the strip step can drop as a unit.
 */
function calloutLines(
    thread: CommentThread,
    ctx: MdCtx,
    depth: number,
): string[] {
    const prefix = "> ".repeat(depth + 1);
    const bare = prefix.trimEnd();
    const lines = [prefix + metaLine(thread)];
    const body = renderBlocks(thread.body, ctx);
    if (body !== "") {
        for (const ln of body.split("\n")) {
            lines.push(ln === "" ? bare : prefix + ln);
        }
    }
    for (const reply of thread.replies) {
        lines.push(...calloutLines(reply, ctx, depth + 1));
    }
    return lines;
}

/**
 * metaLine is the `[!comment]` tag line of a callout: the thread id, then the
 * author, timestamp, and (inline only) resolution, joined by ` · `. Empty fields
 * are omitted, so a reply — which carries no resolution — shows just id, author,
 * and date.
 */
function metaLine(thread: CommentThread): string {
    const parts = [`id:${thread.id}`];
    if (thread.authorId !== "") {
        parts.push(`@${thread.authorId}`);
    }
    if (thread.createdAt !== "") {
        parts.push(thread.createdAt);
    }
    if (thread.resolution !== "") {
        parts.push(thread.resolution);
    }
    return `[!comment] ${parts.join(" · ")}`;
}
