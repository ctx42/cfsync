// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Live-test seeding for comments. The production client does not create
// top-level comments (that is Stage 3), so the comment suites seed them here
// with a direct authenticated POST to the v2 comment API — the same calls the
// UI makes. An inline comment is created by text selection: Confluence finds the
// text in the current body and injects the matching `annotation` mark itself, so
// the seeded page only needs to contain the selected text.

import { basicAuth } from "@cfsync/core";
import type { LiveEnv } from "./live-env.ts";

/** SeededComment is the id and (inline only) marker ref of a seeded comment. */
export interface SeededComment {
    id: string;
    /** The injected annotation-mark id (inline only); `""` for a footer comment. */
    markerRef: string;
}

/**
 * seedInlineComment creates an inline comment on `pageId` anchored to the first
 * occurrence of `textSelection` in the page body, with `text` as its (plain)
 * body. Confluence injects the annotation into the body, so `textSelection` must
 * already appear there. Returns the new comment id and its injected marker ref.
 */
export async function seedInlineComment(
    env: LiveEnv,
    pageId: string,
    textSelection: string,
    text: string,
): Promise<SeededComment> {
    const body = {
        pageId,
        body: { representation: "storage", value: `<p>${text}</p>` },
        inlineCommentProperties: {
            textSelection,
            textSelectionMatchCount: 1,
            textSelectionMatchIndex: 0,
        },
    };
    const res = await post(env, "/wiki/api/v2/inline-comments", body);
    return { id: str(res["id"]), markerRef: markerRef(res) };
}

/**
 * seedFooterComment creates a page-level footer comment on `pageId` with `text`
 * as its (plain) body, returning its id.
 */
export async function seedFooterComment(
    env: LiveEnv,
    pageId: string,
    text: string,
): Promise<SeededComment> {
    const body = {
        pageId,
        body: { representation: "storage", value: `<p>${text}</p>` },
    };
    const res = await post(env, "/wiki/api/v2/footer-comments", body);
    return { id: str(res["id"]), markerRef: "" };
}

/** post sends an authenticated JSON POST and returns the parsed response object. */
async function post(
    env: LiveEnv,
    path: string,
    body: unknown,
): Promise<Record<string, unknown>> {
    const resp = await fetch(`${env.host}${path}`, {
        method: "POST",
        headers: {
            Authorization: basicAuth(env.account, env.token),
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        throw new Error(`seed comment ${path}: HTTP ${resp.status}`);
    }
    return (await resp.json()) as Record<string, unknown>;
}

/** markerRef reads the injected inline-marker ref from a create response. */
function markerRef(res: Record<string, unknown>): string {
    const props = res["properties"];
    if (typeof props === "object" && props !== null) {
        return str((props as Record<string, unknown>)["inlineMarkerRef"]);
    }
    return "";
}

/** str narrows a JSON value to a string, or `""`. */
function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}
