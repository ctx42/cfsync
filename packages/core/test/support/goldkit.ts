// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The `ctx42/goldkit` shim: load a golden fixture and, when given template
// data, render it as a Go `text/template` before parsing. Only the two actions
// the project's fixtures use are supported — `{{.Field}}` and
// `{{printf "%q" .Field}}` — so unsupported actions fail loudly rather than
// rendering wrong. Test-only support code; `node:` is allowed.

import { readFileSync } from "node:fs";
import { goQuote } from "../../src/adf/render/frontmatter.ts";
import { type Golden, parseGolden } from "./golden.ts";

export { goQuote };

/** Data bound to a fixture template: field name → value. */
export type TemplateData = Record<string, unknown>;

/** One `{{ … }}` template action. */
const ACTION = /\{\{(.*?)\}\}/g;
const FIELD = /^\.(\w+)$/;
const PRINTF_Q = /^printf\s+"%q"\s+\.(\w+)$/;

/**
 * renderGoTemplate renders `text` as a Go `text/template`, substituting the
 * supported actions from `data`. A `{{.Version}}` numeric field renders as Go
 * prints it (`3`); a `{{printf "%q" .ADF}}` field is Go-quoted. An unsupported
 * action or an unknown field throws.
 */
export function renderGoTemplate(text: string, data: TemplateData): string {
    return text.replace(ACTION, (_match, raw: string) => {
        const action = raw.trim();

        const printf = PRINTF_Q.exec(action);
        if (printf) {
            return goQuote(fieldString(data, printf[1] as string));
        }

        const field = FIELD.exec(action);
        if (field) {
            return fieldString(data, field[1] as string);
        }

        throw new Error(`goldkit: unsupported template action {{${action}}}`);
    });
}

/** Render a data field the way Go's template prints it. */
function fieldString(data: TemplateData, name: string): string {
    if (!(name in data)) {
        throw new Error(`goldkit: template references unknown field .${name}`);
    }
    const value = data[name];
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    throw new Error(`goldkit: field .${name} is not a scalar`);
}

/**
 * createGolden loads the golden fixture at `path`. When `data` is given, the
 * file is rendered as a Go template first (mirroring `goldkit.Create`); with
 * `null`/omitted data the file is parsed verbatim.
 */
export function createGolden(path: string, data?: TemplateData | null): Golden {
    const raw = readFileSync(path, "utf8");
    const text = data == null ? raw : renderGoTemplate(raw, data);
    return parseGolden(text);
}
