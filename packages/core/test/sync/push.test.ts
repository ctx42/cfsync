// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the edit-push cases of pkg/cfsync/push_test.go. The push goes
// through the injected ports, so it is driven with StubHttpClient + MemFS; the
// Yaml port is backed by the real `yaml` package (the CLI's parser), which also
// exercises the frontmatter round trip. New-image upload and page creation are
// covered elsewhere / M7.4.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { type Flavor, obsidianFlavor } from "../../src/flavor/flavor.ts";
import { type Node, newADF } from "../../src/models/adf.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import type { Yaml } from "../../src/ports/yaml.ts";
import { type CreateInput, classifyCreates } from "../../src/sync/create.ts";
import { LinkIndex, linkMapper } from "../../src/sync/linkindex.ts";
import {
    MetaCache,
    managedPushDests,
    metaAssets,
    Pusher,
    parseMeta,
    splitFrontmatter,
} from "../../src/sync/push.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

/**
 * WriteFailFS is a MemFS that rejects writes to any path matching `failOn`, used
 * to simulate a local-disk failure during the post-push refresh.
 */
class WriteFailFS extends MemFS {
    constructor(private readonly failOn: (path: string) => boolean) {
        super();
    }
    override write(path: string, data: Uint8Array | string): Promise<void> {
        if (this.failOn(path)) {
            return Promise.reject(new Error("disk full"));
        }
        return super.write(path, data);
    }
}

const yaml: Yaml = { parse: (t) => parseYaml(t) };

const config = (): Config =>
    buildConfig(
        {},
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );

/** para builds a localId-tagged paragraph node. */
const para = (localId: string, text: string): Node => ({
    type: "paragraph",
    attrs: { localId },
    content: [{ type: "text", text }],
});

/** docOf wraps paragraphs in an ADF doc. */
const docOf = (...paras: Node[]): Node & { version: number } => ({
    version: 1,
    type: "doc",
    content: paras,
});

/** note builds a note file: frontmatter (page_id 123 at version) + body. */
function note(version: number, body: string, title = "My Page"): string {
    return (
        "---\n" +
        `title: "${title}"\n` +
        'page_path: "p.md"\n' +
        'page_id: "123"\n' +
        `page_version: ${version}\n` +
        'space_id: "9"\n' +
        "---\n\n" +
        body
    );
}

/** cacheWrapper is the cached baseline ADF wrapper JSON. */
function cacheWrapper(version: number, doc: Node, title = "My Page"): string {
    return JSON.stringify({
        name: "p.md",
        id: "123",
        title,
        version,
        space_id: "9",
        adf: doc,
    });
}

/** livePage is the fetchPage response for the live page. */
function livePage(version: number, doc: Node, title = "My Page"): string {
    return JSON.stringify({
        id: "123",
        title,
        spaceId: "9",
        parentId: "",
        version: { number: version },
        body: { atlas_doc_format: { value: JSON.stringify(doc) } },
    });
}

const pageURL =
    "https://ex.atlassian.net/wiki/api/v2/pages/123?body-format=atlas_doc_format";
const putURL = "https://ex.atlassian.net/wiki/api/v2/pages/123";

/** counterMint mints deterministic localIds (L0, L1, …) for tests. */
function counterMint(): () => string {
    let n = 0;
    return () => `L${n++}`;
}

function pusherFor(
    stub: StubHttpClient,
    fs: MemFS,
    links: LinkIndex | null = null,
    mint = counterMint(),
    force = false,
    flavor: Flavor = obsidianFlavor,
): Pusher {
    const cfg = config();
    return new Pusher({
        client: new ConfluenceClient(stub, {
            host: cfg.host,
            account: cfg.account,
            token: cfg.token,
        }),
        fs,
        yaml,
        config: cfg,
        reporter: new NoopReporter(),
        cacheDir: "/data/cache",
        assetsDir: "/vault/_cfsync-media",
        mintLocalId: mint,
        links,
        flavor,
        force,
    });
}

