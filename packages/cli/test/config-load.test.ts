// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { NodeEnv } from "../src/adapters/env.ts";
import { NodeFS } from "../src/adapters/fs.ts";
import {
    envFilePath,
    loadConfig,
    loadEnvFile,
    runtimeDirs,
} from "../src/config-load.ts";

const fs = new NodeFS();
// Vitest runs under Node, where `Bun.YAML` is absent, so the tests back the
// YAML port with the `yaml` package (a dev dependency) — the binary uses Bun.
const yaml = { parse: parseYaml };

/** secrets builds an env with the four secrets set, syncRoot at `root`. */
const secrets = (root: string): NodeEnv =>
    new NodeEnv({
        CFSYNC_SITE: "ex",
        CFSYNC_ACCOUNT: "me@ex.com",
        CFSYNC_TOKEN: "tok",
        CFSYNC_ROOT: root,
    });

describe("loadConfig", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "cfsync-cfg-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("reads the YAML, injects secrets, and resolves paths and timeout", async () => {
        const cfgPath = join(dir, ".cfsync.yaml");
        await fs.write(
            cfgPath,
            "timeout: 45s\npages:\n  notes/setup.md: /wiki/spaces/T/pages/1\nspaces:\n  team: /wiki/spaces/T\n",
        );

        const config = await loadConfig(fs, secrets(dir), yaml, cfgPath);

        expect(config.host).toBe("https://ex.atlassian.net");
        expect(config.domain).toBe("ex.atlassian.net");
        expect(config.timeoutMs).toBe(45_000);
        expect(config.pages[join(dir, "notes/setup.md")]).toBe(
            "/wiki/spaces/T/pages/1",
        );
        expect(config.spaces[join(dir, "team")]).toBe("/wiki/spaces/T");

        const dirs = runtimeDirs(config);
        expect(dirs.cacheDir).toBe(join(dir, ".adf_cache"));
        expect(dirs.assetsDir).toBe(join(dir, "_cfsync-media"));
        expect(dirs.linksPath).toBe(join(dir, ".adf_cache/links.json"));
    });

    it("rejects a secret key set in the config file", async () => {
        const cfgPath = join(dir, ".cfsync.yaml");
        await fs.write(
            cfgPath,
            'host: "https://ex.atlassian.net"\npages: {}\n',
        );
        await expect(
            loadConfig(fs, secrets(dir), yaml, cfgPath),
        ).rejects.toThrow('"host" must not be set');
    });

    it("throws when the config file is missing", async () => {
        await expect(
            loadConfig(fs, secrets(dir), yaml, join(dir, "nope.yaml")),
        ).rejects.toThrow("reading config");
    });

    it("defaults an unset timeout to the built-in default", async () => {
        const cfgPath = join(dir, ".cfsync.yaml");
        await fs.write(cfgPath, "pages: {}\n");
        const config = await loadConfig(fs, secrets(dir), yaml, cfgPath);
        expect(config.timeoutMs).toBe(30_000);
    });

    it("reads the nested markdown.margin", async () => {
        const cfgPath = join(dir, ".cfsync.yaml");
        await fs.write(cfgPath, "markdown:\n  margin: 100\npages: {}\n");
        const config = await loadConfig(fs, secrets(dir), yaml, cfgPath);
        expect(config.margin).toBe(100);
    });

    it("defaults the margin to 0 (no wrap) when markdown is absent", async () => {
        const cfgPath = join(dir, ".cfsync.yaml");
        await fs.write(cfgPath, "pages: {}\n");
        const config = await loadConfig(fs, secrets(dir), yaml, cfgPath);
        expect(config.margin).toBe(0);
    });

    it("reads the nested markdown.flavor", async () => {
        const cfgPath = join(dir, ".cfsync.yaml");
        await fs.write(cfgPath, "markdown:\n  flavor: obsidian\npages: {}\n");
        const config = await loadConfig(fs, secrets(dir), yaml, cfgPath);
        expect(config.flavor).toBe("obsidian");
    });

    it("throws on an unknown markdown.flavor", async () => {
        const cfgPath = join(dir, ".cfsync.yaml");
        await fs.write(
            cfgPath,
            "markdown:\n  flavor: nonexistent\npages: {}\n",
        );
        await expect(
            loadConfig(fs, secrets(dir), yaml, cfgPath),
        ).rejects.toThrow('unknown markdown flavor "nonexistent"');
    });
});

describe("loadEnvFile", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "cfsync-env-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("fills unset keys but lets the process environment win", async () => {
        const envPath = join(dir, ".env");
        await fs.write(
            envPath,
            '# creds\nCFSYNC_TOKEN=from-file\nCFSYNC_SITE="file-site"\n',
        );
        const env = new NodeEnv({ CFSYNC_SITE: "env-site" });

        await loadEnvFile(fs, env, envPath, true);

        expect(env.get("CFSYNC_SITE")).toBe("env-site"); // env wins
        expect(env.get("CFSYNC_TOKEN")).toBe("from-file"); // filled from file
    });

    it("ignores a missing default file but errors on a missing explicit one", async () => {
        const env = new NodeEnv();
        await expect(
            loadEnvFile(fs, env, join(dir, ".env"), false),
        ).resolves.toBeUndefined();
        await expect(
            loadEnvFile(fs, env, join(dir, "custom.env"), true),
        ).rejects.toThrow("reading env file");
    });
});

describe("envFilePath", () => {
    it("defaults .env beside the config, or takes the explicit path", () => {
        expect(envFilePath("/v/.cfsync.yaml", "")).toEqual({
            path: "/v/.env",
            explicit: false,
        });
        expect(envFilePath("", "/custom/.env")).toEqual({
            path: "/custom/.env",
            explicit: true,
        });
    });
});
