// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    type Choice,
    decodeKey,
    renderSelect,
    type SelectState,
    stepSelect,
} from "../src/select.ts";

const start = (n: number): SelectState => ({
    cursor: 0,
    choices: Array.from({ length: n }, (): Choice => "later"),
});

describe("stepSelect", () => {
    it("moves the cursor and stops at both ends", () => {
        let s = start(2);
        s = stepSelect(s, "up") as SelectState;
        expect(s.cursor).toBe(0);
        s = stepSelect(s, "down") as SelectState;
        s = stepSelect(s, "down") as SelectState;
        expect(s.cursor).toBe(1);
    });

    it("cycles the row under the cursor later -> create -> never -> later", () => {
        let s = start(2);
        const seen: Choice[] = [];
        for (let i = 0; i < 3; i++) {
            s = stepSelect(s, "cycle") as SelectState;
            seen.push(s.choices[0] ?? "later");
        }
        expect(seen).toEqual(["create", "never", "later"]);
        expect(s.choices[1]).toBe("later");
    });

    it("sets a choice directly and finishes on enter or cancel", () => {
        const s = stepSelect(start(1), "never") as SelectState;
        expect(s.choices).toEqual(["never"]);
        expect(stepSelect(s, "enter")).toBe("done");
        expect(stepSelect(s, "cancel")).toBe("cancel");
        expect(stepSelect(s, "other")).toBe(s);
    });
});

describe("decodeKey", () => {
    it("decodes arrows, letters, enter, and ctrl-c", () => {
        expect(decodeKey("\x1b[A")).toBe("up");
        expect(decodeKey("j")).toBe("down");
        expect(decodeKey(" ")).toBe("cycle");
        expect(decodeKey("c")).toBe("create");
        expect(decodeKey("n")).toBe("never");
        expect(decodeKey("l")).toBe("later");
        expect(decodeKey("\r")).toBe("enter");
        expect(decodeKey("\x03")).toBe("cancel");
        expect(decodeKey("z")).toBe("other");
    });
});

describe("renderSelect", () => {
    it("draws the legend, the cursor, and each row's checkbox", () => {
        const have = renderSelect(["a.md", "b.md", "c.md"], {
            cursor: 1,
            choices: ["create", "never", "later"],
        });
        expect(have.slice(1)).toEqual([
            "  [x] a.md  create",
            "> [-] b.md  never (mark ignore-push)",
            "  [ ] c.md",
        ]);
    });
});
