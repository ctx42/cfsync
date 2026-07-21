// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Page creation planning, ported from the disk-derived-placement half of
// `pkg/cfsync/create.go`. A note whose frontmatter names a title but carries no
// page id has no Confluence counterpart yet; `classifyCreates` splits such
// candidates from ordinary updates and resolves each one's space and parent —
// disk-only, before any prompt or request. For a note under a managed folder or
// space root the space and parent are derived from the directory: the explicit
// frontmatter value wins, else the same-directory `_index.md`, else the stamped
// sibling pages (which must all agree); an unanchored ancestor becomes a folder
// to create first. A candidate that cannot be placed is refused, named, so the
// push reports it rather than creating it in the wrong place. Pure over the
// {@link FileSystem} + {@link Yaml} ports; the create execution is a later layer.

import {
    type ConfluenceClient,
    FolderTitleTakenError,
} from "../confluence/client.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Yaml } from "../ports/yaml.ts";
import { posixBase, posixDir, posixJoin, posixRel } from "../util/path.ts";
import { deriveName } from "./discover.ts";
import {
    type MetaCache,
    type PushMeta,
    readMeta,
    readPageMeta,
} from "./push.ts";

/** The reserved container-index base name. */
const INDEX_FILE = "_index.md";

/** FolderPlan is one missing Confluence folder a create depends on. */
export interface FolderPlan {
    /** The absolute directory the folder mirrors. */
    dir: string;
    /** The folder's Confluence title, de-slugged from the directory name. */
    title: string;
}

/** CreateInput is a resolved new-page candidate: where and what to create. */
export interface CreateInput {
    dest: string;
    title: string;
    spaceId: string;
    /** The parent page id, `""` for a space root. */
    parentId: string;
    /** Ancestor folders (top-down) to create before the page; empty when none. */
    folders: FolderPlan[];
}

/** ClassifyResult splits the create candidates from the refused notes (dest → reason). */
export interface ClassifyResult {
    candidates: CreateInput[];
    refusals: Map<string, string>;
}

/**
 * classifyCreates scans the note destinations and splits the new pages to create
 * from the rest, resolving each root create's space and parent from disk. A
 * titled, id-less note under a root needs only its title; one outside every root
 * is a Pages-mapped note that stays a candidate only when it also names a space
 * explicitly. A note with a page id, no title, or no frontmatter is left to the
 * update path. A candidate that cannot be placed is returned in `refusals`.
 */
export async function classifyCreates(
    fs: FileSystem,
    yaml: Yaml,
    dests: string[],
    roots: string[],
    cache?: MetaCache,
): Promise<ClassifyResult> {
    const candidates: CreateInput[] = [];
    const refusals = new Map<string, string>();

    for (const dest of dests) {
        const meta = await readMeta(cache, fs, yaml, dest);
        if (meta === null || meta.pageId !== "" || meta.title === "") {
            continue;
        }

        const underRoot = underAnyRoot(dest, roots);
        if (underRoot && posixBase(dest) === INDEX_FILE) {
            refusals.set(
                dest,
                "page-backed directory index; creating one is unsupported",
            );
            continue;
        }

        if (!underRoot) {
            if (meta.spaceId === "") {
                continue; // Pages-mapped note: explicit space required.
            }
            candidates.push({
                dest,
                title: meta.title,
                spaceId: meta.spaceId,
                parentId: meta.parentId,
                folders: [],
            });
            continue;
        }

        try {
            const { parent, space, folders } = await placeUnderRoot(
                fs,
                yaml,
                dest,
                meta.parentId,
                meta.spaceId,
                rootOf(dest, roots),
            );
            candidates.push({
                dest,
                title: meta.title,
                spaceId: space,
                parentId: parent,
                folders,
            });
        } catch (err) {
            refusals.set(dest, message(err));
        }
    }
    return { candidates, refusals };
}

/**
 * deriveCreateFields resolves the space and parent for a candidate at `dest`,
 * disk-only. Both explicit fields win outright; otherwise the directory decides
 * (see {@link deriveDirPlacement}). It throws when a field cannot be resolved.
 */
export async function deriveCreateFields(
    fs: FileSystem,
    yaml: Yaml,
    dest: string,
    explicitParent: string,
    explicitSpace: string,
): Promise<{ parent: string; space: string }> {
    if (explicitParent !== "" && explicitSpace !== "") {
        return { parent: explicitParent, space: explicitSpace };
    }
    return deriveDirPlacement(
        fs,
        yaml,
        posixDir(dest),
        dest,
        dest,
        explicitParent,
        explicitSpace,
    );
}

