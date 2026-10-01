// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Comment state shared by pull and push. Pull projects the fetched comments onto
// the render ({@link toRenderComments}) and records the inline threads it drew
// into a per-page sidecar (`<name>.comments.json` in the ADF cache). Push reads
// that record back to tell which threads the user removed from the note — the
// callout and its `[^cf-…]` anchor both gone — and resolves them on Confluence,
// refusing when only one of the two was removed ({@link planResolves}) or when
// the thread changed on Confluence since the pull ({@link checkDrift}).

import { segmentBody } from "../adf/parse/blocks.ts";
import { annotationIdsIn } from "../adf/render/comments.ts";
import type { CommentThread, RenderComments } from "../adf/render/markdown.ts";
import type { PageComment, PageComments } from "../confluence/client.ts";
import type { ADF, Node } from "../models/adf.ts";
import type { FileSystem } from "../ports/fs.ts";
import { posixJoin } from "../util/path.ts";

/** The resolution word marking a settled comment, dropped on pull. */
const RESOLVED = "resolved";

/** Matches a `[^cf-<markerRef>]` anchor ref, capturing the marker. */
const ANCHOR_RE = /\[\^cf-([^\]]+)\]/g;

/** Matches a top-level callout's tag line, capturing the comment id. */
const CALLOUT_RE = /^>\s*\[!comment\]\s+id:(\S+)/i;

/**
 * toRenderComments projects the client's fetched {@link PageComments} onto the
 * render's {@link RenderComments}: inline comments carrying a marker are keyed by
 * it for anchor placement, and footer (page-level) comments become trailing
 * threads. Each comment's ADF body is parsed to its block nodes for the callout.
 *
 * Only comments Confluence shows on the page are kept, so the note matches the CF
 * view. Dropped: resolved comments of either kind (a settled thread), and inline
 * comments with no marker (unanchored). A marker that survives here but is not found in the
 * body at render time is dangling — its highlighted text was deleted, so CF hides
 * it — and the render drops it too.
 */
export function toRenderComments(comments: PageComments): RenderComments {
    const byMarker = new Map<string, CommentThread>();
    const trailing: CommentThread[] = [];
    for (const c of openInline(comments)) {
        byMarker.set(c.markerRef, toThread(c));
    }
    for (const c of comments.footer) {
        if (c.resolution !== RESOLVED) {
            trailing.push(toThread(c));
        }
    }
    return { byMarker, trailing };
}

/** openInline returns the inline comments a pull renders: unresolved, with a marker. */
function openInline(comments: PageComments): PageComment[] {
    return comments.inline.filter(
        (c) => c.resolution !== RESOLVED && c.markerRef !== "",
    );
}

/** countComments totals a comment list including every nested reply. */
export function countComments(comments: PageComment[]): number {
    let n = 0;
    for (const c of comments) {
        n += 1 + countComments(c.replies);
    }
    return n;
}

/** toThread maps one {@link PageComment} (and its replies) to a {@link CommentThread}. */
function toThread(comment: PageComment): CommentThread {
    return {
        id: comment.id,
        markerRef: comment.markerRef,
        resolution: comment.resolution,
        authorId: comment.authorId,
        createdAt: comment.createdAt,
        body: commentBody(comment.adf),
        replies: comment.replies.map(toThread),
    };
}

/**
 * commentBody parses a comment's ADF body (a `doc` JSON string) to its top-level
 * block nodes, the content the callout renders. An unparseable or malformed body
 * yields no blocks, so the callout still shows its metadata line.
 */
function commentBody(adf: string): Node[] {
    try {
        const doc = JSON.parse(adf) as { content?: Node[] };
        return Array.isArray(doc.content) ? doc.content : [];
    } catch {
        return [];
    }
}

/** RecordedComment is one comment of a recorded thread: its id and version. */
export interface RecordedComment {
    id: string;
    version: number;
}

/**
 * RecordedThread is an inline thread as a pull rendered it: the root comment's
 * id, marker, highlighted text and version, plus every reply (at any depth) by
 * id and version — what push compares against the live thread.
 */
export interface RecordedThread {
    id: string;
    markerRef: string;
    anchorText: string;
    version: number;
    replies: RecordedComment[];
}

/**
 * recordThreads returns the inline threads a render of `doc` with `comments`
 * draws: open, with a marker the body carries. A dangling thread is left out,
 * so it is never mistaken for one the user removed.
 */
export function recordThreads(
    comments: PageComments,
    doc: ADF,
): RecordedThread[] {
    const present = new Set(annotationIdsIn(doc.doc));
    const out: RecordedThread[] = [];
    const seen = new Set<string>();
    for (const c of openInline(comments)) {
        if (!present.has(c.markerRef) || seen.has(c.markerRef)) {
            continue;
        }
        seen.add(c.markerRef);
        out.push({
            id: c.id,
            markerRef: c.markerRef,
            anchorText: c.anchorText,
            version: c.version,
            replies: flatReplies(c.replies),
        });
    }
    return out;
}

/** flatReplies lists every reply under a thread, depth-first, by id and version. */
function flatReplies(replies: PageComment[]): RecordedComment[] {
    const out: RecordedComment[] = [];
    for (const r of replies) {
        out.push({ id: r.id, version: r.version });
        out.push(...flatReplies(r.replies));
    }
    return out;
}

