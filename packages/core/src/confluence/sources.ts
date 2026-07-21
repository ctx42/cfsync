// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Confluence source-string parsers, ported from `pkg/cfsync` (pull.go `pageID`,
// helpers.go `isDigits`). They turn a config source or a link href into the
// numeric id the client fetches by. Deferred here from M6.1/M6.2 (sources stayed
// opaque there) to land with their first consumer, the link index (M7.1).
// `folderID`/`spaceLinkKey` land with the discovery walk (M7.4).

/** isDigits reports whether s is non-empty and all ASCII digits. */
export function isDigits(s: string): boolean {
    if (s === "") {
        return false;
    }
    for (const ch of s) {
        if (ch < "0" || ch > "9") {
            return false;
        }
    }
    return true;
}

/**
 * pageID extracts the numeric Confluence page id from a source of the form
 * `.../pages/{id}/...`. The id may follow `pages` directly or after an action
 * segment, as in the edit URL `.../pages/edit-v2/{id}`, so the first all-numeric
 * segment after `pages` is taken. It throws when src names no single page — which
 * includes a folder source. Any `?query` or `#fragment` is stripped first.
 */
export function pageID(src: string): string {
    let path = src;
    const cut = path.search(/[?#]/);
    if (cut >= 0) {
        path = path.slice(0, cut);
    }
    const segs = path.replace(/^\/+|\/+$/g, "").split("/");
    for (let i = 0; i + 1 < segs.length; i++) {
        if (segs[i] !== "pages") {
            continue;
        }
        for (const seg of segs.slice(i + 1)) {
            if (isDigits(seg)) {
                return seg;
            }
        }
    }
    throw new Error(`source "${src}" is not a single page URL`);
}

/**
 * tryPageID is {@link pageID} returning `undefined` instead of throwing, for
 * callers that skip a non-page source rather than fail.
 */
export function tryPageID(src: string): string | undefined {
    try {
        return pageID(src);
    } catch {
        return undefined;
    }
}

/**
 * folderID extracts the numeric Confluence folder id from a source of the form
 * `.../folder/{id}...`. It throws when src names no folder.
 */
export function folderID(src: string): string {
    const path = stripQueryFragment(src);
    const segs = path.replace(/^\/+|\/+$/g, "").split("/");
    for (let i = 0; i + 1 < segs.length; i++) {
        if (segs[i] === "folder" && isDigits(segs[i + 1] ?? "")) {
            return segs[i + 1] ?? "";
        }
    }
    throw new Error(`source "${src}" is not a folder`);
}

/**
 * spaceLinkKey extracts the space key from a link to a space root of the form
 * `.../spaces/{KEY}`, optionally followed by an `overview` segment, a query, or a
 * fragment. It throws when link is not a space-root link (page and folder links,
 * which carry extra path segments, included).
 */
export function spaceLinkKey(link: string): string {
    const path = stripQueryFragment(link);
    const segs = path.replace(/^\/+|\/+$/g, "").split("/");
    for (let i = 0; i + 1 < segs.length; i++) {
        if (segs[i] !== "spaces") {
            continue;
        }
        const key = segs[i + 1] ?? "";
        const rest = segs.slice(i + 2);
        if (
            key !== "" &&
            (rest.length === 0 || (rest.length === 1 && rest[0] === "overview"))
        ) {
            return key;
        }
        break;
    }
    throw new Error(`link "${link}" is not a space root`);
}

/**
 * spaceKeyOf extracts the space key from a source of the form `.../spaces/{KEY}`,
 * or `""` when it names none. Unlike {@link spaceLinkKey} it does not validate the
 * link shape; it is used to build page URLs while walking a folder.
 */
export function spaceKeyOf(src: string): string {
    const segs = src.split("/");
    for (let i = 0; i + 1 < segs.length; i++) {
        if (segs[i] === "spaces") {
            return segs[i + 1] ?? "";
        }
    }
    return "";
}

/** stripQueryFragment drops a trailing `?query` or `#fragment`. */
function stripQueryFragment(s: string): string {
    const cut = s.search(/[?#]/);
    return cut < 0 ? s : s.slice(0, cut);
}
