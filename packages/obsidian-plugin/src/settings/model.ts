// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's settings model lives in core (`config/settings.ts`) because the
// CLI reads the same `data.json` inside a vault; re-exported here so the plugin's
// imports stay local.

export {
    buildPluginConfig,
    type cfsyncSettings,
    DEFAULT_SETTINGS,
} from "@cfsync/core";
