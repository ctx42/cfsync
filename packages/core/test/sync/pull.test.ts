// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the page-pull cases of pkg/cfsync/pull_test.go. The client, cache,
// and notes all go through the injected ports, so a pull is driven end-to-end
// with StubHttpClient + MemFS. Folder/space discovery is exercised in
// discover.test.ts.

import { describe, expect, it } from "vitest";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { NoopReporter, type Reporter } from "../../src/ports/progress.ts";
import { buildLinkIndex, type LinkIndex } from "../../src/sync/linkindex.ts";
import {
    addStats,
    emptyStats,
    Puller,
    type PullOutcome,
    pullConfig,
    pullSummary,
    type ResolveSourceDeps,
    resolvePagePath,
    resolvePageSource,
} from "../../src/sync/pull.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

function testConfig(pages: Record<string, string>): Config {
    return buildConfig(
        { pages },
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );
}

function pullerFor(
    config: Config,
    stub: StubHttpClient,
    fs = new MemFS(),
    links: LinkIndex | null = buildLinkIndex(config.syncRoot, config.pages, []),
    knownVersions?: Map<string, number>,
): { puller: Puller; fs: MemFS } {
    const client = new ConfluenceClient(stub, {
        host: config.host,
        account: config.account,
        token: config.token,
    });
    const puller = new Puller({
        client,
        fs,
        config,
        reporter: new NoopReporter(),
        cacheDir: "/data/cache",
        assetsDir: "/vault/_cfsync-media",
        links,
        flavor: obsidianFlavor,
        ...(knownVersions ? { knownVersions } : {}),
    });
    return { puller, fs };
}

const pageURL = (id: string): string =>
    `https://ex.atlassian.net/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`;

const attachmentsURL = (id: string): string =>
    `https://ex.atlassian.net/wiki/api/v2/pages/${id}/attachments`;

/** An ADF doc carrying one uploaded-file image (fileId F1, localId L1). */
const mediaADF = {
    version: 1,
    type: "doc",
    content: [
        {
            type: "mediaSingle",
            attrs: { layout: "center" },
            content: [
                {
                    type: "media",
                    attrs: {
                        type: "file",
                        id: "F1",
                        localId: "L1",
                        alt: "pic.png",
                    },
                },
            ],
        },
    ],
};

/** The attachments-list response resolving F1 to a downloadable PNG. */
const attachmentsBody = JSON.stringify({
    results: [
        {
            fileId: "F1",
            title: "pic.png",
            mediaType: "image/png",
            downloadLink: "/download/x",
        },
    ],
    _links: {},
});

