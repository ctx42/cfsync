// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from `pkg/adf/links.go`. `Links` translates page links between a
// Confluence document and its local Markdown rendering for one document at a
// known location. It is supplied by the caller so the adf renderer stays
// ignorant of how pages map to local files.

/** A resolved local link: where it points and the label to show for it. */
export interface LocalLink {
    /** The local Markdown link target. */
    target: string;
    /**
     * The label to show. Used only when an `inlineCard` (which carries no text
     * of its own) is rewritten into `[label](target)`; a text link keeps its
     * existing label.
     */
    label: string;
}

/**
 * Links maps page links each way for a pull/push round trip. On render,
 * {@link Links.toLocal} turns a Confluence href into a local target; on
 * reconstruct, {@link Links.toRemote} turns a local target back into the href to
 * push. The two are inverses for a link that survives the round trip, so an
 * unedited document re-renders unchanged. A `null` `Links` leaves every link
 * untouched.
 */
export interface Links {
    /**
     * Map a Confluence href to a local Markdown target and label, or `undefined`
     * to leave the link unchanged (Go's `ok == false`).
     */
    toLocal(href: string): LocalLink | undefined;

    /**
     * Map a local Markdown target back to the Confluence href to push, or
     * `undefined` to leave the target unchanged.
     */
    toRemote(target: string): string | undefined;
}

/**
 * localLink returns the local target for a Confluence href, or the href
 * unchanged when `links` is null or does not map it.
 */
export function localLink(links: Links | null, href: string): string {
    return links?.toLocal(href)?.target ?? href;
}

/**
 * remoteLink returns the Confluence href for a local target, or the target
 * unchanged when `links` is null or does not map it.
 */
export function remoteLink(links: Links | null, target: string): string {
    return links?.toRemote(target) ?? target;
}
