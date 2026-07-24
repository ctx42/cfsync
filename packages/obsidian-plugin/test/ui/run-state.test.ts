// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    PanelReporter,
    type RunState,
    rowKind,
    rowName,
} from "../../src/ui/run-state.ts";

describe("PanelReporter", () => {
    it("moves through discovery to processing and records the bar", () => {
        let last: RunState | undefined;
        const r = new PanelReporter("pushing", (s) => {
            last = s;
        });
        r.found();
        r.found();
        expect(last?.phase).toBe("discovering");
        expect(last?.found).toBe(2);
        r.discovered(3);
        r.item("Home");
        expect(last?.phase).toBe("processing");
        expect(last?.total).toBe(3);
        expect(last?.pos).toBe(1);
        expect(last?.current).toBe("Home");
    });

    it("appends streamed log lines as info rows and finishes", () => {
        let last: RunState | undefined;
        const r = new PanelReporter("pushing", (s) => {
            last = s;
        });
        r.discovered(1);
        r.item("Home");
        r.log("pushing Home ... ok (v14)\n");
        expect(last?.rows.at(-1)).toEqual({
            text: "pushing Home ... ok (v14)",
            kind: "info",
        });
        r.finish();
        expect(last?.phase).toBe("done");
    });

    it("colours a pull line by its leading action word", () => {
        let last: RunState | undefined;
        const r = new PanelReporter("pulling", (s) => {
            last = s;
        });
        r.log("added     docs/guide.md (v3)\n");
        r.log("updated   docs/api.md (v4)\n");
        r.log("unchanged docs/old.md (v2)\n");
        r.log("deleted   docs/gone.md (removed from Confluence)\n");
        r.log("conflict  docs/x.md (v5, resolve markers before pushing)\n");
        r.log("warning: docs/y.md: left in place\n");
        expect(last?.rows.map((row) => row.kind)).toEqual([
            "added",
            "updated",
            "unchanged",
            "deleted",
            "conflict",
            "warn",
        ]);
    });

    it("rowKind leaves a push or discovery line as a neutral info row", () => {
        expect(rowKind("pushing Home ... ok (v14)\n")).toBe("info");
        expect(rowKind("discovering docs to resolve x\n")).toBe("info");
    });

    it("rowName reads the page name from a pull line", () => {
        expect(rowName("added     docs/guide.md (v3)", "added")).toBe(
            "docs/guide.md",
        );
        expect(
            rowName(
                "deleted   docs/gone.md (removed from Confluence)",
                "deleted",
            ),
        ).toBe("docs/gone.md");
    });

    it("rowName reads the page name from push and create lines", () => {
        expect(rowName("pushing team/x.md ... ok (v3)", "info")).toBe(
            "team/x.md",
        );
        expect(rowName("creating team/y.md ... skipped", "info")).toBe(
            "team/y.md",
        );
    });

    it("rowName reads the name from an err failure row", () => {
        expect(rowName("team/x.md: remote moved", "err")).toBe("team/x.md");
    });

    it("rowName keeps spaces in a page name", () => {
        expect(
            rowName("updated   My Notes/Weekly log.md (v4)", "updated"),
        ).toBe("My Notes/Weekly log.md");
    });

    it("rowName returns null for a continuation or nameless line", () => {
        expect(rowName("      warning: left in place", "warn")).toBeNull();
        expect(
            rowName('      reused existing folder "Team"', "info"),
        ).toBeNull();
        expect(rowName("discovering docs to resolve x", "info")).toBeNull();
    });

    it("setTally records the per-action footer breakdown and error count", () => {
        let last: RunState | undefined;
        const r = new PanelReporter("pulling", (s) => {
            last = s;
        });
        r.setTally(
            { added: 2, updated: 1, unchanged: 3, conflict: 0, deleted: 1 },
            2,
        );
        expect(last?.tally).toEqual({
            added: 2,
            updated: 1,
            unchanged: 3,
            conflict: 0,
            deleted: 1,
        });
        expect(last?.counts.err).toBe(2);
    });

    it("streamsLog returns true so the caller does not double-print", () => {
        expect(new PanelReporter("pulling", () => {}).streamsLog()).toBe(true);
    });

    it("records outcome failures as err rows via fail()", () => {
        let last: RunState | undefined;
        const r = new PanelReporter("pushing", (s) => {
            last = s;
        });
        r.fail("API Ref: remote moved");
        expect(last?.rows.at(-1)).toEqual({
            text: "API Ref: remote moved",
            kind: "err",
        });
    });

    it("starts with an empty errorText and no error phase", () => {
        const r = new PanelReporter("pushing", () => {});
        const s = r.state();
        expect(s.errorText).toBe("");
        expect(s.phase).not.toBe("error");
    });

    it("error() enters the error phase and records the message", () => {
        let last: RunState | undefined;
        const r = new PanelReporter("pushing", (s) => {
            last = s;
        });
        r.error("network down");
        expect(last?.phase).toBe("error");
        expect(last?.errorText).toBe("network down");
    });

    it("error() preserves the log and counts of pages already done", () => {
        let last: RunState | undefined;
        const r = new PanelReporter("pushing", (s) => {
            last = s;
        });
        r.discovered(3);
        r.item("Home");
        r.log("pushing Home ... ok (v14)\n");
        r.setCounts({ ok: 1, warn: 0, err: 0 });
        r.error("boom on page 2");
        expect(last?.phase).toBe("error");
        expect(last?.errorText).toBe("boom on page 2");
        // The accumulated row and tally survive the fatal error.
        expect(last?.rows).toEqual([
            { text: "pushing Home ... ok (v14)", kind: "info" },
        ]);
        expect(last?.counts).toEqual({ ok: 1, warn: 0, err: 0 });
        // pos/total are retained so the caller can drop the frozen bar itself.
        expect(last?.pos).toBe(1);
        expect(last?.total).toBe(3);
    });
});