function pageBody(
    id: string,
    version: number,
    adf: unknown = {
        version: 1,
        type: "doc",
        content: [
            { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        ],
    },
): string {
    return JSON.stringify({
        id,
        title: "Title",
        spaceId: "9",
        parentId: "7",
        version: { number: version },
        body: { atlas_doc_format: { value: JSON.stringify(adf) } },
    });
}

/** paras builds a doc of one paragraph per text — a multi-line body for merges. */
function paras(...texts: string[]): unknown {
    return {
        version: 1,
        type: "doc",
        content: texts.map((t) => ({
            type: "paragraph",
            content: [{ type: "text", text: t }],
        })),
    };
}

/** managedNote is a cfsync-managed note as pulled: frontmatter plus body. */
function managedNote(id: string, version: number, body: string): string {
    return (
        "---\n" +
        'title: "Guide"\n' +
        `page_id: "${id}"\n` +
        `page_version: ${version}\n` +
        'space_id: "9"\n' +
        "cfsync-plugin: pull\n" +
        `---\n\n${body}\n`
    );
}

/** cacheNote is a cached-render `.md` (the merge base) with `body`. */
function cacheNote(version: number, body: string): string {
    return `---\npage_version: ${version}\n---\n\n${body}\n`;
}

/** folderConfig maps the `docs` root to a Confluence folder. */
function folderConfig(): Config {
    return buildConfig(
        { folders: { docs: "/wiki/spaces/X/folder/100" } },
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );
}

/** folderStub answers folder 100's children with one page (id 7, "Guide"). */
function folderStub(): StubHttpClient {
    return new StubHttpClient().on(
        "GET",
        "https://ex.atlassian.net/wiki/api/v2/folders/100/direct-children",
        {
            body: JSON.stringify({
                results: [
                    {
                        id: "7",
                        type: "page",
                        title: "Guide",
                        status: "current",
                    },
                ],
                _links: {},
            }),
        },
    );
}

/** pullConfigWith runs a full pullConfig against the given config, stub, and fs. */
function pullConfigWith(
    cfg: Config,
    stub: StubHttpClient,
    fs: MemFS,
): Promise<PullOutcome> {
    const client = new ConfluenceClient(stub, {
        host: cfg.host,
        account: cfg.account,
        token: cfg.token,
    });
    return pullConfig({
        client,
        fs,
        config: cfg,
        reporter: new NoopReporter(),
        cacheDir: "/data/cache",
        assetsDir: "/vault/_cfsync-media",
        linksPath: "/data/cache/links.json",
    });
}

describe("Puller.pullPages", () => {
    it("pulls a fresh page: caches ADF, writes the note and cache md", async () => {
        const config = testConfig({
            "notes/page.md": "/wiki/spaces/X/pages/123/Title",
        });
        const stub = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3),
        });
        const { puller, fs } = pullerFor(config, stub);

        const out = await puller.pullPages();

        expect(out.stats).toEqual({
            pulled: 1,
            rendered: 0,
            unchanged: 0,
            merged: 0,
            conflict: 0,
            total: 1,
        });
        expect(out.errors).toEqual([]);
        expect(out.log).toContain("pulling notes/page.md ... ok (v3)");
        expect(await fs.readText("/vault/notes/page.md")).toContain("hello");
        expect(await fs.readText("/vault/notes/page.md")).toContain(
            "cfsync-plugin: pull",
        );
        expect(await fs.exists("/data/cache/notes/page.v3.json")).toBe(true);
        expect(await fs.exists("/data/cache/notes/page.v3.md")).toBe(true);
    });

    it("reports unchanged on a second pull of the same version", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const stub = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3),
        });
        const { puller } = pullerFor(config, stub);

        await puller.pullPages();
        const out = await puller.pullPages();

        expect(out.stats.unchanged).toBe(1);
        expect(out.stats.pulled).toBe(0);
        expect(out.log).toContain("unchanged");
    });

    it("renders from cache without fetching when the version is already cached", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        // First pull populates the ADF cache at v3.
        const seed = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3),
        });
        const { fs } = pullerFor(config, seed);
        await pullerFor(config, seed, fs).puller.pullPages();

        // A second pull that already knows the remote is still v3 must not fetch:
        // this stub has no route, so any fetchPage would 404 and error.
        const noNet = new StubHttpClient();
        const { puller } = pullerFor(
            config,
            noNet,
            fs,
            buildLinkIndex(config.syncRoot, config.pages, []),
            new Map([["123", 3]]),
        );

        const out = await puller.pullPages();

        expect(out.errors).toEqual([]);
        expect(out.stats.unchanged).toBe(1);
        expect(out.stats.pulled).toBe(0);
        expect(noNet.requests).toHaveLength(0); // zero network calls
    });

    it("fetches when the known remote version is newer than the cache", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const seed = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3),
        });
        const { fs } = pullerFor(config, seed);
        await pullerFor(config, seed, fs).puller.pullPages();

        // Remote moved to v4; v4 is not cached, so the body must be fetched.
        const v4 = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 4),
        });
        const { puller } = pullerFor(
            config,
            v4,
            fs,
            buildLinkIndex(config.syncRoot, config.pages, []),
            new Map([["123", 4]]),
        );

        const out = await puller.pullPages();

        expect(out.errors).toEqual([]);
        expect(out.stats.pulled).toBe(1);
        expect(v4.requests.length).toBeGreaterThan(0);
        expect(await fs.exists("/data/cache/p.v4.json")).toBe(true);
    });

    it("re-renders when the note on disk diverged", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const stub = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3),
        });
        const { puller, fs } = pullerFor(config, stub);

        await puller.pullPages();
        await fs.write("/vault/p.md", "clobbered");
        const out = await puller.pullPages();

        expect(out.stats.rendered).toBe(1);
        expect(await fs.readText("/vault/p.md")).toContain("hello");
    });

    it("keeps unpushed local edits when the remote is unchanged", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const stub = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3, paras("alpha", "beta", "gamma")),
        });
        const { puller, fs } = pullerFor(config, stub);

        await puller.pullPages();
        const pulled = await fs.readText("/vault/p.md");
        await fs.write("/vault/p.md", pulled.replace("beta", "beta-local"));

        const out = await puller.pullPages(); // same v3: remote unchanged

        expect(out.stats.conflict).toBe(0);
        expect(out.stats.merged).toBe(0);
        expect(await fs.readText("/vault/p.md")).toContain("beta-local");
    });

    it("merges local edits with a remote change in a different region", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const seed = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3, paras("alpha", "beta", "gamma")),
        });
        const { fs } = pullerFor(config, seed);
        await pullerFor(config, seed, fs).puller.pullPages();
        const pulled = await fs.readText("/vault/p.md");
        await fs.write("/vault/p.md", pulled.replace("beta", "beta-local"));

        // Remote moves to v4, changing a different paragraph (gamma).
        const v4 = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 4, paras("alpha", "beta", "gamma-remote")),
        });
        const { puller } = pullerFor(
            config,
            v4,
            fs,
            buildLinkIndex(config.syncRoot, config.pages, []),
            new Map([["123", 4]]),
        );

        const out = await puller.pullPages();

        expect(out.stats.merged).toBe(1);
        expect(out.stats.conflict).toBe(0);
        const note = await fs.readText("/vault/p.md");
        expect(note).toContain("beta-local");
        expect(note).toContain("gamma-remote");
        expect(note).not.toContain("<<<<<<<");
        expect(note).toContain("page_version: 4");
    });

    it("writes conflict markers when local and remote change the same region", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const seed = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3, paras("alpha", "beta", "gamma")),
        });
        const { fs } = pullerFor(config, seed);
        await pullerFor(config, seed, fs).puller.pullPages();
        const pulled = await fs.readText("/vault/p.md");
        await fs.write("/vault/p.md", pulled.replace("beta", "beta-local"));

        // Remote moves to v4, changing the same paragraph differently.
        const v4 = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 4, paras("alpha", "beta-remote", "gamma")),
        });
        const { puller } = pullerFor(
            config,
            v4,
            fs,
            buildLinkIndex(config.syncRoot, config.pages, []),
            new Map([["123", 4]]),
        );

        const out = await puller.pullPages();

        expect(out.stats.conflict).toBe(1);
        const note = await fs.readText("/vault/p.md");
        expect(note).toContain("<<<<<<< local (your edits)");
        expect(note).toContain("beta-local");
        expect(note).toContain("beta-remote");
        expect(note).toContain(">>>>>>> remote (Confluence v4)");
    });

    it("leaves a note with conflict markers untouched on re-pull", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const stub = new StubHttpClient().on("GET", pageURL("123"), {
            body: pageBody("123", 3, paras("alpha", "beta")),
        });
        const { puller, fs } = pullerFor(config, stub);

        await puller.pullPages();
        const conflicted = `---\npage_version: 3\n---\nalpha\n<<<<<<< local (your edits)\nmine\n=======\ntheirs\n>>>>>>> remote (Confluence v3)\n`;
        await fs.write("/vault/p.md", conflicted);

        const out = await puller.pullPages();

        expect(out.stats.conflict).toBe(1);
        expect(await fs.readText("/vault/p.md")).toBe(conflicted);
    });

    it("continues past a failed page and collects the error", async () => {
        const config = testConfig({
            "a.md": "/wiki/spaces/X/pages/111/A",
            "b.md": "/wiki/spaces/X/pages/222/B",
        });
        const stub = new StubHttpClient()
            .on("GET", pageURL("111"), { body: pageBody("111", 1) })
            .on("GET", pageURL("222"), { status: 404 });
        const { puller } = pullerFor(config, stub);

        const out = await puller.pullPages();

        expect(out.stats).toMatchObject({ pulled: 1, total: 2 });
        expect(out.errors).toHaveLength(1);
        expect(out.errors[0]).toContain("b.md");
    });

    it("embeds a downloaded image in the rendered note", async () => {
        const adf = {
            version: 1,
            type: "doc",
            content: [
                {
                    type: "mediaSingle",
                    attrs: { layout: "center" },
                    content: [
                        {
                            type: "media",
                            attrs: {
                                type: "file",
                                id: "F1",
                                localId: "L1",
                                alt: "pic.png",
                            },
                        },
                    ],
                },
            ],
        };
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const stub = new StubHttpClient()
            .on("GET", pageURL("123"), { body: pageBody("123", 1, adf) })
            .on(
                "GET",
                "https://ex.atlassian.net/wiki/api/v2/pages/123/attachments",
                {
                    body: JSON.stringify({
                        results: [
                            {
                                fileId: "F1",
                                title: "pic.png",
                                mediaType: "image/png",
                                downloadLink: "/download/x",
                            },
                        ],
                        _links: {},
                    }),
                },
            )
            .on("GET", "https://ex.atlassian.net/wiki/download/x", {
                body: "IMG",
            });
        const { puller, fs } = pullerFor(config, stub);

        await puller.pullPages();

        expect(await fs.readText("/vault/p.md")).toContain("![[F1-L1.png]]");
        expect(await fs.readText("/vault/_cfsync-media/F1-L1.png")).toBe("IMG");
    });

    it("on a cache hit rebuilds the assets map from disk without fetching attachments", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        // Cold pull: fetch the page, list its attachments, download the image.
        const seed = new StubHttpClient()
            .on("GET", pageURL("123"), { body: pageBody("123", 1, mediaADF) })
            .on("GET", attachmentsURL("123"), { body: attachmentsBody })
            .on("GET", "https://ex.atlassian.net/wiki/download/x", {
                body: "IMG",
            });
        const { fs } = pullerFor(config, seed);
        await pullerFor(config, seed, fs).puller.pullPages();

        // Warm pull: version probe says still v1, so the body is served from the
        // ADF cache; the image is already on disk, so no attachment round-trip is
        // needed. This stub has no routes, so any request would 404.
        const noNet = new StubHttpClient();
        const { puller } = pullerFor(
            config,
            noNet,
            fs,
            buildLinkIndex(config.syncRoot, config.pages, []),
            new Map([["123", 1]]),
        );

        const out = await puller.pullPages();

        expect(out.errors).toEqual([]);
        expect(out.stats.unchanged).toBe(1);
        expect(noNet.requests).toHaveLength(0); // no fetchPage, no fetchAttachments
        expect(await fs.readText("/vault/p.md")).toContain("![[F1-L1.png]]");
    });

    it("on a cache hit falls back to fetchAttachments when an image is missing on disk", async () => {
        const config = testConfig({ "p.md": "/wiki/spaces/X/pages/123/Title" });
        const seed = new StubHttpClient()
            .on("GET", pageURL("123"), { body: pageBody("123", 1, mediaADF) })
            .on("GET", attachmentsURL("123"), { body: attachmentsBody })
            .on("GET", "https://ex.atlassian.net/wiki/download/x", {
                body: "IMG",
            });
        const { fs } = pullerFor(config, seed);
        await pullerFor(config, seed, fs).puller.pullPages();

        // Simulate an earlier pull interrupted after caching the ADF but before
        // downloading the image: the body is cached, but the asset is gone.
        await fs.remove("/vault/_cfsync-media/F1-L1.png");

        const warm = new StubHttpClient()
            .on("GET", attachmentsURL("123"), { body: attachmentsBody })
            .on("GET", "https://ex.atlassian.net/wiki/download/x", {
                body: "IMG2",
            });
        const { puller } = pullerFor(
            config,
            warm,
            fs,
            buildLinkIndex(config.syncRoot, config.pages, []),
            new Map([["123", 1]]),
        );

        const out = await puller.pullPages();

        expect(out.errors).toEqual([]);
        // The body still came from the cache (no page fetch), but the missing
        // image forced the attachment round-trip and a re-download.
        expect(warm.requests.some((r) => r.url === pageURL("123"))).toBe(false);
        expect(warm.requests.some((r) => r.url === attachmentsURL("123"))).toBe(
            true,
        );
        expect(await fs.readText("/vault/_cfsync-media/F1-L1.png")).toBe(
            "IMG2",
        );
    });
});

