// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The run lock's I/O (core `LockIO`) over `node:fs` and `process`: an
// exclusive-create (`wx`) write and a signal-0 liveness probe. The CLI and the
// plugin each carry this adapter, since core may not import `node:`.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import type { LockIO } from "@cfsync/core";

/** NodeLockIO implements the core {@link LockIO} over Node. */
export class NodeLockIO implements LockIO {
    async create(path: string, text: string): Promise<boolean> {
        await mkdir(dirname(path), { recursive: true });
        try {
            await writeFile(path, text, { flag: "wx" });
            return true;
        } catch (err) {
            if (code(err) === "EEXIST") {
                return false;
            }
            throw err;
        }
    }

    async read(path: string): Promise<string> {
        try {
            return await readFile(path, "utf8");
        } catch (err) {
            if (code(err) === "ENOENT") {
                return "";
            }
            throw err;
        }
    }

    async remove(path: string): Promise<void> {
        await rm(path, { force: true });
    }

    isAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (err) {
            return code(err) === "EPERM"; // exists, owned by another user
        }
    }
}

/** code returns a Node system error's `code`, or `""`. */
function code(err: unknown): string {
    return typeof err === "object" && err !== null && "code" in err
        ? String(err.code)
        : "";
}