/**
 * deriveDirPlacement resolves the parent and space a page inherits from `dir`. For
 * each field the first source wins: the explicit value, else `dir`'s `_index.md`
 * (its page id is the parent, its space the space), else the stamped siblings,
 * which must agree. It throws (joining both field errors) when it cannot resolve.
 * `self` is the candidate excluded from the sibling scan.
 */
async function deriveDirPlacement(
    fs: FileSystem,
    yaml: Yaml,
    dir: string,
    self: string,
    dest: string,
    explicitParent: string,
    explicitSpace: string,
): Promise<{ parent: string; space: string }> {
    const { index, sibs } = await readDirMetas(fs, yaml, dir, self);
    const indexParent = index?.pageId ?? "";
    const indexSpace = index?.spaceId ?? "";

    const sibParents = new Map<string, string>();
    const sibSpaces = new Map<string, string>();
    for (const [path, meta] of sibs) {
        const base = posixBase(path);
        if (meta.parentId !== "") {
            sibParents.set(base, meta.parentId);
        }
        if (meta.spaceId !== "") {
            sibSpaces.set(base, meta.spaceId);
        }
    }

    const errs: string[] = [];
    let parent = "";
    let space = "";
    try {
        parent = resolveCreateField(
            "parent_id",
            dest,
            explicitParent,
            indexParent,
            sibParents,
        );
    } catch (err) {
        errs.push(message(err));
    }
    try {
        space = resolveCreateField(
            "space_id",
            dest,
            explicitSpace,
            indexSpace,
            sibSpaces,
        );
    } catch (err) {
        errs.push(message(err));
    }
    if (errs.length > 0) {
        throw new Error(errs.join("; "));
    }
    return { parent, space };
}

/**
 * placeUnderRoot resolves where a candidate at `dest` lands under `root` and which
 * ancestor folders must be created first. When the candidate's own directory
 * anchors it (an explicit parent, an `_index.md`, or stamped siblings) no folder
 * is missing. Otherwise it walks up toward `root`: each unanchored directory
 * becomes a missing folder (returned top-down), and the nearest anchored ancestor
 * supplies the parent. A folder whose de-slugged title does not slug back to the
 * directory name is refused. It throws on any refusal.
 */
export async function placeUnderRoot(
    fs: FileSystem,
    yaml: Yaml,
    dest: string,
    explicitParent: string,
    explicitSpace: string,
    root: string,
): Promise<{ parent: string; space: string; folders: FolderPlan[] }> {
    const imm = posixDir(dest);
    if (explicitParent !== "" || (await dirHasAnchor(fs, yaml, imm, dest))) {
        const { parent, space } = await deriveCreateFields(
            fs,
            yaml,
            dest,
            explicitParent,
            explicitSpace,
        );
        return { parent, space, folders: [] };
    }
    if (await dirIsStale(fs, yaml, imm, dest)) {
        throw new Error(staleStampRefusal(imm));
    }

    const chain: string[] = []; // deepest first
    let dir = imm;
    let parent = "";
    let space = "";
    for (;;) {
        if (dir !== imm && (await dirHasAnchor(fs, yaml, dir, ""))) {
            ({ parent, space } = await deriveDirPlacement(
                fs,
                yaml,
                dir,
                "",
                dest,
                "",
                explicitSpace,
            ));
            break;
        }
        if (dir !== imm && (await dirIsStale(fs, yaml, dir, ""))) {
            throw new Error(staleStampRefusal(dir));
        }
        if (dir === root) {
            // No anchored ancestor up to the root: refuse as deriveCreateFields does.
            await deriveCreateFields(
                fs,
                yaml,
                dest,
                explicitParent,
                explicitSpace,
            );
            throw new Error(`cannot place ${posixBase(dest)} under the root`);
        }
        chain.push(dir);
        const up = posixDir(dir);
        if (up === dir) {
            await deriveCreateFields(
                fs,
                yaml,
                dest,
                explicitParent,
                explicitSpace,
            );
            throw new Error(`cannot place ${posixBase(dest)} under the root`);
        }
        dir = up;
    }

    const folders: FolderPlan[] = [];
    for (let i = chain.length - 1; i >= 0; i--) {
        const fdir = chain[i] ?? "";
        const name = posixBase(fdir);
        const title = deSlugTitle(name);
        if (!roundTrips(title, name)) {
            throw new Error(
                `folder "${posixRel(root, fdir)}" title "${title}" does not ` +
                    'round-trip; rename it to lowercase words joined by "_"',
            );
        }
        folders.push({ dir: fdir, title });
    }
    return { parent, space, folders };
}

