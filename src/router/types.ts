/**
 * Core types shared by the fallback router, health tracker and config loader.
 *
 * This module is intentionally free of pi imports so the routing logic can be
 * unit-tested (and reused) without a running pi installation.
 */

/** A physical model reference in `provider/id` form, e.g. `anthropic/claude-haiku-4-5`. */
export type ModelRef = string;

export function parseModelRef(ref: string): { provider: string; id: string } | null {
        const slash = ref.indexOf("/");
        if (slash <= 0 || slash === ref.length - 1) return null;
        const provider = ref.slice(0, slash);
        const id = ref.slice(slash + 1);
        // Provider names cannot contain a slash; model ids MAY (e.g. xkiro-style
        // gateway ids like "qwen/qwen3.7-max:free").
        if (provider.includes("/")) return null;
        return { provider, id };
}

export function modelRef(provider: string, id: string): ModelRef {
        return `${provider}/${id}`;
}

/** Why a model failed; drives cooldown duration. */
export type FailureClass =
        | "rate_limit" // 429 / rate limit / peak hours: back off, retry soon
        | "quota" // quota exhausted / billing: back off for a long time
        | "overloaded" // 5xx / overloaded: transient, retry quickly
        | "network" // DNS / connect / timeout: provider or link down
        | "auth" // 401 / 403: key invalid; pointless to retry until changed
        | "unknown";

/** Per-model health used by the router to skip currently-broken candidates. */
export interface HealthState {
        consecutiveFailures: number;
        /** Epoch ms until which the model is in cooldown (0 = healthy). */
        cooldownUntil: number;
        lastFailureAt: number;
        lastFailureClass: FailureClass | null;
        lastErrorMessage: string | null;
}

export interface HealthClock {
        now(): number;
}

/** Availability predicate injected by the host (pi) adapter. */
export type AvailabilityChecker = (ref: ModelRef) => boolean;

export interface FallbackPick {
        ref: ModelRef;
        index: number;
}

export interface PickOptions {
        /** Model refs that must not be returned (failed earlier, excluded by env, ...). */
        exclude?: Iterable<ModelRef>;
}

/** Fallback policy knobs (all optional; see DEFAULT_POLICY). */
export interface FallbackPolicy {
        /** Cooldown per failure class, ms. */
        cooldowns: Record<FailureClass, number>;
        /** After N consecutive successes a model is considered fully healthy again. */
        recoverySuccesses: number;
}

export type RoleSticky = "turn" | "session";

/** One role: a named executor with its prioritized model fallback list. */
export interface RoleFallbackConfig {
        /** Priority-ordered model refs. Index 0 is primary. */
        models: ModelRef[];
        /** How the router treats a new user turn: return to primary ("turn") or stay ("session"). Default "turn". */
        sticky?: RoleSticky;
        /** Max process-level spawn attempts by the subagent tool (level 1). Default 2. */
        maxAttempts?: number;
        /** Per-spawn timeout in ms (SIGTERM, then SIGKILL). Default 600000. */
        timeoutMs?: number;
        /** Optional working directory override for this role. */
        cwd?: string;
        /** Optional thinking level passed to the child (`--thinking`). */
        thinking?: string;
}

export interface ProxyConfig {
        /** Proxy host. */
        host: string;
        /** Proxy port. */
        port: number;
        /** SOCKS version; only 5 is supported. Default 5. */
        type?: 4 | 5;
        /** Optional username for user/password auth. */
        username?: string;
        /** Optional password for user/password auth. */
        password?: string;
}

export type ProviderApi = "openai-completions" | "anthropic-messages" | "openai-responses";

/** Model entry inside a proxied provider; unknown fields get safe defaults. */
export interface ProviderModelConfig {
        id: string;
        name?: string;
        reasoning?: boolean;
        input?: Array<"text" | "image">;
        contextWindow?: number;
        maxTokens?: number;
        cost?: {
                input: number;
                output: number;
                cacheRead: number;
                cacheWrite: number;
        };
}

/** An LLM provider whose HTTP traffic must go through a SOCKS5 proxy. */
export interface ProxiedProviderConfig {
        /** Proxy name from `proxies`. Required. */
        proxy: string;
        /** Wire protocol. Default "openai-completions". */
        api?: ProviderApi;
        /** API base URL, e.g. https://api.openai.com/v1. */
        baseUrl: string;
        /** Literal key, `$ENV_NAME` or `!command` (pi interpolation). */
        apiKey?: string;
        /** Extra headers; values support the same interpolation as apiKey. */
        headers?: Record<string, string>;
        /** Chat models exposed by this provider. */
        models: ProviderModelConfig[];
}

export interface SubagentsConfig {
        roles?: Record<string, RoleFallbackConfig>;
        proxies?: Record<string, ProxyConfig>;
        providers?: Record<string, ProxiedProviderConfig>;
        defaults?: {
                /** Max parallel child processes for the tool's parallel mode. Default 4. */
                parallel?: number;
                /** Cooldown overrides per failure class. */
                cooldowns?: Partial<Record<FailureClass, number>>;
                /** Consecutive successes required to clear a model's failure state. */
                recoverySuccesses?: number;
        };
}

export const DEFAULT_POLICY: FallbackPolicy = {
        cooldowns: {
                rate_limit: 60_000,
                quota: 15 * 60_000,
                overloaded: 20_000,
                network: 30_000,
                auth: 10 * 60_000,
                unknown: 30_000,
        },
        recoverySuccesses: 2,
};
