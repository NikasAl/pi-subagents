/**
 * pi-subagents — role-based subagents for pi with per-role model fallback
 * routing and per-provider SOCKS5 proxies.
 *
 * Registers:
 *  - provider entries from `providers` (SOCKS5-tunnelled, see src/socks);
 *  - one virtual model per role under `roles/<name>` (request-level fallback,
 *    see src/subagents/virtual-models.ts);
 *  - the `subagent` tool (process-level fallback + isolated child sessions);
 *  - the `/roles` and `/ctx` commands for observability.
 *
 * Config: `<agentDir>/pi-subagents.json` (override with PI_SUBAGENTS_CONFIG).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProxiedProviders } from "./socks/provider.ts";
import { registerCtxCommand } from "./subagents/ctx-command.ts";
import { registerSubagentTool } from "./subagents/tool.ts";
import { registerRoleVirtualModels } from "./subagents/virtual-models.ts";
import { Runtime } from "./subagents/runtime.ts";

export default function (pi: ExtensionAPI): void {
	const runtime = new Runtime();

	// The ModelRegistry is only reachable through contexts; capture it as soon
	// as a session exists so virtual-model routing can resolve/verify models.
	pi.on("session_start", (_event, ctx) => {
		runtime.modelRegistry ??= ctx.modelRegistry;
	});

	// Invalid config must not take the whole pi session down: register nothing
	// and let the tool / /roles report the precise error instead.
	if (!runtime.configError && !runtime.configMissing) {
		try {
			registerProxiedProviders(pi, runtime.config);
		} catch (error) {
			console.error("[pi-subagents] provider registration failed:", error instanceof Error ? error.message : error);
		}
	}
	if (!runtime.configError) {
		try {
			registerRoleVirtualModels(pi, runtime);
		} catch (error) {
			console.error("[pi-subagents] virtual model registration failed:", error instanceof Error ? error.message : error);
		}
	}

	registerSubagentTool(pi, runtime);
	registerCtxCommand(pi);

	pi.registerCommand("roles", {
		description: "Show pi-subagents roles, model fallback lists and provider health",
		handler: async (_name, ctx) => {
			runtime.modelRegistry ??= ctx.modelRegistry;
			ctx.ui.notify(formatRolesReport(runtime), "info");
		},
	});
}

function formatRolesReport(runtime: Runtime): string {
	if (runtime.configError) return `pi-subagents: config error in ${runtime.configPath}\n${runtime.configError.message}`;
	if (runtime.configMissing) return `pi-subagents: no config found at ${runtime.configPath} (see README to get started)`;
	const roles = runtime.roles();
	if (roles.length === 0) return `pi-subagents: config loaded from ${runtime.configPath}, but no runnable roles (need agent files and/or roles.<name>.models)`;

	const lines: string[] = [`config: ${runtime.configPath}`];
	for (const role of roles) {
		lines.push(
			`\nrole ${role.name} [${role.source}]${role.filePath ? ` ${role.filePath}` : ""}`,
			`  fallback: ${role.models.map((ref, i) => `${i + 1}. ${ref}`).join("  ")}`,
			`  tools: ${role.tools?.join(", ") ?? "(pi defaults)"} · sticky: ${role.sticky} · spawn attempts: ${role.maxAttempts}`,
		);
		for (const ref of role.models) {
			const state = runtime.health.state(ref);
			const configured = runtime.isConfigured(ref);
			const status = !configured ? "no credentials" : runtime.health.isHealthy(ref) ? "ok" : `cooldown (${state?.lastFailureClass}) until ${new Date(state!.cooldownUntil).toISOString()}`;
			lines.push(`    ${ref}: ${status}`);
		}
	}
	const providers = Object.keys(runtime.config.providers ?? {});
	if (providers.length > 0) lines.push(`\nsocks5 providers: ${providers.join(", ")}`);
	return lines.join("\n");
}
