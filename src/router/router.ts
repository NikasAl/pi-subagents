import type { AvailabilityChecker, FallbackPick, ModelRef, PickOptions } from "./types.ts";
import { parseModelRef } from "./types.ts";

export interface FallbackRouterOptions {
	/** Priority-ordered model refs (index 0 = primary). */
	models: readonly ModelRef[];
	/** Returns true when a model can be used (provider has credentials). Injected by the host. */
	isConfigured?: AvailabilityChecker;
	/** Returns false while a model is in cooldown. Injected by the host. */
	isHealthy?: (ref: ModelRef) => boolean;
}

/**
 * Chooses the first usable model from a priority list.
 *
 * Pure and side-effect free: callers own health state and decide what to
 * exclude. This keeps the router unit-testable with mock providers and lets
 * both integration levels (virtual-model route() inside a child process and
 * the subagent tool in the orchestrator) share exactly the same policy.
 */
export class FallbackRouter {
	readonly models: readonly ModelRef[];
	private readonly isConfigured: AvailabilityChecker;
	private readonly isHealthy: (ref: ModelRef) => boolean;

	constructor(options: FallbackRouterOptions) {
		this.models = options.models;
		this.isConfigured = options.isConfigured ?? (() => true);
		this.isHealthy = options.isHealthy ?? (() => true);
	}

	/** First candidate that is valid, configured and healthy, and not excluded. */
	pick(options: PickOptions = {}): FallbackPick | null {
		const exclude = new Set(options.exclude ?? []);
		for (let index = 0; index < this.models.length; index++) {
			const ref = this.models[index]!;
			if (exclude.has(ref)) continue;
			if (!parseModelRef(ref)) continue;
			if (!this.isConfigured(ref)) continue;
			if (!this.isHealthy(ref)) continue;
			return { ref, index };
		}
		return null;
	}

	/** First candidate strictly after `afterRef` in priority order (used on retries). */
	nextAfter(afterRef: ModelRef, options: PickOptions = {}): FallbackPick | null {
		const startIndex = this.models.indexOf(afterRef);
		const exclude = new Set(options.exclude ?? []);
		for (let index = Math.max(startIndex, -1) + 1; index < this.models.length; index++) {
			const ref = this.models[index]!;
			if (exclude.has(ref)) continue;
			if (!parseModelRef(ref)) continue;
			if (!this.isConfigured(ref)) continue;
			if (!this.isHealthy(ref)) continue;
			return { ref, index };
		}
		return null;
	}

	/** All refs that are structurally valid (`provider/id`). */
	validRefs(): ModelRef[] {
		return this.models.filter((ref) => parseModelRef(ref) !== null);
	}
}

/** Parse a `PI_SUBAGENTS_EXCLUDE`-style list ("a/m1, b/m2") into a Set. */
export function parseExcludeList(raw: string | undefined | null): Set<ModelRef> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}