describe("splitFrontmatter", () => {
    it("splits fences and trims the body", () => {
        expect(splitFrontmatter("---\ntitle: X\n---\n\nhello\n")).toEqual({
            frontmatter: "title: X\n",
            body: "hello",
            bodyLine: 5, // "hello" is the 5th line of the file
        });
    });
    it("rejects a file with no frontmatter", () => {
        expect(() => splitFrontmatter("hello")).toThrow("no frontmatter");
    });
    it("rejects unterminated frontmatter", () => {
        expect(() => splitFrontmatter("---\ntitle: X\n")).toThrow(
            "unterminated",
        );
    });
});

describe("parseMeta / metaAssets", () => {
    it("maps the cfsync frontmatter fields", () => {
        const meta = parseMeta(
            parseYaml(
                'cfsync-plugin: pull\ntitle: "T"\npage_id: "5"\npage_version: 7\n' +
                    "mentions:\n  Ann: A\n" +
                    "page_images:\n  - local_id: L1\n    file: ../_cfsync-media/x.png\n    alt: x\n",
            ),
        );
        expect(meta).toMatchObject({
            pageId: "5",
            pageVersion: 7,
            cfsync: true,
        });
        expect(meta.mentions).toEqual({ Ann: "A" });
        expect(metaAssets(meta)).toEqual({ L1: "../_cfsync-media/x.png" });
    });

    it("defaults cfsync to false when the key is absent", () => {
        const meta = parseMeta(parseYaml('title: "T"\npage_id: "5"\n'));
        expect(meta.cfsync).toBe(false);
    });
});

describe("managedPushDests", () => {
    const fm = (extra: string): string =>
        `---\ntitle: "T"\n${extra}---\n\nbody`;

    it("unions configured pages with pushable root files, skipping local and unmanaged", async () => {
        const cfg = buildConfig(
            {
                pages: { "a.md": "/wiki/spaces/X/pages/1/A" },
                folders: { docs: "/wiki/spaces/X/folder/9" },
            },
            {
                site: "ex",
                account: "a@ex.com",
                token: "t",
                syncRoot: "/vault",
            },
        );
        const fs = new MemFS();
        await fs.write("/vault/a.md", fm('page_id: "1"\npage_version: 1\n')); // configured page
        await fs.write(
            "/vault/docs/existing.md",
            fm('page_id: "2"\npage_version: 1\n'),
        ); // root page, has id
        await fs.write("/vault/docs/new.md", fm("")); // root create candidate (title only)
        await fs.write("/vault/docs/local.md", fm("cf_local: true\n")); // marked local → skip
        await fs.write(
            "/vault/docs/held.md",
            fm('page_id: "3"\npage_version: 1\ncfsync-plugin: ignore-push\n'),
        ); // marked ignore-push → skip
        await fs.write("/vault/docs/plain.md", "no frontmatter here"); // unmanaged → skip

        expect(await managedPushDests(fs, yaml, cfg)).toEqual([
            "/vault/a.md",
            "/vault/docs/existing.md",
            "/vault/docs/new.md",
        ]);
    });

    it("excludes cached page copies under the .adf_cache dir", async () => {
        // A folder root mapped at the sync root puts the ADF cache dir inside
        // the walked tree. The cached `.md` copies pull wrote there carry a
        // page_id, so without a cache-dir skip they are mistaken for notes to
        // push (regression: broke any `.`-rooted mapping after a pull).
        const cfg = buildConfig(
            { folders: { ".": "/wiki/spaces/X/folder/9" } },
            {
                site: "ex",
                account: "a@ex.com",
                token: "t",
                syncRoot: "/vault",
            },
        );
        const fs = new MemFS();
        await fs.write("/vault/note.md", fm('page_id: "1"\npage_version: 1\n'));
        await fs.write(
            "/vault/.adf_cache/note.v1.md",
            fm('page_id: "1"\npage_version: 1\n'),
        );

        expect(await managedPushDests(fs, yaml, cfg)).toEqual([
            "/vault/note.md",
        ]);
    });

    it("excludes a configured page marked local", async () => {
        const cfg = buildConfig(
            { pages: { "a.md": "/wiki/spaces/X/pages/1/A" } },
            {
                site: "ex",
                account: "a@ex.com",
                token: "t",
                syncRoot: "/vault",
            },
        );
        const fs = new MemFS();
        await fs.write("/vault/a.md", fm("cf_local: true\n"));
        expect(await managedPushDests(fs, yaml, cfg)).toEqual([]);
    });

    it("excludes a configured page marked ignore-push", async () => {
        const cfg = buildConfig(
            { pages: { "a.md": "/wiki/spaces/X/pages/1/A" } },
            {
                site: "ex",
                account: "a@ex.com",
                token: "t",
                syncRoot: "/vault",
            },
        );
        const fs = new MemFS();
        await fs.write(
            "/vault/a.md",
            fm('page_id: "1"\npage_version: 1\ncfsync-plugin: ignore-push\n'),
        );
        expect(await managedPushDests(fs, yaml, cfg)).toEqual([]);
    });
});

