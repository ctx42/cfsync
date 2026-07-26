// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Comment decoration of the render (Stage 1, read-only): an inline comment adds
// a `[^cf-<markerRef>]` anchor after its annotated run and a `[!comment]` callout
// after the block that carries the marker; a footer comment collects into the
// trailing `## Comments` section. The comment-free path is unchanged — with no
// comments in the render opts the output is byte-identical (covered by the
// existing sourcemap/markdown suites).

import { describe, expect, it } from "vitest";
import {
    parseCommentThreads,
    stripCommentDecorations,
} from "../../../src/adf/render/comments.ts";
import type {
    CommentThread,
    RenderComments,
} from "../../../src/adf/render/markdown.ts";
import { obsidianFlavor } from "../../../src/flavor/obsidian/index.ts";
import { newADF } from "../../../src/models/adf.ts";

/** para builds a one-paragraph comment body (the ADF the callout renders). */
const para = (text: string): CommentThread["body"] => [
    { type: "paragraph", content: [{ type: "text", text }] },
];

/** render runs the Obsidian flavor and returns the body after the frontmatter. */
function body(data: string, comments: RenderComments): string {
    const md = obsidianFlavor.render(newADF(data), {
        assets: {},
        links: null,
        comments,
    })[0];
    return md
        .slice(md.indexOf("\n---\n") + "\n---\n".length)
        .replace(/^\n+/, "")
        .replace(/\n+$/, "");
}

describe("comment decoration", () => {
    // A paragraph whose middle run carries an inlineComment annotation "M1".
    const doc = `{
       "adf": { "type": "doc", "content": [
          { "type": "paragraph", "content": [
             { "type": "text", "text": "The clause " },
             { "type": "text", "text": "needs a source",
               "marks": [ { "type": "annotation",
                 "attrs": { "id": "M1", "annotationType": "inlineComment" } } ] },
             { "type": "text", "text": "." } ] },
          { "type": "paragraph", "content": [
             { "type": "text", "text": "Next paragraph." } ] }
       ] }
    }`;

    it("anchors an inline comment and appends its callout after the block", () => {
        const thread: CommentThread = {
            id: "C1",
            markerRef: "M1",
            resolution: "open",
            authorId: "jsmith",
            createdAt: "2026-07-20T10:00:00Z",
            body: para("Where's this from?"),
            replies: [
                {
                    id: "C2",
                    markerRef: "",
                    resolution: "",
                    authorId: "rzajac",
                    createdAt: "2026-07-21T09:00:00Z",
                    body: para("Added in the appendix."),
                    replies: [],
                },
            ],
        };
        const comments: RenderComments = {
            byMarker: new Map([["M1", thread]]),
            trailing: [],
        };

        // The ref is appended after the whole text run (never splitting it), so
        // with the run being the entire paragraph it lands after the period —
        // which also reads as a conventional footnote ref after punctuation.
        expect(body(doc, comments)).toBe(
            [
                "The clause needs a source.[^cf-M1]",
                "",
                "> [!comment] id:C1 · @jsmith · 2026-07-20T10:00:00Z · open",
                "> Where's this from?",
                "> > [!comment] id:C2 · @rzajac · 2026-07-21T09:00:00Z",
                "> > Added in the appendix.",
                "",
                "Next paragraph.",
            ].join("\n"),
        );
    });

    it("collects a footer comment into the trailing section", () => {
        const footer: CommentThread = {
            id: "F1",
            markerRef: "",
            resolution: "",
            authorId: "jsmith",
            createdAt: "2026-07-22T08:00:00Z",
            body: para("Page-level note."),
            replies: [],
        };
        const comments: RenderComments = {
            byMarker: new Map(),
            trailing: [footer],
        };

        expect(body(doc, comments)).toBe(
            [
                "The clause needs a source.",
                "",
                "Next paragraph.",
                "",
                "## Comments",
                "",
                "> [!comment] id:F1 · @jsmith · 2026-07-22T08:00:00Z",
                "> Page-level note.",
            ].join("\n"),
        );
    });

    it("strips back to the exact comment-free body, and the strip is a no-op on the ADF", () => {
        // A doc whose fenced code block contains both a blank line and a line
        // that looks like a callout tag — neither must confuse the strip.
        const tricky = `{
           "adf": { "type": "doc", "content": [
              { "type": "paragraph", "content": [
                 { "type": "text", "text": "Before " },
                 { "type": "text", "text": "here",
                   "marks": [ { "type": "annotation",
                     "attrs": { "id": "M1", "annotationType": "inlineComment" } } ] } ] },
              { "type": "codeBlock", "attrs": { "language": "text" },
                "content": [ { "type": "text",
                  "text": "line1\\n\\n> [!comment] not a real callout\\nline2" } ] },
              { "type": "paragraph", "content": [
                 { "type": "text", "text": "After." } ] }
           ] }
        }`;
        const thread: CommentThread = {
            id: "C1",
            markerRef: "M1",
            resolution: "open",
            authorId: "jsmith",
            createdAt: "2026-07-20T10:00:00Z",
            body: para("A question."),
            replies: [],
        };
        const footer: CommentThread = {
            id: "F1",
            markerRef: "",
            resolution: "",
            authorId: "jsmith",
            createdAt: "2026-07-22T08:00:00Z",
            body: para("Page note."),
            replies: [],
        };
        const comments: RenderComments = {
            byMarker: new Map([["M1", thread]]),
            trailing: [footer],
        };
        const empty: RenderComments = { byMarker: new Map(), trailing: [] };

        const decorated = body(tricky, comments);
        const clean = body(tricky, empty);
        // Sanity: the decoration really did add the anchor, callout, and section.
        expect(decorated).toContain("[^cf-M1]");
        expect(decorated).toContain("[!comment]");
        expect(decorated).toContain("## Comments");

        // The strip recovers the comment-free body exactly — the fenced code
        // block (blank line and callout-looking line included) survives whole.
        expect(stripCommentDecorations(decorated)).toBe(clean);

        // And feeding the stripped body back through reconstruct is a no-op: the
        // ADF is identical to the cached baseline, so a push would PUT nothing.
        const base = newADF(tricky);
        const rebuilt = obsidianFlavor.reconstruct(
            base,
            stripCommentDecorations(decorated),
            { mentions: null, assets: null, images: null, links: null },
        );
        expect(JSON.stringify(rebuilt.doc)).toBe(JSON.stringify(base.doc));
    });

    it("puts an inline comment whose marker is absent from the body in the trailing section", () => {
        const orphan: CommentThread = {
            id: "C9",
            markerRef: "GONE",
            resolution: "dangling",
            authorId: "jsmith",
            createdAt: "2026-07-23T08:00:00Z",
            body: para("Anchor text was edited away."),
            replies: [],
        };
        const comments: RenderComments = {
            byMarker: new Map([["GONE", orphan]]),
            trailing: [],
        };

        const out = body(doc, comments);
        expect(out).not.toContain("[^cf-");
        expect(out).toContain("## Comments");
        expect(out).toContain("> [!comment] id:C9 · @jsmith");
        expect(out).toContain("dangling");
    });
});

