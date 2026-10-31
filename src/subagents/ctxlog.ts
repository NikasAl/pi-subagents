/**
 * Optional per-run context report for subagent runs ("what fills the context").
 *
 * While the child streams (parent-side, via runChild's onEvent hook), this
 * collector tracks:
 *   - per assistant message ("turn"): fresh input, cacheRead, cacheWrite,
 *     output tokens and the estimated accumulated context size
 *     (context ≈ input + cacheRead + cacheWrite, straight from the child's
 *     provider-reported usage on message_end);
 *   - where the space goes: role system prompt, task, assistant text,
 *     tool-call arguments and tool results per tool (token estimate =
 *     serialized chars / 4 — precision is not critical, dynamics and
 *     top consumers are).
 *
 * The data is appended incrementally to a JSONL file (one writeSync per
 * event), so it can be tailed live while a subagent runs. On finish() a final
 * compact `report` record is appended (the last line): per-turn growth,
 * totals (in/out/cache/cost) and the top-N largest context items.
 *
 * The file never enters the parent's model context — same mechanics as the
 * verbose tool log: the tool result only carries a short pointer line and the
 * trace entry (pi.appendEntry) stores paths. Unlike the tool log, the context
 * report contains only NUMBERS (sizes), never tool result bodies.
 *
 * Enabling (first match wins for the ctx-specific switches; otherwise the
 * context report follows the tool-log switch; default is OFF):
 *   1. PI_SUBAGENTS_CTXLOG env var: "on"/"off" or a path.
 *   2. `defaults.ctxLog` in pi-subagents.json: true/false or a path.
 *   3. Inherited: on iff the tool-log switch is on (verboseLog param /
 *      PI_SUBAGENTS_TOOLLOG / defaults.toolLog).
 * A path ending in .jsonl/.log is used as the exact output file (runs
 * append); any other path is a directory with one file per attempt:
 *   <dir>/<timestamp>-<role>-attempt<N>.ctx.jsonl
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { attemptLogFilePath, parseToolLogValue, type ToolLogDirective } from "./toollog.ts";

/** Same shape as the tool-log directive (on/off + file or directory target). */
export type CtxLogDirective = ToolLogDirective;

/** How many items the compact `top` list keeps (the full list is in `items`). */
const TOP_ITEMS = 8;

/** Token estimate: serialized characters / 4 (rough by design). */
export function estimateTokens(chars: number): number {
        return Math.ceil(chars / 4);
}

/** Estimated context size of one request: everything the provider had to read. */
export function contextEstimate(usage: { input: number; cacheRead: number; cacheWrite: number }): number {
        return usage.input + usage.cacheRead + usage.cacheWrite;
}

export interface ResolveCtxLogInput {
        /** Already-resolved tool-log directive (inheritance source). */
        toolLog: ToolLogDirective;
        /** PI_SUBAGENTS_CTXLOG env var. */
        env?: string;
        /** `defaults.ctxLog` from the config file. */
        config?: boolean | string;
        /** Default directory when the resolved value is a plain boolean. */
        defaultDir: string;
}

function toDirective(value: boolean | string | undefined, defaultDir: string): CtxLogDirective {
        let resolved: boolean | string | undefined = value;
        if (typeof resolved === "string") resolved = parseToolLogValue(resolved);
        if (resolved === undefined || resolved === false) return { enabled: false };
        if (resolved === true) return { enabled: true, target: defaultDir, isFile: false };
        const target = String(resolved).trim();
        if (target === "") return { enabled: false };
        return { enabled: true, target, isFile: /\.(jsonl|log)$/i.test(target) };
}

/**
 * Resolve the effective context-report setting.
 * Precedence: env var > config > inherit from the tool-log directive.
 */
export function resolveCtxLogSetting(input: ResolveCtxLogInput): CtxLogDirective {
        if (input.env !== undefined && input.env.trim() !== "") {
                return toDirective(parseToolLogValue(input.env), input.defaultDir);
        }
        if (input.config !== undefined) {
                return toDirective(input.config, input.defaultDir);
        }
        // Inherit from the tool-log switch. A file target belongs to the tool log;
        // the context report falls back to its own default directory.
        if (input.toolLog.enabled) {
                return input.toolLog.isFile
                        ? { enabled: true, target: input.defaultDir, isFile: false }
                        : { enabled: true, target: input.toolLog.target, isFile: false };
        }
        return { enabled: false };
}

