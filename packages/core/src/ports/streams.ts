// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Standard I/O as ports, so the core never touches process streams directly.
// Ported from the `Streamer` interface of `ctx42/ring`. Adapters back these
// with `process.std*` (CLI) or an Obsidian surface (plugin); tests back them
// with in-memory buffers.

/** A sink for text output. */
export interface Writer {
    /** Append `text` to the stream. */
    write(text: string): void;
}

/** A source of text input. */
export interface Reader {
    /** Read all available input as a single string. */
    readAll(): string;
}

/** A program's standard input, output, and error streams. */
export interface Streams {
    readonly stdin: Reader;
    readonly stdout: Writer;
    readonly stderr: Writer;
}
