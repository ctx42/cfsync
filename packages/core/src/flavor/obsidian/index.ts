// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Obsidian-native flavor: the dialect cfsync has shipped from day one,
// gathered behind the Flavor seam. Behavior is unchanged — render wraps
// marshallMapped and reconstruct wraps putLinks.

import { putLinks } from "../../adf/lens/reconstruct.ts";
import { marshallMapped } from "../../adf/lens/sourcemap.ts";
import type { Flavor } from "../flavor.ts";

export const obsidianFlavor: Flavor = {
    id: "obsidian",
    render: (adf, o) => marshallMapped(adf, o.assets, o.links, o.margin ?? 0),
    reconstruct: (adf, body, o) =>
        putLinks(
            adf,
            body,
            o.mentions,
            o.assets,
            o.images,
            o.links,
            o.force ?? false,
        ),
};
