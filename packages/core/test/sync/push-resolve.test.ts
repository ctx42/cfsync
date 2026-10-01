// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Push resolving inline comments the user removed from a note: both the
// `[!comment]` callout and the `[^cf-…]` anchor gone resolves the thread; one
// without the other, or a thread changed on Confluence since the pull, fails the
// push before any write.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { type Node, newADF } from "../../src/models/adf.ts";
import type { HttpRequest, HttpResponse } from "../../src/ports/http.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import type { Yaml } from "../../src/ports/yaml.ts";
import {
    type RecordedThread,
    readRecord,
    toRenderComments,
} from "../../src/sync/comments.ts";
import { Pusher, pushPreflight } from "../../src/sync/push.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const yaml: Yaml = { parse: (t) => parseYaml(t) };
const v2 = "https://ex.atlassian.net/wiki/api/v2";
const adfQ = "?body-format=atlas_doc_format";
const pageURL = `${v2}/pages/123${adfQ}`;
const putURL = `${v2}/pages/123`;
const inlineURL = `${v2}/pages/123/inline-comments${adfQ}`;
const footerURL = `${v2}/pages/123/footer-comments${adfQ}`;
const resolveURL = (id: string): string => `${v2}/inline-comments/${id}`;
const childrenURL = (id: string): string =>
    `${v2}/inline-comments/${id}/children${adfQ}`;

const cfg = (comments = true): Config =>
    buildConfig(
        { comments },
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );

/** marked is a text run carrying the inline-comment annotation `marker`. */
const marked = (text: string, marker: string): Node => ({
    type: "text",
    text,
    marks: [
        {
            type: "annotation",
            attrs: { id: marker, annotationType: "inlineComment" },
        },
    ],
});

/** para is a localId-tagged paragraph of the given inline runs. */
const para = (localId: string, ...content: Node[]): Node => ({
    type: "paragraph",
    attrs: { localId },
    content,
});

const text = (t: string): Node => ({ type: "text", text: t });

/** The page: "keep" plus two commented paragraphs (C1 on M1, C2 on M2). */
const doc: Node & { version: number } = {
    version: 1,
    type: "doc",
    content: [
        para("a", text("keep")),
        para("b", text("Change "), marked("data type", "M1"), text(" now.")),
        para("c", text("Also "), marked("the label", "M2"), text(".")),
    ],
};

function wrapper(version: number): string {
    return JSON.stringify({
        name: "p.md",
        id: "123",
        title: "My Page",
        version,
        space_id: "9",
        adf: doc,
    });
}

function livePage(version: number): string {
    return JSON.stringify({
        id: "123",
        title: "My Page",
        spaceId: "9",
        parentId: "",
        version: { number: version },
        body: { atlas_doc_format: { value: JSON.stringify(doc) } },
    });
}

/** LiveComment describes one inline comment the stub serves. */
interface LiveComment {
    id: string;
    marker: string;
    selection: string;
    status?: string;
    version?: number;
    replies?: { id: string; version: number }[];
}

const C1: LiveComment = { id: "C1", marker: "M1", selection: "data type" };
const C2: LiveComment = { id: "C2", marker: "M2", selection: "the label" };

const commentJSON = (
    c: { id: string; version?: number },
    extra: Record<string, unknown> = {},
) => ({
    id: c.id,
    version: { authorId: "u", createdAt: "", number: c.version ?? 1 },
    body: {
        atlas_doc_format: {
            value: JSON.stringify({
                type: "doc",
                content: [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text: `say ${c.id}` }],
                    },
                ],
            }),
        },
    },
    ...extra,
});

/**
 * ResolvingStub serves the page and its comments, and once a comment is
 * resolved through it, lists that comment as resolved from then on.
 */
