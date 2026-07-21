// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/cfsync/config_test.go, adapted to the redesigned shape: the
// sync root replaces work_dir and arrives as an injected secret, so the file-
// loading, `.env`, and `override` tests move to the CLI/plugin adapters; the
// source-format checks (page id / folder / space) move to M6.2 with the client.
// The path validators, domain, timeout, secret validation, destination
// resolution + collision, forbidden-key rejection, and new scope-guard cases
// port here.

import { describe, expect, it } from "vitest";
import {
    buildConfig,
    rejectEnvKeys,
    reqTimeout,
    type Secrets,
    siteDomain,
    siteHost,
    validateDest,
    validateRoot,
    validateSecrets,
    validateSite,
} from "../../src/config/config.ts";

/** secretsFor builds valid secrets with the given sync root. */
const secretsFor = (syncRoot: string): Secrets => ({
    site: "ex",
    account: "a@ex.com",
    token: "secret",
    syncRoot,
});

describe("validateDest", () => {
    it("accepts a relative .md path", () => {
        expect(() => validateDest("a/b.md")).not.toThrow();
    });

    const cases: Array<{ name: string; dest: string; want: string }> = [
        { name: "empty", dest: "", want: "is empty" },
        { name: "absolute", dest: "/abs/x.md", want: "must be relative" },
        { name: "not markdown", dest: "note.txt", want: "must end in .md" },
        { name: "no extension", dest: "note", want: "must end in .md" },
        {
            name: "escapes root",
            dest: "../x.md",
            want: "escapes the sync root",
        },
        {
            name: "escapes root nested",
            dest: "a/../../x.md",
            want: "escapes the sync root",
        },
    ];
    for (const tc of cases) {
        it(`rejects ${tc.name}`, () => {
            expect(() => validateDest(tc.dest)).toThrow(tc.want);
        });
    }
});

describe("validateRoot", () => {
    it("accepts a relative directory path", () => {
        expect(() => validateRoot("docs/sub")).not.toThrow();
    });

    const cases: Array<{ name: string; root: string; want: string }> = [
        { name: "empty", root: "", want: "is empty" },
        { name: "absolute", root: "/abs", want: "must be relative" },
        { name: "markdown", root: "docs.md", want: "must not end in .md" },
        { name: "escapes root", root: "../x", want: "escapes the sync root" },
        {
            name: "escapes root nested",
            root: "a/../../x",
            want: "escapes the sync root",
        },
    ];
    for (const tc of cases) {
        it(`rejects ${tc.name}`, () => {
            expect(() => validateRoot(tc.root)).toThrow(tc.want);
        });
    }
});

describe("siteHost / siteDomain", () => {
    it("expands a subdomain into the Site base URL", () => {
        expect(siteHost("your-site")).toBe("https://your-site.atlassian.net");
    });

    it("derives the scheme-less domain", () => {
        expect(siteDomain("your-site")).toBe("your-site.atlassian.net");
    });
});

describe("validateSite", () => {
    it("accepts a bare subdomain", () => {
        expect(() => validateSite("your-site")).not.toThrow();
    });

    it("accepts a subdomain with internal hyphens and digits", () => {
        expect(() => validateSite("my-team-01")).not.toThrow();
    });

    const cases: Array<{ name: string; site: string }> = [
        { name: "empty", site: "" },
        { name: "full https URL", site: "https://ex.atlassian.net" },
        { name: "dotted host", site: "ex.atlassian.net" },
        { name: "with path", site: "ex/wiki" },
        { name: "with scheme only", site: "https://ex" },
        { name: "leading hyphen", site: "-ex" },
        { name: "trailing hyphen", site: "ex-" },
    ];
    for (const tc of cases) {
        it(`rejects ${tc.name}`, () => {
            expect(() => validateSite(tc.site)).toThrow(
                "must be a bare subdomain",
            );
        });
    }
});

describe("reqTimeout", () => {
    it("returns the configured timeout", () => {
        expect(reqTimeout(45_000)).toBe(45_000);
    });
    it("falls back to the default when non-positive", () => {
        expect(reqTimeout(0)).toBe(30_000);
    });
});

