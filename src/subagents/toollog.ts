/**
 * Optional verbose tool-call logging for subagent runs (debugging).
 *
 * The child runs with `--no-session`, so nothing is persisted on the child
 * side. When verbose logging is enabled, the PARENT parses the child's JSONL
 * stream (via runChild's onEvent hook) and appends every tool event to a
 * JSONL log file. The file is written incrementally (one writeSync per
 * event), so it can be tailed live while a subagent appears to hang.
 *
 * The log file never enters the parent's model context: the tool result text
 * only carries the file path (a pointer), and trace entries are stored with
 * pi.appendEntry, which pi documents as "durable data excluded from model
 * context" (docs/extensions.md, state table).
 *
 * Log line types:
 *   run_start      — one per attempt: role, planned model, task, cwd
 *   tool_call_start — a child tool execution started (toolName + full args)
 *   tool_update    — slim progress marker for long-running tools
 *                    (partial result omitted, only its text length)
 *   tool_result_end — the child tool execution finished (full result or error)
 *   assistant      — slim per-assistant-message marker (model, stop reason,
 *                    declared tool calls; no message body)
 *   run_end        — attempt outcome (exit code, timeout, abort, duration)
 *
 * Enabling (first match wins; default is OFF):
 *   1. `verboseLog` parameter of the subagent tool (boolean).
 *   2. PI_SUBAGENTS_TOOLLOG env var: "on"/"off" or a path.
 *   3. `defaults.toolLog` in pi-subagents.json: true/false or a path.
 * A path ending in .jsonl/.log is used as the exact output file (runs append);
 * any other path is used as a directory with one file per attempt:
 *   <dir>/<timestamp>-<role>-attempt<N>.jsonl
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Where tool-call logs should go for one tool invocation. */
export type ToolLogDirective =
        | { enabled: false }
        | { enabled: true; target: string; isFile: boolean };

const ON_VALUES = new Set(["on", "1", "true", "yes"]);
const OFF_VALUES = new Set(["off", "0", "false", "no"]);

/** Parse an env-style value: "on"/"off" or a filesystem path. */
export function parseToolLogValue(value: string): boolean | string {
        const v = value.trim();
        const lower = v.toLowerCase();
        if (ON_VALUES.has(lower)) return true;
        if (OFF_VALUES.has(lower)) return false;
        return v;
}

export interface ResolveToolLogInput {
        /** `verboseLog` parameter of the subagent tool (highest priority). */
        param?: boolean;
        /** PI_SUBAGENTS_TOOLLOG env var. */
        env?: string;
        /** `defaults.toolLog` from the config file. */
        config?: boolean | string;
        /** Default directory when the resolved value is a plain boolean. */
        defaultDir: string;
}

/**
 * Resolve the effective tool-log setting.
 * Precedence: tool parameter > env var > config > disabled.
 */
export function resolveToolLogSetting(input: ResolveToolLogInput): ToolLogDirective {
        let value: boolean | string | undefined;
        if (input.param !== undefined) {
                value = input.param;
        } else if (input.env !== undefined && input.env.trim() !== "") {
                value = parseToolLogValue(input.env);
        } else {
                value = input.config;
        }
        // String values (env or config) may be "on"/"off" spellings, not just paths.
        if (typeof value === "string") value = parseToolLogValue(value);

        if (value === undefined || value === false) return { enabled: false };
        if (value === true) return { enabled: true, target: input.defaultDir, isFile: false };
        const target = String(value).trim();
        if (target === "") return { enabled: false };
        return { enabled: true, target, isFile: /\.(jsonl|log)$/i.test(target) };
}

/** `2026-10-31T09-15-33-512Z` — filesystem-safe ISO timestamp. */
export function toolLogStamp(date: Date = new Date()): string {
        return date.toISOString().replace(/[:.]/g, "-");
}

/** Choose the log file for one attempt, avoiding collisions with parallel runs. */
export function attemptLogFilePath(dir: string, roleName: string, attempt: number, now: Date = new Date(), ext = ".jsonl"): string {
        const safeRole = roleName.replace(/[^\w.-]+/g, "_");
        const base = `${toolLogStamp(now)}-${safeRole}-attempt${attempt}`;
        let candidate = path.join(dir, `${base}${ext}`);
        if (!fs.existsSync(candidate)) return candidate;
        // Parallel tasks of the same role can start within the same millisecond:
        // disambiguate with the pid, then a counter.
        candidate = path.join(dir, `${base}-${process.pid}${ext}`);
        if (!fs.existsSync(candidate)) return candidate;
        for (let k = 2; ; k++) {
                candidate = path.join(dir, `${base}-${process.pid}-${k}${ext}`);
                if (!fs.existsSync(candidate)) return candidate;
        }
}

