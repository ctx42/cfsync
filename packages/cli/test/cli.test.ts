// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// End-to-end CLI tests: they drive `main` through its injected MainCtx with an
// in-memory filesystem and a stub HTTP client (reused from the core test support),
// so a whole command runs — flag parsing, config + env loading, dep assembly,
// orchestration, and output routing — without touching the network or disk.

import {
    type Clock,
    type HttpClient,
    newADF,
    obsidianFlavor,
    type Streams,
} from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { StubHttpClient } from "../../core/test/support/http-stub.ts";
import { MemFS } from "../../core/test/support/memfs.ts";
import { MemLock } from "../../core/test/support/memlock.ts";
import { NodeEnv } from "../src/adapters/env.ts";
import { EXIT_ERR, EXIT_OK, type MainCtx, main } from "../src/main.ts";
import { VERSION } from "../src/version.ts";

const SITE = "ex";
const HOST = "https://ex.atlassian.net";

/** capture builds a Streams whose output is inspectable. */
function capture(): Streams & { outText(): string; errText(): string } {
    let out = "";
    let err = "";
    return {
        stdin: { readAll: () => "" },
        stdout: { write: (t) => (out += t) },
        stderr: { write: (t) => (err += t) },
        outText: () => out,
        errText: () => err,
    };
}

const clock: Clock = () => new Date(1_000_000);

/** ctxFor builds a MainCtx over the given filesystem, env, and HTTP stub. */
function ctxFor(
    argv: string[],
    fs: MemFS,
    env: NodeEnv,
    http?: HttpClient,
): { ctx: MainCtx; streams: ReturnType<typeof capture> } {
    const streams = capture();
    const ctx: MainCtx = {
        argv,
        streams,
        env,
        fs,
        clock,
        isTTY: false,
        ask: () => Promise.resolve(""),
        yaml: { parse: parseYaml },
        lock: new MemLock(),
        ...(http ? { httpClient: http } : {}),
    };
    return { ctx, streams };
}

/** secretsEnv builds an env with the four secrets set, syncRoot at `root`. */
const secretsEnv = (root: string): NodeEnv =>
    new NodeEnv({
        CFSYNC_SITE: SITE,
        CFSYNC_ACCOUNT: "me@ex.com",
        CFSYNC_TOKEN: "tok",
        CFSYNC_ROOT: root,
    });

/** withConfig writes a config file at /w/.cfsync.yaml and returns the MemFS. */
async function withConfig(yaml: string): Promise<MemFS> {
    const fs = new MemFS();
    await fs.write("/w/.cfsync.yaml", yaml);
    return fs;
}

const CONFIG_ARG = ["--config", "/w/.cfsync.yaml"];