/** roundTrips reports whether de-slugging `title` re-derives the directory `name`. */
function roundTrips(title: string, name: string): boolean {
    try {
        return deriveName(title) === name;
    } catch {
        return false;
    }
}

/**
 * dirHasAnchor reports whether `dir` carries a placement anchor for a child page:
 * an `_index.md` with a page id, or a stamped sibling naming a parent. A directory
 * holding only id-less candidates is not an anchor.
 */
async function dirHasAnchor(
    fs: FileSystem,
    yaml: Yaml,
    dir: string,
    self: string,
): Promise<boolean> {
    const { index, sibs } = await readDirMetas(fs, yaml, dir, self);
    if (index !== null && index.pageId !== "") {
        return true;
    }
    for (const meta of sibs.values()) {
        if (meta.parentId !== "") {
            return true;
        }
    }
    return false;
}

/**
 * dirIsStale reports whether `dir` holds a tracked sibling page (a page id but no
 * parent_id) without an `_index.md` anchor — a directory pulled before parent_id
 * stamping, whose pages already exist remotely, so planning a folder for it would
 * duplicate the remote chain.
 */
async function dirIsStale(
    fs: FileSystem,
    yaml: Yaml,
    dir: string,
    self: string,
): Promise<boolean> {
    const { index, sibs } = await readDirMetas(fs, yaml, dir, self);
    if (index !== null && index.pageId !== "") {
        return false;
    }
    for (const meta of sibs.values()) {
        if (meta.pageId !== "" && meta.parentId === "") {
            return true;
        }
    }
    return false;
}

/** staleStampRefusal builds the refusal for a directory pulled before parent_id stamping. */
function staleStampRefusal(dir: string): string {
    return (
        `${posixBase(dir)} holds pages pulled before parent_id stamping; ` +
        "re-pull the space before creating pages under it"
    );
}

/**
 * deSlugTitle turns a slug directory name into a folder title: underscores become
 * spaces and each word is capitalized. It inverts {@link deriveName} for the names
 * it can produce; a name it cannot invert is caught by the round-trip check.
 */
export function deSlugTitle(name: string): string {
    return name
        .split("_")
        .map((word) => {
            if (word === "") {
                return word;
            }
            const chars = [...word];
            chars[0] = (chars[0] ?? "").toUpperCase();
            return chars.join("");
        })
        .join(" ");
}

/**
 * resolveCreateField resolves one create field: the explicit value, else the
 * index value, else the single value the siblings agree on. Disagreeing siblings
 * or no source at all throws, naming the fix.
 */
function resolveCreateField(
    field: string,
    dest: string,
    explicit: string,
    indexVal: string,
    sibVals: Map<string, string>,
): string {
    if (explicit !== "") {
        return explicit;
    }
    if (indexVal !== "") {
        return indexVal;
    }

    let value = "";
    let disagree = false;
    for (const v of sibVals.values()) {
        if (value === "") {
            value = v;
        } else if (v !== value) {
            disagree = true;
        }
    }
    if (disagree) {
        const names = [...sibVals.keys()].sort();
        const parts = names.map((n) => `${n}=${sibVals.get(n) ?? ""}`);
        throw new Error(
            `${field} disagrees among siblings: ${parts.join(", ")}`,
        );
    }
    if (value !== "") {
        return value;
    }
    throw new Error(
        `cannot derive ${field} for ${posixBase(dest)}; ` +
            `re-pull the space or set ${field} explicitly`,
    );
}

/**
 * readDirMetas reads the notes in `dir` for create derivation: the `_index.md`
 * metadata (null when absent/unparsable), and a map from each stamped sibling's
 * path to its metadata. The candidate `self`, the `_index.md`, and any `cf_local`
 * note are excluded from the siblings.
 */
async function readDirMetas(
    fs: FileSystem,
    yaml: Yaml,
    dir: string,
    self: string,
): Promise<{ index: PushMeta | null; sibs: Map<string, PushMeta> }> {
    let names: string[];
    try {
        names = await fs.readdir(dir);
    } catch {
        return { index: null, sibs: new Map() };
    }

    let index: PushMeta | null = null;
    const sibs = new Map<string, PushMeta>();
    for (const name of names) {
        if (!name.endsWith(".md")) {
            continue;
        }
        const path = posixJoin(dir, name);
        let isDir: boolean;
        try {
            isDir = (await fs.stat(path)).isDirectory;
        } catch {
            continue;
        }
        if (isDir) {
            continue;
        }
        const meta = await readPageMeta(fs, yaml, path);
        if (meta === null) {
            continue;
        }
        if (name === INDEX_FILE) {
            index = meta;
        } else if (path !== self && !meta.local) {
            sibs.set(path, meta);
        }
    }
    return { index, sibs };
}

