// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Environment access as a port, ported from the read side of `ctx42/ring`'s
// `Environ`. Secrets (host, account, token) reach the core through this rather
// than a global `process.env`, so the plugin can supply them from its own
// settings and the CLI from the real environment or a `.env` file.

/** Read access to a set of environment variables. */
export interface Env {
    /**
     * Look up `key`. Returns the value (which may be empty) when set, or
     * `undefined` when unset — the distinction Go's `EnvLookup` preserves.
     */
    lookup(key: string): string | undefined;

    /** Return `key`'s value, or `""` when unset (Go's `EnvGet`). */
    get(key: string): string;
}
