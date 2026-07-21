// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { describe, expect, it } from "vitest";

import {
    type RequestUrlFn,
    RequestUrlHttpClient,
} from "../../src/adapters/http.ts";

function response(
    overrides: Partial<RequestUrlResponse> = {},
): RequestUrlResponse {
    return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: null,
        text: "",
        ...overrides,
    };
}

describe("RequestUrlHttpClient", () => {
    it("passes method, headers, and forces throw:false", async () => {
        let captured: RequestUrlParam | undefined;
        const fake: RequestUrlFn = async (p) => {
            captured = p;
            return response();
        };
        await new RequestUrlHttpClient(fake).do({
            method: "GET",
            url: "https://ex/a",
            headers: { Authorization: "Basic z" },
        });
        expect(captured?.method).toBe("GET");
        expect(captured?.url).toBe("https://ex/a");
        expect(captured?.headers).toEqual({ Authorization: "Basic z" });
        expect(captured?.throw).toBe(false);
    });

    it("lower-cases response header keys and decodes the body", async () => {
        const bytes = new TextEncoder().encode("hi");
        const fake: RequestUrlFn = async () =>
            response({
                status: 201,
                headers: { "Content-Type": "application/json" },
                arrayBuffer: bytes.buffer as ArrayBuffer,
            });
        const resp = await new RequestUrlHttpClient(fake).do({
            method: "GET",
            url: "https://ex",
        });
        expect(resp.status).toBe(201);
        expect(resp.headers["content-type"]).toBe("application/json");
        expect(new TextDecoder().decode(resp.body)).toBe("hi");
    });

    it("returns a non-2xx response instead of throwing", async () => {
        const fake: RequestUrlFn = async () => response({ status: 401 });
        const resp = await new RequestUrlHttpClient(fake).do({
            method: "GET",
            url: "https://ex",
        });
        expect(resp.status).toBe(401);
    });
});
