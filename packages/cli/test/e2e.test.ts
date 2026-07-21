// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The MSW fake-Confluence end-to-end suite. Unlike cli.test.ts (which injects a
// StubHttpClient in place of the port), these run the CLI with its real
// FetchHttpClient and a real temp-dir filesystem, letting MSW intercept the
// actual fetch. So a whole command exercises the true transport — the Basic-auth
// header, the URL and query building, the request/response bodies, and the
// retry/backoff — plus config loading and disk writes, exactly as a user's run
// would, only against an in-memory Site.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { basicAuth, type Clock, type Streams } from "@cfsync/core";
import { setupServer } from "msw/node";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
} from "vitest";
import { parse as parseYaml } from "yaml";
import { NodeEnv } from "../src/adapters/env.ts";
import { NodeFS } from "../src/adapters/fs.ts";
import { EXIT_OK, main } from "../src/main.ts";
import {
    type FakeState,
    handlers,
    newState,
    paragraphDoc,
} from "./support/fake-confluence.ts";

const SITE = "fake";
const HOST = "https://fake.atlassian.net";
const ACCOUNT = "me@example.com";
const TOKEN = "s3cr3t";
const clock: Clock = () => new Date(1_000_000);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cfsync-e2e-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

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

/** run drives `main` with the real fetch adapter against the fake Site. */
async function run(
    argv: string[],
): Promise<{ code: number; out: string; err: string }> {
    const streams = capture();
    const env = new NodeEnv({
        CFSYNC_SITE: SITE,
        CFSYNC_ACCOUNT: ACCOUNT,
        CFSYNC_TOKEN: TOKEN,
        CFSYNC_ROOT: dir,
    });
    const code = await main({
        argv,
        streams,
        env,
        fs: new NodeFS(),
        clock,
        isTTY: false,
        ask: () => Promise.resolve(""),
        yaml: { parse: parseYaml },
    });
    return { code, out: streams.outText(), err: streams.errText() };
}

/** writeConfig writes the config file and returns its path + the `--config` args. */
async function writeConfig(yaml: string): Promise<string[]> {
    const path = join(dir, ".cfsync.yaml");
    await writeFile(path, yaml);
    return ["--config", path];
}

/** started registers the fake handlers and returns the state for assertions. */
function started(state: FakeState): FakeState {
    server.use(...handlers(state));
    return state;
}

describe("test command over the real fetch adapter", () => {
    it("connects and sends the Basic-auth header", async () => {
        const state = started(newState(HOST, "acc-9"));
        const cfg = await writeConfig("pages: {}\n");

        const r = await run(["test", ...cfg]);

        expect(r.code).toBe(EXIT_OK);
        expect(r.out).toBe(`cfsync: connected to ${HOST} as acc-9\n`);
        expect(state.requests[0]?.path).toBe("/wiki/rest/api/user/current");
        expect(state.requests[0]?.auth).toBe(basicAuth(ACCOUNT, TOKEN));
    });

    it("retries a transient 503 and still succeeds", async () => {
        const state = started(newState(HOST, "acc-9"));
        state.failUserTimes = 2; // fail twice, then succeed
        const cfg = await writeConfig("pages: {}\n");

        const r = await run(["test", ...cfg]);

        expect(r.code).toBe(EXIT_OK);
        const userCalls = state.requests.filter(
            (q) => q.path === "/wiki/rest/api/user/current",
        );
        expect(userCalls.length).toBe(3); // first attempt + 2 retries
    });
});

describe("pull → edit → push round-trip over the real adapter", () => {
    const pageEntry = "pages:\n  notes/p.md: /wiki/spaces/T/pages/100/Hello\n";

    it("pulls a page to Markdown, then pushes an edit at the next version", async () => {
        const state = started(
            newState(HOST, "acc-9", [
                {
                    id: "100",
                    title: "Hello",
                    version: 1,
                    spaceId: "9",
                    parentId: "",
                    adf: paragraphDoc("Hello world"),
                },
            ]),
        );
        const cfg = await writeConfig(pageEntry);
        const note = join(dir, "notes/p.md");

        // --- Pull ---
        const pulled = await run(["pull", ...cfg]);
        expect(pulled.code).toBe(EXIT_OK);
        expect(pulled.out).toContain("1 page");
        const md = await readFile(note, "utf8");
        expect(md).toContain("Hello world");
        expect(md).toContain('page_id: "100"');
        expect(md).toContain("cfsync-plugin: pull");
        // The source ADF was cached for the push baseline.
        await expect(
            readFile(join(dir, ".adf_cache/notes/p.v1.json"), "utf8"),
        ).resolves.toContain("Hello world");

        // --- Edit the note body ---
        await writeFile(note, md.replace("Hello world", "Hello EDITED"));

        // --- Push ---
        const pushed = await run(["push", ...cfg]);
        expect(pushed.code).toBe(EXIT_OK);
        expect(pushed.out).toContain("ok (v2)");
        // The fake Site received the update: version bumped, new text stored.
        expect(state.pages.get("100")?.version).toBe(2);
        expect(JSON.stringify(state.pages.get("100")?.adf)).toContain(
            "Hello EDITED",
        );
    });

    it("reports no changes when the note is pushed unedited", async () => {
        started(
            newState(HOST, "acc-9", [
                {
                    id: "100",
                    title: "Hello",
                    version: 1,
                    spaceId: "9",
                    parentId: "",
                    adf: paragraphDoc("Hello world"),
                },
            ]),
        );
        const cfg = await writeConfig(pageEntry);

        await run(["pull", ...cfg]);
        const pushed = await run(["push", ...cfg]);

        expect(pushed.code).toBe(EXIT_OK);
        expect(pushed.out).toContain("unchanged");
    });
});

describe("create a new note under a root over the real adapter", () => {
    it("discovers a fresh note, creates the page, and stamps its id", async () => {
        const state = started(newState(HOST, "acc-9"));
        // A space root with a brand-new, id-less note under it — the case the
        // disk walk in managedPushDests surfaces (it is in no link index yet).
        const cfg = await writeConfig("spaces:\n  team: /wiki/spaces/T\n");
        const note = join(dir, "team/release_notes.md");
        await mkdir(dirname(note), { recursive: true });
        await writeFile(
            note,
            '---\ntitle: "Release Notes"\nspace_id: "9"\nparent_id: "100"\n---\n\n# Release Notes\n\nFirst draft.\n',
        );

        const pushed = await run(["push", "--yes", ...cfg]);

        expect(pushed.code).toBe(EXIT_OK);
        expect(pushed.out).toContain(
            "creating team/release_notes.md ... ok (v1)",
        );
        // The fake Site created the page (id 500) via POST, restricted via PUT.
        expect(state.pages.get("500")?.title).toBe("Release Notes");
        expect(state.requests.some((q) => q.method === "POST")).toBe(true);
        expect(
            state.requests.some((q) => q.path.endsWith("/restriction")),
        ).toBe(true);
        // The note is now tracked, so a re-push would update, not re-create.
        expect(await readFile(note, "utf8")).toContain('page_id: "500"');
    });
});
