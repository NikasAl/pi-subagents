import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { classifyFailure } from "../router/errors.ts";
import { FallbackRouter } from "../router/router.ts";
import type { ModelRef } from "../router/types.ts";
import {
        buildChildArgs,
        childErrorText,
        cleanupTempPromptFile,
        resolvePiCli,
        runChild,
        shouldRespawn,
        writeTempPromptFile,
        type ChildRunResult,
} from "./child.ts";
import type { EffectiveRole, Runtime } from "./runtime.ts";
import { formatAttempts } from "./render.ts";
import { resolveCtxLogSetting, startAttemptCtxLog, type CtxLogDirective } from "./ctxlog.ts";
import { resolveToolLogSetting, startAttemptToolLog, type ToolLogDirective } from "./toollog.ts";

const MAX_PARALLEL_TASKS = 8;

export interface AttemptRecord {
        ref: ModelRef;
        ok: boolean;
        model: string | null;
        exitCode: number;
        stopReason: string | null;
        errorClass: string | null;
        errorMessage: string | null;
        usage: ChildRunResult["usage"];
        finalText: string | null;
        /** Tool executions observed in this attempt (counted from the child stream). */
        toolCallCount: number;
        /** Verbose tool-call log file of this attempt (null when logging is off). */
        toolLogPath: string | null;
        /** Per-run context report file of this attempt (null when reporting is off). */
        ctxLogPath: string | null;
}

export interface RoleRunResult {
        ok: boolean;
        role: string;
        attempts: AttemptRecord[];
        finalText: string | null;
        modelUsed: ModelRef | null;
        usage: ChildRunResult["usage"];
        aborted: boolean;
}

/** MapWithConcurrencyLimit: fixed-size worker pool over an array. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
        items: readonly TIn[],
        limit: number,
        fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
        const results = new Array<TOut>(items.length);
        let nextIndex = 0;
        const worker = async () => {
                while (true) {
                        const current = nextIndex++;
                        if (current >= items.length) return;
                        results[current] = await fn(items[current]!, current);
                }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
        return results;
}

/**
 * Level-1 fallback: pick a model with the orchestrator's health tracker, spawn
 * the child with `roles/<role>` (level-2 request-level fallback inside), and
 * respawn with the next candidate if the child dies before producing output.
 */
