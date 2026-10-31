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

### Verbose tool-call logging (debugging)

When a subagent "thinks forever" or seems stuck, enable verbose logging to see exactly what it is doing — every child tool call (name, arguments, full result or error) — written incrementally to a JSONL file you can `tail -f` while the child runs. **Off by default**; enabling does not change any other behavior.

Three switches (first match wins):

1. **Tool parameter** — the model can pass `verboseLog: true` for one call:
   `{ "role": "scout", "task": "...", "verboseLog": true }`
2. **Env var** — `PI_SUBAGENTS_TOOLLOG=on` (or `off`, or a path) for a whole pi session.
3. **Config** — `"defaults": { "toolLog": true }` in `pi-subagents.json` (or `"on"`/`"off"`, or a path).

The value is a boolean, `on`/`off`, or a path. A path ending in `.jsonl`/`.log` is used as the exact output file (runs append); any other path is a directory holding one file per attempt. Default directory: `~/.pi/agent/pi-subagents/toollogs/`, file name `<timestamp>-<role>-attempt<N>.jsonl`.

The log never enters the parent's model context: the tool result only gets one short pointer line (`tool log: <path>`), and the `pi-subagents.trace` session entry stores the paths too — `pi.appendEntry()` entries are documented by pi as *durable data excluded from model context*. Files are created with `0600` permissions and may contain tool output/secrets — don't commit them.

Example file (one JSON object per line):

```jsonl
{"type":"run_start","ts":"...","role":"tester","attempt":1,"model":"dead-socks/test-model","task":"...","cwd":"...","pid":123}
{"type":"assistant","ts":"...","provider":"dead-socks","stopReason":"error","errorMessage":"Connection error.","toolCalls":[],"textLength":0}
{"type":"assistant","ts":"...","provider":"mock-via-socks","stopReason":"toolUse","toolCalls":[{"id":"call_1","name":"bash","arguments":{"command":"echo hi"}}],"textLength":0}
{"type":"tool_call_start","ts":"...","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"}}
{"type":"tool_update","ts":"...","toolCallId":"call_1","toolName":"bash","partialTextLength":17}
{"type":"tool_result_end","ts":"...","toolCallId":"call_1","toolName":"bash","isError":false,"durationMs":6,"result":{"content":[{"type":"text","text":"hi\n"}]}}
{"type":"assistant","ts":"...","provider":"mock-via-socks","stopReason":"stop","textLength":10}
{"type":"run_end","ts":"...","exitCode":0,"timedOut":false,"aborted":false,"durationMs":900,"toolCallCount":1}
```

`run_start` records the planned model of the attempt; the `assistant` lines show the physical provider/model that actually answered — so level-2 fallback inside the child is visible in one file. Long-running tools emit slim `tool_update` markers (text length only) so a hanging child is distinguishable from a busy one.

### Per-run context report ("what fills the subagent's context")

While a subagent runs, its fresh input is dominated by re-reading growing history (cacheRead) and ever-larger tool results. The context report makes that visible **while it happens**, not after: the parent watches the child's stream and, per assistant message ("turn"), records provider-reported fresh `input`, `cacheRead`, `cacheWrite`, `output` and the estimated context size (`input + cacheRead + cacheWrite`), plus where the space goes (token estimate = serialized chars / 4 — rough by design, what matters is the dynamics and the top offenders): role system prompt, task, assistant text, tool-call args and tool results per tool.

Switches (first match wins; otherwise the report follows the tool-log switch, so `verboseLog: true` produces both files; default OFF):

1. **Env var** — `PI_SUBAGENTS_CTXLOG=on` (or `off`, or a path).
2. **Config** — `"defaults": { "ctxLog": true }` in `pi-subagents.json` (or `"on"`/`"off"`, or a path).
3. **Inherited** — on iff the tool-log switch is on (`verboseLog` param / `PI_SUBAGENTS_TOOLLOG` / `defaults.toolLog`).

A path ending in `.jsonl`/`.log` is the exact output file; any other path is a directory with one file per attempt. Default directory: `~/.pi/agent/pi-subagents/ctxlogs/` (when inherited from a directory toollog target, the report is written next to the tool log — one debug folder per session). File name: `<timestamp>-<role>-attempt<N>.ctx.jsonl`, created `0600`, appended incrementally — `tail -f` it while the child runs.

The file never enters the parent's model context: the tool result only gets a pointer line (`context report: <path>`), and the trace entry stores the path too. Unlike the tool log it contains **only numbers** (sizes), never tool result bodies; the task text appears only as an 80-char preview.

The last line of the file is the compact report:

```jsonl
{"type":"report","schema":"pi-subagents.ctx-report/1","role":"tester","attempt":1,"model":"dead-socks/test-model",
 "outcome":{"exitCode":0,"timedOut":false,"aborted":false,"stopReason":"stop","errorMessage":null,"durationMs":900},
 "estimator":"chars/4",
 "turns":[{"turn":1,"input":100,"cacheRead":900,"cacheWrite":50,"output":20,"totalTokens":1070,"cost":0.01,"contextEstimate":1050,"textTokens":0,"toolCallArgsTokens":0},
          {"turn":2,"input":150,"cacheRead":2000,"cacheWrite":0,"output":30,"totalTokens":2180,"cost":0.02,"contextEstimate":2150,"textTokens":2,"toolCallArgsTokens":0}],
 "totals":{"input":250,"output":50,"cacheRead":2900,"cacheWrite":50,"totalTokens":3250,"cost":0.03,"requests":2,"maxContextEstimate":2150,"lastContextEstimate":2150},
 "budget":{"systemPromptTokens":85,"taskTokens":11,"assistantTextTokens":2,"toolCallArgsTokens":11,"toolResultTokens":10033},
 "items":[{"kind":"tool-results","name":"read","tokens":10022,"share":98.5,"calls":1,"errors":0},
          {"kind":"system-prompt","name":"scout","tokens":85,"share":0.8},
          {"kind":"task","name":"user task","tokens":11,"share":0.4},
          {"kind":"tool-args","name":"all tool calls","tokens":11,"share":0.1},
          {"kind":"tool-results","name":"bash","tokens":11,"share":0.1,"calls":1,"errors":0},
          {"kind":"assistant-text","name":"assistant messages","tokens":2,"share":0}],
 "top":[{"kind":"tool-results","name":"read","tokens":10022,"share":98.5,"calls":1,"errors":0}, "..."]}
```

Earlier lines are the live trail: `run_start`, one `turn_usage` per assistant message, one `tool_result` (size only) per executed tool call.

### /ctx — what fills the parent session's context

`/ctx` (TUI/RPC) shows the same view for the **current parent session**: per-turn fresh input / cacheRead / cacheWrite / output and estimated context size for the last 20 turns (plus the peak of earlier ones), totals and cost, and the top consumers of the current context — system prompt, user messages, assistant text + tool-call args, tool results per tool (chars/4 estimate). Rendered via `ctx.ui.notify` — shown to you, never sent to the model.

## Transparency (no black boxes)

- **What the child sees**: exactly the role system prompt (`--system-prompt` replaces pi's default), the task as the user message, the whitelisted tools. The child is spawned with `-ne -e <this extension> -nc --no-skills` — no discovered extensions, no AGENTS.md/CLAUDE.md, no skills; config files (`models.json`, `auth.json`, `settings.json`) still load, which is what gives the child its providers/keys. Project-level `.pi/agents` is intentionally **not** loaded (only user-level roles).
- **What the parent sees**: the child's full JSONL event stream is parsed by the tool; the tool result includes the answering model, the attempt trace and usage; the same trace is persisted to the session as a `pi-subagents.trace` custom entry (not sent to the LLM). With `verboseLog` (see above) the full tool-call trail goes to a JSONL file, and only its path reaches the result text.
- **Routing decisions**: virtual-model routing state (`excluded` list) is stored by pi on the session branch (`pi.virtual-model-state` entries) — inspectable in the session JSONL.

## Tests

```bash
npm test          # everything (unit + smoke)
npm run test:unit # unit only
npm run test:smoke# integration against a real pi
```

- **Unit** (`test/router.test.ts`, `test/health.test.ts`, `test/config.test.ts`, `test/toollog.test.ts`, `test/ctxlog.test.ts`): priority picks, exhaustion, cooldown math with an injectable clock, failure classification, config validation, tool-log setting precedence, per-attempt log files written from a fake child JSONL stream (content, truncation, default-off, no-leak), ctx-report aggregation from a fake child stream with preset usage (turn rows, totals, budget decomposition, top items, numbers-only file) — all against mock providers, no keys.
- **SOCKS5** (`test/socks-fetch.test.ts`): a real minimal SOCKS5 server (RFC 1928: no-auth + username/password) started in-process; GET/POST/POST+JSON routed through the tunnel, failure surfacing, per-proxy dispatcher isolation.
- **Smoke against real pi** (`test/smoke.pi.test.ts`): a mock OpenAI-compatible SSE endpoint + local SOCKS5 server + temp agent dir + real `pi` processes.
  - A: `pi --model roles/tester` — the virtual model routes, the dead provider fails, the request lands on the live provider through the SOCKS5 tunnel; asserts the physical model that answered and that traffic really crossed the tunnel.
  - B: parent pi (mock LLM, also via SOCKS5) calls the `subagent` tool; the child's primary provider is dead; the child falls back to the live provider; the parent receives the trace and finishes.
  - C: the parent calls `subagent` with `verboseLog: true` and again without it; asserts the log file exists with the child's bash tool call (args + result), that the context report exists with per-turn usage and budget numbers, that the model-visible tool result contains only the file paths (no tool call bodies, no report numbers), and that the non-verbose call creates neither.

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
  index.ts               # extension entry: providers + virtual models + tool + /roles + /ctx
  router/                # pure TS core (no pi imports): types, config, health, fallback
  socks/                 # SOCKS5 fetch + proxied provider registration
  subagents/             # child spawn/parse, runtime, virtual models, tool, rendering
                         # + toollog.ts (verbose tool-call log), ctxlog.ts (per-run
                         # context report), ctx-command.ts (/ctx parent session report)
agents/                  # example role files (scout, planner, worker, reviewer)
examples/                # annotated config
test/                    # unit + socks5 + real-pi smoke
scripts/                 # debug utilities
```

## License

MIT
