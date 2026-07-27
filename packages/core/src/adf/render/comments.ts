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
