// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Image-asset download, ported from the download half of `pkg/cfsync/assets.go`.
// A pull resolves every file-media reference in a page against the page's
// attachments and downloads each into the shared assets directory (under the sync
// root, so Obsidian `![[…]]` embeds resolve), returning a map from each media node
// localId to the image path relative to the note. Everything goes through the
// injected {@link ConfluenceClient} and {@link FileSystem} ports. Upload/canonical
// naming (`canonicalAssetName`) is the push side, M7.3.

import type { Attachment, ConfluenceClient } from "../confluence/client.ts";
import type { MediaRef } from "../models/adf.ts";
import type { FileSystem } from "../ports/fs.ts";
import { posixDir, posixExt, posixJoin, posixRel } from "../util/path.ts";

/**
 * assetsFromDisk reconstructs the {@link downloadImages} assets map — media node
 * localId → image path relative to `dest` — from the files already in
 * `assetsDir`, without any network I/O. A pull uses it on a version/cache hit
 * (the page body was served from the ADF cache, so its images were downloaded by
 * an earlier pull and are already on disk), skipping the attachment round-trip.
 *
 * It matches each ref to a file named `{fileId}-{localId}{ext}` — the name
 * {@link assetName} writes — by prefix, since the extension is derived from the
 * attachment's media type, which is not known here. It returns null (signalling
 * the caller to fall back to {@link downloadImages}) if ANY referenced image is
 * absent: a ref never resolved to an attachment, or a prior pull was interrupted
 * after the ADF was cached but before its images were downloaded. Returning the
 * whole map or nothing keeps the fallback all-or-nothing, so a partial map never
 * renders a page with some images missing.
 */
export async function assetsFromDisk(
    fs: FileSystem,
    assetsDir: string,
    dest: string,
    refs: MediaRef[],
): Promise<Record<string, string> | null> {
    if (refs.length === 0) {
        return {};
    }
    let entries: string[];
    try {
        entries = await fs.readdir(assetsDir);
    } catch {
        return null; // no assets dir yet: nothing on disk to reconstruct from
    }
    const assets: Record<string, string> = {};
    for (const ref of refs) {
        const prefix = `${ref.fileId}-${ref.localId}`;
        const name = entries.find(
            (e) => e === prefix || e.startsWith(`${prefix}.`),
        );
        if (name === undefined) {
            return null; // a referenced image is missing: fall back to a fetch
        }
        assets[ref.localId] = relPath(dest, posixJoin(assetsDir, name));
    }
    return assets;
}

/**
 * downloadImages resolves every file-media reference against the page's
 * attachments, downloads each matched image into `assetsDir`, and returns a map
 * from each media node localId to the image path relative to `dest`. A reference
 * with no matching attachment is skipped (it renders as a placeholder), and an
 * image already on disk is left in place.
 */
export async function downloadImages(
    client: ConfluenceClient,
    fs: FileSystem,
    assetsDir: string,
    pageId: string,
    dest: string,
    refs: MediaRef[],
): Promise<Record<string, string>> {
    if (refs.length === 0) {
        return {};
    }
    const atts = await client.fetchAttachments(pageId);
    const assets: Record<string, string> = {};
    for (const ref of refs) {
        const att = atts.get(ref.fileId);
        if (att === undefined) {
            continue;
        }
        const path = posixJoin(assetsDir, assetName(ref, att));
        await ensureAsset(client, fs, att.downloadLink, path);
        assets[ref.localId] = relPath(dest, path);
    }
    return assets;
}

/**
 * ensureAsset downloads the attachment at `downloadLink` to `path`, unless a file
 * is already present there.
 */
export async function ensureAsset(
    client: ConfluenceClient,
    fs: FileSystem,
    downloadLink: string,
    path: string,
): Promise<void> {
    if (await fs.exists(path)) {
        return;
    }
    await fs.write(path, await client.download(downloadLink));
}

/**
 * assetName builds the on-disk file name for a media reference,
 * `{fileId}-{localId}{ext}`, with the extension taken from the attachment's media
 * type. The localId makes the name unique per media node.
 */
export function assetName(ref: MediaRef, att: Attachment): string {
    return `${ref.fileId}-${ref.localId}${imageExt(att.mediaType, att.title)}`;
}

/**
 * imageExt returns the file extension for an image, preferring a known mapping
 * from its media type and falling back to the title's extension.
 */
export function imageExt(mediaType: string, title: string): string {
    switch (mediaType) {
        case "image/jpeg":
            return ".jpg";
        case "image/png":
            return ".png";
        case "image/gif":
            return ".gif";
        case "image/webp":
            return ".webp";
        case "image/svg+xml":
            return ".svg";
        case "image/bmp":
            return ".bmp";
        case "image/tiff":
            return ".tiff";
        default:
            return posixExt(title);
    }
}

/** relPath returns `target` relative to the directory of `dest`, for a Markdown link. */
export function relPath(dest: string, target: string): string {
    return posixRel(posixDir(dest), target);
}