describe("Pusher.pushOne", () => {
    const baseDoc = docOf(para("p", "original"));

    it("pushes an edit, PUTs the next version, and refreshes", async () => {
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "edited"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, baseDoc));
        const stub = new StubHttpClient()
            .on("GET", pageURL, { body: livePage(3, baseDoc) })
            .on("PUT", putURL, { status: 200 });

        const { changed, version } = await pusherFor(stub, fs).pushOne(
            "/vault/p.md",
        );

        expect(changed).toBe(true);
        expect(version).toBe(4);
        const put = stub.requests.find((r) => r.method === "PUT");
        expect(put).toBeDefined();
        expect(String(put?.body)).toContain('"number":4');
        expect(String(put?.body)).toContain("edited");
        // Refresh wrote the v4 cache and rewrote the note.
        expect(await fs.exists("/data/cache/p.v4.json")).toBe(true);
        expect(await fs.readText("/vault/p.md")).toContain("edited");
    });

    it("skips a note with no changes", async () => {
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "original"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, baseDoc));
        const stub = new StubHttpClient().on("GET", pageURL, {
            body: livePage(3, baseDoc),
        });

        const { changed } = await pusherFor(stub, fs).pushOne("/vault/p.md");

        expect(changed).toBe(false);
        expect(stub.requests.some((r) => r.method === "PUT")).toBe(false);
    });

    it("rebases onto a moved remote with a three-way merge", async () => {
        const base = docOf(para("p1", "alpha"), para("p2", "beta"));
        const remote = docOf(para("p1", "alpha"), para("p2", "beta remote"));
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "alpha local\n\nbeta"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, base));
        const stub = new StubHttpClient()
            .on("GET", pageURL, { body: livePage(5, remote) })
            .on("PUT", putURL, { status: 200 });

        const { changed, version } = await pusherFor(stub, fs).pushOne(
            "/vault/p.md",
        );

        expect(changed).toBe(true);
        expect(version).toBe(6); // live 5 + 1
        const put = stub.requests.find((r) => r.method === "PUT");
        expect(String(put?.body)).toContain("alpha local");
        expect(String(put?.body)).toContain("beta remote");
    });

    it("refuses a block edited on both sides as a conflict with re-pull guidance (item 20)", async () => {
        const base = docOf(para("p1", "alpha"), para("p2", "beta"));
        const remote = docOf(para("p1", "alpha remote"), para("p2", "beta"));
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "alpha local\n\nbeta"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, base));
        const stub = new StubHttpClient().on("GET", pageURL, {
            body: livePage(5, remote),
        });

        // A genuine three-way conflict (both sides edited p1) keeps the
        // version-conflict framing: re-pulling is how the user resolves it.
        const err = await pusherFor(stub, fs)
            .pushOne("/vault/p.md")
            .catch((e: unknown) => e as Error);
        if (!(err instanceof Error)) throw err;
        expect(err.message).toContain(
            "conflict: local base v3 but remote is v5",
        );
        expect(err.message).toContain("re-pull first");
    });

    it("lets an unbackportable lens refusal on the merge path surface honestly, not as a version conflict (item 20)", async () => {
        // Local edits only p1; p2's remote change merges cleanly, so merge3 does
        // NOT conflict and the failure comes from the merge-path reconstruct. A
        // reconstruct lens-law refusal (re-pulling cannot fix it) must keep its
        // own message rather than being masked as "re-pull first".
        const base = docOf(para("p1", "alpha"), para("p2", "beta"));
        const remote = docOf(para("p1", "alpha"), para("p2", "beta remote"));
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "alpha local\n\nbeta"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, base));
        const stub = new StubHttpClient()
            .on("GET", pageURL, { body: livePage(5, remote) })
            .on("PUT", putURL, { status: 200 });

        // A flavor that back-ports fine against the cached base (version 3, the
        // first reconstruct + change detection) but refuses the merge-path
        // reconstruct against the live document (version 5) with a lens-law error.
        const flavor: Flavor = {
            ...obsidianFlavor,
            reconstruct: (adf, body, o) => {
                if (adf.version === 5) {
                    throw new Error(
                        "push: cannot change the number of table columns",
                    );
                }
                return obsidianFlavor.reconstruct(adf, body, o);
            },
        };

        const err = await pusherFor(
            stub,
            fs,
            null,
            counterMint(),
            false,
            flavor,
        )
            .pushOne("/vault/p.md")
            .catch((e: unknown) => e as Error);
        if (!(err instanceof Error)) throw err;
        expect(err.message).toContain(
            "cannot change the number of table columns",
        );
        expect(err.message).not.toContain("re-pull first");
        expect(err.message).not.toContain("conflict: local base");
    });

    it("rejects frontmatter without a page id or version", async () => {
        const fs = new MemFS();
        await fs.write("/vault/p.md", "---\ntitle: X\n---\n\nbody");
        await expect(
            pusherFor(new StubHttpClient(), fs).pushOne("/vault/p.md"),
        ).rejects.toThrow("lacks page_id or page_version");
    });

    it("refuses to push a note carrying unresolved conflict markers", async () => {
        const fs = new MemFS();
        await fs.write(
            "/vault/p.md",
            note(
                3,
                "alpha\n<<<<<<< local (your edits)\nmine\n=======\ntheirs\n>>>>>>> remote (Confluence v4)\ngamma",
            ),
        );
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, baseDoc));
        const stub = new StubHttpClient();

        await expect(
            pusherFor(stub, fs).pushOne("/vault/p.md"),
        ).rejects.toThrow("unresolved conflict markers");
        // It bails before any network call.
        expect(stub.requests).toHaveLength(0);
    });

    it("force repushes an unchanged body when the link href regenerates", async () => {
        // Cached ADF links to page 42 by the old query-form href; the link
        // index now maps the same local target to the path-form href. The body
        // is byte-identical, so a normal push is a no-op; force repushes.
        const oldHref = "/wiki/pages/viewpage.action?pageId=42";
        const linkDoc = (href: string): Node & { version: number } => ({
            version: 1,
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    attrs: { localId: "p" },
                    content: [
                        { type: "text", text: "see " },
                        {
                            type: "text",
                            text: "Other",
                            marks: [{ type: "link", attrs: { href } }],
                        },
                    ],
                },
            ],
        });
        const base = linkDoc(oldHref);

        // A link index with page 42 at "other.md" produces the new path-form
        // href on push (via DocLinks.toRemote).
        const idx = new LinkIndex("/vault");
        idx.add({
            id: "42",
            dest: "other.md",
            url: "/wiki/spaces/X/pages/42",
            title: "Other",
            spaceKey: "X",
        });
        const links = linkMapper(
            idx,
            "/vault/p.md",
            "ex.atlassian.net",
            "https://ex.atlassian.net",
        );

        const fs = new MemFS();
        // Render the cached ADF to get the exact on-disk body (with the local
        // link target), so the body truly matches — the diff is all "keep".
        const [renderedMd, sm] = obsidianFlavor.render(
            newADF(cacheWrapper(3, base)),
            { assets: {}, links },
        );
        const body = renderedMd.slice(sm.bodyStart).replace(/\n$/, "");
        await fs.write("/vault/p.md", note(3, body));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, base));
        const stub = new StubHttpClient()
            .on("GET", pageURL, { body: livePage(3, base) })
            .on("PUT", putURL, { status: 200 });

        // Without force: no change is detected, nothing is PUT.
        const plain = await pusherFor(stub, fs, idx).pushOne("/vault/p.md");
        expect(plain.changed).toBe(false);

        // With force: the href regenerates, so the ADF differs and is PUT.
        const stub2 = new StubHttpClient()
            .on("GET", pageURL, { body: livePage(3, base) })
            .on("PUT", putURL, { status: 200 });
        const forced = await pusherFor(
            stub2,
            fs,
            idx,
            counterMint(),
            true,
        ).pushOne("/vault/p.md");
        expect(forced.changed).toBe(true);
        const put = stub2.requests.find((r) => r.method === "PUT");
        expect(String(put?.body)).toContain("/wiki/spaces/X/pages/42");
    });

    it("force makes no PUT when there is no conversion difference", async () => {
        // A plain paragraph, no links: under force every block is re-derived,
        // but a plain paragraph re-derives to the same ADF, so the push must
        // still be a no-op — force must not force a PUT on its own.
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "original"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, baseDoc));
        const stub = new StubHttpClient().on("GET", pageURL, {
            body: livePage(3, baseDoc),
        });

        const { changed } = await pusherFor(
            stub,
            fs,
            null,
            counterMint(),
            true,
        ).pushOne("/vault/p.md");

        expect(changed).toBe(false);
        expect(stub.requests.some((r) => r.method === "PUT")).toBe(false);
    });
});

