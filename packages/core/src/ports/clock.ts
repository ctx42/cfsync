// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Time as a port, ported from `ctx42/ring`'s `Clock`. Injecting the clock keeps
// rendering and cache timestamps deterministic under test. `Date` is a UTC
// instant, so callers format explicitly rather than relying on a local zone.

/** Returns the current instant. */
export type Clock = () => Date;
