// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

/**
 * Executable entry point for the cfsync CLI (← `cmd/cfsync/main.go`). It wires
 * the Node adapters — process streams, environment, filesystem, system clock, and
 * an interactive line reader — into {@link main} and exits with its return code.
 * Bundled to a single binary via `bun build --compile`.
 *
 * Kept side-effect-only: tests import `./main.ts` with their own injected context,
 * never this file, so importing the package never runs the process.
 */
import { nodeClock } from "./adapters/clock.ts";
import { NodeEnv } from "./adapters/env.ts";
import { NodeFS } from "./adapters/fs.ts";
import { nodeStreams } from "./adapters/streams.ts";
import { EXIT_ERR, main } from "./main.ts";
import { nodeAsk } from "./prompt.ts";

main({
    argv: process.argv.slice(2),
    streams: nodeStreams,
    env: new NodeEnv(process.env),
    fs: new NodeFS(),
    clock: nodeClock,
    // The reporter writes to stderr; the confirmation prompt reads stdin. Track
    // each stream's terminal status separately so redirecting one does not
    // mis-gate the other (a piped stdin must never trigger an interactive prompt).
    isTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    ask: nodeAsk,
})
    .then((code) => {
        // Set the exit code instead of calling process.exit(): an abrupt exit
        // truncates buffered stdout writes to a pipe or file (the StreamWriter
        // ignores backpressure), losing the tail of a large log or summary. The
        // process exits with this code once the event loop drains the streams.
        process.exitCode = code;
    })
    .catch((err: unknown) => {
        // A rejection escaping main (e.g. reporter/adapter construction) would
        // otherwise surface as an unhandled rejection; report it like any other.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`cfsync: ${message}\n`);
        process.exitCode = EXIT_ERR;
    });
