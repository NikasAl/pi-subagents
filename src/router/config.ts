import * as fs from "node:fs";
import path from "node:path";
import type { FailureClass, ProxiedProviderConfig, ProxyConfig, RoleFallbackConfig, SubagentsConfig } from "./types.ts";
import { parseModelRef } from "./types.ts";

export class ConfigError extends Error {}

/** Default config location inside the pi agent dir. */
export const CONFIG_FILE_NAME = "pi-subagents.json";
export const CONFIG_ENV_VAR = "PI_SUBAGENTS_CONFIG";

function isPlainObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, where: string): Record<string, unknown> {
        if (value === undefined) return {};
        if (!isPlainObject(value)) throw new ConfigError(`${where} must be an object`);
        return value;
}

function expectString(value: unknown, where: string): string {
        if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`${where} must be a non-empty string`);
        return value;
}

function expectOptionalString(value: unknown, where: string): string | undefined {
        if (value === undefined || value === null) return undefined;
        return expectString(value, where);
}

function expectModelRefList(value: unknown, where: string): string[] {
        if (!Array.isArray(value) || value.length === 0) throw new ConfigError(`${where} must be a non-empty array of "provider/id" strings`);
        const refs: string[] = [];
        for (const [i, entry] of value.entries()) {
                const ref = expectString(entry, `${where}[${i}]`);
                if (!parseModelRef(ref)) throw new ConfigError(`${where}[${i}] must look like "provider/id", got "${ref}"`);
                refs.push(ref);
        }
        return refs;
}

function parseRole(name: string, raw: unknown): RoleFallbackConfig {
        const where = `roles.${name}`;
        const obj = expectObject(raw, where);
        const role: RoleFallbackConfig = {
                models: expectModelRefList(obj.models, `${where}.models`),
        };
        if (obj.sticky !== undefined) {
                if (obj.sticky !== "turn" && obj.sticky !== "session") throw new ConfigError(`${where}.sticky must be "turn" or "session"`);
                role.sticky = obj.sticky;
        }
        if (obj.maxAttempts !== undefined) {
                if (typeof obj.maxAttempts !== "number" || !Number.isInteger(obj.maxAttempts) || obj.maxAttempts < 1)
                        throw new ConfigError(`${where}.maxAttempts must be a positive integer`);
                role.maxAttempts = obj.maxAttempts;
        }
        if (obj.timeoutMs !== undefined) {
                if (typeof obj.timeoutMs !== "number" || obj.timeoutMs < 1000) throw new ConfigError(`${where}.timeoutMs must be >= 1000`);
                role.timeoutMs = obj.timeoutMs;
        }
        const cwd = expectOptionalString(obj.cwd, `${where}.cwd`);
        if (cwd) role.cwd = cwd;
        const thinking = expectOptionalString(obj.thinking, `${where}.thinking`);
        if (thinking) role.thinking = thinking;
        return role;
}

function parseProxy(name: string, raw: unknown): ProxyConfig {
        const where = `proxies.${name}`;
        const obj = expectObject(raw, where);
        const port = obj.port;
        if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535)
                throw new ConfigError(`${where}.port must be an integer in 1..65535`);
        if (obj.type !== undefined && obj.type !== 5 && obj.type !== 4) throw new ConfigError(`${where}.type must be 4 or 5`);
        const proxy: ProxyConfig = {
                host: expectString(obj.host, `${where}.host`),
                port,
                type: 5,
        };
        const username = expectOptionalString(obj.username, `${where}.username`);
        if (username) proxy.username = username;
        const password = expectOptionalString(obj.password, `${where}.password`);
        if (password) proxy.password = password;
        return proxy;
}

const KNOWN_APIS = new Set(["openai-completions", "anthropic-messages", "openai-responses"]);

function parseProvider(name: string, raw: unknown): ProxiedProviderConfig {
        const where = `providers.${name}`;
        const obj = expectObject(raw, where);
        const proxy = expectString(obj.proxy, `${where}.proxy`);
        const baseUrl = expectString(obj.baseUrl, `${where}.baseUrl`);
        if (!/^https?:\/\//.test(baseUrl)) throw new ConfigError(`${where}.baseUrl must start with http:// or https://`);
        let api = "openai-completions";
        if (obj.api !== undefined && obj.api !== null) {
                api = expectString(obj.api, `${where}.api`);
                if (!KNOWN_APIS.has(api))
                        throw new ConfigError(`${where}.api must be one of: ${[...KNOWN_APIS].join(", ")} (SOCKS5 fetch injection is implemented for these)`);
        }
        const apiKey = expectOptionalString(obj.apiKey, `${where}.apiKey`);
        let headers: Record<string, string> | undefined;
        if (obj.headers !== undefined) {
                const rawHeaders = expectObject(obj.headers, `${where}.headers`);
                headers = Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k, expectString(v, `${where}.headers.${k}`)]));
        }
        if (!Array.isArray(obj.models) || obj.models.length === 0)
                throw new ConfigError(`${where}.models must be a non-empty array of model entries`);
        const models = obj.models.map((entry, i) => {
                const mObj = expectObject(entry, `${where}.models[${i}]`);
                const model: ProxiedProviderConfig["models"][number] = { id: expectString(mObj.id, `${where}.models[${i}].id`) };
                const modelName = expectOptionalString(mObj.name, `${where}.models[${i}].name`);
                if (modelName) model.name = modelName;
                if (mObj.reasoning !== undefined) {
                        if (typeof mObj.reasoning !== "boolean") throw new ConfigError(`${where}.models[${i}].reasoning must be boolean`);
                        model.reasoning = mObj.reasoning;
                }
                if (mObj.input !== undefined) {
                        if (!Array.isArray(mObj.input) || mObj.input.some((x) => x !== "text" && x !== "image"))
                                throw new ConfigError(`${where}.models[${i}].input must be an array of "text"/"image"`);
                        model.input = mObj.input as Array<"text" | "image">;
                }
                for (const field of ["contextWindow", "maxTokens"] as const) {
                        if (mObj[field] !== undefined) {
                                if (typeof mObj[field] !== "number" || mObj[field] <= 0) throw new ConfigError(`${where}.models[${i}].${field} must be a positive number`);
                                model[field] = mObj[field];
                        }
                }
                if (mObj.cost !== undefined) {
                        const c = expectObject(mObj.cost, `${where}.models[${i}].cost`);
                        const cost: { input: number; output: number; cacheRead: number; cacheWrite: number } = {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                        };
                        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
                                if (c[key] !== undefined) {
                                        if (typeof c[key] !== "number" || c[key] < 0) throw new ConfigError(`${where}.models[${i}].cost.${key} must be a non-negative number`);
                                        cost[key] = c[key];
                                }
                        }
                        model.cost = cost;
                }
                return model;
        });
        const provider: ProxiedProviderConfig = { proxy, baseUrl, api: api as ProxiedProviderConfig["api"], models };
        if (apiKey) provider.apiKey = apiKey;
        if (headers) provider.headers = headers;
        return provider;
}

