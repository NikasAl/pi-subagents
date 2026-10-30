# Architecture decisions (why it is built this way)

This document records the decisions made during implementation and the evidence behind them.
Reference sources: pi 1.4.0 (`@earendil-works/pi-coding-agent@1.4.0`) docs and dist types.

## D1. Fallback routing lives in virtual models (`roles/<role>`), not in prompt text or provider config

- pi has **no declarative fallback lists** (checked `models.json` schema: `allowedFallbackModels` is Anthropic server-side refusal fallback only).
- pi **does** call a virtual model's `route()` before every request, including automatic agent-level retries, and hands `request.failed` (physical model + error message) to the router on `reason: "retry"` (docs/virtual-models.md; dist/core/model-runtime.js `resolveModel`).
- Agent-level retry (settings.json `retry.*`, default 3 attempts, exponential backoff) already covers the target failure classes (overloaded / rate limit / 5xx), so request-level failover needs zero custom retry machinery inside the child.
- Prompt-based routing ("ask the parent LLM to pick the next model") is nondeterministic, costs tokens and adds latency — rejected.

## D2. Two-level fallback (parent tool ↔ child router), one shared policy core

- Parallel children are separate processes; their in-child routers cannot share health state. Cross-child coordination must live in the orchestrator process (HealthTracker shared by all parallel spawns).
- The parent also needs to handle failures that never reach the LLM layer (spawn errors, timeouts, crash before first response) — that is process-level, hence respawn logic in the tool.
- Both levels use the same `src/router` core (FallbackRouter + HealthTracker + classifyFailure), which is pure TS with injected dependencies (`isConfigured`, clock) — unit-testable without pi.
- The parent propagates its knowledge to re-spawned children via `PI_SUBAGENTS_EXCLUDE` env (comma-separated `provider/id`), keeping the virtual-model router the single decision point inside a child.

## D3. Child context is fully determined by the role file

- Official example (`examples/extensions/subagent`) appends the role prompt to pi's default system prompt and leaves AGENTS.md/CLAUDE.md/skills enabled. That leaks project instructions into every executor — contradicting the "exact context" requirement.
- Here the child is spawned with `--system-prompt <role file body>` (replacement), `-nc --no-skills -ne -e <this extension>`. The child still loads `models.json`/`auth.json`/`settings.json` (providers, keys, retry policy) — that is required for the fallback mechanism to work.
- Project-level `.pi/agents` is deliberately not read (repo-controlled prompt injection surface); only user-level `~/.pi/agent/agents` plus the user's config.

## D4. SOCKS5 per provider via `ProviderRequestOptions.fetch` and delegation to built-in APIs

- pi has no SOCKS5 support. `ProviderRequestOptions.fetch` (pi-ai types.d.ts) is honored by the `openai-completions`, `anthropic-messages` and `openai-responses` implementations (verified in dist/api/*.js: `options?.fetch` reaches the HTTP client).
- The legacy provider form (`pi.registerProvider(name, { api, streamSimple })`) routes **all** streaming for that provider's api through the extension's `streamSimple` (dist/core/provider-composer.js `streamWith`), receiving the full options object — the injection point.
- The extension delegates to the built-in API implementation with `{ ...options, fetch: socksFetch }` (same pattern as pi's `custom-provider-gitlab-duo` example), preserving pi's message conversion, tool handling, usage accounting, retries and compat behavior. Copying a stream implementation was rejected as unsafe.
- One undici dispatcher (fetch-socks over `socks`) per proxy entry → per-provider tunnels, several providers may share one.

## D5. `route()` context capture

- In pi 1.4.0, `route(request)` is invoked with a **single argument** (dist/core/model-runtime.js: `virtual.route({...})`; `definition.route(request)`). The `route(request, ctx)` form shown in docs/examples receives `ctx === undefined` at runtime.
- Therefore the ModelRegistry is captured from the first available context (`session_start` handler, then tool/command contexts) and stored on the Runtime; routing before that throws a precise error (routing only happens once a session exists, so this is defensive).

## D6. What is intentionally out of scope

- Chain mode (scout→planner→worker as one tool call): the parent model composes the same flow with two tool calls, and the level-1 fallback/health logic is easier to keep correct for single/parallel. Can be added later without breaking config.
- Non-chat APIs (Google, Bedrock, WebSocket transports) for SOCKS5: fetch injection is verified only for the three APIs above; silently tunneling unknown transports would be worse than refusing.
- Persisting health across processes (a shared health file): cooldowns are process-local by design; the config-driven cooldowns plus env exclusion cover the cross-process case.