describe("Pusher.pushOne with a new image", () => {
    const baseDoc = docOf(para("p", "intro"));
    const attURL =
        "https://ex.atlassian.net/wiki/rest/api/content/123/child/attachment";

    it("uploads, splices, PUTs, canonicalizes, and refreshes", async () => {
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "intro\n\n![[newpic.png]]"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, baseDoc));
        await fs.write("/vault/newpic.png", "IMG");
        const stub = new StubHttpClient()
            .on("POST", attURL, {
                body: JSON.stringify({
                    results: [{ id: "C1", extensions: { fileId: "F1" } }],
                }),
            })
            .on("GET", pageURL, { body: livePage(3, baseDoc) })
            .on("PUT", putURL, { status: 200 });

        const { changed, version } = await pusherFor(stub, fs).pushOne(
            "/vault/p.md",
        );

        expect(changed).toBe(true);
        expect(version).toBe(4);
        // The PUT carries the spliced media node.
        const put = stub.requests.find((r) => r.method === "PUT");
        expect(String(put?.body)).toContain("mediaSingle");
        expect(String(put?.body)).toContain("F1");
        expect(String(put?.body)).toContain("contentId-123");
        // The image was moved to _cfsync-media under its canonical name and the note
        // rewritten to embed it; the working-tree copy is gone.
        expect(await fs.readText("/vault/_cfsync-media/F1-L0.png")).toBe("IMG");
        expect(await fs.exists("/vault/newpic.png")).toBe(false);
        expect(await fs.readText("/vault/p.md")).toContain("![[F1-L0.png]]");
    });

    it("rejects an inline new image without uploading", async () => {
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "see ![[inline.png]] here"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, baseDoc));
        await fs.write("/vault/inline.png", "IMG");
        const stub = new StubHttpClient();

        await expect(
            pusherFor(stub, fs).pushOne("/vault/p.md"),
        ).rejects.toThrow("inline image");
        expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
    });

    it("deletes the orphan attachment when the PUT fails", async () => {
        const fs = new MemFS();
        await fs.write("/vault/p.md", note(3, "intro\n\n![[newpic.png]]"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, baseDoc));
        await fs.write("/vault/newpic.png", "IMG");
        const stub = new StubHttpClient()
            .on("POST", attURL, {
                body: JSON.stringify({
                    results: [{ id: "C1", extensions: { fileId: "F1" } }],
                }),
            })
            .on("GET", pageURL, { body: livePage(3, baseDoc) })
            .on("PUT", putURL, { status: 500 })
            .on("DELETE", "https://ex.atlassian.net/wiki/rest/api/content/C1", {
                status: 204,
            });

        await expect(
            pusherFor(stub, fs).pushOne("/vault/p.md"),
        ).rejects.toThrow("HTTP 500");
        expect(
            stub.requests.some(
                (r) =>
                    r.method === "DELETE" &&
                    r.url ===
                        "https://ex.atlassian.net/wiki/rest/api/content/C1",
            ),
        ).toBe(true);
    });
});

