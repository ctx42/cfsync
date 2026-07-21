// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from the create-execution cases of pkg/cfsync/create_test.go
// (Test_pushCreate): ensuring the ancestor-folder chain, reuse and refusal on a
// per-space title collision, page create + author restriction, the rollbacks that
// keep a failed create from leaving an orphan folder or a world-visible page, and
// the id stamp that survives a failed local refresh. Driven through the ports with
// the sequential QueueHttpClient (mirroring Go's httpkit server) + MemFS.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import type { Yaml } from "../../src/ports/yaml.ts";
import type { CreateInput } from "../../src/sync/create.ts";
import { Pusher } from "../../src/sync/push.ts";
import { QueueHttpClient } from "../support/http-queue.ts";
import { MemFS } from "../support/memfs.ts";

const H = "https://ex.atlassian.net";
const yaml: Yaml = { parse: (t) => parseYaml(t) };
const CACHE = "/data/cache";

/** folderPageMD is a title-only new page; its placement comes from the plan. */
const folderPageMD = '---\ntitle: "Page"\n---\n\n# H\n\nbody\n';
/** newPageMD is a new page under a space root, with a real body. */
const newPageMD =
    '---\ntitle: "New Page"\nspace_id: "9"\nparent_id: "77"\n---\n\n' +
    "# Heading\n\nA paragraph.\n";

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

function pusherFor(q: QueueHttpClient, fs: MemFS, cacheDir = CACHE): Pusher {
    const cfg = config();
    return new Pusher({
        client: new ConfluenceClient(q, {
            host: H,
            account: "a@ex.com",
            token: "secret",
        }),
        fs,
        yaml,
        config: cfg,
        reporter: new NoopReporter(),
        cacheDir,
        assetsDir: "/vault/_cfsync-media",
        mintLocalId: () => "L0",
        links: null,
        flavor: obsidianFlavor,
        force: false,
    });
}

/** input builds a CreateInput with sensible create defaults. */
function input(over: Partial<CreateInput> & { dest: string }): CreateInput {
    return {
        title: "Page",
        spaceId: "9",
        parentId: "100",
        folders: [],
        ...over,
    };
}

const TAKEN =
    '{"errors":[{"title":"A folder exists with the same title in this space"}]}';
const FOUND_ALPHA =
    '{"results":[{"id":"FX","type":"folder","title":"Alpha","status":"current"}],"_links":{}}';

