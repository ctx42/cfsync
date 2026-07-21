// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's Env adapter, a mutable environment seeded from `process.env`. It is
// mutable because the CLI layers values onto it before the run: a `.env` file
// fills in variables the process environment left unset, and `--sync-root`
// overrides the sync-root variable — the same `EnvSet` layering the Go tool does
// through its `ring`. The core only ever reads it (the {@link Env} port), so the
// mutation stays on the CLI side of the boundary.

import type { Env } from "@cfsync/core";

/**
 * NodeEnv is a read/write environment over a plain map. `lookup` preserves the
 * set-but-empty vs unset distinction; `get` collapses unset to `""`. `set` and
 * `setDefault` layer values on before the run.
 */
export class NodeEnv implements Env {
    private readonly vars = new Map<string, string>();

    /** Seed from a `key → value` record, skipping `undefined` values. */
    constructor(source: Record<string, string | undefined> = {}) {
        for (const [key, value] of Object.entries(source)) {
            if (value !== undefined) {
                this.vars.set(key, value);
            }
        }
    }

    lookup(key: string): string | undefined {
        return this.vars.get(key);
    }

    get(key: string): string {
        return this.vars.get(key) ?? "";
    }

    /** Set `key` to `value`, overriding any current value. */
    set(key: string, value: string): void {
        this.vars.set(key, value);
    }

    /**
     * Set `key` to `value` only when it has no non-empty value yet, so an existing
     * process-environment value always wins over a `.env` fallback — the rule Go's
     * `loadEnvFile` follows.
     */
    setDefault(key: string, value: string): void {
        if (this.get(key) === "") {
            this.vars.set(key, value);
        }
    }
}
