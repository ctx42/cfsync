// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's Clock adapter: the system clock. Injected into the core so cache
// timestamps and the progress reporter read time through a port rather than a
// global, keeping the core testable and runtime-neutral.

import type { Clock } from "@cfsync/core";

/** nodeClock returns the current instant from the system clock. */
export const nodeClock: Clock = () => new Date();
