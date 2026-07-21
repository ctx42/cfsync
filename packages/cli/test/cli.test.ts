// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// End-to-end CLI tests: they drive `main` through its injected MainCtx with an
// in-memory filesystem and a stub HTTP client (reused from the core test support),
// so a whole command runs — flag parsing, config + env loading, dep assembly,
// orchestration, and output routing — without touching the network or disk.

import type { Clock, HttpClient, Streams } from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { StubHttpClient } from "../../core/test/support/http-stub.ts";
import { MemFS } from "../../core/test/support/memfs.ts";
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

    it("status reports no pages to check with no managed pages", async () => {
        const fs = await withConfig("pages: {}\n");
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
        );
        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe("cfsync: no pages to check\n");
    });
});

describe("status command", () => {
    /** note is a managed .md file with a page id and base version. */
    const note = (pageId: string, version: number): string =>
        "---\n" +
        `title: P\npage_id: "${pageId}"\npage_version: ${version}\n` +
        "cfsync-plugin: pull\n---\nbody\n";

    /** bulk is one fetchPageVersions response for the given id/version pairs. */
    const bulk = (...pairs: Array<[string, number]>): string =>
        JSON.stringify({
            results: pairs.map(([id, number]) => ({ id, version: { number } })),
            _links: {},
        });

    async function vaultWith(
        ...notes: Array<[string, string]>
    ): Promise<MemFS> {
        const fs = await withConfig('folders:\n  wiki: "/wiki/spaces/T"\n');
        for (const [path, body] of notes) {
            await fs.write(path, body);
        }
        return fs;
    }

    it("lists the pages whose remote version moved ahead", async () => {
        const fs = await vaultWith(
            ["/w/wiki/A.md", note("101", 5)],
            ["/w/wiki/B.md", note("102", 5)],
        );
        const http = new StubHttpClient().on(
            "GET",
            `${HOST}/wiki/api/v2/pages?id=101&id=102&limit=250`,
            { body: bulk(["101", 5], ["102", 7]) },
        );
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_OK);
        const out = streams.outText();
        expect(out).toContain(
            "cfsync: 1 of 2 pages have newer versions on Confluence",
        );
        expect(out).toContain("local v5 -> remote v7");
        expect(http.requests.length).toBe(1); // one bulk call for both pages
    });

    it("reports all up to date when no remote version moved", async () => {
        const fs = await vaultWith(["/w/wiki/A.md", note("101", 5)]);
        const http = new StubHttpClient().on(
            "GET",
            `${HOST}/wiki/api/v2/pages?id=101&limit=250`,
            { body: bulk(["101", 5]) },
        );
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_OK);
        expect(streams.outText()).toBe(
            "cfsync: all managed pages are up to date\n",
        );
    });

    it("warns about a page it could not check", async () => {
        const fs = await vaultWith(["/w/wiki/A.md", note("101", 5)]);
        // The bulk response omits id 101 (deleted or not visible).
        const http = new StubHttpClient().on(
            "GET",
            `${HOST}/wiki/api/v2/pages?id=101&limit=250`,
            { body: bulk() },
        );
        const { ctx, streams } = ctxFor(
            ["status", ...CONFIG_ARG],
            fs,
            secretsEnv("/w"),
            http,
        );

        expect(await main(ctx)).toBe(EXIT_OK);
        const out = streams.outText();
        expect(out).toContain("warning:");
        expect(out).toContain("could not check");
        expect(out).toContain("cfsync: all managed pages are up to date");
    });
});
