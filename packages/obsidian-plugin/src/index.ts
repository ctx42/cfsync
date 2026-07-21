// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

/**
 * `@cfsync/obsidian-plugin` is the desktop-first Obsidian plugin shell: it
 * wires the runtime-neutral {@link @cfsync/core} engine to Obsidian via
 * adapters (requestUrl, Vault), a settings tab, commands, and rendering.
 *
 * Placeholder for the M0.1 skeleton; the plugin lifecycle (`main.ts`) and its
 * esbuild → CommonJS bundle land in M0.2 and M8.
 */
import { PACKAGE_NAME as CORE } from "@cfsync/core";

export const CORE_PACKAGE = CORE;
