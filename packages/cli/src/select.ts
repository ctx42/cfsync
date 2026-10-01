// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's interactive row selector: one row per item, each cycling through its
// own options and starting at the first, so pressing enter straight away keeps
// every row at its default. Push uses it for new pages (ask later / create /
// never push) and `status -i` for each status row's actions. The state machine
// ({@link stepSelect}) and the rendering ({@link renderSelect}) are pure; the
// keys come from an injected {@link KeySource}, so the whole selector is tested
// without a terminal, and `nodeKeys` wires the real one over a raw-mode stdin.

/** SelectRow is one selector row: its label and the options it cycles through. */
export interface SelectRow {
    label: string;
    /** The row's options, the first being the default. */
    options: string[];
}

/** SelectState is the selector's cursor row and each row's chosen option index. */
export interface SelectState {
    cursor: number;
    choices: number[];
}

/** Key is a decoded keypress the selector reacts to. */
export type Key =
    | { kind: "up" | "down" | "next" | "prev" | "enter" | "cancel" | "other" }
    | { kind: "letter"; letter: string };

/** KeySource yields raw keypress data, one key per {@link KeySource.next} call. */
export interface KeySource {
    /** Resolves with the next key's raw data (e.g. `"\x1b[A"`, `" "`, `"\r"`). */
    next(): Promise<string>;
    /** Releases the input (restores cooked mode); idempotent. */
    close(): void;
}

/** decodeKey maps raw keypress data onto a {@link Key}. */
export function decodeKey(data: string): Key {
    switch (data) {
        case "\x1b[A":
            return { kind: "up" };
        case "\x1b[B":
            return { kind: "down" };
        case " ":
        case "\x1b[C":
            return { kind: "next" };
        case "\x1b[D":
            return { kind: "prev" };
        case "\r":
        case "\n":
            return { kind: "enter" };
        case "\x03":
        case "\x1b":
        case "q":
            return { kind: "cancel" };
    }
    return /^[a-z]$/.test(data)
        ? { kind: "letter", letter: data }
        : { kind: "other" };
}

/**
 * stepSelect applies `key` to `state` over `rows`, returning the next state,
 * `"done"` on enter, or `"cancel"` on ctrl-c / escape / q. The cursor stops at
 * both ends; next and prev cycle the cursor row's options; a letter picks the
 * row's first option starting with it.
 */
export function stepSelect(
    rows: SelectRow[],
    state: SelectState,
    key: Key,
): SelectState | "done" | "cancel" {
    const n = rows[state.cursor]?.options.length ?? 1;
    const now = state.choices[state.cursor] ?? 0;
    const set = (choice: number): SelectState => ({
        cursor: state.cursor,
        choices: state.choices.map((v, i) => (i === state.cursor ? choice : v)),
    });
    switch (key.kind) {
        case "up":
            return { ...state, cursor: Math.max(0, state.cursor - 1) };
        case "down":
            return {
                ...state,
                cursor: Math.min(rows.length - 1, state.cursor + 1),
            };
        case "next":
            return set((now + 1) % n);
        case "prev":
            return set((now + n - 1) % n);
        case "letter": {
            const at = (rows[state.cursor]?.options ?? []).findIndex((o) =>
                o.startsWith(key.letter),
            );
            return at < 0 ? state : set(at);
        }
        case "enter":
            return "done";
        case "cancel":
            return "cancel";
        case "other":
            return state;
    }
}

/** HELP is the selector's key legend. */
const HELP =
    "  ↑/↓ move · space/→ next · ← previous · first letter picks · " +
    "enter apply · q cancel";

/**
 * renderSelect returns the selector's lines: the legend, then one row per item
 * with its label padded to a common width and its chosen option in brackets.
 * A row away from its default is marked with `*`.
 */
export function renderSelect(rows: SelectRow[], state: SelectState): string[] {
    const width = Math.max(0, ...rows.map((r) => r.label.length));
    const lines = rows.map((r, i) => {
        const choice = state.choices[i] ?? 0;
        const pointer = i === state.cursor ? ">" : " ";
        const mark = choice === 0 ? " " : "*";
        const option = r.options[choice] ?? "";
        return `${pointer}${mark} ${r.label.padEnd(width)}  [${option}]`;
    });
    return [HELP, ...lines];
}

/**
 * runSelect shows the selector for `rows` on `write` (stderr) and returns each
 * row's chosen option index once enter is pressed. It redraws in place after
 * each key. It throws when the user cancels, so the caller aborts rather than
 * guessing, and always closes `keys`.
 */
export async function runSelect(
    rows: SelectRow[],
    keys: KeySource,
    write: (text: string) => void,
): Promise<number[]> {
    let state: SelectState = { cursor: 0, choices: rows.map(() => 0) };
    let lines = renderSelect(rows, state);
    write(`${lines.join("\n")}\n`);
    try {
        for (;;) {
            const next = stepSelect(rows, state, decodeKey(await keys.next()));
            if (next === "done") {
                return state.choices;
            }
            if (next === "cancel") {
                throw new Error("cancelled");
            }
            state = next;
            // Move up over the previous drawing and rewrite every line.
            lines = renderSelect(rows, state);
            write(
                `\x1b[${lines.length}A` +
                    lines.map((l) => `\x1b[2K${l}\n`).join(""),
            );
        }
    } finally {
        keys.close();
    }
}

/**
 * nodeKeys returns a {@link KeySource} over the process stdin in raw mode, so
 * each keypress arrives on its own without echo. Raw mode is restored on close.
 * It rejects a pending read when stdin ends.
 */
export function nodeKeys(): KeySource {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const queue: string[] = [];
    let waiting: {
        resolve: (d: string) => void;
        reject: (e: Error) => void;
    } | null = null;
    const onData = (buf: Buffer): void => {
        const data = buf.toString("utf8");
        if (waiting !== null) {
            const w = waiting;
            waiting = null;
            w.resolve(data);
        } else {
            queue.push(data);
        }
    };
    const onEnd = (): void => {
        waiting?.reject(new Error("prompt: input closed"));
        waiting = null;
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    let closed = false;
    return {
        next: () => {
            const queued = queue.shift();
            if (queued !== undefined) {
                return Promise.resolve(queued);
            }
            return new Promise<string>((resolve, reject) => {
                waiting = { resolve, reject };
            });
        },
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            stdin.off("data", onData);
            stdin.off("end", onEnd);
            stdin.setRawMode(wasRaw);
            stdin.pause();
        },
    };
}