describe("pullConfig (discovery + pull)", () => {
    it("discovers a folder, pulls its pages, and writes the link index", async () => {
        const config = testConfig({});
        // buildConfig above only set pages; rebuild with a folder.
        const cfg = buildConfig(
            { folders: { docs: "/wiki/spaces/X/folder/100" } },
            {
                site: "ex",
                account: "a@ex.com",
                token: "secret",
                syncRoot: "/vault",
            },
        );
        void config;
        const stub = new StubHttpClient()
            .on(
                "GET",
                "https://ex.atlassian.net/wiki/api/v2/folders/100/direct-children",
                {
                    body: JSON.stringify({
                        results: [
                            {
                                id: "7",
                                type: "page",
                                title: "Guide",
                                status: "current",
                            },
                        ],
                        _links: {},
                    }),
                },
            )
            .on("GET", pageURL("7"), { body: pageBody("7", 2) });
        const fs = new MemFS();
        const client = new ConfluenceClient(stub, {
            host: cfg.host,
            account: cfg.account,
            token: cfg.token,
        });

        const out = await pullConfig({
            client,
            fs,
            config: cfg,
            reporter: new NoopReporter(),
            cacheDir: "/data/cache",
            assetsDir: "/vault/_cfsync-media",
            linksPath: "/data/cache/links.json",
        });

        expect(out.stats).toMatchObject({ pulled: 1, total: 1 });
        expect(out.errors).toEqual([]);
        expect(await fs.readText("/vault/docs/guide.md")).toContain("hello");
        const links = await fs.readText("/data/cache/links.json");
        expect(links).toContain('"id": "7"');
        expect(links).toContain('"dest": "docs/guide.md"');
    });

    it("relocates a moved page's note and removes the stale copy", async () => {
        const cfg = folderConfig();
        const stub = folderStub().on("GET", pageURL("7"), {
            body: pageBody("7", 2),
        });
        const fs = new MemFS();
        // A note left at the page's old path by an earlier pull.
        await fs.write("/vault/docs/old.md", managedNote("7", 2, "hello"));

        const out = await pullConfigWith(cfg, stub, fs);

        expect(out.errors).toEqual([]);
        expect(out.log).toContain("moving docs/old.md -> docs/guide.md");
        expect(await fs.exists("/vault/docs/old.md")).toBe(false);
        expect(await fs.readText("/vault/docs/guide.md")).toContain("hello");
    });

    it("carries unpushed edits from the stale copy onto the moved page", async () => {
        const cfg = folderConfig();
        const stub = folderStub().on("GET", pageURL("7"), {
            body: pageBody("7", 2),
        });
        const fs = new MemFS();
        // The freshly-pulled duplicate (clean) plus the old note the user edited.
        await fs.write("/vault/docs/guide.md", managedNote("7", 2, "hello"));
        await fs.write("/vault/docs/old.md", managedNote("7", 2, "hello EDIT"));
        await fs.write("/data/cache/docs/guide.v2.md", cacheNote(2, "hello"));
        await fs.write("/data/cache/docs/old.v2.md", cacheNote(2, "hello"));

        const out = await pullConfigWith(cfg, stub, fs);

        expect(out.errors).toEqual([]);
        expect(await fs.exists("/vault/docs/old.md")).toBe(false);
        // The edit survived onto the moved page; the remote (unchanged) did not
        // clobber it.
        expect(await fs.readText("/vault/docs/guide.md")).toContain(
            "hello EDIT",
        );
    });

    it("leaves both copies when each carries unpushed edits", async () => {
        const cfg = folderConfig();
        const stub = folderStub().on("GET", pageURL("7"), {
            body: pageBody("7", 2),
        });
        const fs = new MemFS();
        await fs.write("/vault/docs/guide.md", managedNote("7", 2, "new edit"));
        await fs.write("/vault/docs/old.md", managedNote("7", 2, "old edit"));
        await fs.write("/data/cache/docs/guide.v2.md", cacheNote(2, "hello"));
        await fs.write("/data/cache/docs/old.v2.md", cacheNote(2, "hello"));

        const out = await pullConfigWith(cfg, stub, fs);

        expect(out.log).toContain("both hold unpushed edits");
        expect(await fs.exists("/vault/docs/old.md")).toBe(true);
        expect(await fs.readText("/vault/docs/old.md")).toContain("old edit");
    });

    it("aborts on a destination collision before writing", async () => {
        const cfg = buildConfig(
            {
                pages: { "docs/guide.md": "/wiki/spaces/X/pages/9/Guide" },
                folders: { docs: "/wiki/spaces/X/folder/100" },
            },
            {
                site: "ex",
                account: "a@ex.com",
                token: "secret",
                syncRoot: "/vault",
            },
        );
        const stub = new StubHttpClient().on(
            "GET",
            "https://ex.atlassian.net/wiki/api/v2/folders/100/direct-children",
            {
                body: JSON.stringify({
                    results: [
                        {
                            id: "7",
                            type: "page",
                            title: "Guide",
                            status: "current",
                        },
                    ],
                    _links: {},
                }),
            },
        );
        const fs = new MemFS();
        const client = new ConfluenceClient(stub, {
            host: cfg.host,
            account: cfg.account,
            token: cfg.token,
        });

        await expect(
            pullConfig({
                client,
                fs,
                config: cfg,
                reporter: new NoopReporter(),
                cacheDir: "/data/cache",
                assetsDir: "/vault/_cfsync-media",
                linksPath: "/data/cache/links.json",
            }),
        ).rejects.toThrow("claimed by more than one entry");
        expect(await fs.exists("/data/cache/links.json")).toBe(false);
    });
});

