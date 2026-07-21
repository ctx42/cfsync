// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { NodeEnv } from "../../src/adapters/env.ts";

describe("NodeEnv", () => {
    it("seeds from a record and preserves set-but-empty vs unset", () => {
        const env = new NodeEnv({ A: "1", B: "", C: undefined });
        expect(env.lookup("A")).toBe("1");
        expect(env.lookup("B")).toBe(""); // set but empty
        expect(env.lookup("C")).toBeUndefined(); // unset (undefined skipped)
        expect(env.get("C")).toBe("");
    });

    it("set overrides and setDefault only fills an unset-or-empty key", () => {
        const env = new NodeEnv({ A: "keep", B: "" });
        env.set("A", "override");
        env.setDefault("A", "ignored"); // A is non-empty → unchanged
        env.setDefault("B", "filled"); // B is empty → filled
        env.setDefault("C", "new"); // C unset → filled
        expect(env.get("A")).toBe("override");
        expect(env.get("B")).toBe("filled");
        expect(env.get("C")).toBe("new");
    });
});
