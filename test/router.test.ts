import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/router/errors.ts";
import { HealthTracker } from "../src/router/health.ts";
import { FallbackRouter, parseExcludeList } from "../src/router/router.ts";
import { parseModelRef, type ModelRef } from "../src/router/types.ts";

describe("parseModelRef", () => {
        it("splits on the first slash", () => {
                expect(parseModelRef("anthropic/claude-haiku-4-5")).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
        });

        it("allows gateway-style model ids containing slashes (xkiro etc.)", () => {
                expect(parseModelRef("xkiro/qwen/qwen3.7-max:free")).toEqual({ provider: "xkiro", id: "qwen/qwen3.7-max:free" });
        });

        it("rejects refs without a slash or with empty parts", () => {
                expect(parseModelRef("noslash")).toBeNull();
                expect(parseModelRef("/id")).toBeNull();
                expect(parseModelRef("prov/")).toBeNull();
                expect(parseModelRef("")).toBeNull();
        });
});

describe("FallbackRouter", () => {
        const models: ModelRef[] = ["a/m1", "b/m2", "c/m3"];

        it("returns the first candidate by default (priority order)", () => {
                const router = new FallbackRouter({ models });
                expect(router.pick()).toEqual({ ref: "a/m1", index: 0 });
        });

        it("skips unconfigured models (mock providers)", () => {
                const router = new FallbackRouter({ models, isConfigured: (ref) => ref !== "a/m1" });
                expect(router.pick()).toEqual({ ref: "b/m2", index: 1 });
        });

        it("skips unhealthy (cooldown) models", () => {
                const router = new FallbackRouter({ models, isHealthy: (ref) => ref !== "b/m2" });
                expect(router.pick({ exclude: ["a/m1"] })).toEqual({ ref: "c/m3", index: 2 });
        });

        it("skips excluded models and reports exhaustion as null", () => {
                const router = new FallbackRouter({ models });
                expect(router.pick({ exclude: ["a/m1", "b/m2", "c/m3"] })).toBeNull();
        });

        it("nextAfter starts strictly after the failed model", () => {
                const router = new FallbackRouter({ models });
                expect(router.nextAfter("a/m1")).toEqual({ ref: "b/m2", index: 1 });
                expect(router.nextAfter("b/m2", { exclude: ["c/m3"] })).toBeNull();
                expect(router.nextAfter("not-in-list")).toEqual({ ref: "a/m1", index: 0 });
        });

        it("ignores structurally invalid refs", () => {
                const router = new FallbackRouter({ models: ["bad", "a/m1"] });
                expect(router.pick()).toEqual({ ref: "a/m1", index: 1 });
                expect(router.validRefs()).toEqual(["a/m1"]);
        });
});

describe("HealthTracker", () => {
        it("starts healthy and applies class-based cooldowns", () => {
                let now = 1_000;
                const clock = { now: () => now };
                const health = new HealthTracker(clock, { cooldowns: { network: 30_000 } });
                expect(health.isHealthy("a/m1")).toBe(true);

                health.recordFailure("a/m1", "network", "ECONNREFUSED");
                expect(health.isHealthy("a/m1")).toBe(false);

                now += 29_999;
                expect(health.isHealthy("a/m1")).toBe(false);
                now += 1;
                expect(health.isHealthy("a/m1")).toBe(true);

                const state = health.state("a/m1");
                expect(state?.lastFailureClass).toBe("network");
                expect(state?.lastErrorMessage).toBe("ECONNREFUSED");
        });

        it("grows cooldown with consecutive failures (capped at x8)", () => {
                let now = 0;
                const clock = { now: () => now };
                const health = new HealthTracker(clock, { cooldowns: { overloaded: 10_000 } });
                health.recordFailure("a/m1", "overloaded");
                expect(health.state("a/m1")!.cooldownUntil).toBe(10_000); // x1
                health.recordFailure("a/m1", "overloaded");
                expect(health.state("a/m1")!.cooldownUntil).toBe(20_000); // x2
                now = 25_000;
                health.recordFailure("a/m1", "overloaded");
                expect(health.state("a/m1")!.cooldownUntil).toBe(65_000); // x4
                now = 65_000;
                for (let i = 0; i < 10; i++) health.recordFailure("a/m1", "overloaded");
                // capped at x8 → last increment 80_000 at most from now
                expect(health.state("a/m1")!.cooldownUntil).toBeLessThanOrEqual(now + 80_000);
        });

        it("recovers after consecutive successes", () => {
                const health = new HealthTracker({ now: () => 0 }, { cooldowns: { rate_limit: 60_000 }, recoverySuccesses: 2 });
                health.recordFailure("a/m1", "rate_limit");
                health.recordFailure("a/m1", "rate_limit");
                health.recordFailure("a/m1", "rate_limit");
                health.recordSuccess("a/m1");
                expect(health.state("a/m1")).toBeDefined(); // 3-2=1 failure left, but out of cooldown
                expect(health.isHealthy("a/m1")).toBe(true);
                health.recordSuccess("a/m1");
                expect(health.state("a/m1")).toBeUndefined(); // clean again
        });

        it("reset clears one or all models", () => {
                const health = new HealthTracker({ now: () => 0 });
                health.recordFailure("a/m1", "auth");
                health.recordFailure("b/m2", "auth");
                health.reset("a/m1");
                expect(health.isHealthy("a/m1")).toBe(true);
                expect(health.isHealthy("b/m2")).toBe(false);
                health.reset();
                expect(health.isHealthy("b/m2")).toBe(true);
        });
});

describe("classifyFailure", () => {
        it.each([
                ["429 Too Many Requests", "rate_limit"],
                ["rate limit exceeded", "rate_limit"],
                ["insufficient_quota: You exceeded your current quota", "quota"],
                ["500 Internal Server Error", "overloaded"],
                ["provider is overloaded", "overloaded"],
                ["connect ECONNREFUSED 127.0.0.1:9", "network"],
                ["fetch failed / ETIMEDOUT", "network"],
                ["401 invalid api key", "auth"],
                ["something strange", "unknown"],
        ])("%s → %s", (message, expected) => {
                expect(classifyFailure(message)).toBe(expected);
        });
});

describe("parseExcludeList", () => {
        it("parses comma-separated refs and ignores empties", () => {
                expect(parseExcludeList("a/m1, b/m2 ,,")).toEqual(new Set(["a/m1", "b/m2"]));
                expect(parseExcludeList(undefined)).toEqual(new Set());
        });
});