describe("resolvePageSource", () => {
    const LINKS = "/data/cache/links.json";

    function sourceDeps(
        config: Config,
        stub: StubHttpClient,
        fs = new MemFS(),
    ): ResolveSourceDeps {
        const client = new ConfluenceClient(stub, {
            host: config.host,
            account: config.account,
            token: config.token,
        });
        return {
            client,
            fs,
            config,
            reporter: new NoopReporter(),
            linksPath: LINKS,
        };
    }

    /** folderConfig configures one folder root `docs` at folder id 100 in space X. */
    function folderConfig(): Config {
        return buildConfig(
            { folders: { docs: "/wiki/spaces/X/folder/100" } },
            {
                site: "ex",
                account: "a@ex.com",
                token: "secret",
                syncRoot: "/vault",
            },
        );
    }

    /** guideChildren stubs folder 100 as holding one page (id 7, "Guide"). */
    function guideChildren(): StubHttpClient {
        return new StubHttpClient().on(
            "GET",
            "https://ex.atlassian.net/wiki/api/v2/folders/100/direct-children",
            {
                body: JSON.stringify({
                    results: [
                        {
                            id: "7",
                            type: "page",
                            title: "Guide",
                            status: "current",
                        },
                    ],
                    _links: {},
                }),
            },
        );
    }

    it("resolves a configured page from the config without discovery", async () => {
        const config = testConfig({ "a.md": "/wiki/spaces/X/pages/1/A" });
        const deps = sourceDeps(config, new StubHttpClient());
        const { src, spaceKey } = await resolvePageSource(deps, "/vault/a.md");
        expect({ src, spaceKey }).toEqual({
            src: "/wiki/spaces/X/pages/1/A",
            spaceKey: "",
        });
    });

    it("resolves a discovered page already in the persisted index", async () => {
        const config = folderConfig();
        const links = buildLinkIndex("/vault", {}, [
            {
                dest: "/vault/docs/guide.md",
                id: "7",
                title: "Guide",
                url: "/wiki/spaces/X/pages/7",
                parentId: "",
                spaceKey: "",
            },
        ]);
        // A stub with no routes: resolving from the index must not call out.
        const deps = sourceDeps(config, new StubHttpClient());
        await links.write(deps.fs, LINKS);
        const { src, spaceKey } = await resolvePageSource(
            deps,
            "/vault/docs/guide.md",
        );
        expect({ src, spaceKey }).toEqual({
            src: "/wiki/spaces/X/pages/7",
            spaceKey: "",
        });
    });

    it("auto-discovers the containing root when the page is not yet indexed", async () => {
        const config = folderConfig();
        const deps = sourceDeps(config, guideChildren());
        const { src, spaceKey } = await resolvePageSource(
            deps,
            "/vault/docs/guide.md",
        );
        expect({ src, spaceKey }).toEqual({
            src: "/wiki/spaces/X/pages/7",
            spaceKey: "",
        });
        // The freshly discovered root is persisted so a later pull skips discovery.
        const written = await deps.fs.readText(LINKS);
        expect(written).toContain('"dest": "docs/guide.md"');
        expect(written).toContain('"id": "7"');
    });

    it("keeps the reporter off the discovery counter while auto-discovering", async () => {
        const config = folderConfig();
        let found = 0;
        const logs: string[] = [];
        const reporter: Reporter = {
            found: () => {
                found++;
            },
            discovered: () => {},
            item: () => {},
            log: (l) => {
                logs.push(l);
            },
            finish: () => {},
            streamsLog: () => false,
        };
        const client = new ConfluenceClient(guideChildren(), {
            host: config.host,
            account: config.account,
            token: config.token,
        });
        await resolvePageSource(
            { client, fs: new MemFS(), config, reporter, linksPath: LINKS },
            "/vault/docs/guide.md",
        );
        // The single page is announced by the caller, not this walk, so the walk
        // must not fire found() — only its one contextual log line surfaces.
        expect(found).toBe(0);
        expect(logs.join("")).toContain("discovering folder docs");
    });

    it("rejects a path under no configured root", async () => {
        const config = testConfig({ "a.md": "/wiki/spaces/X/pages/1/A" });
        const deps = sourceDeps(config, new StubHttpClient());
        await expect(resolvePageSource(deps, "/vault/z.md")).rejects.toThrow(
            "not a managed page",
        );
    });

    it("rejects a path under a root the discovery does not place", async () => {
        const config = folderConfig();
        const deps = sourceDeps(config, guideChildren());
        await expect(
            resolvePageSource(deps, "/vault/docs/missing.md"),
        ).rejects.toThrow("not a managed page");
    });
});

