import type { ExtensionAPI, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Api, Model as AiModel } from "@earendil-works/pi-ai";
import { FallbackRouter } from "../router/router.ts";
import { classifyFailure } from "../router/errors.ts";
import { modelRef, type ModelRef } from "../router/types.ts";
import { VIRTUAL_PROVIDER, type EffectiveRole, type Runtime } from "./runtime.ts";

/** Router state persisted by pi on the session branch. */
interface RoleRouteState {
        /** Model refs excluded during the current run (failed requests). Reset on each new user turn. */
        excluded: ModelRef[];
}

/**
 * Register one virtual model per role under the `roles` provider.
 *
 * This is the request-level (level-2) fallback: pi calls route() before every
 * request of a session that selected `roles/<name>`, including automatic
 * retries (`reason: "retry"`), which carry the failed physical model in
 * `request.failed`. Switching models on retry is pi's documented mechanism
 * for exactly the down/quota/overload cases.
 */
export function registerRoleVirtualModels(pi: ExtensionAPI, runtime: Runtime): void {
        const roles = runtime.roles();
        for (const role of roles) {
                pi.registerVirtualModel({
                        provider: VIRTUAL_PROVIDER,
                        id: role.name,
                        name: `Role: ${role.name}`,
                        // Offer the full ladder; pi clamps to the routed physical model.
                        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
                        route(request: ModelRouteRequest<RoleRouteState>): ModelRoute<RoleRouteState> {
                                return routeRoleRequest(runtime, role, request);
                        },
                });
        }
}

function resolveModel(runtime: Runtime, ref: ModelRef): AiModel<Api> | undefined {
        const registry = runtime.modelRegistry;
        if (!registry) return undefined;
        const slash = ref.indexOf("/");
        if (slash <= 0) return undefined;
        return registry.find(ref.slice(0, slash), ref.slice(slash + 1));
}

export function routeRoleRequest(
        runtime: Runtime,
        role: EffectiveRole,
        request: ModelRouteRequest<RoleRouteState>,
): ModelRoute<RoleRouteState> {
        if (!runtime.modelRegistry) {
                throw new Error(`pi-subagents: role "${role.name}" cannot route yet: model registry is not available`);
        }

        // Health bookkeeping: the failing request's model goes into cooldown.
        if (request.reason === "retry" && request.failed) {
                const failedRef = modelRef(request.failed.model.provider, request.failed.model.id);
                if (role.models.includes(failedRef)) {
                        runtime.health.recordFailure(
                                failedRef,
                                classifyFailure(request.failed.message.errorMessage, request.failed.message.stopReason),
                                request.failed.message.errorMessage ?? undefined,
                        );
                }
        }

        const state: RoleRouteState = request.state ?? { excluded: [] };
        const router = new FallbackRouter({
                models: role.models,
                isConfigured: runtime.isConfigured,
                isHealthy: runtime.isHealthy,
        });

        const previousRef = request.previous ? modelRef(request.previous.model.provider, request.previous.model.id) : null;
        const sticky = (ref: ModelRef | null): ModelRoute<RoleRouteState> | null => {
                if (!ref) return null;
                if (state.excluded.includes(ref)) return null;
                if (!runtime.isHealthy(ref)) return null;
                const model = resolveModel(runtime, ref);
                if (!model) return null;
                return { model, thinkingLevel: request.thinkingLevel, state };
        };

        let pick: ReturnType<FallbackRouter["pick"]> = null;

        if (request.reason === "retry") {
                const exclude = new Set<ModelRef>([...state.excluded, ...runtime.envExcluded]);
                if (request.failed) exclude.add(modelRef(request.failed.model.provider, request.failed.model.id));
                pick = router.pick({ exclude });
                if (pick) {
                        const nextState: RoleRouteState = { excluded: [...state.excluded] };
                        if (request.failed) nextState.excluded.push(modelRef(request.failed.model.provider, request.failed.model.id));
                        const model = resolveModel(runtime, pick.ref);
                        if (!model) throw new Error(`pi-subagents: role "${role.name}": model ${pick.ref} is not in the catalog`);
                        return { model, thinkingLevel: request.thinkingLevel, state: nextState };
                }
                throw new Error(`pi-subagents: role "${role.name}" exhausted its model list (${role.models.join(" → ")})`);
        }

        if (request.reason === "user" && role.sticky === "session") {
                const kept = sticky(previousRef);
                if (kept) return kept;
        }

        if (request.reason === "continuation" || request.reason === "direct") {
                // Keep the model that answered last: preserves prompt cache and thinking signatures.
                const kept = sticky(previousRef);
                if (kept) return kept;
        }

        // Fresh pick (new user turn with sticky="turn", or no previous response).
        pick = router.pick({ exclude: runtime.envExcluded });
        if (!pick) {
                throw new Error(
                        `pi-subagents: role "${role.name}" has no usable model (configured list: ${role.models.join(" → ")}; check credentials/cooldowns)`,
                );
        }
        const model = resolveModel(runtime, pick.ref);
        if (!model) throw new Error(`pi-subagents: role "${role.name}": model ${pick.ref} is not in the catalog`);
        return { model, thinkingLevel: request.thinkingLevel, state: { excluded: [] } };
}
