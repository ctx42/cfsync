// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Test harness modelling a program execution context, ported from `ctx42/ring`
// + `ringtest`. It bundles the injected ports (streams, env, clock) with the
// program name and args, backs stdout/stderr with in-memory buffers, and lets a
// test read what a command wrote. The filesystem port is added in M1.5.

import type { Clock } from "../../src/ports/clock.ts";
import type { Env } from "../../src/ports/env.ts";
import type { Reader, Streams, Writer } from "../../src/ports/streams.ts";

/** A {@link Writer} that accumulates everything written for later inspection. */
class BufferWriter implements Writer {
    private buffer = "";
    write(text: string): void {
        this.buffer += text;
    }
    text(): string {
        return this.buffer;
    }
}

/** A {@link Reader} serving a fixed input string. */
class StringReader implements Reader {
    constructor(private readonly input: string) {}
    readAll(): string {
        return this.input;
    }
}

/** An in-memory {@link Env} whose variables can be seeded and set. */
export class FakeEnv implements Env {
    private readonly vars: Map<string, string>;
    constructor(entries: Record<string, string> = {}) {
        this.vars = new Map(Object.entries(entries));
    }
    lookup(key: string): string | undefined {
        return this.vars.get(key);
    }
    get(key: string): string {
        return this.vars.get(key) ?? "";
    }
    set(key: string, value: string): void {
        this.vars.set(key, value);
    }
}

/** The injected execution context a command receives. */
export interface Ring {
    readonly name: string;
    readonly args: readonly string[];
    readonly env: Env;
    readonly streams: Streams;
    readonly clock: Clock;
}

/** Options seeding a {@link Ring}; every field defaults to an empty value. */
export interface RingOptions {
    name?: string;
    args?: readonly string[];
    env?: Record<string, string>;
    stdin?: string;
    clock?: Clock;
}

/** A {@link Ring} plus accessors for whatever a command wrote to the streams. */
export interface TestRing {
    readonly ring: Ring;
    stdout(): string;
    stderr(): string;
}

/** The fixed instant the default clock returns, for deterministic timestamps. */
export const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

/** Build a {@link TestRing} with in-memory streams and the given fakes. */
export function createRing(opts: RingOptions = {}): TestRing {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const ring: Ring = {
        name: opts.name ?? "cfsync",
        args: opts.args ?? [],
        env: new FakeEnv(opts.env ?? {}),
        streams: {
            stdin: new StringReader(opts.stdin ?? ""),
            stdout,
            stderr,
        },
        clock: opts.clock ?? (() => FIXED_NOW),
    };
    return {
        ring,
        stdout: () => stdout.text(),
        stderr: () => stderr.text(),
    };
}
