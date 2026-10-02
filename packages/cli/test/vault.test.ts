// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Vault-mode tests: the CLI inside an Obsidian vault takes its config from the
// cfsync plugin's `data.json`, its cache home and token from this device's
// pointer, and refuses every other config source. Driven through `main` over an
// in-memory filesystem, like cli.test.ts.

import {
    type Clock,
    formatPointer,
    pointerPath,
    type Streams,
} from "@cfsync/core";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { MemFS } from "../../core/test/support/memfs.ts";
import { MemLock } from "../../core/test/support/memlock.ts";
import { NodeEnv } from "../src/adapters/env.ts";
import { EXIT_ERR, EXIT_OK, type MainCtx, main } from "../src/main.ts";
import {
    DATA_FILE,
    findVault,
    loadVaultConfig,
    PLUGIN_DIR,
    type VaultHost,
} from "../src/vault.ts";

const VAULT = "/v";
const CACHE = "/cache/cfsync/v-0123456789ab";
const DEVICE = "host-a";
const HOST: VaultHost = { device: DEVICE, realpath: async (p) => p };
const clock: Clock = () => new Date(1_000_000);

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

/** VaultOpts tweaks the vault {@link vaultFS} lays out. */
interface VaultOpts {
    data?: Record<string, unknown>;
    pointer?: Record<string, unknown> | null;
    token?: string | null;
}

/** vaultFS lays out a vault with the plugin's data.json, a pointer, and a token. */
async function vaultFS(opts: VaultOpts = {}): Promise<MemFS> {
    const fs = new MemFS();
    const data = opts.data ?? {
        schemaVersion: 1,
        site: "ex",
        account: "me@ex.com",
        syncRoot: "notes",
        pages: {},
    };
    await fs.write(`${VAULT}/${PLUGIN_DIR}/${DATA_FILE}`, JSON.stringify(data));
    if (opts.pointer !== null) {
        const p = {
            version: 1,
            device: DEVICE,
            vaultPath: VAULT,
            cacheDir: CACHE,
            ...opts.pointer,
        };
        await fs.write(
            pointerPath(`${VAULT}/${PLUGIN_DIR}`, DEVICE),
            formatPointer(p as Parameters<typeof formatPointer>[0]),
        );
    }
    if (opts.token !== null) {
        await fs.write(`${CACHE}/token`, `${opts.token ?? "tok"}\n`);
    }
    return fs;
}

/** run drives `main` from `cwd` inside the vault. */
async function run(
    argv: string[],
    fs: MemFS,
    opts: { cwd?: string; env?: Record<string, string>; lock?: MemLock } = {},
): Promise<{ code: number; out: string; err: string; lock: MemLock }> {
    const streams = capture();
    const lock = opts.lock ?? new MemLock();
    const ctx: MainCtx = {
        argv,
        streams,
        env: new NodeEnv(opts.env ?? {}),
        fs,
        clock,
        isTTY: false,
        ask: () => Promise.resolve(""),
        yaml: { parse: parseYaml },
        lock,
        cwd: opts.cwd ?? `${VAULT}/notes/sub`,
        vaultHost: HOST,
    };
    const code = await main(ctx);
    return { code, out: streams.outText(), err: streams.errText(), lock };
}

describe("findVault", () => {
    it("finds the nearest ancestor holding the plugin's data.json", async () => {
        const fs = await vaultFS();

        expect(await findVault(fs, "/v/a/b")).toBe("/v");
        expect(await findVault(fs, "/v")).toBe("/v");
    });

    it("returns null outside a vault", async () => {
        expect(await findVault(await vaultFS(), "/elsewhere/x")).toBeNull();
    });

    it("ignores a renamed Obsidian config folder", async () => {
        const fs = new MemFS();
        await fs.write("/v/.obs/plugins/cfsync/data.json", "{}");

        expect(await findVault(fs, "/v")).toBeNull();
    });
});

