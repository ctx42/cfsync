// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["packages/*/{src,test}/**/*.test.ts"],
        // Live integration tests hit a real Atlassian Site; they run only via
        // the cli package's `test:live` script, never in the default suite.
        exclude: ["**/node_modules/**", "**/*.live.test.ts"],
        // Every package must ship at least one test; a package with none is a
        // mistake, not a pass.
        passWithNoTests: false,
    },
});