class ResolvingStub extends StubHttpClient {
    constructor(
        private comments: LiveComment[],
        footer: { id: string }[] = [],
    ) {
        super();
        this.on("GET", pageURL, { body: livePage(3) })
            .on("PUT", putURL, { status: 200 })
            .on("GET", footerURL, {
                body: JSON.stringify({
                    results: footer.map((f) => commentJSON(f)),
                    _links: {},
                }),
            });
        for (const f of footer) {
            this.on("GET", `${v2}/footer-comments/${f.id}/children${adfQ}`, {
                body: JSON.stringify({ results: [], _links: {} }),
            });
        }
        this.serve();
    }

    /** serve (re)registers the inline-comment listing and reply routes. */
    private serve(): void {
        this.on("GET", inlineURL, {
            body: JSON.stringify({
                results: this.comments.map((c) =>
                    commentJSON(c, {
                        resolutionStatus: c.status ?? "open",
                        properties: {
                            inlineMarkerRef: c.marker,
                            inlineOriginalSelection: c.selection,
                        },
                    }),
                ),
                _links: {},
            }),
        });
        for (const c of this.comments) {
            this.on("GET", childrenURL(c.id), {
                body: JSON.stringify({
                    results: (c.replies ?? []).map((r) => commentJSON(r)),
                    _links: {},
                }),
            });
            for (const r of c.replies ?? []) {
                this.on("GET", childrenURL(r.id), {
                    body: JSON.stringify({ results: [], _links: {} }),
                });
            }
            if (!this.routed(c.id)) {
                this.on("PUT", resolveURL(c.id), { status: 200 });
            }
        }
    }

    private readonly failing = new Set<string>();

    /** failResolve makes resolving comment `id` answer HTTP 500. */
    failResolve(id: string): this {
        this.failing.add(id);
        this.on("PUT", resolveURL(id), { status: 500 });
        return this;
    }

    private routed(id: string): boolean {
        return this.failing.has(id);
    }

    override async do(request: HttpRequest): Promise<HttpResponse> {
        const resp = await super.do(request);
        const id = request.url.startsWith(`${v2}/inline-comments/`)
            ? request.url.slice(`${v2}/inline-comments/`.length)
            : "";
        if (request.method === "PUT" && resp.status === 200 && id !== "") {
            this.comments = this.comments.map((c) =>
                c.id === id ? { ...c, status: "resolved" } : c,
            );
            this.serve();
        }
        return resp;
    }

    /** writes are the non-GET requests sent. */
    writes(): HttpRequest[] {
        return this.requests.filter((r) => r.method !== "GET");
    }
}

/** recorded is the pull-time record of a served comment. */
const recorded = (c: LiveComment): RecordedThread => ({
    id: c.id,
    markerRef: c.marker,
    anchorText: c.selection,
    version: c.version ?? 1,
    replies: (c.replies ?? []).map((r) => ({ id: r.id, version: r.version })),
});

/**
 * pulled renders the note as a pull with `comments` would, and seeds the cache:
 * the v3 baseline ADF and render, and the comment record.
 */
async function pulled(
    fs: MemFS,
    comments: LiveComment[],
    footer: { id: string }[] = [],
): Promise<string> {
    const asPage = (c: { id: string; version?: number }) => ({
        id: c.id,
        kind: "inline" as const,
        resolution: "open",
        markerRef: "",
        anchorText: "",
        authorId: "u",
        createdAt: "",
        version: c.version ?? 1,
        adf: commentJSON(c).body.atlas_doc_format.value,
        replies: [],
    });
    const md = obsidianFlavor.render(newADF(wrapper(3)), {
        assets: {},
        links: null,
        comments: toRenderComments({
            inline: comments.map((c) => ({
                ...asPage(c),
                markerRef: c.marker,
                anchorText: c.selection,
                replies: (c.replies ?? []).map(asPage),
            })),
            footer: footer.map((f) => ({ ...asPage(f), kind: "footer" })),
        }),
    })[0];
    await fs.write("/vault/p.md", md);
    await fs.write("/data/cache/p.v3.json", wrapper(3));
    await fs.write("/data/cache/p.v3.md", md);
    await fs.write(
        "/data/cache/p.comments.json",
        JSON.stringify({ threads: comments.map(recorded) }),
    );
    return md;
}

