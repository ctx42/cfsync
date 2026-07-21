// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The CLI's YAML adapter, backing the core {@link Yaml} port with Bun's built-in
// parser. `Bun.YAML` is part of the Bun runtime and is embedded by
// `bun build --compile`, so the shipped binary parses YAML with no third-party
// dependency. `Bun` is declared locally — the project types against @types/node,
// not bun-types, so this names only the one API used. Tests, which run under
// Vitest (Node, no `Bun`), inject a `yaml`-package parser instead.

import type { Yaml } from "@cfsync/core";

declare const Bun: { YAML: { parse(text: string): unknown } };

/** bunYaml backs the {@link Yaml} port with Bun's native YAML parser. */
export const bunYaml: Yaml = {
    parse: (text) => Bun.YAML.parse(text),
};
