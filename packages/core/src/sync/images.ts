// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Image upload, ported from the upload half of `pkg/cfsync/images.go`. On push,
// every user-added local image embedded on its own line (`![[file]]`) is uploaded
// as a new attachment so the lens can splice it in as a media node; each is
// recorded in the assets map (localId → path) for the refreshed frontmatter and,
// on failure, cleaned up so a rejected push leaves no orphan attachment. An image
// embedded inline in a paragraph cannot be uploaded (the lens cannot anchor an
// inline media node), so the push rejects it. Detection is re-baselined from Go's
// `![alt](path)` to the Obsidian `![[file]]` embed dialect; a resolved image is a
// bare-name embed next to the note.

import type { NewImage } from "../adf/lens/reconstruct.ts";
import type { ConfluenceClient } from "../confluence/client.ts";
import type { FileSystem } from "../ports/fs.ts";
import {
    isAbsPosix,
    posixBase,
    posixDir,
    posixExt,
    posixJoin,
} from "../util/path.ts";
import { imageExt, relPath } from "./assets.ts";

/** mintLocalId mints a fresh media-node localId; injected so tests stay deterministic. */
export type MintLocalId = () => string;

/** UploadedImage records one attachment uploaded on a push, for cleanup/canonicalize. */
export interface UploadedImage {
    /** v1 attachment content id, for deleting an orphan on failure. */
    contentId: string;
    /** minted media node localId. */
    localId: string;
    /** attachment fileId → media `attrs.id`. */
    fileId: string;
    /** absolute path of the user's local file. */
    src: string;
}

/** PendingImage is a user-added local image found in the edited body. */
interface PendingImage {
    /** the embed target as written (`![[target]]`). */
    target: string;
    /** the resolved on-disk file to upload. */
    abs: string;
}

/**
 * uploadNewImages uploads every user-added local image embedded on its own line
 * and returns the {@link NewImage} descriptors the lens splices in plus the
 * {@link UploadedImage} records for cleanup/canonicalize. It rejects an inline
 * image before uploading anything, and records each localId in `assets`. With no
 * new image it does no network I/O.
 */
export async function uploadNewImages(
    client: ConfluenceClient,
    fs: FileSystem,
    pageId: string,
    dest: string,
    body: string,
    assets: Record<string, string>,
    mint: MintLocalId,
): Promise<{ images: NewImage[]; uploaded: UploadedImage[] }> {
    const inline = await detectInlineNewImages(fs, body, assets, dest);
    if (inline[0] !== undefined) {
        throw new Error(
            `push: inline image "${inline[0]}" is not supported; put the ` +
                "image on its own line to upload it",
        );
    }
    const pending = await detectNewImages(fs, body, assets, dest);
    if (pending.length === 0) {
        return { images: [], uploaded: [] };
    }

    const images: NewImage[] = [];
    const uploaded: UploadedImage[] = [];
    for (const p of pending) {
        const bytes = await fs.read(p.abs);
        const { fileId, contentId } = await client.uploadAttachment(
            pageId,
            posixBase(p.abs),
            bytes,
        );
        // Record the attachment before minting the localId, so a mint that threw
        // still hands the caller its contentId to delete.
        const up: UploadedImage = {
            contentId,
            fileId,
            src: p.abs,
            localId: "",
        };
        uploaded.push(up);
        up.localId = mint();
        images.push({
            path: p.target,
            alt: p.target,
            fileId,
            localId: up.localId,
            collection: `contentId-${pageId}`,
        });
        assets[up.localId] = p.target;
    }
    return { images, uploaded };
}

/**
 * canonicalizeImages moves each uploaded image into `assetsDir` under the same
 * `{fileId}-{localId}{ext}` name a pull would write, then repoints its assets
 * entry at that path, so the refreshed Markdown matches a fresh pull and the next
 * pull reuses the file. Called only after a push succeeds.
 */
export async function canonicalizeImages(
    fs: FileSystem,
    uploaded: UploadedImage[],
    dest: string,
    assetsDir: string,
    assets: Record<string, string>,
): Promise<void> {
    for (const up of uploaded) {
        const path = posixJoin(
            assetsDir,
            canonicalAssetName(up.fileId, up.localId, up.src),
        );
        await moveFile(fs, up.src, path);
        assets[up.localId] = relPath(dest, path);
    }
}

/**
 * deleteAttachments best-effort removes the attachments uploaded for a push that
 * then failed, ignoring per-attachment errors: the push has already failed, and a
 * lingering attachment is a lesser fault than masking the original error.
 */
export async function deleteAttachments(
    client: ConfluenceClient,
    uploaded: UploadedImage[],
): Promise<void> {
    for (const up of uploaded) {
        if (up.contentId === "") {
            continue;
        }
        try {
            await client.deleteAttachment(up.contentId);
        } catch {
            // best-effort cleanup
        }
    }
}