export interface TurnUsage {
        turn: number;
        model?: string;
        provider?: string;
        stopReason?: string;
        errorMessage?: string;
        /** Fresh (non-cached) input tokens reported by the provider. */
        input: number;
        cacheRead: number;
        cacheWrite: number;
        output: number;
        totalTokens: number;
        cost: number;
        /** input + cacheRead + cacheWrite: what the provider actually read this turn. */
        contextEstimate: number;
        /** Estimated tokens of this assistant message's visible text (chars/4). */
        textTokens: number;
        /** Estimated tokens of this assistant message's tool-call arguments (chars/4). */
        toolCallArgsTokens: number;
}

interface ToolStats {
        calls: number;
        errors: number;
        resultTokens: number;
        resultMax: number;
        argsTokens: number;
        durationMs: number;
}

function emptyToolStats(): ToolStats {
        return { calls: 0, errors: 0, resultTokens: 0, resultMax: 0, argsTokens: 0, durationMs: 0 };
}

export interface ContextItem {
        kind: "system-prompt" | "task" | "assistant-text" | "tool-args" | "tool-results";
        name: string;
        tokens: number;
        /** Share of the estimated final context content, percent (1 decimal). */
        share: number;
        calls?: number;
        errors?: number;
}

export interface AttemptCtxReport {
        schema: "pi-subagents.ctx-report/1";
        role: string;
        attempt: number;
        /** Planned model for the attempt (physical model per turn is in turns). */
        model: string;
        outcome: {
                exitCode: number;
                timedOut: boolean;
                aborted: boolean;
                stopReason: string | null;
                errorMessage: string | null;
                durationMs: number;
        };
        estimator: "chars/4";
        turns: TurnUsage[];
        totals: {
                input: number;
                output: number;
                cacheRead: number;
                cacheWrite: number;
                totalTokens: number;
                cost: number;
                requests: number;
                /** Largest estimated context across turns (= peak). */
                maxContextEstimate: number;
                /** Estimated context of the last turn (0 if the child never answered). */
                lastContextEstimate: number;
        };
        /** Estimated size of every context ingredient (tokens, chars/4). */
        budget: {
                systemPromptTokens: number;
                taskTokens: number;
                assistantTextTokens: number;
                toolCallArgsTokens: number;
                toolResultTokens: number;
        };
        /** Full decomposition, largest first. */
        items: ContextItem[];
        /** The TOP_ITEMS largest items (subset of `items`). */
        top: ContextItem[];
}

export interface AttemptCtxLogStart {
        directive: CtxLogDirective & { enabled: true };
        roleName: string;
        attempt: number;
        /** Planned model for this attempt (provider/id), for the header line. */
        modelRef: string;
        task: string;
        /** The role system prompt (its size is what matters, not the text). */
        systemPrompt: string;
        cwd?: string;
        now?: Date;
}

export interface AttemptCtxLogRunEnd {
        exitCode: number;
        timedOut: boolean;
        aborted: boolean;
        stopReason: string | null;
        errorMessage: string | null;
        durationMs: number;
}

export interface AttemptCtxLog {
        path: string;
        /** Consume one parsed JSONL record of the child stream (filters internally). */
        onChildEvent(event: Record<string, unknown>): void;
        /** Append the final report record and close the file. Idempotent (then returns null). */
        finish(runEnd: AttemptCtxLogRunEnd): AttemptCtxReport | null;
}

function jsonChars(value: unknown): number {
        if (value === undefined) return 0;
        try {
                return (JSON.stringify(value) ?? "").length;
        } catch {
                return 0;
        }
}

function messageTextLength(message: Record<string, unknown>): number {
        const content = message.content;
        if (typeof content === "string") return content.length;
        if (!Array.isArray(content)) return 0;
        let total = 0;
        for (const block of content as Array<Record<string, unknown>>) {
                if (block.type === "text" && typeof block.text === "string") total += block.text.length;
        }
        return total;
}