/** underAnyRoot reports whether `dest` lies within any of the roots. */
export function underAnyRoot(dest: string, roots: string[]): boolean {
    return roots.some((root) => {
        const rel = posixRel(root, dest);
        return rel !== ".." && !rel.startsWith("../");
    });
}

/** rootOf returns the longest root `dest` lies within, or `""`. */
export function rootOf(dest: string, roots: string[]): string {
    let best = "";
    for (const root of roots) {
        const rel = posixRel(root, dest);
        if (rel === ".." || rel.startsWith("../")) {
            continue;
        }
        if (root.length > best.length) {
            best = root;
        }
    }
    return best;
}

/** CreatedFolder records a folder created during one create so a later failure can undo it. */
export interface CreatedFolder {
    dir: string;
    id: string;
}

/**
 * ensureFolders creates the ancestor folders a candidate depends on, top-down,
 * so its page has a real parent, and returns the parent the page attaches to.
 * `folderIds` is the run-scoped `dir → id` map: a folder already made this run is
 * reused, and each new folder is recorded there. A folder whose title collides
 * with an existing one in the space is reused when it sits under the intended
 * parent (reported in `reused`) and refused otherwise — folder titles are unique
 * per space. A new folder is restricted to the author like a page; any failure
 * rolls back the folders made in this call so no orphan chain survives, and the
 * roll back is joined into the thrown error.
 */
export async function ensureFolders(
    client: ConfluenceClient,
    input: CreateInput,
    accountId: string,
    folderIds: Map<string, string>,
): Promise<{ parent: string; created: CreatedFolder[]; reused: string[] }> {
    let parent = input.parentId;
    const created: CreatedFolder[] = [];
    const reused: string[] = [];

    for (const fol of input.folders) {
        const known = folderIds.get(fol.dir);
        if (known !== undefined) {
            parent = known;
            continue;
        }

        let id: string;
        try {
            id = await client.createFolder(input.spaceId, parent, fol.title);
        } catch (err) {
            if (err instanceof FolderTitleTakenError) {
                let existing: string;
                try {
                    existing = await client.childFolderTitled(
                        parent,
                        fol.title,
                    );
                } catch (lookErr) {
                    await rollbackFolders(client, folderIds, created);
                    throw new Error(`${message(err)}; ${message(lookErr)}`);
                }
                if (existing !== "") {
                    folderIds.set(fol.dir, existing);
                    reused.push(fol.title);
                    parent = existing;
                    continue;
                }
                await rollbackFolders(client, folderIds, created);
                throw new Error(
                    `folder "${fol.title}" already exists elsewhere in the ` +
                        "space; Confluence folder titles are unique per " +
                        `space, so rename ${fol.dir}`,
                );
            }
            await rollbackFolders(client, folderIds, created);
            throw err;
        }

        // A folder is world-visible until restricted, like a page; delete it and
        // unwind on failure so no unrestricted folder survives.
        try {
            await client.restrictToAuthor(id, accountId);
        } catch (err) {
            let joined = message(err);
            try {
                await client.deleteFolder(id);
            } catch (delErr) {
                joined = `${joined}; ${message(delErr)}`;
            }
            await rollbackFolders(client, folderIds, created);
            throw new Error(joined);
        }
        folderIds.set(fol.dir, id);
        created.push({ dir: fol.dir, id });
        parent = id;
    }
    return { parent, created, reused };
}

/**
 * rollbackFolders deletes the folders created during a failed create, in reverse
 * of their creation, and forgets their ids so a later page does not reuse a
 * deleted folder. A delete failure is dropped: the create already failed, and a
 * leftover empty folder is a lesser harm than masking the cause.
 */
export async function rollbackFolders(
    client: ConfluenceClient,
    folderIds: Map<string, string>,
    created: CreatedFolder[],
): Promise<void> {
    for (let i = created.length - 1; i >= 0; i--) {
        const c = created[i];
        if (c === undefined) {
            continue;
        }
        folderIds.delete(c.dir);
        try {
            await client.deleteFolder(c.id);
        } catch {
            // Dropped: see the doc comment.
        }
    }
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