describe("Pusher post-update robustness (item 21)", () => {
    const baseDoc = docOf(para("p", "original"));

    it("counts the page pushed and advances the note version when the post-update refresh fails, surfacing a warning", async () => {
        // The remote update (PUT) succeeds, then writing the v4 ADF cache during
        // the refresh fails. The push must still count as pushed (the remote is
        // updated), advance the note's page_version so the next push does not
        // re-merge, and surface the refresh failure only as a warning.
        const fs = new WriteFailFS((p) => p.endsWith("p.v4.json"));
        await fs.write("/vault/p.md", note(3, "edited"));
        await fs.write("/data/cache/p.v3.json", cacheWrapper(3, baseDoc));
        const stub = new StubHttpClient()
            .on("GET", pageURL, { body: livePage(3, baseDoc) })
            .on("PUT", putURL, { status: 200 });

        const outcome = await pusherFor(stub, fs).pushDests(["/vault/p.md"]);

        // The remote PUT went out and the page counts as pushed, not failed.
        expect(stub.requests.some((r) => r.method === "PUT")).toBe(true);
        expect(outcome.pushed).toBe(1);
        expect(outcome.errors).toEqual([]);
        // The refresh failure is a warning, not a hard error.
        expect(outcome.warnings).toHaveLength(1);
        expect(outcome.warnings[0]).toContain("refreshing the local");
        expect(outcome.log).toContain("warning:");
        // The note's version advanced before the failed refresh, so a later push
        // is an in-sync update rather than a spurious re-merge.
        const stamped = await fs.readText("/vault/p.md");
        expect(stamped).toContain("page_version: 4");
        expect(stamped).toContain("edited");
        // The failed v4 cache was never written.
        expect(await fs.exists("/data/cache/p.v4.json")).toBe(false);
    });
});

