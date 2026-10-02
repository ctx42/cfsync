// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildConfig } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { newADF } from "../../src/models/adf.ts";
import { type PreflightDeps, pushPreflight } from "../../src/sync/push.ts";
import { QueueHttpClient } from "../support/http-queue.ts";
import { MemFS } from "../support/memfs.ts";

const yaml = { parse };
const cacheDir = "/cache";

function cfg() {
    return buildConfig(
        { pages: {}, folders: { wiki: "/wiki/spaces/T" }, spaces: {} },
        { site: "ex", account: "a@b.c", token: "t", syncRoot: "/vault" },
    );
}

/** adfDoc is a two-paragraph page body. */
const adfDoc = {
    version: 1,
    type: "doc",
    content: [
        {
            type: "paragraph",
            attrs: { localId: "p1" },
            content: [{ type: "text", text: "First paragraph." }],
        },
        {
            type: "paragraph",
            attrs: { localId: "p2" },
            content: [{ type: "text", text: "Second paragraph." }],
        },
    ],
};

/**
 * trickyDoc holds the constructs whose render does not segment back one block
 * per node: a space-only paragraph, a space-led paragraph after a list, and a
 * `Comments` heading that is page content.
 */
const trickyDoc = {
    version: 1,
    type: "doc",
    content: [
        {
            type: "bulletList",
            content: [
                {
                    type: "listItem",
                    content: [
                        {
                            type: "paragraph",
                            content: [{ type: "text", text: "item" }],
                        },
                    ],
                },
            ],
        },
        { type: "paragraph", content: [{ type: "text", text: " By default" }] },
        { type: "paragraph", content: [{ type: "text", text: " " }] },
        {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Comments" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "Send it." }] },
    ],
};

/** wrapper is the cached `.vN.json` of page `id` named `name` at `version`. */
function wrapper(
    name: string,
    id: string,
    version: number,
    doc: unknown = adfDoc,
): string {
    return JSON.stringify({
        name,
        id,
        title: "P",
        version,
        space_id: "9",
        adf: doc,
    });
}

/**
 * pulled seeds the vault and cache as a pull of `name` at `version` would: the
 * base ADF, its render, and the note. With `cacheBase` false only the note is
 * written, as on a fresh clone. It returns the rendered note.
 */
async function pulled(
    fs: MemFS,
    name: string,
    id: string,
    version: number,
    cacheBase = true,
    doc: unknown = adfDoc,
): Promise<string> {
    const json = wrapper(name, id, version, doc);
    const md = obsidianFlavor.render(newADF(json), {
        assets: {},
        links: null,
    })[0];
    const base = name.slice(0, -".md".length);
    await fs.write(`/vault/${name}`, md);
    if (cacheBase) {
        await fs.write(`${cacheDir}/${base}.v${version}.json`, json);
        await fs.write(`${cacheDir}/${base}.v${version}.md`, md);
    }
    return md;
}

/** edit rewrites the note at `path` through `f`. */
async function edit(
    fs: MemFS,
    path: string,
    f: (md: string) => string,
): Promise<void> {
    await fs.write(path, f(await fs.readText(path)));
}

/** livePage is a fetchPage response for page `id` at `version`. */
function livePage(id: string, version: number): string {
    return JSON.stringify({
        id,
        title: "P",
        spaceId: "9",
        parentId: "",
        version: { number: version },
        body: { atlas_doc_format: { value: JSON.stringify(adfDoc) } },
    });
}

/** versionsJson is one bulk fetchPageVersions response for the given id/version pairs. */
function versionsJson(...pairs: Array<[string, number]>): string {
    return JSON.stringify({
        results: pairs.map(([id, number]) => ({ id, version: { number } })),
        _links: {},
    });
}

function depsOf(http: QueueHttpClient, fs: MemFS): PreflightDeps {
    return {
        client: new ConfluenceClient(http, {
            host: "https://ex.atlassian.net",
            account: "a@b.c",
            token: "t",
        }),
        fs,
        yaml,
        config: cfg(),
        cacheDir,
        flavor: obsidianFlavor,
        links: null,
    };
}

describe("pushPreflight", () => {
    it("classifies every class from one bulk version lookup", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/Same.md", "101", 5);
        await pulled(fs, "wiki/Edited.md", "102", 5);
        await edit(fs, "/vault/wiki/Edited.md", (md) =>
            md.replace("First", "Edited first"),
        );
        await pulled(fs, "wiki/Behind.md", "103", 5);
        await pulled(fs, "wiki/Both.md", "104", 5);
        await edit(fs, "/vault/wiki/Both.md", (md) =>
            md.replace("Second", "Edited second"),
        );
        await fs.write("/vault/wiki/New.md", "---\ntitle: New\n---\nbody\n");
        await fs.write("/vault/wiki/Bad.md", "no frontmatter here");
        const http = new QueueHttpClient().rsp(
            200,
            versionsJson(["101", 5], ["102", 5], ["103", 7], ["104", 8]),
        );

        const have = await pushPreflight(depsOf(http, fs), [
            "/vault/wiki/Same.md",
            "/vault/wiki/Edited.md",
            "/vault/wiki/Behind.md",
            "/vault/wiki/Both.md",
            "/vault/wiki/New.md",
            "/vault/wiki/Bad.md",
        ]);

        expect(http.count).toBe(1); // bulk, not one fetch per page
        expect(have.map((e) => e.cls)).toEqual([
            "unchanged",
            "modified",
            "remote-moved",
            "diverged",
            "new",
            "skip",
        ]);
        expect(have[2]?.remoteVersion).toBe(7);
        expect(have[3]?.remoteVersion).toBe(8);
    });

    it("treats an edit that leaves the page as it was as unchanged", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/A.md", "101", 5);
        // A frontmatter key cfsync does not push and an extra trailing blank
        // line: the bytes differ, the reconstructed page does not.
        await edit(fs, "/vault/wiki/A.md", (md) =>
            md.replace("---\n", "---\ntags: draft\n").concat("\n"),
        );
        const http = new QueueHttpClient().rsp(200, versionsJson(["101", 5]));

        const have = await pushPreflight(depsOf(http, fs), [
            "/vault/wiki/A.md",
        ]);

        expect(have[0]?.cls).toBe("unchanged");
    });

    it.each([
        ["missing", null],
        ["stale", "---\npage_version: 5\n---\n\nan older render\n"],
    ])(
        "treats an untouched note as unchanged with a %s base render",
        async (_, render) => {
            const fs = new MemFS();
            await pulled(fs, "wiki/A.md", "101", 5, true, trickyDoc);
            const mdBase = `${cacheDir}/wiki/A.v5.md`;
            if (render === null) {
                await fs.remove(mdBase);
            } else {
                await fs.write(mdBase, render);
            }
            const http = new QueueHttpClient().rsp(
                200,
                versionsJson(["101", 5]),
            );

            const have = await pushPreflight(depsOf(http, fs), [
                "/vault/wiki/A.md",
            ]);

            expect(have[0]?.cls).toBe("unchanged");
        },
    );

    it("marks a note a push would refuse refused, with the reason", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/A.md", "101", 5);
        await edit(fs, "/vault/wiki/A.md", (md) =>
            md.concat("<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> remote\n"),
        );
        const http = new QueueHttpClient().rsp(200, versionsJson(["101", 7]));

        const have = await pushPreflight(depsOf(http, fs), [
            "/vault/wiki/A.md",
        ]);

        expect(have[0]?.cls).toBe("refused");
        expect(have[0]?.reason).toContain("unresolved conflict markers");
        expect(have[0]?.remoteVersion).toBe(7);
    });

    it("fetches and caches a base missing from the cache", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/A.md", "101", 5, false);
        const http = new QueueHttpClient()
            .rsp(200, versionsJson(["101", 5]))
            .rsp(200, livePage("101", 5));

        const have = await pushPreflight(depsOf(http, fs), [
            "/vault/wiki/A.md",
        ]);

        expect(have[0]?.cls).toBe("unchanged");
        expect(http.requests[1]?.url).toContain("/pages/101?");
        expect(http.requests[1]?.url).toContain("&version=5");
        expect(await fs.exists(`${cacheDir}/wiki/A.v5.json`)).toBe(true);

        // A second run finds the base cached: only the bulk lookup goes out.
        http.rsp(200, versionsJson(["101", 5]));
        await pushPreflight(depsOf(http, fs), ["/vault/wiki/A.md"]);
        expect(http.count).toBe(3);
    });

    it("refuses a note whose missing base cannot be fetched", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/A.md", "101", 5, false);
        const http = new QueueHttpClient()
            .rsp(200, versionsJson(["101", 5]))
            .rsp(404);

        const have = await pushPreflight(depsOf(http, fs), [
            "/vault/wiki/A.md",
        ]);

        expect(have[0]?.cls).toBe("refused");
        expect(have[0]?.reason).toContain("HTTP 404");
    });

    it("preserves the dest order of its input", async () => {
        const fs = new MemFS();
        await fs.write("/vault/wiki/New.md", "---\ntitle: New\n---\nbody\n");
        await pulled(fs, "wiki/A.md", "101", 5);
        const http = new QueueHttpClient().rsp(200, versionsJson(["101", 5]));

        const have = await pushPreflight(depsOf(http, fs), [
            "/vault/wiki/New.md",
            "/vault/wiki/A.md",
        ]);

        expect(have.map((e) => e.dest)).toEqual([
            "/vault/wiki/New.md",
            "/vault/wiki/A.md",
        ]);
    });

    it("marks a page missing from the response as skip, not a throw", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/A.md", "101", 5);
        // The bulk response omits id 101 (deleted or not visible to the account).
        const http = new QueueHttpClient().rsp(200, versionsJson());

        const have = await pushPreflight(depsOf(http, fs), [
            "/vault/wiki/A.md",
        ]);

        expect(have[0]?.cls).toBe("skip");
        expect(have[0]?.reason).toContain("not found");
        expect(have[0]?.localBase).toBe(5);
    });

    it("marks the whole batch skip when the bulk fetch fails, not a throw", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/A.md", "101", 5);
        const http = new QueueHttpClient().rsp(500, "boom");

        const have = await pushPreflight(depsOf(http, fs), [
            "/vault/wiki/A.md",
        ]);

        expect(have[0]?.cls).toBe("skip");
        expect(have[0]?.reason).toContain("500");
        expect(have[0]?.pageId).toBe("");
        expect(have[0]?.remoteVersion).toBe(0);
        expect(have[0]?.localBase).toBe(5);
    });

    it("throws when the bulk fetch fails in strict mode", async () => {
        const fs = new MemFS();
        await pulled(fs, "wiki/A.md", "101", 5);
        const http = new QueueHttpClient().rsp(500, "boom");

        await expect(
            pushPreflight(depsOf(http, fs), ["/vault/wiki/A.md"], undefined, {
                strict: true,
            }),
        ).rejects.toThrow("500");
    });
});