/** Validate an already-parsed JSON document. Throws ConfigError with a precise message. */
export function parseConfig(document: unknown): SubagentsConfig {
        const root = expectObject(document, "config");
        const config: SubagentsConfig = {};

        if (root.roles !== undefined) {
                const rolesObj = expectObject(root.roles, "roles");
                config.roles = Object.fromEntries(Object.entries(rolesObj).map(([name, raw]) => [name, parseRole(name, raw)]));
        }
        if (root.proxies !== undefined) {
                const proxiesObj = expectObject(root.proxies, "proxies");
                config.proxies = Object.fromEntries(Object.entries(proxiesObj).map(([name, raw]) => [name, parseProxy(name, raw)]));
        }
        if (root.providers !== undefined) {
                const providersObj = expectObject(root.providers, "providers");
                config.providers = Object.fromEntries(Object.entries(providersObj).map(([name, raw]) => [name, parseProvider(name, raw)]));
                if (config.proxies) {
                        for (const [name, provider] of Object.entries(config.providers)) {
                                if (!config.proxies[provider.proxy]) {
                                        throw new ConfigError(`providers.${name}.proxy references unknown proxy "${provider.proxy}"`);
                                }
                        }
                } else {
                        throw new ConfigError(`config has providers but no proxies section`);
                }
        }
        if (root.defaults !== undefined) {
                const defaults = expectObject(root.defaults, "defaults");
                config.defaults = {};
                if (defaults.parallel !== undefined) {
                        if (typeof defaults.parallel !== "number" || !Number.isInteger(defaults.parallel) || defaults.parallel < 1)
                                throw new ConfigError("defaults.parallel must be a positive integer");
                        config.defaults.parallel = defaults.parallel;
                }
                if (defaults.cooldowns !== undefined) {
                        const cooldowns = expectObject(defaults.cooldowns, "defaults.cooldowns");
                        const parsed: Partial<Record<FailureClass, number>> = {};
                        for (const [key, value] of Object.entries(cooldowns)) {
                                if (typeof value !== "number" || value < 0) throw new ConfigError(`defaults.cooldowns.${key} must be a non-negative number`);
                                parsed[key as FailureClass] = value;
                        }
                        config.defaults.cooldowns = parsed;
                }
                if (defaults.recoverySuccesses !== undefined) {
                        if (typeof defaults.recoverySuccesses !== "number" || defaults.recoverySuccesses < 1)
                                throw new ConfigError("defaults.recoverySuccesses must be a positive integer");
                        config.defaults.recoverySuccesses = defaults.recoverySuccesses;
                }
                if (defaults.toolLog !== undefined) {
                        const value = defaults.toolLog;
                        if (typeof value !== "boolean" && typeof value !== "string")
                                throw new ConfigError('defaults.toolLog must be a boolean or a string ("on", "off", or a directory/*.jsonl file path)');
                        if (typeof value === "string" && value.trim() === "")
                                throw new ConfigError("defaults.toolLog must not be an empty string");
                        config.defaults.toolLog = value;
                }
                if (defaults.ctxLog !== undefined) {
                        const value = defaults.ctxLog;
                        if (typeof value !== "boolean" && typeof value !== "string")
                                throw new ConfigError('defaults.ctxLog must be a boolean or a string ("on", "off", or a directory/*.jsonl file path)');
                        if (typeof value === "string" && value.trim() === "")
                                throw new ConfigError("defaults.ctxLog must not be an empty string");
                        config.defaults.ctxLog = value;
                }
        }
        return config;
}

/** Resolve the config path: PI_SUBAGENTS_CONFIG overrides `<agentDir>/pi-subagents.json`. */
export function configPath(agentDir: string): string {
        return process.env[CONFIG_ENV_VAR]?.trim() || path.join(agentDir, CONFIG_FILE_NAME);
}

/**
 * Load and validate the config. Missing file is not an error: the extension
 * still loads (providers/roles simply absent) so pi stays usable; calling the
 * subagent tool without config produces a precise error instead.
 */
export function loadConfig(agentDir: string): { config: SubagentsConfig; path: string; missing: boolean } {
        const file = configPath(agentDir);
        let text: string;
        try {
                text = fs.readFileSync(file, "utf-8");
        } catch {
                return { config: {}, path: file, missing: true };
        }
        let document: unknown;
        try {
                document = JSON.parse(text);
        } catch (error) {
                throw new ConfigError(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { config: parseConfig(document), path: file, missing: false };
}