function buildReport(
        start: Pick<AttemptCtxLogStart, "roleName" | "attempt" | "modelRef">,
        turns: TurnUsage[],
        tools: Map<string, ToolStats>,
        budget: AttemptCtxReport["budget"],
        outcome: AttemptCtxReport["outcome"],
): AttemptCtxReport {
        const totals = {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: 0,
                requests: turns.length,
                maxContextEstimate: 0,
                lastContextEstimate: 0,
        };
        for (const turn of turns) {
                totals.input += turn.input;
                totals.output += turn.output;
                totals.cacheRead += turn.cacheRead;
                totals.cacheWrite += turn.cacheWrite;
                totals.totalTokens += turn.totalTokens;
                totals.cost += turn.cost;
                if (turn.contextEstimate > totals.maxContextEstimate) totals.maxContextEstimate = turn.contextEstimate;
                totals.lastContextEstimate = turn.contextEstimate;
        }

        const items: ContextItem[] = [];
        let sum = budget.systemPromptTokens + budget.taskTokens + budget.assistantTextTokens + budget.toolCallArgsTokens + budget.toolResultTokens;
        items.push({ kind: "system-prompt", name: start.roleName, tokens: budget.systemPromptTokens, share: 0 });
        items.push({ kind: "task", name: "user task", tokens: budget.taskTokens, share: 0 });
        items.push({ kind: "assistant-text", name: "assistant messages", tokens: budget.assistantTextTokens, share: 0 });
        items.push({ kind: "tool-args", name: "all tool calls", tokens: budget.toolCallArgsTokens, share: 0 });
        for (const [name, stats] of tools) {
                if (stats.resultTokens === 0 && stats.argsTokens === 0) continue;
                items.push({
                        kind: "tool-results",
                        name,
                        tokens: stats.resultTokens,
                        share: 0,
                        calls: stats.calls,
                        errors: stats.errors,
                });
        }
        if (sum <= 0) sum = 1;
        for (const item of items) item.share = Math.round((item.tokens / sum) * 1000) / 10;
        items.sort((a, b) => b.tokens - a.tokens);
        return {
                schema: "pi-subagents.ctx-report/1",
                role: start.roleName,
                attempt: start.attempt,
                model: start.modelRef,
                outcome,
                estimator: "chars/4",
                turns,
                totals,
                budget,
                items,
                top: items.slice(0, TOP_ITEMS),
        };
}

/**
 * Create and open a per-attempt context report. Never throws: on filesystem
 * errors it logs to stderr and returns null (reporting must never break a run).
 */
