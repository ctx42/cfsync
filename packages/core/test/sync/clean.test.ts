// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/cfsync/clean_test.go. clean discovers each root's remote content
// over the HttpClient port and scans the disk over the FileSystem port, so it is
// driven with StubHttpClient + MemFS + the real `yaml` parser. The confirm/prompt
// UX is the adapter's; core is `findStale` + `removeStale`.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import type { Yaml } from "../../src/ports/yaml.ts";
import {
    type CleanDeps,
    findStale,
    removeStale,
} from "../../src/sync/clean.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const H = "https://ex.atlassian.net";
const yaml: Yaml = { parse: (t) => parseYaml(t) };

const config = (): Config =>
    buildConfig(
        { folders: { docs: "/wiki/spaces/X/folder/100" } },
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );

/** managed builds a cfsync-managed note (carries the cfsync-plugin marker and a page id). */
const managed = (pageId: string): string =>
    `---\ncfsync-plugin: pull\ntitle: "T"\npage_id: "${pageId}"\npage_version: 1\n---\n\nbody`;

function depsFor(stub: StubHttpClient, fs: MemFS): CleanDeps {
    const cfg = config();
    return {
        client: new ConfluenceClient(stub, {
            host: H,
            account: "a@ex.com",
            token: "secret",
        }),
        fs,
        yaml,
        config: cfg,
        reporter: new NoopReporter(),
    };
}

/** folderChildren registers the direct-children response for folder 100. */
function folderChildren(
    stub: StubHttpClient,
    results: Array<{ id: string; type: string; title: string }>,
): StubHttpClient {
    return stub.on("GET", `${H}/wiki/api/v2/folders/100/direct-children`, {
        body: JSON.stringify({
            results: results.map((r) => ({ status: "current", ...r })),
            _links: {},
        }),
    });
}

describe("findStale / removeStale", () => {
    it("finds managed notes with no remote page and the dirs they empty", async () => {
        const fs = new MemFS();
        await fs.write("/vault/docs/keep.md", managed("7")); // still remote
        await fs.write("/vault/docs/gone.md", managed("9")); // stale
        await fs.write("/vault/docs/notes/old.md", managed("10")); // stale
        await fs.write("/vault/docs/readme.md", "not managed"); // no frontmatter
        // Remote currently has only "Keep" → /vault/docs/keep.md.
        const stub = folderChildren(new StubHttpClient(), [
            { id: "7", type: "page", title: "Keep" },
        ]);

        const plan = await findStale(depsFor(stub, fs));

        const paths = plan.items.map((i) => i.path);
        expect(paths).toContain("/vault/docs/gone.md");
        expect(paths).toContain("/vault/docs/notes/old.md");
        expect(paths).toContain("/vault/docs/notes"); // removable once emptied
        expect(paths).not.toContain("/vault/docs/keep.md");
        expect(paths).not.toContain("/vault/docs/readme.md");
        expect(plan.warnings).toEqual([]);

        const res = await removeStale(fs, plan.items);
        expect(res.removedFiles).toBe(2);
        expect(res.removedDirs).toBe(1);
        expect(await fs.exists("/vault/docs/gone.md")).toBe(false);
        expect(await fs.exists("/vault/docs/notes")).toBe(false);
        expect(await fs.exists("/vault/docs/keep.md")).toBe(true);
        expect(await fs.exists("/vault/docs/readme.md")).toBe(true);
    });

    it("ignores a page_id-only note lacking the cfsync-plugin marker", async () => {
        const fs = new MemFS();
        // Pre-marker note: has a page id but no `cfsync-plugin: pull`.
        await fs.write(
            "/vault/docs/legacy.md",
            '---\ntitle: "T"\npage_id: "9"\npage_version: 1\n---\n\nbody',
        );
        // Remote has no matching page, so a cfsync-managed note here would be stale.
        const stub = folderChildren(new StubHttpClient(), []);

        const plan = await findStale(depsFor(stub, fs));

        expect(plan.items.map((i) => i.path)).not.toContain(
            "/vault/docs/legacy.md",
        );
        expect(await fs.exists("/vault/docs/legacy.md")).toBe(true);
    });

    it("treats a cfsync-marked note with no page_id as stale", async () => {
        const fs = new MemFS();
        await fs.write("/vault/docs/keep.md", managed("7")); // still remote
        // Marker present, page id absent: the `cfsync-plugin: pull` marker alone
        // drives staleness, pinning it as the sole gate (not `page_id`). A live
        // remote page keeps discovery non-empty, so the empty-discovery floor
        // does not apply — marker-based staleness is what is under test.
        await fs.write(
            "/vault/docs/marked.md",
            '---\ncfsync-plugin: pull\ntitle: "T"\npage_version: 1\n---\n\nbody',
        );
        const stub = folderChildren(new StubHttpClient(), [
            { id: "7", type: "page", title: "Keep" },
        ]);

        const plan = await findStale(depsFor(stub, fs));

        expect(plan.items.map((i) => i.path)).toContain(
            "/vault/docs/marked.md",
        );

        const res = await removeStale(fs, plan.items);
        expect(res.removedFiles).toBe(1);
        expect(await fs.exists("/vault/docs/marked.md")).toBe(false);
        expect(await fs.exists("/vault/docs/keep.md")).toBe(true);
    });

    it("skips an empty-discovery root that still holds managed notes, deleting nothing", async () => {
        const fs = new MemFS();
        // A successful-but-empty discovery (e.g. revoked permission or a
        // transient blank listing) must not wipe managed notes on disk.
        await fs.write("/vault/docs/a.md", managed("9"));
        await fs.write("/vault/docs/sub/b.md", managed("10"));
        const stub = folderChildren(new StubHttpClient(), []); // empty result

        const plan = await findStale(depsFor(stub, fs));

        expect(plan.items).toEqual([]);
        expect(plan.warnings.length).toBe(1);
        expect(plan.warnings[0]).toContain("skipping /vault/docs");
        expect(plan.warnings[0]).toContain("managed");
        expect(await fs.exists("/vault/docs/a.md")).toBe(true);
        expect(await fs.exists("/vault/docs/sub/b.md")).toBe(true);
    });

    it("cleans nothing for an empty-discovery root with no managed notes", async () => {
        const fs = new MemFS();
        // A root genuinely emptied remotely, with only unmanaged files left, is
        // a no-op: nothing to delete and no warning to raise.
        await fs.write("/vault/docs/readme.md", "not managed"); // no frontmatter
        const stub = folderChildren(new StubHttpClient(), []);

        const plan = await findStale(depsFor(stub, fs));

        expect(plan.items).toEqual([]);
        expect(plan.warnings).toEqual([]);
        expect(await fs.exists("/vault/docs/readme.md")).toBe(true);
    });

    it("skips a root whose discovery fails, cleaning nothing there", async () => {
        const fs = new MemFS();
        await fs.write("/vault/docs/gone.md", managed("9"));
        const stub = new StubHttpClient().on(
            "GET",
            `${H}/wiki/api/v2/folders/100/direct-children`,
            { status: 500 },
        );

        const plan = await findStale(depsFor(stub, fs));

        expect(plan.items).toEqual([]);
        expect(plan.warnings[0]).toContain("skipping");
        expect(await fs.exists("/vault/docs/gone.md")).toBe(true);
    });
});