describe("dispatch", () => {
    it("prints the version", async () => {
        const { ctx, streams } = ctxFor(
            ["version"],
            new MemFS(),
            new NodeEnv(),
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe(`cfsync ${VERSION}\n`);
    });

    it("prints top-level and per-command help", async () => {
        const top = ctxFor(["help"], new MemFS(), new NodeEnv());
        expect(await main(top.ctx)).toBe(EXIT_OK);
        expect(top.streams.outText()).toContain("Usage:");

        const push = ctxFor(["help", "push"], new MemFS(), new NodeEnv());
        expect(await main(push.ctx)).toBe(EXIT_OK);
        expect(push.streams.outText()).toContain("cfsync push —");
        expect(push.streams.outText()).toContain("--force");

        const status = ctxFor(["help", "status"], new MemFS(), new NodeEnv());
        expect(await main(status.ctx)).toBe(EXIT_OK);
        expect(status.streams.outText()).toContain("cfsync status —");
    });

    it("errors on no args and on an unknown command", async () => {
        const bare = ctxFor([], new MemFS(), new NodeEnv());
        expect(await main(bare.ctx)).toBe(EXIT_ERR);
        expect(bare.streams.errText()).toContain("Usage:");

        const bad = ctxFor(["frob"], new MemFS(), new NodeEnv());
        expect(await main(bad.ctx)).toBe(EXIT_ERR);
        expect(bad.streams.errText()).toContain("unknown command: frob");
    });

    it("prints a command's help with --help", async () => {
        const { ctx, streams } = ctxFor(
            ["pull", "--help"],
            new MemFS(),
            new NodeEnv(),
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toContain("cfsync pull —");
    });
});

describe("test command", () => {
    it("reports the authenticated connection", async () => {
        const fs = await withConfig("pages: {}\n");
        const http = new StubHttpClient().on(
            "GET",
            `${HOST}/wiki/rest/api/user/current`,
            { body: '{"accountId":"acc-1"}' },
        );
        const { ctx, streams } = ctxFor(
            ["test", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe(
            `cfsync: connected to ${HOST} as acc-1\n`,
        );
    });

    it("fails when the config file is missing", async () => {
        const { ctx, streams } = ctxFor(
            ["test", "--config", "/w/none.yaml"],
            new MemFS(),
            secretsEnv("/w"),
        );
        expect(await main(ctx)).toBe(EXIT_ERR);
        expect(streams.errText()).toContain("reading config");
    });
});

describe("offline commands", () => {
    it("gc reports no orphans when the assets dir is empty", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx, streams } = ctxFor(
            ["gc", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toContain("no orphaned assets");
    });

    it("push reports nothing to push with no managed pages", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx, streams } = ctxFor(
            ["push", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe("cfsync: no pages to push\n");
    });

    it("push --force is accepted and reports nothing to push with no pages", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx, streams } = ctxFor(
            ["push", "--force", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe("cfsync: no pages to push\n");
    });

    it("clean reports nothing to clean with no roots", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx, streams } = ctxFor(
            ["clean", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe("cfsync: nothing to clean\n");
    });

    it("rejects too many page arguments", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx, streams } = ctxFor(
            ["pull", "a.md", "b.md", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
        );
        expect(await main(ctx)).toBe(EXIT_ERR);
        expect(streams.errText()).toContain("accepts at most one page");
    });

    it("status reports everything up to date with no managed pages", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe("cfsync: everything up to date\n");
    });
});

describe("run lock", () => {
    it("refuses a command while another live run holds the lock", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
        );
        const lock = new MemLock();
        lock.alive.add(9);
        const holder = {
            pid: 9,
            tool: "plugin",
            command: "pull",
            startedAt: "2026-10-02T10:00:00Z",
        };
        lock.files.set("/w/.adf_cache/cfsync.lock", JSON.stringify(holder));
        ctx.lock = lock;

        expect(await main(ctx)).toBe(EXIT_ERR);
        expect(streams.errText()).toContain(
            "busy: cfsync plugin pull, pid 9 is running",
        );
    });

    it("releases the lock when the command finishes", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx } = ctxFor(["status", ...CONFIG_ARG], fs, secretsEnv("/w"));
        const lock = new MemLock();
        ctx.lock = lock;

        expect(await main(ctx)).toBe(EXIT_OK);
        expect(lock.files.size).toBe(0);
    });
});

