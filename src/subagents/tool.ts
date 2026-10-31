import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
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
        options: { cwd?: string; signal?: AbortSignal; toolLog?: ToolLogDirective },
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
                // Verbose tool-call logging (debugging): written parent-side from the
                // child's JSONL stream; disabled by default (see toollog.ts).
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
                let result: ChildRunResult;
                try {
                        result = await runChild(cli, buildChildArgs({ roleName: role.name, task, systemPromptPath: promptFile.filePath, tools: role.tools, thinking: role.thinking }), {
                                cwd: options.cwd ?? role.cwd,
                                signal: options.signal,
                                timeoutMs: role.timeoutMs,
                                env: { PI_SUBAGENTS_EXCLUDE: [...exclude].join(",") },
                                collectToolEvents: toolLogger !== null,
                                onEvent: toolLogger ? (event) => toolLogger.onChildEvent(event) : undefined,
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

const TaskItem = Type.Object({
        role: Type.String({ description: "Role name (see /roles)" }),
        task: Type.String({ description: "Exact task for this subagent" }),
        cwd: Type.Optional(Type.String({ description: "Optional working directory for this task" })),
});

const SubagentParams = Type.Object({
        role: Type.Optional(Type.String({ description: "Role name for single mode (see /roles)" })),
        task: Type.Optional(Type.String({ description: "Task for single mode" })),
        tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode: array of {role, task} (max 8)" })),
        cwd: Type.Optional(Type.String({ description: "Optional working directory (single mode)" })),
        verboseLog: Type.Optional(
                Type.Boolean({
                        description:
                                "Write a verbose tool-call log for debugging: every child tool call (name, arguments, result or error) is appended to a JSONL file under <agentDir>/pi-subagents/toollogs/. The tool result returns the file path only. Default: off.",
                }),
        ),
});

export function registerSubagentTool(pi: ExtensionAPI, runtime: Runtime): void {
        pi.registerTool({
                name: "subagent",
                label: "Subagent",
                description: [
                        "Delegate a task to a role-based subagent running in an isolated pi child process.",
                        "Each role has a prioritized model fallback list (see /roles): if a provider is down, rate-limited or overloaded, the next model in the list takes over automatically.",
                        "Modes: single {role, task} or parallel {tasks: [{role, task}]} (max 8).",
                        "The tool result reports which model executed the task, every fallback attempt, and token usage.",
                        "Set verboseLog=true to record every child tool call (name, arguments, results) to a JSONL log file and get its path back — use it when a subagent seems stuck or fails.",
                ].join(" "),
                promptGuidelines: [
                        "Use the subagent tool for focused subtasks (recon, planning, review, implementation) to keep the main context clean.",
                        "Give the subagent a self-contained task: paths, constraints and the exact expected result. Do not assume the subagent sees this conversation.",
                ],
                parameters: SubagentParams,

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
                                        `Invalid parameters: provide exactly one of {role, task} (single mode) or {tasks} (parallel mode). Known roles: ${roleList(runtime)}.`,
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

                        if (hasTasks) {
                                const tasks = params.tasks!;
                                if (tasks.length > MAX_PARALLEL_TASKS) {
                                        return textResult(`Too many parallel tasks (${tasks.length}); max is ${MAX_PARALLEL_TASKS}.`, {}, true);
                                }
                                const results = await mapWithConcurrencyLimit(tasks, runtime.parallelLimit, async (item) => {
                                        const role = runtime.getRole(item.role);
                                        if (!role)
                                                return { ok: false as const, role: item.role, error: `Unknown role "${item.role}". Known: ${roleList(runtime)}` };
                                        const run = await runRoleWithFallback(runtime, role, item.task, { cwd: item.cwd, signal, toolLog });
                                        return { ok: true as const, role: item.role, result: run };
                                });
                                const allOk = results.every((r) => r.ok && r.result.ok);
                                return textResult(formatParallelResult(results), { tasks: results }, !allOk && results.some((r) => r.ok && !r.result.ok && !r.result.aborted));
                        }

                        const role = runtime.getRole(params.role!);
                        if (!role) {
                                return textResult(`Unknown role "${params.role}". Known roles: ${roleList(runtime)}. Run /roles for details.`, { knownRoles: runtime.roles().map((r) => r.name) }, true);
                        }

                        const result = await runRoleWithFallback(runtime, role, params.task!, { cwd: params.cwd, signal, toolLog });
                        // appendEntry entries are durable session data EXCLUDED from the model
                        // context (pi docs/extensions.md, state table) — safe for verbose details.
                        pi.appendEntry("pi-subagents.trace", {
                                role: role.name,
                                attempts: result.attempts,
                                usage: result.usage,
                                toolLogs: result.attempts.map((a) => a.toolLogPath).filter((p): p is string => p !== null),
                        });
                        return textResult(formatSingleResult(result), { role: role.name, attempts: result.attempts, usage: result.usage }, !result.ok && !result.aborted);
                },
        });
}

function roleList(runtime: Runtime): string {
        const roles = runtime.roles();
        return roles.length > 0 ? roles.map((r) => r.name).join(", ") : "(none)";
}

function textResult(text: string, details: unknown, isError: boolean) {
        return {
                content: [{ type: "text" as const, text }],
                details,
                ...(isError ? { isError: true } : {}),
        };
}

export function formatSingleResult(result: RoleRunResult): string {
        const logLines = toolLogLines(result.attempts);
        if (result.ok) {
                const usage = result.usage;
                const lines = [
                        `[subagent role=${result.role}] done`,
                        `model: ${result.modelUsed ?? "?"} · attempts: ${result.attempts.length} · in ${usage.input} out ${usage.output} ctx ${usage.totalTokens} $${usage.cost.toFixed(4)}`,
                        ...logLines,
                        `---`,
                        result.finalText ?? "(no output)",
                ];
                return lines.join("\n");
        }
        return [
                `[subagent role=${result.role}] FAILED`,
                formatAttempts(result.attempts),
                ...logLines,
                ...(result.aborted ? ["(aborted)"] : []),
        ].join("\n");
}

/** Pointer lines for verbose tool-call logs (path only — never tool call bodies). */
function toolLogLines(attempts: AttemptRecord[]): string[] {
        const numbered = attempts
                .map((attempt, index) => ({ n: index + 1, path: attempt.toolLogPath }))
                .filter((entry): entry is { n: number; path: string } => entry.path !== null);
        if (numbered.length === 0) return [];
        const simple = numbered.length === 1 && attempts.length === 1;
        return numbered.map((entry) => (simple ? `tool log: ${entry.path}` : `tool log (attempt ${entry.n}): ${entry.path}`));
}

export function formatParallelResult(
        results: Array<{ ok: boolean; role: string; result?: RoleRunResult; error?: string }>,
): string {
        const done = results.filter((r) => r.ok && r.result?.ok).length;
        const sections = results.map((r, i) => {
                const title = `### [${i + 1}] role=${r.role} ${r.ok ? (r.result?.ok ? "done" : "FAILED") : `unknown role: ${r.error}`}`;
                if (!r.ok) return `${title}\n${r.error}`;
                return `${title}\n${formatSingleResult(r.result!)}`;
        });
        return `Parallel: ${done}/${results.length} succeeded\n\n${sections.join("\n\n")}`;
}
