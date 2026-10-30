import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/router/config.ts";

const VALID = {
        roles: {
                scout: { models: ["a/m1", "b/m2"], sticky: "turn", maxAttempts: 2, timeoutMs: 60_000 },
        },
        proxies: {
                main: { host: "127.0.0.1", port: 1080, username: "u", password: "p" },
        },
        providers: {
                "via-socks": {
                        proxy: "main",
                        api: "openai-completions",
                        baseUrl: "https://api.example.com/v1",
                        apiKey: "$KEY",
                        models: [{ id: "m1", contextWindow: 8000 }],
                },
        },
        defaults: { parallel: 3, cooldowns: { network: 5_000 }, recoverySuccesses: 3 },
};

describe("parseConfig", () => {
        it("accepts a valid document", () => {
                const config = parseConfig(VALID);
                expect(config.roles?.scout?.models).toEqual(["a/m1", "b/m2"]);
                expect(config.proxies?.main?.port).toBe(1080);
                expect(config.providers?.["via-socks"]?.models[0]?.contextWindow).toBe(8000);
                expect(config.defaults?.parallel).toBe(3);
        });

        it("accepts an empty object", () => {
                expect(parseConfig({})).toEqual({});
        });

        it("rejects malformed model refs", () => {
                expect(() => parseConfig({ roles: { r: { models: ["no-slash"] } } })).toThrow(ConfigError);
                expect(() => parseConfig({ roles: { r: { models: ["prov/"] } } })).toThrow(ConfigError);
                expect(() => parseConfig({ roles: { r: { models: ["/id"] } } })).toThrow(ConfigError);
                expect(() => parseConfig({ roles: { r: { models: [] } } })).toThrow(ConfigError);
        });

        it("accepts gateway-style model ids containing slashes", () => {
                expect(() => parseConfig({ roles: { r: { models: ["xkiro/qwen/qwen3.7-max:free"] } } })).not.toThrow();
        });

        it("rejects unknown provider api", () => {
                expect(() => parseConfig({ proxies: { p: { host: "h", port: 1 } }, providers: { x: { proxy: "p", api: "soap", baseUrl: "https://x", models: [{ id: "m" }] } } })).toThrow(
                        /api must be one of/,
                );
        });

        it("rejects provider referencing unknown proxy", () => {
                expect(() => parseConfig({ proxies: { other: { host: "h", port: 1 } }, providers: { x: { proxy: "main", baseUrl: "https://x", models: [{ id: "m" }] } } })).toThrow(
                        /unknown proxy "main"/,
                );
                expect(() => parseConfig({ providers: { x: { proxy: "p", baseUrl: "https://x", models: [{ id: "m" }] } } })).toThrow(/no proxies section/);
        });

        it("rejects bad proxy ports and hosts", () => {
                expect(() => parseConfig({ proxies: { p: { host: "h", port: 99_999 } } })).toThrow(/port/);
                expect(() => parseConfig({ proxies: { p: { host: "", port: 1080 } } })).toThrow(/host/);
        });

        it("rejects bad baseUrl and role knobs", () => {
                expect(() => parseConfig({ providers: { x: { proxy: "p", baseUrl: "ftp://x", models: [{ id: "m" }] } } })).toThrow(/baseUrl/);
                expect(() => parseConfig({ roles: { r: { models: ["a/b"], maxAttempts: 0 } } })).toThrow(/maxAttempts/);
                expect(() => parseConfig({ roles: { r: { models: ["a/b"], sticky: "sometimes" } } })).toThrow(/sticky/);
        });
});

describe("loadConfig", () => {
        it("returns missing=true when the file does not exist", () => {
                const result = loadConfig("/nonexistent-agent-dir");
                expect(result.missing).toBe(true);
                expect(result.config).toEqual({});
        });

        it("throws a precise error for invalid JSON", () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cfg-"));
                fs.writeFileSync(path.join(dir, "pi-subagents.json"), "{ not json");
                expect(() => loadConfig(dir)).toThrow(/invalid JSON/);
        });

        it("uses PI_SUBAGENTS_CONFIG override", () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cfg-"));
                const custom = path.join(dir, "custom.json");
                fs.writeFileSync(custom, JSON.stringify({ roles: { r: { models: ["a/b"] } } }));
                process.env.PI_SUBAGENTS_CONFIG = custom;
                try {
                        const result = loadConfig(dir);
                        expect(result.missing).toBe(false);
                        expect(result.config.roles?.r?.models).toEqual(["a/b"]);
                } finally {
                        delete process.env.PI_SUBAGENTS_CONFIG;
                }
        });
});