describe("Pusher.pushCreate stamp preservation (item 22)", () => {
    const createURL = "https://ex.atlassian.net/wiki/api/v2/pages";
    const restrictURL =
        "https://ex.atlassian.net/wiki/rest/api/content/555/restriction";

    it("preserves mentions, page_images, space_key and cf_domain when stamping the create identity", async () => {
        // A create candidate carrying assets, mentions, space_key and cf_domain.
        // After the page is created and restricted, the follow-up refresh fails
        // (v1 cache write) — the stamped note must still carry those fields so a
        // later push can resolve the page's assets and mentions.
        const noteText =
            "---\n" +
            "cf_local: true\n" +
            'title: "New Page"\n' +
            'space_key: "SK"\n' +
            'cf_domain: "ex.atlassian.net"\n' +
            "mentions:\n  Ann: A1\n" +
            "page_images:\n" +
            "  - local_id: L1\n    file: ../_cfsync-media/x.png\n    alt: pic\n" +
            "---\n\nbody text";
        const dest = "/vault/new.md";
        const fs = new WriteFailFS((p) => p.endsWith(".json"));
        await fs.write(dest, noteText);
        const stub = new StubHttpClient()
            .on("POST", createURL, {
                body: JSON.stringify({ id: "555", version: { number: 1 } }),
            })
            .on("PUT", restrictURL, { status: 200 });

        const input: CreateInput = {
            dest,
            title: "New Page",
            spaceId: "9",
            parentId: "",
            folders: [],
        };
        // The create + restrict succeed; the follow-up cache write fails, so
        // pushCreate rejects — but only after the identity was stamped.
        await expect(
            pusherFor(stub, fs).pushCreate(dest, input, "acct-1", new Map()),
        ).rejects.toThrow();

        const stamped = await fs.readText(dest);
        expect(stamped).toContain('page_id: "555"');
        expect(stamped).toContain("page_version: 1");
        expect(stamped).toContain('space_key: "SK"');
        expect(stamped).toContain('cf_domain: "ex.atlassian.net"');
        expect(stamped).toContain("mentions:");
        expect(stamped).toContain('"Ann": "A1"');
        expect(stamped).toContain("page_images:");
        expect(stamped).toContain('local_id: "L1"');
        expect(stamped).toContain('file: "../_cfsync-media/x.png"');
        // The create marker replaced cf_local so it is no longer a candidate.
        expect(stamped).toContain("cfsync-plugin: pull");
        expect(stamped).not.toContain("cf_local");
    });
});