export async function runRoleWithFallback(
        runtime: Runtime,
        role: EffectiveRole,
        task: string,
        options: { cwd?: string; signal?: AbortSignal; toolLog?: ToolLogDirective; ctxLog?: CtxLogDirective },
): Promise<RoleRunResult> {
        const cli = resolvePiCli();
        if (!cli) {
                return {
                        ok: false,
                        role: role.name,
                        attempts: [],
                        finalText: null,
                        modelUsed: null,
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
                        aborted: false,
                };
        }

        const router = new FallbackRouter({
                models: role.models,
                isConfigured: runtime.isConfigured,
                isHealthy: runtime.isHealthy,
        });

        const attempts: AttemptRecord[] = [];
        const exclude = new Set<ModelRef>(runtime.envExcluded);
        const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

        for (let attempt = 1; attempt <= role.maxAttempts; attempt++) {
                if (options.signal?.aborted) break;
                const pick = router.pick({ exclude });
                if (!pick) break;

                const promptFile = writeTempPromptFile(role.name, role.systemPrompt);
                // Verbose tool-call logging + per-run context report (debugging): both
                // written parent-side from the child's JSONL stream; disabled by default
                // (see toollog.ts / ctxlog.ts).
                const attemptStartedAt = Date.now();
                const toolLogger = options.toolLog?.enabled
                        ? startAttemptToolLog({
                                  directive: options.toolLog,
                                  roleName: role.name,
                                  attempt,
                                  modelRef: pick.ref,
                                  task,
                                  cwd: options.cwd ?? role.cwd,
                          })
                        : null;
                const ctxLogger = options.ctxLog?.enabled
                        ? startAttemptCtxLog({
                                  directive: options.ctxLog,
                                  roleName: role.name,
                                  attempt,
                                  modelRef: pick.ref,
                                  task,
                                  systemPrompt: role.systemPrompt,
                                  cwd: options.cwd ?? role.cwd,
                          })
                        : null;
                let result: ChildRunResult;
                try {
                        result = await runChild(cli, buildChildArgs({ roleName: role.name, task, systemPromptPath: promptFile.filePath, tools: role.tools, thinking: role.thinking }), {
                                cwd: options.cwd ?? role.cwd,
                                signal: options.signal,
                                timeoutMs: role.timeoutMs,
                                env: { PI_SUBAGENTS_EXCLUDE: [...exclude].join(",") },
                                collectToolEvents: toolLogger !== null,
                                onEvent: toolLogger || ctxLogger
                                        ? (event) => {
                                                  toolLogger?.onChildEvent(event);
                                                  ctxLogger?.onChildEvent(event);
                                          }
                                        : undefined,
                        });
                } finally {
                        cleanupTempPromptFile(promptFile);
                }
                toolLogger?.finish({
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                        aborted: result.aborted,
                        stopReason: result.stopReason,
                        errorMessage: result.errorMessage,
                        durationMs: Date.now() - attemptStartedAt,
                        toolCallCount: result.toolResultCount,
                });
                ctxLogger?.finish({
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                        aborted: result.aborted,
                        stopReason: result.stopReason,
                        errorMessage: result.errorMessage,
                        durationMs: Date.now() - attemptStartedAt,
                });

                totalUsage.input += result.usage.input;
                totalUsage.output += result.usage.output;
                totalUsage.cacheRead += result.usage.cacheRead;
                totalUsage.cacheWrite += result.usage.cacheWrite;
                totalUsage.totalTokens += result.usage.totalTokens;
                totalUsage.cost += result.usage.cost;

                const failed = shouldRespawn(result);
                const errorMessage = failed ? childErrorText(result) : null;
                attempts.push({
                        ref: pick.ref,
                        ok: !failed,
                        model: result.modelUsed,
                        exitCode: result.exitCode,
                        stopReason: result.stopReason,
                        errorClass: failed ? classifyFailure(errorMessage, result.stderr) : null,
                        errorMessage,
                        usage: result.usage,
                        finalText: result.finalText,
                        toolCallCount: result.toolResultCount,
                        toolLogPath: toolLogger?.path ?? null,
                        ctxLogPath: ctxLogger?.path ?? null,
                });

                if (options.signal?.aborted) {
                        return { ok: false, role: role.name, attempts, finalText: result.finalText, modelUsed: null, usage: totalUsage, aborted: true };
                }

                if (!failed) {
                        runtime.health.recordSuccess(pick.ref);
                        return {
                                ok: true,
                                role: role.name,
                                attempts,
                                finalText: result.finalText,
                                // Physical model that actually answered inside the child (may differ
                                // from pick.ref when level-2 fallback triggered inside the child).
                                modelUsed: result.modelUsed ?? pick.ref,
                                usage: totalUsage,
                                aborted: false,
                        };
                }

                runtime.health.recordFailure(pick.ref, classifyFailure(errorMessage, result.stderr), errorMessage ?? undefined);
                exclude.add(pick.ref);
        }

        return {
                ok: false,
                role: role.name,
                attempts,
                finalText: attempts[attempts.length - 1]?.finalText ?? null,
                modelUsed: null,
                usage: totalUsage,
                aborted: Boolean(options.signal?.aborted),
        };
}

/**
 * Near-synonyms the model reaches for when the roster is not in its context
 * (observed in real sessions: `recon`, `review`, `coder`, `implementation`).
 * Resolved instead of failing the call, so a wrong guess costs no round trip.
 */
const ROLE_ALIASES: Record<string, string> = {
        recon: "scout",
        research: "scout",
        explore: "scout",
        investigate: "scout",
        plan: "planner",
        coder: "worker",
        dev: "worker",
        implement: "worker",
        implementation: "worker",
        executor: "worker",
        review: "reviewer",
        critique: "reviewer",
        image: "vision",
        images: "vision",
        "image-check": "vision",
        screenshot: "vision",
        screenshots: "vision",
        visual: "vision",
        inspect: "vision",
};