describe("loadVaultConfig", () => {
    it("resolves settings, cache home, token, and sync root", async () => {
        const have = await loadVaultConfig(await vaultFS(), HOST, VAULT);

        expect(have.cacheDir).toBe(CACHE);
        expect(have.schemaVersion).toBe(1);
        expect(have.config.syncRoot).toBe("/v/notes");
        expect(have.config.token).toBe("tok");
        expect(have.config.host).toBe("https://ex.atlassian.net");
    });

    it("uses the vault as the sync root when syncRoot is empty", async () => {
        const fs = await vaultFS({
            data: { site: "ex", account: "me@ex.com", syncRoot: "" },
        });

        const have = await loadVaultConfig(fs, HOST, VAULT);

        expect(have.config.syncRoot).toBe("/v");
        expect(have.schemaVersion).toBe(1); // no schemaVersion reads as v1
    });

    it("refuses a newer schema version, asking to upgrade the CLI", async () => {
        const fs = await vaultFS({ data: { schemaVersion: 99 } });

        await expect(loadVaultConfig(fs, HOST, VAULT)).rejects.toThrow(
            /schema version 99 is newer than this CLI supports \(1\); upgrade the CLI/,
        );
    });

    it("refuses a missing pointer", async () => {
        const fs = await vaultFS({ pointer: null });

        await expect(loadVaultConfig(fs, HOST, VAULT)).rejects.toThrow(
            /no cfsync device pointer for "host-a"; open the vault in Obsidian/,
        );
    });

    it("refuses a pointer written for another vault path", async () => {
        const fs = await vaultFS({ pointer: { vaultPath: "/other" } });

        await expect(loadVaultConfig(fs, HOST, VAULT)).rejects.toThrow(
            /written for vault \/other; open the vault in Obsidian/,
        );
    });

    it("refuses a pointer whose device does not match", async () => {
        const fs = await vaultFS({ pointer: { device: "host-b" } });
        // host-b's content under host-a's file name: a copied pointer
        await expect(loadVaultConfig(fs, HOST, VAULT)).rejects.toThrow(
            /written on "host-b", not "host-a"; open the vault in Obsidian/,
        );
    });

    it("matches the vault path after realpath", async () => {
        const fs = await vaultFS({ pointer: { vaultPath: "/link/v" } });
        const host: VaultHost = {
            device: DEVICE,
            realpath: async (p) => p.replace("/link/v", "/v"),
        };

        expect((await loadVaultConfig(fs, host, VAULT)).cacheDir).toBe(CACHE);
    });

    it("refuses a missing token", async () => {
        const fs = await vaultFS({ token: null });

        await expect(loadVaultConfig(fs, HOST, VAULT)).rejects.toThrow(
            /no API token on this device/,
        );
    });
});

describe("vault mode", () => {
    it("runs from a vault subfolder and reports the config source", async () => {
        const fs = await vaultFS();

        const have = await run(["status"], fs);

        expect(have.code).toBe(EXIT_OK);
        expect(have.out).toBe("cfsync: everything up to date\n");
        expect(have.err).toBe("config: vault /v (cfsync plugin, schema v1)\n");
    });

    it("never creates an in-vault ADF cache", async () => {
        const fs = await vaultFS();

        await run(["status"], fs);

        expect(await fs.exists("/v/notes/.adf_cache")).toBe(false);
    });

    it("takes the run lock in the plugin's cache home", async () => {
        const lock = new MemLock();
        lock.alive.add(9);
        lock.files.set(
            `${CACHE}/cfsync.lock`,
            JSON.stringify({
                pid: 9,
                tool: "plugin",
                command: "pulling",
                startedAt: "2026-10-02T10:00:00Z",
            }),
        );

        const have = await run(["status"], await vaultFS(), { lock });

        expect(have.code).toBe(EXIT_ERR);
        expect(have.err).toContain("busy: cfsync plugin pulling, pid 9");
    });

    for (const [flag, argv] of [
        ["--config", ["status", "--config", "/x.yaml"]],
        ["--env", ["status", "--env", "/x.env"]],
        ["--sync-root", ["status", "--sync-root", "/x"]],
    ] as const) {
        it(`refuses ${flag}`, async () => {
            const have = await run([...argv], await vaultFS());

            expect(have.code).toBe(EXIT_ERR);
            expect(have.err).toContain(
                `${flag} cannot be used inside an Obsidian vault (/v)`,
            );
        });
    }

    it("refuses a .cfsync.yaml in the working directory", async () => {
        const fs = await vaultFS();
        await fs.write("/v/notes/sub/.cfsync.yaml", "pages: {}\n");

        const have = await run(["status"], fs);

        expect(have.code).toBe(EXIT_ERR);
        expect(have.err).toContain(
            "/v/notes/sub/.cfsync.yaml cannot be used inside an Obsidian vault",
        );
    });

    it("ignores CFSYNC_* variables and a default .env with one warning", async () => {
        const fs = await vaultFS();
        await fs.write("/v/notes/sub/.env", "CFSYNC_TOKEN=other\n");

        const have = await run(["status"], fs, {
            env: { CFSYNC_TOKEN: "other", CFSYNC_SITE: "nope" },
        });

        expect(have.code).toBe(EXIT_OK);
        expect(have.err).toContain(
            "cfsync: warning: ignoring CFSYNC_SITE, CFSYNC_TOKEN, .env inside " +
                "an Obsidian vault",
        );
        expect(have.err.match(/warning/g)).toHaveLength(1);
    });

    it("prints no source line outside a vault", async () => {
        const fs = new MemFS();
        await fs.write("/w/.cfsync.yaml", "pages: {}\n");

        const have = await run(["status", "--config", "/w/.cfsync.yaml"], fs, {
            cwd: "/w",
            env: {
                CFSYNC_SITE: "ex",
                CFSYNC_ACCOUNT: "me@ex.com",
                CFSYNC_TOKEN: "tok",
                CFSYNC_ROOT: "/w",
            },
        });

        expect(have.code).toBe(EXIT_OK);
        expect(have.err).not.toContain("config: vault");
    });
});