function partialTextLength(partialResult: unknown): number | undefined {
        if (partialResult === null || typeof partialResult !== "object") return undefined;
        const content = (partialResult as Record<string, unknown>)["content"];
        if (!Array.isArray(content)) return undefined;
        let total = 0;
        for (const block of content as Array<Record<string, unknown>>) {
                if (block.type === "text" && typeof block.text === "string") total += block.text.length;
        }
        return total;
}

function declaredToolCalls(message: Record<string, unknown>): Array<{ id: string; name: string; arguments: unknown }> {
        const content = message.content;
        if (!Array.isArray(content)) return [];
        const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
        for (const block of content as Array<Record<string, unknown>>) {
                if (block.type === "toolCall") {
                        calls.push({ id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: block.arguments });
                }
        }
        return calls;
}

function assistantTextLength(message: Record<string, unknown>): number {
        const content = message.content;
        if (typeof content === "string") return content.length;
        if (!Array.isArray(content)) return 0;
        let total = 0;
        for (const block of content as Array<Record<string, unknown>>) {
                if (block.type === "text" && typeof block.text === "string") total += block.text.length;
        }
        return total;
}

export interface AttemptToolLogStart {
        directive: ToolLogDirective & { enabled: true };
        roleName: string;
        attempt: number;
        /** Planned model for this attempt (provider/id), for the header line. */
        modelRef: string;
        task: string;
        cwd?: string;
        now?: Date;
}

export interface AttemptToolLogRunEnd {
        exitCode: number;
        timedOut: boolean;
        aborted: boolean;
        stopReason: string | null;
        errorMessage: string | null;
        durationMs: number;
        toolCallCount: number;
}

export interface AttemptToolLog {
        path: string;
        /** Consume one parsed JSONL record of the child stream (filters internally). */
        onChildEvent(event: Record<string, unknown>): void;
        /** Write the run_end footer and close the file. Idempotent. */
        finish(runEnd: AttemptToolLogRunEnd): void;
}

/**
 * Create and open a per-attempt tool log. Never throws: on filesystem errors
 * it logs to stderr and returns null (logging must never break a run).
 */
export function startAttemptToolLog(start: AttemptToolLogStart): AttemptToolLog | null {
        let file: string;
        try {
                if (start.directive.isFile) {
                        file = start.directive.target;
                        fs.mkdirSync(path.dirname(file), { recursive: true });
                } else {
                        fs.mkdirSync(start.directive.target, { recursive: true });
                        file = attemptLogFilePath(start.directive.target, start.roleName, start.attempt, start.now);
                }
                const fd = fs.openSync(file, "a", 0o600);
                try {
                        fs.chmodSync(file, 0o600);
                } catch {
                        /* best effort */
                }

                let closed = false;
                let finished = false;
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
                        task: start.task,
                        cwd: start.cwd ?? process.cwd(),
                        pid: process.pid,
                });

                return {
                        path: file,
                        onChildEvent(event) {
                                const type = event.type as string | undefined;
                                const ts = new Date().toISOString();
                                if (type === "tool_execution_start") {
                                        writeLine({
                                                type: "tool_call_start",
                                                ts,
                                                toolCallId: event.toolCallId,
                                                toolName: event.toolName,
                                                args: event.args,
                                        });
                                } else if (type === "tool_execution_update") {
                                        writeLine({
                                                type: "tool_update",
                                                ts,
                                                toolCallId: event.toolCallId,
                                                toolName: event.toolName,
                                                partialTextLength: partialTextLength(event.partialResult),
                                        });
                                } else if (type === "tool_execution_end") {
                                        writeLine({
                                                type: "tool_result_end",
                                                ts,
                                                toolCallId: event.toolCallId,
                                                toolName: event.toolName,
                                                isError: event.isError === true,
                                                durationMs: event.durationMs,
                                                result: event.result,
                                        });
                                } else if (type === "message_end" && event.message) {
                                        const message = event.message as Record<string, unknown>;
                                        if (message.role !== "assistant") return;
                                        const usage = message.usage as Record<string, unknown> | undefined;
                                        writeLine({
                                                type: "assistant",
                                                ts,
                                                model: typeof message.model === "string" ? message.model : undefined,
                                                provider: typeof message.provider === "string" ? message.provider : undefined,
                                                stopReason: message.stopReason,
                                                errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
                                                toolCalls: declaredToolCalls(message),
                                                textLength: assistantTextLength(message),
                                                totalTokens: typeof usage?.totalTokens === "number" ? usage.totalTokens : undefined,
                                        });
                                }
                        },
                        finish(runEnd) {
                                if (finished) return;
                                finished = true;
                                writeLine({ type: "run_end", ts: new Date().toISOString(), ...runEnd });
                                closed = true;
                                try {
                                        fs.closeSync(fd);
                                } catch {
                                        /* ignore double close */
                                }
                        },
                };
        } catch (error) {
                console.error(
                        "[pi-subagents] toollog: failed to create the tool log file:",
                        error instanceof Error ? error.message : error,
                );
                return null;
        }
}