/** edit rewrites the note through `f`. */
async function edit(fs: MemFS, f: (md: string) => string): Promise<void> {
    await fs.write("/vault/p.md", f(await fs.readText("/vault/p.md")));
}

/** dropCallout removes comment `id`'s top-level callout block. */
const dropCallout =
    (id: string) =>
    (md: string): string =>
        md.replace(
            new RegExp(`\\n\\n> \\[!comment\\] id:${id} [^\\n]*(\\n>[^\\n]*)*`),
            "",
        );

/** dropAnchor removes the `[^cf-<marker>]` anchor. */
const dropAnchor =
    (marker: string) =>
    (md: string): string =>
        md.replace(`[^cf-${marker}]`, "");

function pusherFor(stub: StubHttpClient, fs: MemFS, config = cfg()): Pusher {
    return new Pusher({
        client: new ConfluenceClient(stub, {
            host: config.host,
            account: config.account,
            token: config.token,
        }),
        fs,
        yaml,
        config,
        reporter: new NoopReporter(),
        cacheDir: "/data/cache",
        assetsDir: "/vault/_cfsync-media",
        mintLocalId: () => "L0",
        links: null,
        flavor: obsidianFlavor,
    });
}

describe("Pusher resolving removed comments", () => {
    it("renders the fixture note with both callouts and anchors", async () => {
        const fs = new MemFS();
        const md = await pulled(fs, [C1, C2]);

        expect(md).toContain("Change data type now.[^cf-M1]");
        expect(md).toContain("> [!comment] id:C1");
        expect(md).toContain("> [!comment] id:C2");
    });

    it("resolves a comment whose callout and anchor were removed, without a page update", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1, C2]);
        await edit(fs, (md) => dropAnchor("M1")(dropCallout("C1")(md)));
        const stub = new ResolvingStub([C1, C2]);

        const have = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(have).toEqual({
            changed: true,
            version: 3,
            warning: "",
            lines: ['resolved comment id:C1 "data type"'],
        });
        const writes = stub.writes();
        expect(writes.map((r) => r.url)).toEqual([resolveURL("C1")]);
        expect(JSON.parse(String(writes[0]?.body))).toMatchObject({
            version: { number: 2 },
            resolved: true,
        });
        // The refresh re-renders from the live comments: C1 gone, C2 kept.
        const note = await fs.readText("/vault/p.md");
        expect(note).not.toContain("id:C1");
        expect(note).toContain("> [!comment] id:C2");
        expect(note).toContain("page_version: 3");
        expect(await fs.readText("/data/cache/p.v3.md")).toBe(note);
        const record = await readRecord(fs, "/data/cache", "p.md");
        expect(record.map((t) => t.id)).toEqual(["C2"]);
    });

    it("fails when only the callout was removed, sending nothing", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, dropCallout("C1"));
        const stub = new ResolvingStub([C1]);

        const err = await pusherFor(stub, fs)
            .pushOne("/vault/p.md")
            .catch((e: unknown) => e as Error);

        if (!(err instanceof Error)) throw err;
        expect(err.message).toContain("comment half-removed: id:C1");
        expect(err.message).toContain("callout removed");
        expect(stub.writes()).toEqual([]);
    });

    it("fails when only the anchor was removed, sending nothing", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, (md) => dropAnchor("M1")(md).replace("keep", "kept"));
        const stub = new ResolvingStub([C1]);

        const err = await pusherFor(stub, fs)
            .pushOne("/vault/p.md")
            .catch((e: unknown) => e as Error);

        if (!(err instanceof Error)) throw err;
        expect(err.message).toContain("comment half-removed: id:C1");
        expect(err.message).toContain("anchor removed");
        expect(stub.writes()).toEqual([]);
    });

    it("resolves, not relocates, when the commented paragraph goes with its callout", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1, C2]);
        await edit(fs, (md) =>
            dropCallout("C1")(md).replace(
                /\n\nChange data type now\.\[\^cf-M1\]/,
                "",
            ),
        );
        const stub = new ResolvingStub([C1, C2]);

        const have = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(have.changed).toBe(true);
        expect(have.version).toBe(4);
        expect(have.warning).toBe("");
        expect(have.lines).toEqual(['resolved comment id:C1 "data type"']);
        const writes = stub.writes();
        expect(writes.map((r) => `${r.method} ${r.url}`)).toEqual([
            `PUT ${putURL}`,
            `PUT ${resolveURL("C1")}`,
        ]);
        const pushed = String(writes[0]?.body);
        expect(pushed).not.toContain("data type");
        expect(pushed).not.toContain('\\"M1\\"');
        expect(pushed).toContain('\\"M2\\"');
    });

    it("still relocates a comment whose anchor stays while its text is rewritten", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, (md) =>
            md.replace("Change data type now.[^cf-M1]", "Swap it now.[^cf-M1]"),
        );
        const stub = new ResolvingStub([C1]);

        const have = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(have.lines).toEqual([]);
        expect(have.warning).toContain("moved 1 open Confluence comment(s)");
        expect(stub.writes().map((r) => r.url)).toEqual([putURL]);
    });

    it("fails asking for a pull when a reply was added since the pull", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, (md) => dropAnchor("M1")(dropCallout("C1")(md)));
        const stub = new ResolvingStub([
            { ...C1, replies: [{ id: "R1", version: 1 }] },
        ]);

        const err = await pusherFor(stub, fs)
            .pushOne("/vault/p.md")
            .catch((e: unknown) => e as Error);

        if (!(err instanceof Error)) throw err;
        expect(err.message).toBe(
            "comment changed on Confluence since the last pull: id:C1; pull first",
        );
        expect(stub.writes()).toEqual([]);
    });

    it("fails asking for a pull when a comment was edited since the pull", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, (md) => dropAnchor("M1")(dropCallout("C1")(md)));
        const stub = new ResolvingStub([{ ...C1, version: 2 }]);

        const err = await pusherFor(stub, fs)
            .pushOne("/vault/p.md")
            .catch((e: unknown) => e as Error);

        if (!(err instanceof Error)) throw err;
        expect(err.message).toContain("pull first");
        expect(stub.writes()).toEqual([]);
    });

    it("reports a thread already resolved or deleted on Confluence as done", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1, C2]);
        await edit(fs, (md) =>
            dropAnchor("M2")(
                dropCallout("C2")(dropAnchor("M1")(dropCallout("C1")(md))),
            ),
        );
        const stub = new ResolvingStub([{ ...C1, status: "resolved" }]);

        const have = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(have.changed).toBe(false);
        expect(have.lines).toEqual([
            'already resolved comment id:C1 "data type"',
            'already deleted comment id:C2 "the label"',
        ]);
        expect(stub.writes()).toEqual([]);
    });

    it("keeps the pushed page and warns when a resolve fails after the update", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, (md) =>
            dropAnchor("M1")(dropCallout("C1")(md)).replace("keep", "kept"),
        );
        const stub = new ResolvingStub([C1]).failResolve("C1");

        const have = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(have.changed).toBe(true);
        expect(have.version).toBe(4);
        expect(have.lines).toEqual([]);
        expect(have.warning).toBe(
            "resolving comment(s) failed: id:C1 (resolve comment C1: HTTP 500)",
        );
        // C1 is still open, so the refreshed note brings its callout back.
        const note = await fs.readText("/vault/p.md");
        expect(note).toContain("> [!comment] id:C1");
        expect(note).toContain("page_version: 4");
    });

    it("resolves nothing when the page update fails", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, (md) =>
            dropAnchor("M1")(dropCallout("C1")(md)).replace("keep", "kept"),
        );
        const stub = new ResolvingStub([C1]);
        stub.on("PUT", putURL, { status: 500 });

        await expect(
            pusherFor(stub, fs).pushOne("/vault/p.md"),
        ).rejects.toThrow("HTTP 500");
        expect(stub.writes().map((r) => r.url)).toEqual([putURL]);
    });

    it("keeps other callouts in the note after a page update", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1, C2]);
        await edit(fs, (md) => md.replace("keep", "kept"));
        const stub = new ResolvingStub([C1, C2]);

        const have = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(have.version).toBe(4);
        const note = await fs.readText("/vault/p.md");
        expect(note).toContain("kept");
        expect(note).toContain("> [!comment] id:C1");
        expect(note).toContain("> [!comment] id:C2");
        expect(await fs.readText("/data/cache/p.v4.md")).toBe(note);
        const record = await readRecord(fs, "/data/cache", "p.md");
        expect(record.map((t) => t.id)).toEqual(["C1", "C2"]);
    });

    it("ignores a removed footer comment", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1], [{ id: "F1" }]);
        await edit(fs, (md) =>
            md.replace(/\n\n> \[!comment\] id:F1 [^\n]*(\n>[^\n]*)*/, ""),
        );
        const stub = new ResolvingStub([C1], [{ id: "F1" }]);

        const have = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(have.changed).toBe(false);
        expect(stub.writes()).toEqual([]);
    });

    it("ignores a removed reply", async () => {
        const fs = new MemFS();
        const withReply = { ...C1, replies: [{ id: "R1", version: 1 }] };
        await pulled(fs, [withReply]);
        await edit(fs, (md) =>
            md.replace(/\n> > \[!comment\] id:R1 [^\n]*(\n> >[^\n]*)*/, ""),
        );
        const stub = new ResolvingStub([withReply]);

        const have = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(have.changed).toBe(false);
        expect(stub.writes()).toEqual([]);
    });

    it("never resolves with comments off", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, (md) => dropAnchor("M1")(dropCallout("C1")(md)));
        const stub = new ResolvingStub([C1]);

        const have = await pusherFor(stub, fs, cfg(false)).pushOne(
            "/vault/p.md",
        );

        expect(have.changed).toBe(false);
        expect(stub.requests.some((r) => r.url.includes("comments"))).toBe(
            false,
        );
    });

    it("reports resolves in the batch log", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1]);
        await edit(fs, (md) => dropAnchor("M1")(dropCallout("C1")(md)));
        const stub = new ResolvingStub([C1]);

        const out = await pusherFor(stub, fs).pushDests(["/vault/p.md"]);

        expect(out.errors).toEqual([]);
        expect(out.log).toBe(
            "pushing p.md ... ok (v3)\n" +
                '      resolved comment id:C1 "data type"\n',
        );
    });
});

describe("pushPreflight resolves", () => {
    it("lists each comment a push would resolve", async () => {
        const fs = new MemFS();
        await pulled(fs, [C1, C2]);
        await edit(fs, (md) => dropAnchor("M1")(dropCallout("C1")(md)));
        const stub = new StubHttpClient().on(
            "GET",
            `${v2}/pages?id=123&limit=250`,
            {
                body: JSON.stringify({
                    results: [{ id: "123", version: { number: 3 } }],
                    _links: {},
                }),
            },
        );
        const config = cfg();

        const have = await pushPreflight(
            {
                client: new ConfluenceClient(stub, {
                    host: config.host,
                    account: config.account,
                    token: config.token,
                }),
                fs,
                yaml,
                config,
                cacheDir: "/data/cache",
                flavor: obsidianFlavor,
                links: null,
            },
            ["/vault/p.md"],
        );

        expect(have[0]?.cls).toBe("modified");
        expect(have[0]?.resolves).toEqual(['id:C1 "data type"']);
    });
});
