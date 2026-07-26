// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Comment write-back (Stage 2): syncComments reads the [!comment] callouts from
// an edited note, diffs them against the live threads, and creates replies /
// toggles resolution. Driven end-to-end through the StubHttpClient, since the
// client talks over the HttpClient port.

import { describe, expect, it } from "vitest";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { syncComments } from "../../src/sync/comments.ts";
import { StubHttpClient } from "../support/http-stub.ts";

const cfg = {
    host: "https://ex.atlassian.net",
    account: "a@ex.com",
    token: "t",
};
const v2 = "https://ex.atlassian.net/wiki/api/v2";
const adfQ = "?body-format=atlas_doc_format";

/** commentBody wraps text in the ADF body shape the fetch returns. */
const commentBody = (
    text: string,
): { atlas_doc_format: { value: string } } => ({
    atlas_doc_format: {
        value: JSON.stringify({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        }),
    },
});

/**
 * withThread stubs a page whose one inline comment C1 ("Q") has resolution
 * `resolution` and version `version`, and one existing reply C2 ("A"). Footer is
 * empty. Reply/resolve endpoints are registered so a write succeeds.
 */
function withThread(resolution: string, version = 1): StubHttpClient {
    return new StubHttpClient()
        .on("GET", `${v2}/pages/123/inline-comments${adfQ}`, {
            body: JSON.stringify({
                results: [
                    {
                        id: "C1",
                        resolutionStatus: resolution,
                        properties: { inlineMarkerRef: "M1" },
                        version: { number: version, authorId: "jsmith" },
                        body: commentBody("Q"),
                    },
                ],
                _links: {},
            }),
        })
        .on("GET", `${v2}/inline-comments/C1/children${adfQ}`, {
            body: JSON.stringify({
                results: [
                    {
                        id: "C2",
                        version: { number: 1, authorId: "rzajac" },
                        body: commentBody("A"),
                    },
                ],
                _links: {},
            }),
        })
        .on("GET", `${v2}/inline-comments/C2/children${adfQ}`, {
            body: JSON.stringify({ results: [], _links: {} }),
        })
        .on("GET", `${v2}/pages/123/footer-comments${adfQ}`, {
            body: JSON.stringify({ results: [], _links: {} }),
        })
        .on("POST", `${v2}/inline-comments`, { body: '{"id":"C7"}' })
        .on("PUT", `${v2}/inline-comments/C1`, { status: 200 });
}

const client = (stub: StubHttpClient): ConfluenceClient =>
    new ConfluenceClient(stub, cfg);

describe("syncComments", () => {
    it("creates a new untagged reply under its thread", async () => {
        const stub = withThread("open");
        const body = [
            "> [!comment] id:C1 · @jsmith · open",
            "> Q",
            "> > [!comment] id:C2 · @rzajac",
            "> > A",
            "> > [!comment]",
            "> > A fresh reply.",
        ].join("\n");

        const out = await syncComments(client(stub), "123", body);

        expect(out.actions).toEqual(["replied to comment C1"]);
        expect(out.warnings).toEqual([]);
        expect(out.changed).toBe(true);
        const post = stub.requests.find((r) => r.method === "POST");
        const sent = JSON.parse(String(post?.body));
        expect(sent.parentCommentId).toBe("C1");
        expect(sent.body.value).toContain("A fresh reply.");
    });

    it("does not re-send a reply whose text already exists (idempotent)", async () => {
        const stub = withThread("open");
        // The nested reply repeats C2's existing text "A".
        const body = [
            "> [!comment] id:C1 · @jsmith · open",
            "> Q",
            "> > [!comment]",
            "> > A",
        ].join("\n");

        const out = await syncComments(client(stub), "123", body);

        expect(out.changed).toBe(false);
        expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
    });

    it("warns that a flipped resolution cannot be written back (API limitation)", async () => {
        const stub = withThread("open");
        const body = "> [!comment] id:C1 · @jsmith · resolved\n> Q";

        const out = await syncComments(client(stub), "123", body);

        // Confluence exposes no stable REST endpoint to resolve a comment, so the
        // change is reported as unsupported rather than silently attempted.
        expect(out.actions).toEqual([]);
        expect(out.changed).toBe(false);
        expect(out.warnings[0]).toContain("not supported");
        expect(stub.requests.some((r) => r.method === "PUT")).toBe(false);
    });

    it("leaves an already-resolved thread untouched with no warning", async () => {
        const stub = withThread("resolved");
        const body = "> [!comment] id:C1 · @jsmith · resolved\n> Q";

        const out = await syncComments(client(stub), "123", body);

        expect(out.changed).toBe(false);
        expect(out.warnings).toEqual([]);
        expect(stub.requests.some((r) => r.method === "PUT")).toBe(false);
    });

    it("warns but does not throw when a reply fails", async () => {
        const stub = withThread("open").on("POST", `${v2}/inline-comments`, {
            status: 500,
        });
        const body = [
            "> [!comment] id:C1 · @jsmith · open",
            "> Q",
            "> > [!comment]",
            "> > New reply.",
        ].join("\n");

        const out = await syncComments(client(stub), "123", body);

        expect(out.actions).toEqual([]);
        expect(out.warnings[0]).toContain("reply to comment C1 failed");
        expect(out.changed).toBe(false);
    });

    it("warns when a callout references a comment that no longer exists", async () => {
        const stub = withThread("open");
        const body = "> [!comment] id:GONE · @jsmith · open\n> Stale.";

        const out = await syncComments(client(stub), "123", body);

        expect(out.warnings[0]).toContain("GONE no longer exists");
    });
});