export function startAttemptCtxLog(start: AttemptCtxLogStart): AttemptCtxLog | null {
        let file: string;
        try {
                if (start.directive.isFile) {
                        file = start.directive.target;
                        fs.mkdirSync(path.dirname(file), { recursive: true });
                } else {
                        fs.mkdirSync(start.directive.target, { recursive: true });
                        file = attemptLogFilePath(start.directive.target, start.roleName, start.attempt, start.now, ".ctx.jsonl");
                }
                const fd = fs.openSync(file, "a", 0o600);
                try {
                        fs.chmodSync(file, 0o600);
                } catch {
                        /* best effort */
                }

                let closed = false;
                let finished = false;
                let turn = 0;
                let assistantTextTokens = 0;
                let toolCallArgsTokensTotal = 0;
                const turns: TurnUsage[] = [];
                const tools = new Map<string, ToolStats>();
                const budget: AttemptCtxReport["budget"] = {
                        systemPromptTokens: estimateTokens(start.systemPrompt.length),
                        taskTokens: estimateTokens(start.task.length),
                        assistantTextTokens: 0,
                        toolCallArgsTokens: 0,
                        toolResultTokens: 0,
                };
                const writeLine = (record: Record<string, unknown>) => {
                        if (closed) return;
                        try {
                                fs.writeSync(fd, `${JSON.stringify(record)}\n`);
                        } catch {
                                /* swallow: a broken log must not break the run */
                        }
                };

                writeLine({
                        type: "run_start",
                        ts: new Date().toISOString(),
                        role: start.roleName,
                        attempt: start.attempt,
                        model: start.modelRef,
                        cwd: start.cwd ?? process.cwd(),
                        pid: process.pid,
                        estimator: "chars/4",
                        systemPromptTokens: budget.systemPromptTokens,
                        taskTokens: budget.taskTokens,
                        taskPreview: start.task.length > 80 ? `${start.task.slice(0, 80)}…` : start.task,
                });

                return {
                        path: file,
                        onChildEvent(event) {
                                const type = event.type as string | undefined;
                                const ts = new Date().toISOString();
                                if (type === "message_end" && event.message) {
                                        const message = event.message as Record<string, unknown>;
                                        if (message.role !== "assistant") return;
                                        const usage = (message.usage ?? {}) as Record<string, unknown>;
                                        const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
                                        const cost = usage.cost as { total?: number } | undefined;
                                        const textTokens = estimateTokens(messageTextLength(message));
                                        turn++;
                                        const row: TurnUsage = {
                                                turn,
                                                model: typeof message.model === "string" ? message.model : undefined,
                                                provider: typeof message.provider === "string" ? message.provider : undefined,
                                                stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
                                                errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
                                                input: num("input"),
                                                cacheRead: num("cacheRead"),
                                                cacheWrite: num("cacheWrite"),
                                                output: num("output"),
                                                totalTokens: num("totalTokens"),
                                                cost: cost?.total ?? 0,
                                                contextEstimate: contextEstimate({ input: num("input"), cacheRead: num("cacheRead"), cacheWrite: num("cacheWrite") }),
                                                // Tool-call args are counted from tool_execution_start (one start
                                                // per executed call) to stay in sync with the per-tool stats.
                                                textTokens,
                                                toolCallArgsTokens: 0,
                                        };
                                        turns.push(row);
                                        assistantTextTokens += textTokens;
                                        budget.assistantTextTokens = assistantTextTokens;
                                        writeLine({ type: "turn_usage", ts, ...row });
                                        return;
                                }
                                if (type === "tool_execution_end") {
                                        const toolName = String(event.toolName ?? "");
                                        const resultTokens = estimateTokens(jsonChars(event.result));
                                        const stats = tools.get(toolName) ?? emptyToolStats();
                                        stats.errors += event.isError === true ? 1 : 0;
                                        stats.resultTokens += resultTokens;
                                        stats.resultMax = Math.max(stats.resultMax, resultTokens);
                                        if (typeof event.durationMs === "number") stats.durationMs += event.durationMs;
                                        tools.set(toolName, stats);
                                        budget.toolResultTokens += resultTokens;
                                        writeLine({
                                                type: "tool_result",
                                                ts,
                                                toolCallId: event.toolCallId,
                                                toolName,
                                                isError: event.isError === true,
                                                durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
                                                resultTokens,
                                        });
                                        return;
                                }
                                if (type === "tool_execution_start") {
                                        // The authoritative source for per-tool call counts and args
                                        // sizes: exactly one start event per executed call.
                                        const toolName = String(event.toolName ?? "");
                                        const stats = tools.get(toolName) ?? emptyToolStats();
                                        stats.calls++;
                                        const argsTokens = estimateTokens(jsonChars(event.args));
                                        stats.argsTokens += argsTokens;
                                        tools.set(toolName, stats);
                                        toolCallArgsTokensTotal += argsTokens;
                                        budget.toolCallArgsTokens = toolCallArgsTokensTotal;
                                }
                        },
                        finish(runEnd) {
                                if (finished) return null;
                                finished = true;
                                const report = buildReport({ roleName: start.roleName, attempt: start.attempt, modelRef: start.modelRef }, turns, tools, budget, {
                                        exitCode: runEnd.exitCode,
                                        timedOut: runEnd.timedOut,
                                        aborted: runEnd.aborted,
                                        stopReason: runEnd.stopReason,
                                        errorMessage: runEnd.errorMessage,
                                        durationMs: runEnd.durationMs,
                                });
                                writeLine({ type: "report", ts: new Date().toISOString(), ...report });
                                closed = true;
                                try {
                                        fs.closeSync(fd);
                                } catch {
                                        /* ignore double close */
                                }
                                return report;
                        },
                };
        } catch (error) {
                console.error(
                        "[pi-subagents] ctxlog: failed to create the context report file:",
                        error instanceof Error ? error.message : error,
                );
                return null;
        }
}
