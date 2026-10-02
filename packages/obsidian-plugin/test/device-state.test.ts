// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePointer, pointerPath } from "@cfsync/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    loadDeviceToken,
    readToken,
    tokenPath,
    writePointer,
    writeToken,
} from "../src/device-state.ts";

describe("device state", () => {
    let root = "";
    let cache = "";

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "cfsync-device-"));
        cache = join(root, "cache");
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await chmod(root, 0o700);
        await rm(root, { recursive: true, force: true });
    });

    /** legacy is an in-memory stand-in for the localStorage token slot. */
    function legacy(token: string) {
        const slot = { token };
        return {
            slot,
            store: {
                load: () => slot.token,
                clear: () => {
                    slot.token = "";
                },
            },
        };
    }

    describe("writePointer", () => {
        it("records the device, vault path, and cache dir", async () => {
            await writePointer(join(root, "plugin"), "host-a", "/v", cache);

            const path = pointerPath(join(root, "plugin"), "host-a");
            const have = parsePointer(await readFile(path, "utf8"));
            expect(have).toEqual({
                version: 1,
                device: "host-a",
                vaultPath: "/v",
                cacheDir: cache,
            });
        });

        it("leaves an unchanged pointer untouched", async () => {
            const dir = join(root, "plugin");
            await writePointer(dir, "host-a", "/v", cache);
            const path = pointerPath(dir, "host-a");
            const before = (await stat(path)).mtimeMs;
            await new Promise((r) => setTimeout(r, 20));

            await writePointer(dir, "host-a", "/v", cache);

            expect((await stat(path)).mtimeMs).toBe(before);
        });

        it("keeps one pointer per device", async () => {
            const dir = join(root, "plugin");
            await writePointer(dir, "host-a", "/v", "/ca");
            await writePointer(dir, "host-b", "/w", "/cb");

            const a = await readFile(pointerPath(dir, "host-a"), "utf8");
            expect(parsePointer(a).cacheDir).toBe("/ca");
        });
    });

    describe("token file", () => {
        it("round-trips the token with owner-only permissions", async () => {
            await writeToken(cache, "secret");

            expect(await readToken(cache)).toBe("secret");
            expect((await stat(tokenPath(cache))).mode & 0o777).toBe(0o600);
        });

        it("tightens the permissions of an existing file", async () => {
            await mkdir(cache, { recursive: true });
            await writeFile(tokenPath(cache), "old", { mode: 0o644 });

            await writeToken(cache, "new");

            expect((await stat(tokenPath(cache))).mode & 0o777).toBe(0o600);
        });

        it("removes the file for an empty token", async () => {
            await writeToken(cache, "secret");
            await writeToken(cache, "");

            expect(await readToken(cache)).toBe("");
        });

        it("reads an absent token as empty", async () => {
            expect(await readToken(cache)).toBe("");
        });
    });

    describe("loadDeviceToken", () => {
        it("migrates a localStorage token and clears it", async () => {
            const { slot, store } = legacy("secret");

            const have = await loadDeviceToken(cache, store);

            expect(have).toBe("secret");
            expect(await readToken(cache)).toBe("secret");
            expect(slot.token).toBe("");
        });

        it("reads the token file when localStorage is empty", async () => {
            await writeToken(cache, "secret");

            expect(await loadDeviceToken(cache, legacy("").store)).toBe(
                "secret",
            );
        });

        it("keeps the localStorage token when the write fails", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            await chmod(root, 0o500); // cache dir cannot be created
            const { slot, store } = legacy("secret");

            const have = await loadDeviceToken(cache, store);

            expect(have).toBe("secret");
            expect(slot.token).toBe("secret");
        });
    });
});