describe("validateSecrets", () => {
    it("accepts complete secrets", () => {
        expect(() => validateSecrets(secretsFor("wd"))).not.toThrow();
    });

    const cases: Array<{ name: string; secrets: Secrets; want: string }> = [
        {
            name: "missing site",
            secrets: {
                site: "",
                account: "a@ex.com",
                token: "secret",
                syncRoot: "wd",
            },
            want: "site is required",
        },
        {
            name: "missing account",
            secrets: {
                site: "ex",
                account: "",
                token: "secret",
                syncRoot: "wd",
            },
            want: "account is required",
        },
        {
            name: "missing token",
            secrets: {
                site: "ex",
                account: "a@ex.com",
                token: "",
                syncRoot: "wd",
            },
            want: "token is required",
        },
        {
            name: "missing sync root",
            secrets: {
                site: "ex",
                account: "a@ex.com",
                token: "secret",
                syncRoot: "",
            },
            want: "sync root is required",
        },
        {
            name: "site is a full URL",
            secrets: {
                site: "https://ex.atlassian.net",
                account: "a@ex.com",
                token: "secret",
                syncRoot: "wd",
            },
            want: "must be a bare subdomain",
        },
        {
            name: "site is a dotted host",
            secrets: {
                site: "ex.atlassian.net",
                account: "a@ex.com",
                token: "secret",
                syncRoot: "wd",
            },
            want: "must be a bare subdomain",
        },
    ];
    for (const tc of cases) {
        it(`rejects ${tc.name}`, () => {
            expect(() => validateSecrets(tc.secrets)).toThrow(tc.want);
        });
    }
});

describe("rejectEnvKeys", () => {
    it("allows a file config without injected keys", () => {
        expect(() => rejectEnvKeys({ pages: { "a.md": "src" } })).not.toThrow();
    });

    const keys = [
        "site",
        "host",
        "account",
        "token",
        "sync_root",
        "work_dir",
        // camelCase forms guarded as defence in depth: an accidental spread of a
        // Secrets-shaped source must not smuggle the sync root into the file config.
        "syncRoot",
        "workDir",
    ];
    for (const key of keys) {
        it(`rejects ${key}`, () => {
            expect(() => rejectEnvKeys({ [key]: "x" })).toThrow(
                `"${key}" must not be set`,
            );
        });
    }
});