describe("status command", () => {
    const adfDoc = {
        version: 1,
        type: "doc",
        content: [
            {
                type: "paragraph",
                attrs: { localId: "p1" },
                content: [{ type: "text", text: "Body text." }],
            },
        ],
    };

    /**
     * pulled seeds `/w/<name>` and its cached base as a pull at `version` would;
     * with `edit` the note's text is then changed so a push would update it.
     */
    async function pulled(
        fs: MemFS,
        name: string,
        id: string,
        version: number,
        edit = false,
    ): Promise<void> {
        const json = JSON.stringify({
            name,
            id,
            title: "P",
            version,
            space_id: "9",
            adf: adfDoc,
        });
        const md = obsidianFlavor.render(newADF(json), {
            assets: {},
            links: null,
        })[0];
        const base = `/w/.adf_cache/${name.slice(0, -".md".length)}`;
        await fs.write(`${base}.v${version}.json`, json);
        await fs.write(`${base}.v${version}.md`, md);
        await fs.write(
            `/w/${name}`,
            edit ? md.replace("Body text.", "Edited text.") : md,
        );
    }

    /** bulk is one fetchPageVersions response for the given id/version pairs. */
    const bulk = (...pairs: Array<[string, number]>): string =>
        JSON.stringify({
            results: pairs.map(([id, number]) => ({ id, version: { number } })),
            _links: {},
        });

    const bulkURL = (...ids: string[]): string =>
        `${HOST}/wiki/api/v2/pages?${ids.map((id) => `id=${id}`).join("&")}&limit=250`;

    const vault = (): Promise<MemFS> =>
        withConfig('folders:\n  wiki: "/wiki/spaces/T"\n');

    it("reports push, pull, and diverged sections like git status", async () => {
        const fs = await vault();
        await pulled(fs, "wiki/Same.md", "1", 5);
        await pulled(fs, "wiki/Edited.md", "2", 5, true);
        await pulled(fs, "wiki/Behind.md", "3", 12);
        await pulled(fs, "wiki/Both.md", "4", 7, true);
        await fs.write(
            "/w/wiki/Broken.md",
            '---\ntitle: X\npage_id: "5"\npage_version: 2\n---\n' +
                "<<<<<<< local\na\n=======\nb\n>>>>>>> remote\n",
        );
        await fs.write("/w/wiki/New.md", "---\ntitle: New\n---\nx\n");
        await fs.write(
            "/w/wiki/Mine.md",
            "---\ntitle: Mine\ncfsync-plugin: ignore-push\n---\nx\n",
        );
        const http = new StubHttpClient()
            .on("GET", bulkURL("3", "4", "5", "2", "1"), {
                body: bulk(["1", 5], ["2", 5], ["3", 14], ["4", 9], ["5", 2]),
            })
            .on(
                "GET",
                `${HOST}/wiki/api/v2/pages/5?body-format=atlas_doc_format&version=2`,
                {
                    body: JSON.stringify({
                        id: "5",
                        title: "X",
                        version: { number: 2 },
                        body: { atlas_doc_format: { value: '{"type":"doc"}' } },
                    }),
                },
            );
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe(
            "To push (3):\n" +
                "  refused   wiki/Broken.md  (unresolved conflict markers; " +
                "resolve them before pushing)\n" +
                "  modified  wiki/Edited.md\n" +
                "  new       wiki/New.md\n" +
                "\n" +
                "To pull (1):\n" +
                "  remote    wiki/Behind.md  local v12 -> remote v14\n" +
                "\n" +
                "Diverged (1):\n" +
                "  diverged  wiki/Both.md    local v7 -> remote v9, local edits\n",
        );
    });

    it("lists ignored notes with --ignored", async () => {
        const fs = await vault();
        await pulled(fs, "wiki/Same.md", "1", 5);
        await fs.write(
            "/w/wiki/Mine.md",
            "---\ntitle: Mine\ncfsync-plugin: ignore-push\n---\nx\n",
        );
        const http = new StubHttpClient().on("GET", bulkURL("1"), {
            body: bulk(["1", 5]),
        });
        const { ctx, streams } = ctxFor(
            ["status", "--ignored", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe(
            "Ignored (1):\n  ignored  wiki/Mine.md\n\n" +
                "cfsync: everything up to date\n",
        );
    });

    it("reports only the notes under a path argument", async () => {
        const fs = await vault();
        await pulled(fs, "wiki/a/One.md", "1", 5, true);
        await pulled(fs, "wiki/b/Two.md", "2", 5, true);
        const http = new StubHttpClient().on("GET", bulkURL("1"), {
            body: bulk(["1", 5]),
        });
        const { ctx, streams } = ctxFor(
            ["status", "wiki/a", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe(
            "To push (1):\n  modified  wiki/a/One.md\n",
        );
    });

    it("reports everything up to date when nothing is pending", async () => {
        const fs = await vault();
        await pulled(fs, "wiki/Same.md", "1", 5);
        const http = new StubHttpClient().on("GET", bulkURL("1"), {
            body: bulk(["1", 5]),
        });
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe("cfsync: everything up to date\n");
    });

    it("warns about a page it could not check", async () => {
        const fs = await vault();
        await pulled(fs, "wiki/A.md", "1", 5);
        // The bulk response omits id 1 (deleted or not visible).
        const http = new StubHttpClient().on("GET", bulkURL("1"), {
            body: bulk(),
        });
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe(
            "cfsync: nothing to push or pull among the checked pages\n\n" +
                "warning: wiki/A.md: could not check " +
                "(page not found on Confluence)\n",
        );
    });

    describe("with -i", () => {
        const pageEntry = "pages:\n  wiki/A.md: /wiki/spaces/T/pages/1/A\n";
        const live = (): StubHttpClient =>
            new StubHttpClient()
                .on("GET", bulkURL("1"), { body: bulk(["1", 5]) })
                .on(
                    "GET",
                    `${HOST}/wiki/api/v2/pages/1?body-format=atlas_doc_format`,
                    {
                        body: JSON.stringify({
                            id: "1",
                            title: "P",
                            spaceId: "9",
                            parentId: "",
                            version: { number: 5 },
                            body: {
                                atlas_doc_format: {
                                    value: JSON.stringify(adfDoc),
                                },
                            },
                        }),
                    },
                );

        /** interactive runs `status -i` with scripted keys and answers. */
        async function interactive(
            fs: MemFS,
            http: StubHttpClient,
            keys: string[],
            answers: string[] = [],
        ) {
            const { ctx, streams } = ctxFor(
                ["status", "-i", ...CONFIG_ARG],
                fs,
                secretsEnv("/w"),
                http,
            );
            let k = 0;
            let a = 0;
            ctx.stdinIsTTY = true;
            ctx.keys = () => ({
                next: () => Promise.resolve(keys[k++] ?? "\r"),
                close: () => {},
            });
            ctx.ask = () => Promise.resolve(answers[a++] ?? "");
            return { code: await main(ctx), streams };
        }

        it("applies nothing when enter is pressed straight away", async () => {
            const fs = await withConfig(pageEntry);
            await pulled(fs, "wiki/A.md", "1", 5, true);
            const edited = await fs.readText("/w/wiki/A.md");

            const have = await interactive(fs, live(), ["\r"]);

            expect(have.code).toBe(EXIT_OK);
            expect(have.streams.outText()).toBe("cfsync: nothing to apply\n");
            expect(await fs.readText("/w/wiki/A.md")).toBe(edited);
        });

        it("overwrites a modified note after the confirmation", async () => {
            const fs = await withConfig(pageEntry);
            await pulled(fs, "wiki/A.md", "1", 5, true);

            const have = await interactive(fs, live(), ["o", "\r"], ["y"]);

            expect(have.code).toBe(EXIT_OK);
            expect(have.streams.errText()).toContain("  wiki/A.md\n");
            expect(have.streams.outText()).toContain(
                "ok      overwrite from Confluence  wiki/A.md",
            );
            expect(await fs.readText("/w/wiki/A.md")).toContain("Body text.");
        });

        it("applies nothing when the overwrite is declined", async () => {
            const fs = await withConfig(pageEntry);
            await pulled(fs, "wiki/A.md", "1", 5, true);
            const edited = await fs.readText("/w/wiki/A.md");

            const have = await interactive(fs, live(), ["o", "\r"], ["n"]);

            expect(have.streams.outText()).toBe("cfsync: nothing applied\n");
            expect(await fs.readText("/w/wiki/A.md")).toBe(edited);
        });

        it("refuses without a terminal", async () => {
            const fs = await withConfig(pageEntry);
            await pulled(fs, "wiki/A.md", "1", 5, true);
            const { ctx, streams } = ctxFor(
                ["status", "-i", ...CONFIG_ARG],
                fs,
                secretsEnv("/w"),
                live(),
            );

            expect(await main(ctx)).toBe(EXIT_ERR);
            expect(streams.errText()).toContain(
                "needs an interactive terminal",
            );
        });
    });

    it("fails without a report when Confluence cannot be reached", async () => {
        const fs = await vault();
        await pulled(fs, "wiki/A.md", "1", 5, true);
        const http = new StubHttpClient().on("GET", bulkURL("1"), {
            status: 503,
        });
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_ERR);
        expect(streams.outText()).toBe("");
        expect(streams.errText()).toContain("checking status");
    });
});
