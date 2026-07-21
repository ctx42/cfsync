// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// POSIX path helpers (forward-slash only). Core cannot import `node:path`, and
// Obsidian vault paths are always POSIX, so these mirror Go's `path/filepath`
// Clean/Join/IsAbs/Ext/Dir/Base/Rel for the `/` separator. Shared by config,
// cache, and the sync layer.

/** isAbsPosix reports whether p begins at the root. */
export function isAbsPosix(p: string): boolean {
    return p.startsWith("/");
}

/**
 * posixClean returns the shortest equivalent path, resolving `.`/`..` and
 * collapsing separators, mirroring `filepath.Clean` for `/`. An empty path cleans
 * to `.`.
 */
export function posixClean(p: string): string {
    const abs = isAbsPosix(p);
    const out: string[] = [];
    for (const part of p.split("/")) {
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            const last = out[out.length - 1];
            if (out.length > 0 && last !== "..") {
                out.pop();
            } else if (!abs) {
                out.push("..");
            }
            continue;
        }
        out.push(part);
    }
    const joined = out.join("/");
    if (abs) {
        return `/${joined}`;
    }
    return joined === "" ? "." : joined;
}

/** posixJoin joins path elements with `/` and cleans the result, like filepath.Join. */
export function posixJoin(a: string, b: string): string {
    return posixClean(`${a}/${b}`);
}

/**
 * posixExt returns the file-name extension of p — the suffix from the final `.`
 * of the last path element — or `""` when it has none, mirroring filepath.Ext.
 */
export function posixExt(p: string): string {
    const b = p.slice(p.lastIndexOf("/") + 1);
    const dot = b.lastIndexOf(".");
    return dot < 0 ? "" : b.slice(dot);
}

/**
 * posixDir returns everything up to, but not including, the final `/` of the
 * cleaned path, mirroring filepath.Dir: `.` when there is no separator, `/` at
 * the root.
 */
export function posixDir(p: string): string {
    const c = posixClean(p);
    const i = c.lastIndexOf("/");
    if (i < 0) {
        return ".";
    }
    return i === 0 ? "/" : c.slice(0, i);
}

/** posixBase returns the last element of the cleaned path, mirroring filepath.Base. */
export function posixBase(p: string): string {
    const c = posixClean(p);
    if (c === "/") {
        return "/";
    }
    const i = c.lastIndexOf("/");
    return i < 0 ? c : c.slice(i + 1);
}

/**
 * posixRel returns a relative path that is lexically equivalent to `to` when
 * joined to `from`, mirroring `filepath.Rel` for two paths of the same kind (both
 * absolute or both relative). It assumes cleaned, same-kind inputs, which is how
 * the link index uses it.
 */
export function posixRel(from: string, to: string): string {
    const fromC = posixClean(from);
    const toC = posixClean(to);
    if (fromC === toC) {
        return ".";
    }
    const fromParts = segments(fromC);
    const toParts = segments(toC);
    let i = 0;
    while (
        i < fromParts.length &&
        i < toParts.length &&
        fromParts[i] === toParts[i]
    ) {
        i++;
    }
    const ups = fromParts.length - i;
    const out = [...new Array<string>(ups).fill(".."), ...toParts.slice(i)];
    return out.length === 0 ? "." : out.join("/");
}

/**
 * segments splits a cleaned path into its real elements, dropping a leading `/`
 * and the lone `.` a cleaned current-directory path is. The `.` drop matters for
 * {@link posixRel}: a `.` `from` is zero segments (like `filepath.Rel`), so it
 * adds no spurious `..` when the target is a plain sub-path.
 */
function segments(p: string): string[] {
    return p.split("/").filter((s) => s !== "" && s !== ".");
}
