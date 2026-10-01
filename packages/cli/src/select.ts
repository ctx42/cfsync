// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The interactive checkbox list push shows for new pages: one row per new note,
// each cycling through "ask again next time", "create", and "never" (mark it
// ignore-push). Every row starts undecided, so pressing enter straight away
// creates nothing. The state machine ({@link stepSelect}) and the rendering
// ({@link renderSelect}) are pure; the keys come from an injected
// {@link KeySource}, so the whole selector is tested without a terminal, and
// `nodeKeys` wires the real one over a raw-mode stdin.

/** Choice is one new note's decision: skip it this time, create it, or never ask again. */
export type Choice = "later" | "create" | "never";

/** SelectState is the selector's cursor row and every row's current choice. */
export interface SelectState {
    cursor: number;
    choices: Choice[];
}

/** Key is a decoded keypress the selector reacts to. */
export type Key =
    | "up"
    | "down"
    | "cycle"
    | "create"
    | "never"
    | "later"
    | "enter"
    | "cancel"
    | "other";

/** KeySource yields raw keypress data, one key per {@link KeySource.next} call. */
export interface KeySource {
    /** Resolves with the next key's raw data (e.g. `"\x1b[A"`, `" "`, `"\r"`). */
    next(): Promise<string>;
    /** Releases the input (restores cooked mode); idempotent. */
    close(): void;
}

/** CYCLE is the order space steps a row through. */
const CYCLE: Choice[] = ["later", "create", "never"];

/** decodeKey maps raw keypress data onto a {@link Key}. */
export function decodeKey(data: string): Key {
    switch (data) {
        case "\x1b[A":
        case "k":
            return "up";
        case "\x1b[B":
        case "j":
            return "down";
        case " ":
            return "cycle";
        case "c":
        case "y":
            return "create";
        case "n":
            return "never";
        case "l":
        case "u":
            return "later";
        case "\r":
        case "\n":
            return "enter";
        case "\x03":
        case "\x1b":
        case "q":
            return "cancel";
        default:
            return "other";
    }
}

/**
 * stepSelect applies `key` to `state`, returning the next state, `"done"` on
 * enter, or `"cancel"` on ctrl-c / escape / q. The cursor stops at both ends.
 */
export function stepSelect(
    state: SelectState,
    key: Key,
): SelectState | "done" | "cancel" {
    const last = state.choices.length - 1;
    const set = (c: Choice): SelectState => ({
        cursor: state.cursor,
        choices: state.choices.map((v, i) => (i === state.cursor ? c : v)),
    });
    switch (key) {
        case "up":
            return { ...state, cursor: Math.max(0, state.cursor - 1) };
        case "down":
            return { ...state, cursor: Math.min(last, state.cursor + 1) };
        case "cycle": {
            const now = state.choices[state.cursor] ?? "later";
            return set(
                CYCLE[(CYCLE.indexOf(now) + 1) % CYCLE.length] ?? "later",
            );
        }
        case "create":
        case "never":
        case "later":
            return set(key);
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
    "  ↑/↓ move · space cycle · c create · n never · l later · enter apply · q cancel";

/** BOX is each choice's checkbox. */
const BOX: Record<Choice, string> = {
    later: "[ ]",
    create: "[x]",
    never: "[-]",
};

/** NOTE is each choice's trailing note. */
const NOTE: Record<Choice, string> = {
    later: "",
    create: "  create",
    never: "  never (mark ignore-push)",
};

/** renderSelect returns the selector's lines: the legend, then one row per label. */
export function renderSelect(labels: string[], state: SelectState): string[] {
    const rows = labels.map((label, i) => {
        const choice = state.choices[i] ?? "later";
        const pointer = i === state.cursor ? ">" : " ";
        return `${pointer} ${BOX[choice]} ${label}${NOTE[choice]}`;
    });
    return [HELP, ...rows];
}

/**
 * runSelect shows the selector for `labels` on `write` (stderr) and returns
 * every row's final choice once enter is pressed. It redraws in place after each
 * key. It throws when the user cancels, so the caller aborts rather than
 * guessing, and always closes `keys`.
 */
export async function runSelect(
    labels: string[],
    keys: KeySource,
    write: (text: string) => void,
): Promise<Choice[]> {
    let state: SelectState = {
        cursor: 0,
        choices: labels.map((): Choice => "later"),
    };
    let lines = renderSelect(labels, state);
    write(`${lines.join("\n")}\n`);
    try {
        for (;;) {
            const next = stepSelect(state, decodeKey(await keys.next()));
            if (next === "done") {
                return state.choices;
            }
            if (next === "cancel") {
                throw new Error("push cancelled");
            }
            state = next;
            // Move up over the previous drawing and rewrite every line.
            lines = renderSelect(labels, state);
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