/** recordPath is the sidecar path of page `name` under `cacheDir`. */
function recordPath(cacheDir: string, name: string): string {
    const base = name.endsWith(".md") ? name.slice(0, -3) : name;
    return posixJoin(cacheDir, `${base}.comments.json`);
}

/** writeRecord stores the threads rendered into page `name`'s note. */
export async function writeRecord(
    fs: FileSystem,
    cacheDir: string,
    name: string,
    threads: RecordedThread[],
): Promise<void> {
    const data = `${JSON.stringify({ threads }, null, 2)}\n`;
    await fs.write(recordPath(cacheDir, name), data);
}

/**
 * readRecord returns the threads last rendered into page `name`'s note, or an
 * empty list when no record exists or it is unreadable — then nothing is
 * resolvable, and the next pull restores any callout the user removed.
 */
export async function readRecord(
    fs: FileSystem,
    cacheDir: string,
    name: string,
): Promise<RecordedThread[]> {
    const path = recordPath(cacheDir, name);
    try {
        if (!(await fs.exists(path))) {
            return [];
        }
        const parsed = JSON.parse(await fs.readText(path)) as {
            threads?: unknown;
        };
        return Array.isArray(parsed.threads)
            ? (parsed.threads as RecordedThread[])
            : [];
    } catch {
        return [];
    }
}

/**
 * noteMarks returns the comment ids of the note body's top-level `[!comment]`
 * callouts and the markers of its `[^cf-…]` anchors. Replies (nested callouts)
 * and fenced code are not callouts.
 */
function noteMarks(body: string): {
    callouts: Set<string>;
    anchors: Set<string>;
} {
    const callouts = new Set<string>();
    for (const b of segmentBody(body)) {
        const first = b.text.split("\n", 1)[0] ?? "";
        const m = CALLOUT_RE.exec(first);
        if (m?.[1] !== undefined) {
            callouts.add(m[1]);
        }
    }
    const anchors = new Set<string>();
    for (const m of body.matchAll(ANCHOR_RE)) {
        if (m[1] !== undefined) {
            anchors.add(m[1]);
        }
    }
    return { callouts, anchors };
}

/**
 * planResolves returns the recorded threads the note body no longer carries —
 * both the callout and the anchor removed — which push resolves. It throws when
 * a thread lost only one of the two, naming each such comment, since that edit
 * is ambiguous: remove both to resolve, or neither to keep the comment.
 */
export function planResolves(
    threads: RecordedThread[],
    body: string,
): RecordedThread[] {
    const { callouts, anchors } = noteMarks(body);
    const resolve: RecordedThread[] = [];
    const half: string[] = [];
    for (const t of threads) {
        const hasCallout = callouts.has(t.id);
        const hasAnchor = anchors.has(t.markerRef);
        if (!hasCallout && !hasAnchor) {
            resolve.push(t);
        } else if (hasCallout !== hasAnchor) {
            half.push(
                `id:${t.id} (${hasCallout ? "anchor" : "callout"} removed)`,
            );
        }
    }
    if (half.length > 0) {
        throw new Error(
            `comment half-removed: ${half.join(", ")}; remove both the ` +
                "[!comment] callout and its [^cf-…] anchor to resolve it, " +
                "or restore the removed part",
        );
    }
    return resolve;
}

/** Resolution is the outcome of checking one thread to resolve against Confluence. */
export interface Resolution {
    thread: RecordedThread;
    /** The live root comment to resolve, or null when it is already done. */
    live: PageComment | null;
    /** Why it needs no resolve (`already resolved`/`already deleted`), else `""`. */
    done: string;
}

/**
 * checkDrift matches each thread to resolve with its live counterpart in
 * `comments`. A thread gone from Confluence or already resolved is done. It
 * throws, asking for a pull, when a live thread changed since the record — a
 * reply added or removed, or any comment's version bumped — so a reply the user
 * has not seen is never resolved away.
 */
export function checkDrift(
    threads: RecordedThread[],
    comments: PageComments,
): Resolution[] {
    const byId = new Map(comments.inline.map((c) => [c.id, c]));
    const out: Resolution[] = [];
    const drifted: string[] = [];
    for (const t of threads) {
        const live = byId.get(t.id);
        if (live === undefined) {
            out.push({ thread: t, live: null, done: "already deleted" });
            continue;
        }
        if (live.resolution === RESOLVED) {
            out.push({ thread: t, live: null, done: "already resolved" });
            continue;
        }
        if (changed(t, live)) {
            drifted.push(`id:${t.id}`);
            continue;
        }
        out.push({ thread: t, live, done: "" });
    }
    if (drifted.length > 0) {
        throw new Error(
            `comment changed on Confluence since the last pull: ` +
                `${drifted.join(", ")}; pull first`,
        );
    }
    return out;
}

/** changed reports whether the live thread differs from its record. */
function changed(t: RecordedThread, live: PageComment): boolean {
    if (live.version !== t.version) {
        return true;
    }
    const have = flatReplies(live.replies);
    if (have.length !== t.replies.length) {
        return true;
    }
    return have.some((r, i) => {
        const want = t.replies[i];
        return (
            want === undefined || r.id !== want.id || r.version !== want.version
        );
    });
}

/** describe is a resolve's report line text: the comment id and its highlighted text. */
export function describe(t: RecordedThread): string {
    const text = t.anchorText.replace(/\s+/g, " ").trim();
    return text === "" ? `id:${t.id}` : `id:${t.id} "${text}"`;
}