function oneLine(text: string): string {
        return text.replace(/\s+/g, " ").trim();
}

/** Alphabetical, deterministic order (config order depends on how roles were declared). */
function sortedRoles(runtime: Runtime): EffectiveRole[] {
        return [...runtime.roles()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `name — purpose; name — purpose` — the roster shown to the model in errors. */
export function roleRoster(runtime: Runtime): string {
        const roles = sortedRoles(runtime);
        if (roles.length === 0) return "(no roles configured)";
        return roles.map((role) => `${role.name} — ${oneLine(role.description)}`).join("; ");
}

/**
 * Resolve a requested role: exact name, then case-insensitive, then a known
 * near-synonym. Unknown names are reported (with the roster) instead of failing.
 */
export function resolveRole(runtime: Runtime, requested: string): { role: EffectiveRole; correctedFrom: string | null } | null {
        const wanted = requested.trim();
        const exact = runtime.getRole(wanted);
        if (exact) return { role: exact, correctedFrom: null };
        const lowered = wanted.toLowerCase();
        const caseMatch = runtime.roles().find((role) => role.name.toLowerCase() === lowered);
        if (caseMatch) return { role: caseMatch, correctedFrom: wanted };
        const alias = ROLE_ALIASES[lowered];
        const aliasMatch = alias ? runtime.getRole(alias) : undefined;
        if (aliasMatch) return { role: aliasMatch, correctedFrom: wanted };
        return null;
}

/** Tool parameters; `role` is a real string enum of the current roster, not free text. */
export function buildParams(roleNames: string[]) {
        const roster = roleNames.length > 0 ? roleNames.join(", ") : "(none configured)";
        const roleSchema = (description: string) =>
                roleNames.length > 0 ? StringEnum(roleNames, { description }) : Type.String({ description });

        const TaskItem = Type.Object({
                role: roleSchema(`Role for this task. One of: ${roster}`),
                task: Type.String({ description: "Exact task for this subagent" }),
                cwd: Type.Optional(Type.String({ description: "Optional working directory for this task" })),
        });

        return Type.Object({
                role: Type.Optional(roleSchema(`Role for single mode. One of: ${roster}`)),
                task: Type.Optional(Type.String({ description: "Task for single mode" })),
                tasks: Type.Optional(
                        Type.Array(TaskItem, { description: `Parallel mode: array of {role, task} (max ${MAX_PARALLEL_TASKS})` }),
                ),
                cwd: Type.Optional(Type.String({ description: "Optional working directory (single mode)" })),
                verboseLog: Type.Optional(
                        Type.Boolean({
                                description:
                                        "Write debugging artifacts for this run: (1) a verbose tool-call log — every child tool call (name, arguments, result or error) appended to a JSONL file, and (2) a per-run context report — per-turn input/cacheRead/cacheWrite/output, estimated context growth and the largest context consumers (token estimate). Files go under <agentDir>/pi-subagents/; the tool result returns their paths only. Default: off.",
                        }),
                ),
        });
}

/** Tool description carrying the role roster: the model must never guess role names. */
export function buildSubagentDescription(runtime: Runtime): string {
        const roles = sortedRoles(runtime);
        const roster =
                roles.length > 0
                        ? roles.map((role) => `- ${role.name}: ${oneLine(role.description)}`).join("\n")
                        : "- (none configured — add <agentDir>/agents/<role>.md or roles.<name>.models)";
        return [
                "Delegate a task to a role-based subagent running in an isolated pi child process.",
                "Roles (pick by purpose; never invent a name):",
                roster,
                "Each role has a prioritized model fallback list (see /roles): if a provider is down, rate-limited or overloaded, the next model in the list takes over automatically.",
                "The child is isolated: it does not see this conversation, AGENTS.md/project context files or skills, and it only has the role's whitelisted tools. Put absolute paths, constraints and the expected output format into task.",
                `Modes: single {role, task} or parallel {tasks: [{role, task}]} (max ${MAX_PARALLEL_TASKS}).`,
                "The tool result reports which model executed the task, every fallback attempt, and token usage.",
                "Set verboseLog=true to record every child tool call (name, arguments, results) to a JSONL log file plus a per-run context report (per-turn context growth and largest consumers), and get their paths back — use it when a subagent seems stuck or fails.",
        ].join("\n");
}

export function registerSubagentTool(pi: ExtensionAPI, runtime: Runtime): void {
        pi.registerTool({
                name: "subagent",
                label: "Subagent",
                description: buildSubagentDescription(runtime),
                promptGuidelines: [
                        "Use the subagent tool for focused subtasks (recon, planning, review, implementation) to keep the main context clean.",
                        "Pick the subagent tool role from the roster in its description, by the role's purpose — never invent a role name.",
                        "Give the subagent tool a self-contained task: the child gets no conversation history, no AGENTS.md and no skills, so pass paths, constraints and the exact expected result.",
                ],
                parameters: buildParams(sortedRoles(runtime).map((role) => role.name)),

                async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
                        runtime.modelRegistry ??= ctx.modelRegistry;

                        if (runtime.configError) {
                                return textResult(
                                        `pi-subagents config is invalid: ${runtime.configError.message}\nFix ${runtime.configPath} and run /reload.`,
                                        { configError: runtime.configError.message, configPath: runtime.configPath },
                                        true,
                                );
                        }

                        const hasSingle = Boolean(params.role && params.task);
                        const hasTasks = (params.tasks?.length ?? 0) > 0;
                        if (hasSingle === hasTasks) {
                                return textResult(
                                        `Invalid parameters: provide exactly one of {role, task} (single mode) or {tasks} (parallel mode). Available roles: ${roleRoster(runtime)}.`,
                                        { knownRoles: runtime.roles().map((r) => r.name) },
                                        true,
                                );
                        }

                        if (runtime.roles().length === 0) {
                                return textResult(
                                        `No roles configured. Create agent files in ~/.pi/agent/agents/*.md and/or add fallback lists to ${runtime.configPath} (see README).`,
                                        { configPath: runtime.configPath, configMissing: runtime.configMissing },
                                        true,
                                );
                        }

                        // Verbose tool-call logging: tool parameter > env > config > off.
                        const toolLog = resolveToolLogSetting({
                                param: params.verboseLog,
                                env: process.env["PI_SUBAGENTS_TOOLLOG"],
                                config: runtime.config.defaults?.toolLog,
                                defaultDir: runtime.toolLogDir,
                        });
                        // Context report: PI_SUBAGENTS_CTXLOG / defaults.ctxLog win; otherwise it
                        // follows the tool-log switch (same on/off, same directory; own default
                        // directory when the tool log targets a single file). Off by default.
                        const ctxLog = resolveCtxLogSetting({
                                toolLog,
                                env: process.env["PI_SUBAGENTS_CTXLOG"],
                                config: runtime.config.defaults?.ctxLog,
                                defaultDir: runtime.ctxLogDir,
                        });

                        if (hasTasks) {
                                const tasks = params.tasks!;
                                if (tasks.length > MAX_PARALLEL_TASKS) {
                                        return textResult(`Too many parallel tasks (${tasks.length}); max is ${MAX_PARALLEL_TASKS}.`, {}, true);
                                }
                                const results = await mapWithConcurrencyLimit(tasks, runtime.parallelLimit, async (item) => {
                                        const resolved = resolveRole(runtime, item.role);
                                        if (!resolved)
                                                return { ok: false as const, role: item.role, error: `Unknown role "${item.role}". Available roles: ${roleRoster(runtime)}` };
                                        const run = await runRoleWithFallback(runtime, resolved.role, item.task, { cwd: item.cwd, signal, toolLog, ctxLog });
                                        return { ok: true as const, role: resolved.role.name, note: correctionNote(resolved), result: run };
                                });
                                const allOk = results.every((r) => r.ok && r.result.ok);
                                return textResult(formatParallelResult(results), { tasks: results }, !allOk && results.some((r) => r.ok && !r.result.ok && !r.result.aborted));
                        }

                        const resolved = resolveRole(runtime, params.role!);
                        if (!resolved) {
                                return textResult(
                                        `Unknown role "${params.role}". Available roles: ${roleRoster(runtime)}.`,
                                        { knownRoles: runtime.roles().map((r) => r.name) },
                                        true,
                                );
                        }
                        const role = resolved.role;

                        const result = await runRoleWithFallback(runtime, role, params.task!, { cwd: params.cwd, signal, toolLog, ctxLog });
                        // appendEntry entries are durable session data EXCLUDED from the model
                        // context (pi docs/extensions.md, state table) — safe for verbose details.
                        pi.appendEntry("pi-subagents.trace", {
                                requestedRole: params.role,
                                role: role.name,
                                correctedFrom: resolved.correctedFrom,
                                attempts: result.attempts,
                                usage: result.usage,
                                toolLogs: result.attempts.map((a) => a.toolLogPath).filter((p): p is string => p !== null),
                                ctxLogs: result.attempts.map((a) => a.ctxLogPath).filter((p): p is string => p !== null),
                        });
                        const note = correctionNote(resolved);
                        const text = note ? `${note}\n${formatSingleResult(result)}` : formatSingleResult(result);
                        return textResult(text, { role: role.name, attempts: result.attempts, usage: result.usage }, !result.ok && !result.aborted);
                },
        });
}

/** One-line note when the requested role name was mapped onto a real role. */
function correctionNote(resolved: { role: EffectiveRole; correctedFrom: string | null }): string | null {
        return resolved.correctedFrom === null ? null : `note: role "${resolved.correctedFrom}" resolved to "${resolved.role.name}"`;
}

function textResult(text: string, details: unknown, isError: boolean) {
        return {
                content: [{ type: "text" as const, text }],
                details,
                ...(isError ? { isError: true } : {}),
        };
}

export function formatSingleResult(result: RoleRunResult): string {
        const logLines = pointerLines(result.attempts, (a) => a.toolLogPath, "tool log");
        const ctxLines = pointerLines(result.attempts, (a) => a.ctxLogPath, "context report");
        if (result.ok) {
                const usage = result.usage;
                const lines = [
                        `[subagent role=${result.role}] done`,
                        `model: ${result.modelUsed ?? "?"} · attempts: ${result.attempts.length} · in ${usage.input} out ${usage.output} ctx ${usage.totalTokens} $${usage.cost.toFixed(4)}`,
                        ...logLines,
                        ...ctxLines,
                        `---`,
                        result.finalText ?? "(no output)",
                ];
                return lines.join("\n");
        }
        return [
                `[subagent role=${result.role}] FAILED`,
                formatAttempts(result.attempts),
                ...logLines,
                ...ctxLines,
                ...(result.aborted ? ["(aborted)"] : []),
        ].join("\n");
}

/** Pointer lines for log/report files (path only — never bodies or their numbers). */
function pointerLines(attempts: AttemptRecord[], pick: (attempt: AttemptRecord) => string | null, label: string): string[] {
        const numbered = attempts
                .map((attempt, index) => ({ n: index + 1, path: pick(attempt) }))
                .filter((entry): entry is { n: number; path: string } => entry.path !== null);
        if (numbered.length === 0) return [];
        const simple = numbered.length === 1 && attempts.length === 1;
        return numbered.map((entry) => (simple ? `${label}: ${entry.path}` : `${label} (attempt ${entry.n}): ${entry.path}`));
}

export function formatParallelResult(
        results: Array<{ ok: boolean; role: string; note?: string | null; result?: RoleRunResult; error?: string }>,
): string {
        const done = results.filter((r) => r.ok && r.result?.ok).length;
        const sections = results.map((r, i) => {
                const title = `### [${i + 1}] role=${r.role} ${r.ok ? (r.result?.ok ? "done" : "FAILED") : `unknown role: ${r.error}`}`;
                if (!r.ok) return `${title}\n${r.error}`;
                const note = r.note ? `${r.note}\n` : "";
                return `${title}\n${note}${formatSingleResult(r.result!)}`;
        });
        return `Parallel: ${done}/${results.length} succeeded\n\n${sections.join("\n\n")}`;
}