describe("buildConfig", () => {
    it("builds a config from combined sources", () => {
        const cfg = buildConfig(
            {
                timeoutMs: 45_000,
                pages: { "a.md": "/wiki/spaces/T/pages/1/P" },
                folders: { docs: "/wiki/spaces/T/folder/2" },
                spaces: { team: "/wiki/spaces/TEST" },
            },
            secretsFor("/base/wd"),
        );
        expect(cfg.host).toBe("https://ex.atlassian.net");
        expect(cfg.domain).toBe("ex.atlassian.net");
        expect(cfg.timeoutMs).toBe(45_000);
        expect(cfg.pages).toEqual({
            "/base/wd/a.md": "/wiki/spaces/T/pages/1/P",
        });
        expect(cfg.folders).toEqual({
            "/base/wd/docs": "/wiki/spaces/T/folder/2",
        });
        expect(cfg.spaces).toEqual({ "/base/wd/team": "/wiki/spaces/TEST" });
    });

    it("defaults the timeout when unset", () => {
        expect(buildConfig({}, secretsFor("/base/wd")).timeoutMs).toBe(30_000);
    });

    it("defaults the margin to 0 (no wrap) when unset", () => {
        expect(buildConfig({}, secretsFor("/base/wd")).margin).toBe(0);
    });

    it("keeps a positive margin", () => {
        expect(buildConfig({ margin: 80 }, secretsFor("/base/wd")).margin).toBe(
            80,
        );
    });

    it("rejects a negative, fractional, or non-numeric margin", () => {
        for (const margin of [-1, 79.5, "80"]) {
            expect(() =>
                buildConfig({ margin }, secretsFor("/base/wd")),
            ).toThrow('"markdown.margin" must be a non-negative integer');
        }
    });

    it("rejects a forbidden key in the file config", () => {
        expect(() =>
            buildConfig({ token: "x" }, secretsFor("/base/wd")),
        ).toThrow('"token" must not be set');
    });

    it("resolves page keys under the sync root", () => {
        const cfg = buildConfig(
            {
                pages: {
                    "a/b.md": "/wiki/spaces/TEST/pages/1/Page",
                    "c.md": "/wiki/spaces/DOCS/folder/",
                },
            },
            secretsFor("/base/wd"),
        );
        expect(cfg.pages).toEqual({
            "/base/wd/a/b.md": "/wiki/spaces/TEST/pages/1/Page",
            "/base/wd/c.md": "/wiki/spaces/DOCS/folder/",
        });
    });

    it("allows empty maps", () => {
        const cfg = buildConfig({}, secretsFor("/base/wd"));
        expect(cfg.pages).toEqual({});
        expect(cfg.folders).toEqual({});
        expect(cfg.spaces).toEqual({});
    });

    const collisions: Array<{
        name: string;
        raw: Record<string, unknown>;
        want: string;
    }> = [
        {
            name: "page empty source",
            raw: { pages: { "a.md": "" } },
            want: "empty source",
        },
        {
            name: "pages resolve to the same destination",
            raw: {
                pages: {
                    "a/b.md": "/wiki/spaces/TEST/pages/1/Page",
                    "a/./b.md": "/wiki/spaces/TEST/pages/2/Page",
                },
            },
            want: "same destination",
        },
        {
            name: "folder empty source",
            raw: { folders: { docs: "" } },
            want: "empty source",
        },
        {
            name: "folders share a destination",
            raw: {
                folders: {
                    docs: "/wiki/spaces/DOCS/folder/100",
                    "docs/./.": "/wiki/spaces/DOCS/folder/200",
                },
            },
            want: "same destination",
        },
        {
            name: "space empty source",
            raw: { spaces: { team: "" } },
            want: "empty source",
        },
        {
            name: "spaces share a destination",
            raw: {
                spaces: {
                    team: "/wiki/spaces/TEST",
                    "team/./.": "/wiki/spaces/DOCS",
                },
            },
            want: "same destination",
        },
        {
            name: "folder and space share a destination",
            raw: {
                folders: { docs: "/wiki/spaces/DOCS/folder/100" },
                spaces: { docs: "/wiki/spaces/TEAM" },
            },
            want: "same destination",
        },
    ];
    for (const tc of collisions) {
        it(`rejects ${tc.name}`, () => {
            expect(() => buildConfig(tc.raw, secretsFor("/base/wd"))).toThrow(
                tc.want,
            );
        });
    }
});

describe("markdown.flavor", () => {
    it("defaults to obsidian when unset", () => {
        const cfg = buildConfig({}, secretsFor("/base/wd"));
        expect(cfg.flavor).toBe("obsidian");
    });

    it("accepts a known flavor id", () => {
        const cfg = buildConfig({ flavor: "obsidian" }, secretsFor("/base/wd"));
        expect(cfg.flavor).toBe("obsidian");
    });

    it("throws on an unknown flavor id", () => {
        expect(() =>
            buildConfig({ flavor: "nope" }, secretsFor("/base/wd")),
        ).toThrow(/flavor/);
    });

    it("defaults to obsidian when null (a bare YAML key)", () => {
        const cfg = buildConfig({ flavor: null }, secretsFor("/base/wd"));
        expect(cfg.flavor).toBe("obsidian");
    });

    it("throws when the flavor is not a string", () => {
        expect(() =>
            buildConfig({ flavor: 123 }, secretsFor("/base/wd")),
        ).toThrow(/must be a string/);
    });
});