describe("parseCommentThreads", () => {
    it("reads id and resolution, and finds a new untagged reply", () => {
        const body = [
            "> [!comment] id:C1 · @jsmith · 2026-07-20T10:00:00Z · open",
            "> Where from?",
            "> > [!comment] id:C2 · @rzajac · 2026-07-21T09:00:00Z",
            "> > The appendix.",
            "> > [!comment]",
            "> > Actually section 4.",
        ].join("\n");

        expect(parseCommentThreads(body)).toEqual([
            {
                id: "C1",
                resolution: "open",
                newReplies: [{ parentId: "C1", text: "Actually section 4." }],
            },
        ]);
    });

    it("reflects an edited resolution token", () => {
        const body = "> [!comment] id:C1 · @jsmith · resolved\n> Where from?";
        expect(parseCommentThreads(body)[0]).toMatchObject({
            id: "C1",
            resolution: "resolved",
            newReplies: [],
        });
    });

    it("parents a new reply nested under an existing reply", () => {
        const body = [
            "> [!comment] id:C1 · @jsmith · open",
            "> Q",
            "> > [!comment] id:C2 · @rzajac",
            "> > A",
            "> > > [!comment]",
            "> > > follow-up",
        ].join("\n");

        expect(parseCommentThreads(body)[0]?.newReplies).toEqual([
            { parentId: "C2", text: "follow-up" },
        ]);
    });

    it("ignores non-callout blocks and the trailing heading", () => {
        const body = [
            "Just a paragraph.",
            "",
            "## Comments",
            "",
            "> [!comment] id:F1 · @jsmith",
            "> Page note.",
        ].join("\n");

        expect(parseCommentThreads(body).map((t) => t.id)).toEqual(["F1"]);
    });
});
