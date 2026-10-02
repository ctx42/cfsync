// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    type DevicePointer,
    deviceKey,
    formatPointer,
    parsePointer,
    pointerPath,
} from "../../src/config/device.ts";

const POINTER: DevicePointer = {
    version: 1,
    device: "My-Laptop.local",
    vaultPath: "/home/me/vault",
    cacheDir: "/home/me/.cache/cfsync/vault-0123456789ab",
};

describe("deviceKey", () => {
    it("slugs a device name", () => {
        expect(deviceKey("My-Laptop.local")).toBe("my-laptop-local");
    });

    it("falls back when nothing is left", () => {
        expect(deviceKey("...")).toBe("device");
    });
});

describe("pointerPath", () => {
    it("joins the devices dir and the device key", () => {
        const have = pointerPath(".obsidian/plugins/cfsync", "My Laptop");
        expect(have).toBe(".obsidian/plugins/cfsync/devices/my-laptop.json");
    });
});

describe("parsePointer", () => {
    it("round-trips formatPointer", () => {
        expect(parsePointer(formatPointer(POINTER))).toEqual(POINTER);
    });

    it("drops unknown fields", () => {
        const text = JSON.stringify({ ...POINTER, extra: 1 });
        expect(parsePointer(text)).toEqual(POINTER);
    });

    it("refuses invalid JSON", () => {
        expect(() => parsePointer("{")).toThrow(/invalid JSON/);
    });

    it("refuses a non-object", () => {
        expect(() => parsePointer("[]")).toThrow(/not a JSON object/);
    });

    it("refuses an unknown version", () => {
        const text = JSON.stringify({ ...POINTER, version: 2 });
        expect(() => parsePointer(text)).toThrow(/unsupported version 2/);
    });

    it("refuses a missing field", () => {
        for (const key of ["device", "vaultPath", "cacheDir"]) {
            const text = JSON.stringify({ ...POINTER, [key]: "" });
            expect(() => parsePointer(text)).toThrow(`missing "${key}"`);
        }
    });
});
