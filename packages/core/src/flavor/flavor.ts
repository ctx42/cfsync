// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A Flavor is the pluggable ADF↔Markdown dialect: a matched render/reconstruct
// pair. The lens (diff, merge, sourcemap, cache, pull/push) is flavor-agnostic
// and calls the resolved flavor; a flavor's two halves must agree, because the
// push baseline is a re-render of the same flavor that produced the note.

import type { NewImage } from "../adf/lens/reconstruct.ts";
import type { SourceMap } from "../adf/lens/sourcemap.ts";
import type { Links } from "../adf/links.ts";
import type { ADF } from "../models/adf.ts";
import { obsidianFlavor } from "./obsidian/index.ts";

/** RenderOpts are the inputs a flavor needs to render ADF → Markdown. */
export interface RenderOpts {
    /** Resolved media: node localId → image path, relative to the note. */
    assets: Record<string, string>;
    /** Cross-page link resolver, or null to leave links untouched. */
    links: Links | null;
    /** Soft-wrap column; 0 or unset disables wrapping (the Obsidian default). */
    margin?: number;
}

/** ReconstructOpts are the inputs a flavor needs to back-port Markdown → ADF. */
export interface ReconstructOpts {
    mentions: Record<string, string> | null;
    assets: Record<string, string> | null;
    images: NewImage[] | null;
    links: Links | null;
    /** Re-derive every editable block from its Markdown even when unedited. */
    force?: boolean;
}

/**
 * Flavor is a pluggable Markdown dialect: the render half (ADF→MD, with the
 * sourcemap the lens diff needs) and the reconstruct half (MD→ADF, back-ported
 * onto the cached baseline). Adding a format means implementing a `Flavor` and
 * registering it — today, that means adding a `register(...)` call in this
 * module (see the bottom of this file); it is not yet a drop-in registration
 * a new flavor's own module can perform on its own, because that would
 * reintroduce the import cycle {@link register} exists to avoid.
 */
export interface Flavor {
    readonly id: string;
    render(adf: ADF, opts: RenderOpts): [string, SourceMap];
    reconstruct(adf: ADF, body: string, opts: ReconstructOpts): ADF;
}

/** DEFAULT_FLAVOR is the flavor used when config selects none. */
export const DEFAULT_FLAVOR = "obsidian";

const FLAVORS: Record<string, Flavor> = {};

/**
 * register adds a flavor to the registry; the id must be unique. Throws an
 * Error naming the id if a flavor is already registered under it, rather than
 * silently replacing it.
 */
export function register(flavor: Flavor): void {
    if (Object.hasOwn(FLAVORS, flavor.id)) {
        throw new Error(`flavor "${flavor.id}" is already registered`);
    }
    FLAVORS[flavor.id] = flavor;
}

/**
 * resolveFlavor returns the flavor for `id` (default `obsidian`), or throws an
 * Error naming the unknown id and listing the known ones.
 */
export function resolveFlavor(id: string = DEFAULT_FLAVOR): Flavor {
    const flavor = FLAVORS[id];
    if (flavor === undefined) {
        const known = Object.keys(FLAVORS).sort().join(", ");
        throw new Error(`unknown markdown flavor "${id}"; known: ${known}`);
    }
    return flavor;
}

/**
 * flavorIds returns the ids of every registered flavor, sorted. The Obsidian
 * plugin's settings tab uses it to populate the flavor dropdown from the
 * registry rather than hardcoding the known ids.
 */
export function flavorIds(): string[] {
    return Object.keys(FLAVORS).sort();
}

// Registration happens here, on this module's own load, rather than inside
// `obsidian/index.ts`. `obsidian/index.ts` only needs the `Flavor` type from
// this module (a type-only import, erased at compile time), so the value
// dependency runs one-way (flavor.ts → obsidian/index.ts) with no cycle back
// through `register` — a real cycle there would read `FLAVORS` before this
// module's own top-level code has run, throwing a TDZ error.
register(obsidianFlavor);

export { obsidianFlavor };