describe("helpers", () => {
    it("resolvePagePath joins a relative path and cleans an absolute one", () => {
        expect(resolvePagePath("/vault", "notes/a.md")).toBe(
            "/vault/notes/a.md",
        );
        expect(resolvePagePath("/vault", "/other/a.md")).toBe("/other/a.md");
    });

    it("addStats sums element-wise", () => {
        expect(
            addStats(
                {
                    pulled: 1,
                    rendered: 2,
                    unchanged: 3,
                    merged: 1,
                    conflict: 2,
                    total: 6,
                },
                {
                    pulled: 1,
                    rendered: 0,
                    unchanged: 1,
                    merged: 4,
                    conflict: 3,
                    total: 2,
                },
            ),
        ).toEqual({
            pulled: 2,
            rendered: 2,
            unchanged: 4,
            merged: 5,
            conflict: 5,
            total: 8,
        });
    });

    it("pullSummary notes a re-render caveat only when any page re-rendered", () => {
        expect(pullSummary({ ...emptyStats(), total: 1, pulled: 1 })).toContain(
            "1 pulled (new version)",
        );
        expect(
            pullSummary({ ...emptyStats(), total: 1, rendered: 1 }),
        ).toContain("show up as changes in git");
        expect(
            pullSummary({ ...emptyStats(), total: 1, pulled: 1 }),
        ).not.toContain("show up as changes in git");
    });
});
