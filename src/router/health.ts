import type { FailureClass, HealthClock, HealthState, ModelRef } from "./types.ts";
import { DEFAULT_POLICY, type FallbackPolicy } from "./types.ts";

/** Partial policy overrides accepted by HealthTracker/Runtime. */
export type PolicyOverrides = {
        cooldowns?: Partial<Record<FailureClass, number>>;
        recoverySuccesses?: number;
};

/**
 * Tracks per-model failures with class-based cooldowns.
 *
 * The tracker is deliberately plain: it stores state in memory, uses an
 * injectable clock (for tests) and never throws. It is shared by all subagent
 * spawns of one process, which is what gives parallel children a common view
 * of provider health (level-1 fallback coordination).
 */
export class HealthTracker {
        private readonly states = new Map<ModelRef, HealthState>();
        private readonly clock: HealthClock;
        private readonly policy: FallbackPolicy;

        constructor(clock: HealthClock = { now: () => Date.now() }, overrides: PolicyOverrides = {}) {
                this.clock = clock;
                this.policy = {
                        ...DEFAULT_POLICY,
                        recoverySuccesses: overrides.recoverySuccesses ?? DEFAULT_POLICY.recoverySuccesses,
                        cooldowns: { ...DEFAULT_POLICY.cooldowns, ...overrides.cooldowns },
                };
        }

        state(ref: ModelRef): HealthState | undefined {
                return this.states.get(ref);
        }

        isHealthy(ref: ModelRef): boolean {
                const state = this.states.get(ref);
                if (!state) return true;
                return this.clock.now() >= state.cooldownUntil;
        }

        /** Record a failure; applies cooldown for the failure class (exponential in consecutive failures, capped). */
        recordFailure(ref: ModelRef, failureClass: FailureClass, errorMessage?: string): void {
                const now = this.clock.now();
                const prev = this.states.get(ref);
                const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
                const base = this.policy.cooldowns[failureClass] ?? DEFAULT_POLICY.cooldowns.unknown;
                // Grow cooldown with repeated failures: x2 per consecutive failure, capped at x8.
                const factor = Math.min(2 ** (consecutiveFailures - 1), 8);
                const cooldownUntil = now + base * factor;
                this.states.set(ref, {
                        consecutiveFailures,
                        cooldownUntil,
                        lastFailureAt: now,
                        lastFailureClass: failureClass,
                        lastErrorMessage: errorMessage?.slice(0, 500) ?? null,
                });
        }

        /** Record a success; a model recovers after `recoverySuccesses` consecutive successes. */
        recordSuccess(ref: ModelRef): void {
                const prev = this.states.get(ref);
                if (!prev) return; // never failed: nothing to track
                const consecutiveFailures = Math.max(0, prev.consecutiveFailures - this.policy.recoverySuccesses);
                if (consecutiveFailures === 0) {
                        this.states.delete(ref);
                } else {
                        this.states.set(ref, { ...prev, consecutiveFailures, cooldownUntil: 0 });
                }
        }

        /** Reset one model (e.g. after a manual config change). */
        reset(ref?: ModelRef): void {
                if (ref) this.states.delete(ref);
                else this.states.clear();
        }

        /** Serializable snapshot for /roles and debugging. */
        snapshot(): Record<ModelRef, HealthState> {
                return Object.fromEntries(this.states);
        }
}
