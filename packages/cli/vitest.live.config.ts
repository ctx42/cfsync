// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Vitest config for the real-Confluence live integration tests. It is NOT part
// of the default suite (see the root vitest.config.ts exclude); it runs only via
// this package's `test:live` script, and each suite self-skips when the
// CFSYNC_TEST_* credentials are absent.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        root: import.meta.dirname,
        include: ["test/live/**/*.live.test.ts"],
        passWithNoTests: false,
        // Real HTTP round-trips exceed Vitest's 5s default.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // Run every live test STRICTLY SEQUENTIALLY — one file at a time, one
        // worker process, and no `.concurrent` within a file. The suites are NOT
        // independent: they share the one Confluence test space, so overlapping
        // runs could interfere (most visibly the space-walk contract, which
        // compares a live walk against a flat listing). Serial execution also
        // keeps request bursts from tripping the Site's rate limits.
        fileParallelism: false,
        sequence: { concurrent: false },
        poolOptions: {
            forks: { singleFork: true },
            threads: { singleThread: true },
        },
    },
});