describe("Pusher.pushCreate — folder chain", () => {
    it("creates ancestor folders then the page under the deepest", async () => {
        const fs = new MemFS();
        const dest = "/vault/team/alpha/beta/p.md";
        await fs.write(dest, folderPageMD);
        const folderIds = new Map<string, string>();
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"F1"}') // Alpha POST
            .rsp(200, "{}") // F1 restrict
            .rsp(200, '{"id":"F2"}') // Beta POST
            .rsp(200, "{}") // F2 restrict
            .rsp(200, '{"id":"555","version":{"number":1}}') // page
            .rsp(200, "{}"); // page restrict

        const { version } = await pusherFor(q, fs).pushCreate(
            dest,
            input({
                dest,
                folders: [
                    { dir: "/vault/team/alpha", title: "Alpha" },
                    { dir: "/vault/team/alpha/beta", title: "Beta" },
                ],
            }),
            "acc-1",
            folderIds,
        );

        expect(version).toBe(1);
        expect(q.requests[0]?.url).toBe(`${H}/wiki/api/v2/folders`);
        expect(q.bodyOf(0)).toContain('"title":"Alpha"');
        expect(q.bodyOf(0)).toContain('"parentId":"100"');
        expect(q.requests[1]?.url).toBe(
            `${H}/wiki/rest/api/content/F1/restriction`,
        );
        expect(q.bodyOf(2)).toContain('"title":"Beta"');
        expect(q.bodyOf(2)).toContain('"parentId":"F1"');
        expect(q.requests[3]?.url).toBe(
            `${H}/wiki/rest/api/content/F2/restriction`,
        );
        expect(q.requests[4]?.url).toBe(`${H}/wiki/api/v2/pages`);
        expect(q.bodyOf(4)).toContain('"parentId":"F2"');
        expect(q.requests[5]?.url).toBe(
            `${H}/wiki/rest/api/content/555/restriction`,
        );
        expect(folderIds.get("/vault/team/alpha")).toBe("F1");
        expect(folderIds.get("/vault/team/alpha/beta")).toBe("F2");
    });

    it("reuses a folder that already exists under the parent", async () => {
        const fs = new MemFS();
        const dest = "/vault/team/alpha/p.md";
        await fs.write(dest, folderPageMD);
        const folderIds = new Map<string, string>();
        const q = new QueueHttpClient()
            .rsp(400, TAKEN) // Alpha POST collides
            .rsp(200, FOUND_ALPHA) // lookup under parent
            .rsp(200, '{"id":"555","version":{"number":1}}') // page
            .rsp(200, "{}"); // page restrict

        const { version, reused } = await pusherFor(q, fs).pushCreate(
            dest,
            input({
                dest,
                folders: [{ dir: "/vault/team/alpha", title: "Alpha" }],
            }),
            "acc-1",
            folderIds,
        );

        expect(version).toBe(1);
        expect(reused).toEqual(["Alpha"]);
        expect(q.count).toBe(4);
        expect(q.requests[1]?.url).toBe(
            `${H}/wiki/api/v2/folders/100/direct-children`,
        );
        expect(q.requests[2]?.url).toBe(`${H}/wiki/api/v2/pages`);
        expect(q.bodyOf(2)).toContain('"parentId":"FX"');
        expect(folderIds.get("/vault/team/alpha")).toBe("FX");
    });

    it("reuses a folder under a page parent via endpoint fallback", async () => {
        const fs = new MemFS();
        const dest = "/vault/team/alpha/p.md";
        await fs.write(dest, folderPageMD);
        const q = new QueueHttpClient()
            .rsp(400, TAKEN) // Alpha POST collides
            .rsp(404) // folder lookup: not a folder
            .rsp(200, FOUND_ALPHA) // page lookup: found
            .rsp(200, '{"id":"555","version":{"number":1}}') // page
            .rsp(200, "{}"); // page restrict

        await pusherFor(q, fs).pushCreate(
            dest,
            input({
                dest,
                folders: [{ dir: "/vault/team/alpha", title: "Alpha" }],
            }),
            "acc-1",
            new Map(),
        );

        expect(q.count).toBe(5);
        expect(q.requests[1]?.url).toBe(
            `${H}/wiki/api/v2/folders/100/direct-children`,
        );
        expect(q.requests[2]?.url).toBe(
            `${H}/wiki/api/v2/pages/100/direct-children`,
        );
        expect(q.bodyOf(3)).toContain('"parentId":"FX"');
    });

    it("refuses a cross-parent folder title collision and rolls back", async () => {
        const fs = new MemFS();
        const dest = "/vault/team/alpha/beta/p.md";
        await fs.write(dest, folderPageMD);
        const folderIds = new Map<string, string>();
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"F1"}') // Alpha POST
            .rsp(200, "{}") // F1 restrict
            .rsp(400, TAKEN) // Beta POST collides
            .rsp(200, '{"results":[],"_links":{}}') // lookup under F1: absent
            .rsp(204); // rollback DELETE F1

        await expect(
            pusherFor(q, fs).pushCreate(
                dest,
                input({
                    dest,
                    folders: [
                        { dir: "/vault/team/alpha", title: "Alpha" },
                        { dir: "/vault/team/alpha/beta", title: "Beta" },
                    ],
                }),
                "acc-1",
                folderIds,
            ),
        ).rejects.toThrow('folder "Beta" already exists elsewhere');

        expect(q.count).toBe(5);
        expect(q.requests[4]?.method).toBe("DELETE");
        expect(q.requests[4]?.url).toBe(`${H}/wiki/api/v2/folders/F1`);
        expect(folderIds.has("/vault/team/alpha")).toBe(false);
    });

    it("reuses a folder created earlier in the run", async () => {
        const fs = new MemFS();
        const one = "/vault/team/alpha/one.md";
        const two = "/vault/team/alpha/two.md";
        await fs.write(one, folderPageMD);
        await fs.write(two, folderPageMD);
        const folder = { dir: "/vault/team/alpha", title: "Alpha" };
        const folderIds = new Map<string, string>();
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"F1"}') // folder once
            .rsp(200, "{}") // F1 restrict
            .rsp(200, '{"id":"501","version":{"number":1}}') // one
            .rsp(200, "{}") // one restrict
            .rsp(200, '{"id":"502","version":{"number":1}}') // two
            .rsp(200, "{}"); // two restrict
        const pusher = pusherFor(q, fs);

        await pusher.pushCreate(
            one,
            input({ dest: one, title: "One", folders: [folder] }),
            "acc-1",
            folderIds,
        );
        await pusher.pushCreate(
            two,
            input({ dest: two, title: "Two", folders: [folder] }),
            "acc-1",
            folderIds,
        );

        expect(q.count).toBe(6);
        expect(q.requests[4]?.url).toBe(`${H}/wiki/api/v2/pages`);
        expect(q.bodyOf(4)).toContain('"parentId":"F1"');
    });

    it("recreates a folder after a failed page rolled it back", async () => {
        const fs = new MemFS();
        const one = "/vault/team/alpha/one.md";
        const two = "/vault/team/alpha/two.md";
        await fs.write(one, folderPageMD);
        await fs.write(two, folderPageMD);
        const folder = { dir: "/vault/team/alpha", title: "Alpha" };
        const folderIds = new Map<string, string>();
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"F1"}') // Alpha POST (one)
            .rsp(200, "{}") // F1 restrict
            .rsp(500) // one page POST fails
            .rsp(204) // rollback DELETE F1
            .rsp(200, '{"id":"F2"}') // Alpha POST again (two)
            .rsp(200, "{}") // F2 restrict
            .rsp(200, '{"id":"502","version":{"number":1}}') // two page
            .rsp(200, "{}"); // two restrict
        const pusher = pusherFor(q, fs);

        await expect(
            pusher.pushCreate(
                one,
                input({ dest: one, title: "One", folders: [folder] }),
                "acc-1",
                folderIds,
            ),
        ).rejects.toThrow();
        await pusher.pushCreate(
            two,
            input({ dest: two, title: "Two", folders: [folder] }),
            "acc-1",
            folderIds,
        );

        expect(q.count).toBe(8);
        expect(q.requests[3]?.method).toBe("DELETE");
        expect(q.requests[3]?.url).toBe(`${H}/wiki/api/v2/folders/F1`);
        expect(q.requests[4]?.url).toBe(`${H}/wiki/api/v2/folders`);
        expect(folderIds.get(folder.dir)).toBe("F2");
    });

    it("rolls back created folders when a later folder fails", async () => {
        const fs = new MemFS();
        const dest = "/vault/team/alpha/beta/p.md";
        await fs.write(dest, folderPageMD);
        const folderIds = new Map<string, string>();
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"F1"}') // Alpha POST
            .rsp(200, "{}") // F1 restrict
            .rsp(500) // Beta POST fails
            .rsp(204); // rollback DELETE F1

        await expect(
            pusherFor(q, fs).pushCreate(
                dest,
                input({
                    dest,
                    folders: [
                        { dir: "/vault/team/alpha", title: "Alpha" },
                        { dir: "/vault/team/alpha/beta", title: "Beta" },
                    ],
                }),
                "acc-1",
                folderIds,
            ),
        ).rejects.toThrow("create folder");

        expect(q.count).toBe(4);
        expect(q.requests[3]?.method).toBe("DELETE");
        expect(q.requests[3]?.url).toBe(`${H}/wiki/api/v2/folders/F1`);
        expect(folderIds.size).toBe(0);
    });
});

