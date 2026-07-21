// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    liveConfigured,
    loadLiveEnv,
    mustValue,
    seedClient,
} from "./support/live-env.ts";

describe.skipIf(!liveConfigured())("live harness", () => {
    it("authenticates against the real Site", async () => {
        const env = mustValue(loadLiveEnv(), "live env");
        const client = seedClient(env);
        const accountId = await client.currentAccountID();
        expect(accountId).not.toBe("");
    });

    it("resolves the test space key to an id", async () => {
        const env = mustValue(loadLiveEnv(), "live env");
        const ref = await seedClient(env).resolveSpace(env.space);
        expect(ref.id).not.toBe("");
    });
});
