// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { CORE_PACKAGE } from "../src/index.ts";

describe("plugin skeleton", () => {
    it("resolves the core workspace package", () => {
        expect(CORE_PACKAGE).toBe("@cfsync/core");
    });
});
