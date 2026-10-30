import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
        anthropicMessagesApi,
        openAICompletionsApi,
        openAIResponsesApi,
        type Api,
        type Model,
        type SimpleStreamOptions,
        type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ProxiedProviderConfig, ProxyConfig, SubagentsConfig } from "../router/types.ts";
import { createSocksFetch, type FetchFunction } from "./socks-fetch.ts";

const API_FACTORIES = {
        "openai-completions": () => openAICompletionsApi(),
        "anthropic-messages": () => anthropicMessagesApi(),
        "openai-responses": () => openAIResponsesApi(),
} as const;

function fillModelDefaults(entry: ProxiedProviderConfig["models"][number], api: string) {
        return {
                type: "chat" as const,
                id: entry.id,
                name: entry.name ?? entry.id,
                api,
                reasoning: entry.reasoning ?? false,
                input: entry.input ?? (["text"] as Array<"text" | "image">),
                cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: entry.contextWindow ?? 128_000,
                maxTokens: entry.maxTokens ?? 16_384,
        };
}

/**
 * Register every entry of `config.providers` as a pi provider whose HTTP
 * traffic goes through its own SOCKS5 proxy.
 *
 * Mechanism: the legacy `registerProvider(name, { api, streamSimple })` form.
 * pi routes both stream and streamSimple calls for the provider's api through
 * our `streamSimple`, and we delegate to the built-in API implementation with
 * `{ ...options, fetch: socksFetch }` — the built-in implementations
 * (openai-completions / anthropic-messages / openai-responses) honor
 * `ProviderRequestOptions.fetch`. This preserves pi's message conversion,
 * tool handling, usage accounting, retries and compatibility behavior.
 */
export function registerProxiedProviders(pi: ExtensionAPI, config: SubagentsConfig): void {
        const providers = config.providers ?? {};
        const proxies = config.proxies ?? {};

        for (const [providerId, provider] of Object.entries(providers)) {
                const proxy: ProxyConfig | undefined = proxies[provider.proxy];
                if (!proxy) {
                        throw new Error(`pi-subagents: providers.${providerId}.proxy references unknown proxy "${provider.proxy}"`);
                }
                const api = provider.api ?? "openai-completions";
                const socksFetch = createSocksFetch(proxy);
                const models = provider.models.map((entry) => fillModelDefaults(entry, api));

                pi.registerProvider(providerId, {
                        name: providerId,
                        baseUrl: provider.baseUrl,
                        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
                        ...(provider.headers ? { headers: provider.headers } : {}),
                        api,
                        models,
                        streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
                                delegateStream(api, model, context, options, socksFetch, providerId),
                });
        }
}

/** Delegate to the built-in API implementation with the SOCKS5 fetch injected. */
function delegateStream(
        api: keyof typeof API_FACTORIES,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        socksFetch: FetchFunction,
        providerId: string,
) {
        const factory = API_FACTORIES[api];
        if (!factory) {
                throw new Error(
                        `pi-subagents: provider "${providerId}" uses api "${api}", for which SOCKS5 fetch injection is not implemented ` +
                                `(supported: openai-completions, anthropic-messages, openai-responses)`,
                );
        }
        const streamOptions: SimpleStreamOptions = { ...(options ?? {}), fetch: socksFetch };
        return factory().streamSimple(model, context, streamOptions);
}
