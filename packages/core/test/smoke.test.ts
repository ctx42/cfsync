// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../src/index.ts";

describe("core skeleton", () => {
    it("exposes its package name", () => {
        expect(PACKAGE_NAME).toBe("@cfsync/core");
    });
});