describe("scope guard", () => {
    it("every resolved destination stays under the sync root", () => {
        const cfg = buildConfig(
            {
                pages: { "deep/nested/note.md": "src" },
                folders: { "a/b/c": "/wiki/spaces/T/folder/1" },
                spaces: { team: "/wiki/spaces/T" },
            },
            secretsFor("/vault/Confluence"),
        );
        for (const path of [
            ...Object.keys(cfg.pages),
            ...Object.keys(cfg.folders),
            ...Object.keys(cfg.spaces),
        ]) {
            expect(path.startsWith("/vault/Confluence/")).toBe(true);
        }
    });

    it("resolves destinations under a '.' sync root (the current directory)", () => {
        const cfg = buildConfig(
            {
                pages: { "docs/note.md": "src" },
                folders: { "a/b": "/wiki/spaces/T/folder/1" },
                spaces: { team: "/wiki/spaces/T" },
            },
            secretsFor("."),
        );
        expect(cfg.pages).toEqual({ "docs/note.md": "src" });
        expect(cfg.folders).toEqual({ "a/b": "/wiki/spaces/T/folder/1" });
        expect(cfg.spaces).toEqual({ team: "/wiki/spaces/T" });
    });

    it("a '.' sync root still refuses a destination that escapes it", () => {
        expect(() =>
            buildConfig({ pages: { "../outside.md": "src" } }, secretsFor(".")),
        ).toThrow("escapes the sync root");
    });

    it("a destination that escapes the sync root is refused", () => {
        expect(() =>
            buildConfig(
                { pages: { "../outside.md": "src" } },
                secretsFor("/vault/Confluence"),
            ),
        ).toThrow("escapes the sync root");
        expect(() =>
            buildConfig(
                { folders: { "../outside": "/wiki/spaces/T/folder/1" } },
                secretsFor("/vault/Confluence"),
            ),
        ).toThrow("escapes the sync root");
    });
});

describe("nested roots", () => {
    /** thrown runs buildConfig and returns the thrown Error, or undefined. */
    const thrown = (raw: Record<string, unknown>): Error | undefined => {
        try {
            buildConfig(raw, secretsFor("/base/wd"));
        } catch (e) {
            return e as Error;
        }
        return undefined;
    };

    it("rejects a space nested under a folder, naming both keys", () => {
        const err = thrown({
            folders: { team: "/wiki/spaces/T/folder/1" },
            spaces: { "team/wiki": "/wiki/spaces/W" },
        });
        expect(err?.message).toContain('folder "team"');
        expect(err?.message).toContain('space "team/wiki"');
        expect(err?.message).toContain("nested under the other");
    });

    it("allows a page pinned under a folder root", () => {
        // A page is a leaf destination, not a walked subtree, so pinning one
        // inside a folder root is valid config; any name clash surfaces as a
        // pull-time collision, not a config error.
        expect(() =>
            buildConfig(
                {
                    folders: { docs: "/wiki/spaces/T/folder/1" },
                    pages: { "docs/note.md": "/wiki/spaces/T/pages/1/N" },
                },
                secretsFor("/base/wd"),
            ),
        ).not.toThrow();
    });

    it("allows sibling (non-nested) roots", () => {
        expect(() =>
            buildConfig(
                {
                    folders: { "a/b": "/wiki/spaces/T/folder/1" },
                    spaces: { "a/c": "/wiki/spaces/W" },
                },
                secretsFor("/base/wd"),
            ),
        ).not.toThrow();
    });

    it("allows roots that share a name prefix but do not nest", () => {
        expect(() =>
            buildConfig(
                {
                    folders: { team: "/wiki/spaces/T/folder/1" },
                    spaces: { teamx: "/wiki/spaces/W" },
                },
                secretsFor("/base/wd"),
            ),
        ).not.toThrow();
    });

    it("still rejects two roots resolving to the identical path", () => {
        expect(() =>
            buildConfig(
                {
                    folders: { docs: "/wiki/spaces/DOCS/folder/1" },
                    spaces: { "docs/.": "/wiki/spaces/W" },
                },
                secretsFor("/base/wd"),
            ),
        ).toThrow("same destination");
    });
});
