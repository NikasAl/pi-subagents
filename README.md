# pi-subagents

Role-based subagents for [pi coding agent](https://github.com/earendil-works/pi) (1.4.0) with:

1. **Role executors** — each subagent solves exactly its own small task in an isolated pi child process (own context, own system prompt, own tool whitelist).
2. **Per-role model fallback** — each role gets a priority list of models from different providers; if one is down / rate-limited / overloaded, the request moves to the next one automatically.
3. **Per-provider SOCKS5** — any LLM provider can be routed through its own SOCKS5 tunnel (no global proxy).

Everything is transparent: the tool result reports which physical model executed the task, every fallback attempt, token usage, and the full child trace is persisted to the session (`pi.appendEntry`) — no black boxes.

```
┌─ parent pi session ─────────────────────────────────────────────┐
│  subagent tool (level-1 fallback: pick model, respawn, health)  │
│      │ spawns `pi --mode json -p --no-session -ne -e <entry>`   │
│      ▼                                                          │
│  child pi (isolated context, role system prompt, --tools)       │
│      roles/<role> virtual model (level-2 fallback:              │
│      route() per request + agent-level retry)                   │
│          │  ProviderRequestOptions.fetch = SOCKS5 dispatcher    │
│          ▼                                                      │
│      providers (openai-completions / anthropic-messages /       │
│      openai-responses), each optionally through its own proxy   │
└─────────────────────────────────────────────────────────────────┘
```

## Install

Requirements: Node.js >= 22.19, pi 1.4.0 (`npm i -g @earendil-works/pi-coding-agent`).

```bash
git clone https://github.com/NikasAl/pi-subagents.git
cd pi-subagents
npm install
```

Then either register as a pi package (recommended):

```bash
pi install /path/to/pi-subagents
# or, after pushing to GitHub:
pi install git:github.com/NikasAl/pi-subagents
```

or symlink manually:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-subagents
mkdir -p ~/.pi/agent/agents
ln -s "$(pwd)"/agents/*.md ~/.pi/agent/agents/
```

Verify: start `pi` interactively and run `/roles` (it prints roles, fallback lists and provider health).

Note: when running a session *on* a role (`pi --model roles/<name>`), use TUI mode or `--mode json` print mode. Plain `pi -p` resolves `--model` against the catalogue before extensions load, so virtual `roles/*` models are not visible there.

## Configuration

One file: `~/.pi/agent/pi-subagents.json` (override the location with the `PI_SUBAGENTS_CONFIG` env var). See [`examples/pi-subagents.json`](examples/pi-subagents.json) for a full annotated example.

```json
{
  "roles": {
    "scout": {
      "models": ["anthropic/claude-haiku-4-5", "my-openai-via-socks/gpt-5-mini", "google/gemini-2.5-flash"],
      "sticky": "turn",
      "maxAttempts": 2
    }
  },
  "proxies": {
    "main": { "host": "127.0.0.1", "port": 1080, "username": "$SOCKS_USER", "password": "$SOCKS_PASSWORD" }
  },
  "providers": {
    "my-openai-via-socks": {
      "proxy": "main",
      "api": "openai-completions",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "$OPENAI_API_KEY",
      "models": [
        { "id": "gpt-5-mini", "name": "GPT-5 Mini", "contextWindow": 400000, "maxTokens": 16384,
          "cost": { "input": 0.1, "output": 0.4, "cacheRead": 0.02, "cacheWrite": 0.1 } }
      ]
    }
  }
}
```

### Roles

- **Agent files** (recommended): `~/.pi/agent/agents/<role>.md` with frontmatter `name`, `description`, optional `tools` (comma-separated whitelist passed as `--tools` to the child), optional `model` (default single model). The file body is the role's **entire system prompt** (it replaces pi's default in the child — see [Transparency](#transparency)). See [`agents/`](agents/) for ready examples (`scout`, `planner`, `worker`, `reviewer`).
- **Fallback lists**: `roles.<name>.models` in the config — priority-ordered `provider/id` refs. Index 0 is primary. Model ids may themselves contain slashes (gateway-style ids, split on the first slash only, e.g. `xkiro/qwen/qwen3.7-max:free`). If a role has a config list, it overrides the agent file's single `model`. A role exists when it has an agent file **and/or** a config entry with models.
- **Knobs**: `sticky` (`"turn"` — return to the primary model on each new user turn; `"session"` — stay on the model that answered last), `maxAttempts` (level-1 respawns, default 2), `timeoutMs` (per spawn, default 600000), `cwd`, `thinking`.

### Model fallback: how it works

Two levels, sharing one policy core (`src/router/`):

| Level | Where | Mechanism | Handles |
|---|---|---|---|
| 2 — request-level | inside the child (`roles/<role>` virtual model, `route()`) | pi's virtual models + built-in agent-level retry (`settings.json` → `retry.*`, default 3 attempts with backoff). On `reason: "retry"` the router excludes the failed physical model and picks the next healthy candidate | provider down, 429/quota, 5xx/overloaded — mid-conversation, without losing the child's progress |
| 1 — process-level | orchestrator (the `subagent` tool in the parent) | health-aware pre-spawn pick + respawn with the next candidate if a child dies before producing output; failures are shared across parallel spawns via one HealthTracker, and re-spawned children receive `PI_SUBAGENTS_EXCLUDE` so they skip dead providers | child crash/timeout before any response; coordinates parallel tasks |

Failure classification drives cooldowns: `rate_limit` 60s, `quota` 15min, `overloaded` 20s, `network` 30s, `auth` 10min (configurable in `defaults.cooldowns`; repeated failures double the cooldown, capped ×8).

**Policy note (prompt cache):** switching models loses the provider prompt cache. The default `sticky: "turn"` returns to the primary model on each new user turn (best quality), while continuations and retries stay on the model that answered last (no cache loss within a run). Set `sticky: "session"` to stay on whatever model answered last until it breaks.

### SOCKS5 providers

pi 1.4.0 has no native SOCKS5. This package registers each `providers.<name>` entry as a pi provider whose `streamSimple` delegates to pi's **built-in** API implementations (`openai-completions`, `anthropic-messages`, `openai-responses`) with `ProviderRequestOptions.fetch` replaced by a SOCKS5-tunnelled fetch (`fetch-socks` over undici, one dispatcher per proxy). Message conversion, tool handling, usage accounting, retries and compatibility behavior stay pi's own.

Notes:
- each provider gets its own tunnel (`proxy` references a `proxies` entry); several providers may share one proxy;
- `apiKey`/header values support pi's interpolation: literal, `$ENV_NAME`, `${NAME}`, `!command`;
- other APIs (Google, Bedrock, ...) are not wired for fetch injection yet — see [Limitations](#limitations).

## Usage

In a pi session:

```
Use scout to find all authentication code
Run 2 workers in parallel: one for the cache module, one for the API routes
```

The model calls the `subagent` tool:

- **single**: `{ "role": "scout", "task": "..." }`
- **parallel**: `{ "tasks": [{ "role": "worker", "task": "..." }, ...] }` (max 8, concurrency 4)

`/roles` shows every role, its fallback ladder, per-model health (ok / cooldown / no credentials) and the SOCKS5 providers.

Result returned to the parent model (example):

```
[subagent role=tester] done
model: mock-via-socks/test-model · attempts: 1 · in 267 out 2 ctx 269 $0.0000
---
OK
```

On failure the trace lists every attempt with its classified error:

```
[subagent role=tester] FAILED
attempt 1: dead-socks/test-model → failed[network]: connect ECONNREFUSED 127.0.0.1:1 (exit 1, stop=error)
attempt 2: mock-via-socks/test-model → failed[rate_limit]: 429 too many requests (exit 1, stop=error)
```

## Transparency (no black boxes)

- **What the child sees**: exactly the role system prompt (`--system-prompt` replaces pi's default), the task as the user message, the whitelisted tools. The child is spawned with `-ne -e <this extension> -nc --no-skills` — no discovered extensions, no AGENTS.md/CLAUDE.md, no skills; config files (`models.json`, `auth.json`, `settings.json`) still load, which is what gives the child its providers/keys. Project-level `.pi/agents` is intentionally **not** loaded (only user-level roles).
- **What the parent sees**: the child's full JSONL event stream is parsed by the tool; the tool result includes the answering model, the attempt trace and usage; the same trace is persisted to the session as a `pi-subagents.trace` custom entry (not sent to the LLM).
- **Routing decisions**: virtual-model routing state (`excluded` list) is stored by pi on the session branch (`pi.virtual-model-state` entries) — inspectable in the session JSONL.

## Tests

```bash
npm test          # everything (unit + smoke)
npm run test:unit # unit only
npm run test:smoke# integration against a real pi
```

- **Unit** (`test/router.test.ts`, `test/health.test.ts`, `test/config.test.ts`): priority picks, exhaustion, cooldown math with an injectable clock, failure classification, config validation — all against mock providers, no keys.
- **SOCKS5** (`test/socks-fetch.test.ts`): a real minimal SOCKS5 server (RFC 1928: no-auth + username/password) started in-process; GET/POST/POST+JSON routed through the tunnel, failure surfacing, per-proxy dispatcher isolation.
- **Smoke against real pi** (`test/smoke.pi.test.ts`): a mock OpenAI-compatible SSE endpoint + local SOCKS5 server + temp agent dir + real `pi` processes.
  - A: `pi --model roles/tester` — the virtual model routes, the dead provider fails, the request lands on the live provider through the SOCKS5 tunnel; asserts the physical model that answered and that traffic really crossed the tunnel.
  - B: parent pi (mock LLM, also via SOCKS5) calls the `subagent` tool; the child's primary provider is dead; the child falls back to the live provider; the parent receives the trace and finishes.

## Limitations & risks

- **Prompt cache miss** on model switches (documented policy above; pi keeps continuations sticky automatically).
- **Double retry stacking**: agent-level retry (up to 3) inside the child and level-1 respawn (default 2) in the tool are both bounded, but a fully dead setup can take up to ~5 attempts before failing. Tune `retry.maxRetries` in `~/.pi/agent/settings.json` and `maxAttempts` per role.
- **Parallel children don't share in-child health** (each child is a separate process): level-1 tracking coordinates the parent side; inside a child the fallback ladder is discovered independently. Acceptable because in-child fallback happens at request level without respawns.
- **`route()` receives only `request` in 1.4.0** (the second `ctx` argument shown in pi's docs is not passed) — this package captures the `ModelRegistry` from the first session/tool/command context instead. Do not copy pi's doc example verbatim.
- **SOCKS5 fetch injection** is implemented for `openai-completions`, `anthropic-messages`, `openai-responses`. Providers on other APIs (Google, Bedrock, WebSocket transports) fall back to pi's default fetch (no tunnel).
- **Security**: extensions run inside pi with full user permissions; keep the config and this repo trusted. Role files from the project dir are not loaded; `apiKey` `!command` values execute at request time — treat the config file like a credentials file (`chmod 600` recommended).
- Examples in pi (`examples/extensions/subagent`) are a reference, not an API contract; this package depends only on exported pi APIs (`ExtensionAPI`, `getAgentDir`, `parseFrontmatter`, `ModelRegistry`) and pins `@earendil-works/pi-coding-agent@1.4.0`.

## Repo layout

```
src/
  index.ts               # extension entry: providers + virtual models + tool + /roles
  router/                # pure TS core (no pi imports): types, config, health, fallback
  socks/                 # SOCKS5 fetch + proxied provider registration
  subagents/             # child spawn/parse, runtime, virtual models, tool, rendering
agents/                  # example role files (scout, planner, worker, reviewer)
examples/                # annotated config
test/                    # unit + socks5 + real-pi smoke
scripts/                 # debug utilities
```

## License

MIT