describe("Pusher.pushCreate — page create and refresh", () => {
    it("creates the page, restricts it, and refreshes locally", async () => {
        const fs = new MemFS();
        const dest = "/vault/team/new.md";
        await fs.write(dest, newPageMD);
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"555","version":{"number":1}}')
            .rsp(200, "{}"); // restriction PUT

        const { version } = await pusherFor(q, fs).pushCreate(
            dest,
            input({ dest, title: "New Page", parentId: "77" }),
            "acc-1",
            new Map(),
        );

        expect(version).toBe(1);
        expect(q.requests[0]?.url).toBe(`${H}/wiki/api/v2/pages`);
        expect(q.bodyOf(0)).toContain("Heading");
        expect(q.bodyOf(0)).toContain("A paragraph.");
        expect(q.requests[1]?.url).toBe(
            `${H}/wiki/rest/api/content/555/restriction`,
        );

        const refreshed = await fs.readText(dest);
        expect(refreshed).toContain('page_id: "555"');
        expect(refreshed).toContain("page_version: 1");
        expect(refreshed).toContain("cfsync-plugin: pull");
        expect(await fs.exists(`${CACHE}/team/new.v1.json`)).toBe(true);
    });

    it("deletes the page when the restriction fails", async () => {
        const fs = new MemFS();
        const dest = "/vault/team/new.md";
        await fs.write(dest, newPageMD);
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"555","version":{"number":1}}')
            .rsp(500) // restriction PUT fails
            .rsp(204); // rollback DELETE

        await expect(
            pusherFor(q, fs).pushCreate(
                dest,
                input({ dest, title: "New Page", parentId: "77" }),
                "acc-1",
                new Map(),
            ),
        ).rejects.toThrow("restrict page 555: HTTP 500");

        expect(q.requests[2]?.method).toBe("DELETE");
        expect(q.requests[2]?.url).toBe(`${H}/wiki/api/v2/pages/555`);
        expect(await fs.readText(dest)).not.toContain("page_id");
    });

    it("stamps the page id when the local refresh fails", async () => {
        // A FileSystem whose writes under the cache dir fail, mirroring Go's
        // "cache dir is a file" case: the note stamp still lands.
        class CacheFailFS extends MemFS {
            override write(
                path: string,
                data: Uint8Array | string,
            ): Promise<void> {
                if (path.startsWith(CACHE)) {
                    return Promise.reject(new Error("cache is a file"));
                }
                return super.write(path, data);
            }
        }
        const fs = new CacheFailFS();
        const dest = "/vault/team/new.md";
        await fs.write(dest, newPageMD);
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"555","version":{"number":1}}')
            .rsp(200, "{}");

        await expect(
            pusherFor(q, fs).pushCreate(
                dest,
                input({ dest, title: "New Page", parentId: "77" }),
                "acc-1",
                new Map(),
            ),
        ).rejects.toThrow();

        const refreshed = await fs.readText(dest);
        expect(refreshed).toContain('page_id: "555"');
        expect(refreshed).toContain("page_version: 1");
        expect(refreshed).toContain("cfsync-plugin: pull");
    });

    it("joins the delete error when restriction and rollback both fail", async () => {
        const fs = new MemFS();
        const dest = "/vault/team/new.md";
        await fs.write(dest, newPageMD);
        const q = new QueueHttpClient()
            .rsp(200, '{"id":"555","version":{"number":1}}')
            .rsp(500) // restriction PUT
            .rsp(500); // rollback DELETE

        const err = await pusherFor(q, fs)
            .pushCreate(
                dest,
                input({ dest, title: "New Page", parentId: "77" }),
                "acc-1",
                new Map(),
            )
            .catch((e: unknown) => e);

        expect(String(err)).toContain("restrict page 555: HTTP 500");
        expect(String(err)).toContain("delete page 555: HTTP 500");
    });
});