/**
 * canonicalAssetName builds the on-disk name a pushed image must take so it
 * matches the name a later pull assigns, inferring the media type from the local
 * file's own extension so a server-normalized extension (`.jpeg` → `.jpg`)
 * canonicalizes the same on both paths.
 */
export function canonicalAssetName(
    fileId: string,
    localId: string,
    src: string,
): string {
    const ext = imageExt(mediaTypeByExt(posixExt(src)), posixBase(src));
    return `${fileId}-${localId}${ext}`;
}

/**
 * detectNewImages scans the body for lone-block `![[target]]` embeds whose target
 * is a local file not already tracked in `assets`, resolving each relative to the
 * note's directory. A URL, an already-tracked image (by base name — see
 * {@link isTracked}), or a target with no file on disk is skipped, and a target is
 * reported at most once.
 */
async function detectNewImages(
    fs: FileSystem,
    body: string,
    assets: Record<string, string>,
    dest: string,
): Promise<PendingImage[]> {
    const tracked = trackedNames(assets);
    const dir = posixDir(dest);
    const seen = new Set<string>();
    const out: PendingImage[] = [];
    for (const raw of body.split("\n")) {
        const m = /^!\[\[([^\]]+)\]\]$/.exec(raw.trim());
        if (m === null) {
            continue;
        }
        const target = embedTarget(m[1] ?? "");
        if (isURL(target) || isTracked(tracked, target) || seen.has(target)) {
            continue;
        }
        const abs = isAbsPosix(target) ? target : posixJoin(dir, target);
        if (!(await fs.exists(abs))) {
            continue;
        }
        seen.add(target);
        out.push({ target, abs });
    }
    return out;
}

/**
 * detectInlineNewImages reports the targets of user-added local images embedded
 * inline in a paragraph (not on their own line); such an image cannot be uploaded,
 * so the push rejects it. A lone-block embed, a URL, an already-tracked target, or
 * a target with no local file is not reported.
 */
async function detectInlineNewImages(
    fs: FileSystem,
    body: string,
    assets: Record<string, string>,
    dest: string,
): Promise<string[]> {
    const tracked = trackedNames(assets);
    const dir = posixDir(dest);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const ln of body.split("\n")) {
        if (/^!\[\[([^\]]+)\]\]$/.test(ln.trim())) {
            continue; // a lone-block embed: a candidate for upload, not inline
        }
        for (const m of ln.matchAll(/!\[\[([^\]]+)\]\]/g)) {
            const target = embedTarget(m[1] ?? "");
            if (
                isURL(target) ||
                isTracked(tracked, target) ||
                seen.has(target)
            ) {
                continue;
            }
            const abs = isAbsPosix(target) ? target : posixJoin(dir, target);
            if (!(await fs.exists(abs))) {
                continue;
            }
            seen.add(target);
            out.push(target);
        }
    }
    return out;
}

/** embedTarget strips a `|alias` from an embed's inner text. */
function embedTarget(inner: string): string {
    return inner.split("|")[0] ?? "";
}

/**
 * trackedNames is the set of base names of the images already tracked in assets.
 * A pulled image renders as `![[basename]]`, so an embed is matched against these
 * by base name (see {@link isTracked}).
 */
function trackedNames(assets: Record<string, string>): Set<string> {
    return new Set(Object.values(assets).map(posixBase));
}

/**
 * isTracked reports whether an embed `target` already refers to a tracked image,
 * comparing base names on BOTH sides: `trackedNames` holds base names, and a
 * path-qualified embed such as `![[sub/photo.png]]` of a pulled image must still
 * match its bare-name asset entry, or the push would re-upload it as a duplicate.
 *
 * The trade-off: a genuinely new `sub/photo.png` whose base name collides with a
 * tracked `photo.png` is treated as already-tracked and skipped. Base-name
 * matching is deliberate — the Obsidian embed dialect keys images by base name,
 * so within one note two distinct images sharing a base name is the ambiguous
 * case, and reusing the existing attachment is the least-surprising resolution.
 */
function isTracked(tracked: Set<string>, target: string): boolean {
    return tracked.has(posixBase(target));
}

/** isURL reports whether a target is an http(s) URL rather than a local file. */
function isURL(target: string): boolean {
    return target.startsWith("http://") || target.startsWith("https://");
}

/** moveFile moves a file through the filesystem port: copy then remove the source. */
async function moveFile(
    fs: FileSystem,
    src: string,
    dst: string,
): Promise<void> {
    await fs.write(dst, await fs.read(src));
    await fs.remove(src);
}

/** mediaTypeByExt maps a file extension to its image media type, or `""`. */
function mediaTypeByExt(ext: string): string {
    switch (ext.toLowerCase()) {
        case ".jpg":
        case ".jpeg":
        case ".jfif":
        case ".pjp":
        case ".pjpeg":
            return "image/jpeg";
        case ".png":
            return "image/png";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        case ".svg":
            return "image/svg+xml";
        case ".bmp":
            return "image/bmp";
        case ".tif":
        case ".tiff":
            return "image/tiff";
        default:
            return "";
    }
}
