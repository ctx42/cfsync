// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Confluence source-string normalisation for the settings UI. Users copy a page
// link straight from the browser, which is a full `https://<site>.atlassian.net/
// wiki/...` URL; the sync map only needs the `/wiki/...` path (the client parses
// the page/folder/space id from the path segments either way). Reducing it here
// keeps the stored source short and the settings row readable. Pure — no Obsidian
// runtime — so it unit-tests directly.

/**
 * normalizeConfluenceSource trims `input` and, when it is a full `http(s)://`
 * URL, reduces it to its path (dropping the scheme, host, query, and fragment),
 * e.g. `https://ex.atlassian.net/wiki/spaces/T/pages/1/P?x=1#y` →
 * `/wiki/spaces/T/pages/1/P`. A value that is already a path, is not a URL, or
 * does not parse is returned unchanged (trimmed).
 */
export function normalizeConfluenceSource(input: string): string {
    const value = input.trim();
    if (!/^https?:\/\//i.test(value)) {
        return value;
    }
    try {
        return new URL(value).pathname;
    } catch {
        return value;
    }
}
