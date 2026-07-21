// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's Streams adapter over the process standard streams. The core writes
// progress and results through the {@link Writer}/{@link Streams} ports rather
// than touching `process` directly, so the same orchestration drives a terminal
// here and an Obsidian surface in the plugin. `readAll` reads stdin to EOF for
// the rare non-interactive input path; interactive confirmations use their own
// line reader (see `prompt.ts`), not this.

import { readFileSync } from "node:fs";
import type { Reader, Streams, Writer } from "@cfsync/core";

/** A {@link Writer} backed by a Node writable stream. */
class StreamWriter implements Writer {
    constructor(private readonly sink: NodeJS.WriteStream) {}
    write(text: string): void {
        this.sink.write(text);
    }
}

/** A {@link Reader} that reads the process stdin to EOF, once. */
class StdinReader implements Reader {
    readAll(): string {
        try {
            return readFileSync(0, "utf8");
        } catch {
            return "";
        }
    }
}

/** nodeStreams wires the {@link Streams} port to the process standard streams. */
export const nodeStreams: Streams = {
    stdin: new StdinReader(),
    stdout: new StreamWriter(process.stdout),
    stderr: new StreamWriter(process.stderr),
};
