// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Minimal ambient declarations for the WHATWG Encoding API. `TextEncoder` and
// `TextDecoder` are available in every runtime the core targets — browser,
// mobile webview, Node, Bun, Electron — but live in the DOM lib, which the core
// deliberately excludes to stay isomorphic. Declaring just these two keeps core
// DOM-free while letting it convert between bytes and UTF-8 text.

declare class TextEncoder {
    encode(input?: string): Uint8Array;
}

declare class TextDecoder {
    constructor(label?: string);
    decode(input?: Uint8Array): string;
}