/** CountingFS is a MemFS that tallies readText calls per path. */
class CountingFS extends MemFS {
    readonly reads = new Map<string, number>();
    override readText(path: string): Promise<string> {
        this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
        return super.readText(path);
    }
}

describe("MetaCache", () => {
    const pagesConfig = (): Config =>
        buildConfig(
            {
                pages: {
                    "a.md": "https://ex.atlassian.net/wiki/spaces/S/pages/1/A",
                    "b.md": "https://ex.atlassian.net/wiki/spaces/S/pages/2/B",
                },
            },
            {
                site: "ex",
                account: "a@ex.com",
                token: "secret",
                syncRoot: "/vault",
            },
        );

    const seed = async (fs: MemFS): Promise<void> => {
        await fs.write(
            "/vault/a.md",
            "---\ncfsync-plugin: pull\ntitle: A\n---\nBody A\n",
        );
        await fs.write(
            "/vault/b.md",
            "---\ncfsync-plugin: pull\ntitle: B\n---\nBody B\n",
        );
    };

    it("reads each note once across discovery and create-planning", async () => {
        const fs = new CountingFS();
        await seed(fs);
        const cache = new MetaCache();
        const dests = await managedPushDests(fs, yaml, pagesConfig(), cache);
        await classifyCreates(fs, yaml, dests, [], cache);
        expect(fs.reads.get("/vault/a.md")).toBe(1);
        expect(fs.reads.get("/vault/b.md")).toBe(1);
    });

    it("reads each note once per phase without a cache", async () => {
        const fs = new CountingFS();
        await seed(fs);
        const dests = await managedPushDests(fs, yaml, pagesConfig());
        await classifyCreates(fs, yaml, dests, []);
        expect(fs.reads.get("/vault/a.md")).toBe(2);
        expect(fs.reads.get("/vault/b.md")).toBe(2);
    });

    it("memoizes a repeated read of the same path", async () => {
        const fs = new CountingFS();
        await seed(fs);
        const cache = new MetaCache();
        const first = await cache.read(fs, yaml, "/vault/a.md");
        const second = await cache.read(fs, yaml, "/vault/a.md");
        expect(first).toBe(second);
        expect(fs.reads.get("/vault/a.md")).toBe(1);
    });
});
