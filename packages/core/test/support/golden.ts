// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Minimal loader for the `ctx42/goldkit` golden fixture format: a YAML document
// with a `meta` map, a `bodyType`, and a `body` payload. Test-only support code,
// so it may use `node:` freely. The template-shim variant used for the
// Confluence page fixtures is built on top of this in M1.3.

import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** A parsed golden fixture. */
export interface Golden {
    /** The `meta` map — scenario inputs keyed by name. */
    meta: Record<string, unknown>;
    /** The declared body payload type (`text`, `json`, …). */
    bodyType: string;
    /** The expected body payload. */
    body: string;
}

/** Parse golden fixture `text` (already read, and template-rendered if any). */
export function parseGolden(text: string): Golden {
    const doc = parse(text) as {
        meta?: Record<string, unknown>;
        bodyType?: string;
        body?: string;
    } | null;
    return {
        meta: doc?.meta ?? {},
        bodyType: doc?.bodyType ?? "text",
        body: doc?.body ?? "",
    };
}

/** Load and parse the golden fixture at absolute `path`. */
export function loadGolden(path: string): Golden {
    return parseGolden(readFileSync(path, "utf8"));
}

/** Read a string entry from the fixture's `meta`, or throw if it is not one. */
export function metaString(golden: Golden, key: string): string {
    const value = golden.meta[key];
    if (typeof value !== "string") {
        throw new Error(`golden meta.${key} is not a string`);
    }
    return value;
}

/** Read an integer entry from the fixture's `meta`, or throw if it is not one. */
export function metaInt(golden: Golden, key: string): number {
    const value = golden.meta[key];
    if (typeof value !== "number") {
        throw new Error(`golden meta.${key} is not a number`);
    }
    return Math.trunc(value);
}
