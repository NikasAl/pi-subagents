/**
 * Unit tests for the optional verbose tool-call logging (src/subagents/toollog.ts)
 * and its wiring through runChild (src/subagents/child.ts).
 *
 * The child side is faked with a tiny node script that prints canned pi JSONL
 * events on stdout — runChild only spawns a command and parses its stream, so
 * this exercises the exact parsing → collection → file-writing path without a
 * real pi process (the real end-to-end path is covered by the smoke tests).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runChild } from "../src/subagents/child.ts";
import { attemptLogFilePath, parseToolLogValue, resolveToolLogSetting, startAttemptToolLog } from "../src/subagents/toollog.ts";
import { formatSingleResult, type AttemptRecord, type RoleRunResult } from "../src/subagents/tool.ts";

const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-toollog-"));

function fakeChild(lines: Array<Record<string, unknown>>): { command: string; baseArgs: string[] } {
        const payload = JSON.stringify(lines);
        return {
                command: process.execPath,
                baseArgs: ["-e", `const lines = JSON.parse(process.argv[1]); for (const l of lines) console.log(JSON.stringify(l));`, payload],
        };
}

const SECRET_ARGS = "echo SECRET-ARGS-MARKER";
const SECRET_RESULT = "SECRET-RESULT-MARKER";

function standardChildEvents(): Array<Record<string, unknown>> {
        return [
                { type: "session", id: "fake" },
                { type: "message_end", message: { role: "user", content: "do it" } },
                {
                        type: "message_end",
                        message: {
                                role: "assistant",
                                content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: SECRET_ARGS } }],
                                stopReason: "toolUse",
                                model: "m1",
                        },
                },
                { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: SECRET_ARGS } },
                {
                        type: "tool_execution_update",
                        toolCallId: "call_1",
                        toolName: "bash",
                        partialResult: { content: [{ type: "text", text: "partial output" }] },
                },
                {
                        type: "tool_execution_end",
                        toolCallId: "call_1",
                        toolName: "bash",
                        result: { content: [{ type: "text", text: SECRET_RESULT }], details: {} },
                        isError: false,
                        durationMs: 12,
                },
                {
                        type: "message_end",
                        message: {
                                role: "assistant",
                                content: [{ type: "text", text: "ALL-DONE" }],
                                stopReason: "stop",
                                model: "m1",
                                provider: "prov",
                                usage: { totalTokens: 10 },
                        },
                },
        ];
}

function readLines(file: string): Array<Record<string, unknown>> {
        return fs
                .readFileSync(file, "utf-8")
                .split("\n")
                .filter((l) => l.trim())
                .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("resolveToolLogSetting", () => {
        const defaultDir = "/default/toollogs";

        it("is disabled by default (no param, no env, no config)", () => {
                expect(resolveToolLogSetting({ defaultDir })).toEqual({ enabled: false });
        });

        it("param=true enables with the default dir", () => {
                expect(resolveToolLogSetting({ param: true, defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
        });

        it("param=false wins over enabled env", () => {
                expect(resolveToolLogSetting({ param: false, env: "on", defaultDir })).toEqual({ enabled: false });
        });

        it("param=true wins over env off", () => {
                expect(resolveToolLogSetting({ param: true, env: "off", defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
        });

        it("env on/off parse", () => {
                expect(resolveToolLogSetting({ env: "on", defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
                expect(resolveToolLogSetting({ env: "off", config: true, defaultDir })).toEqual({ enabled: false });
        });

        it("env path: .jsonl is a file, other paths are directories", () => {
                expect(resolveToolLogSetting({ env: "/tmp/runs.jsonl", defaultDir })).toEqual({ enabled: true, target: "/tmp/runs.jsonl", isFile: true });
                expect(resolveToolLogSetting({ env: "/tmp/runs", defaultDir })).toEqual({ enabled: true, target: "/tmp/runs", isFile: false });
        });

        it("config value applies when param and env are unset", () => {
                expect(resolveToolLogSetting({ config: true, defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
                expect(resolveToolLogSetting({ config: "on", defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
                expect(resolveToolLogSetting({ config: false, defaultDir })).toEqual({ enabled: false });
                expect(resolveToolLogSetting({ config: "/cfg/dir", defaultDir })).toEqual({ enabled: true, target: "/cfg/dir", isFile: false });
        });

        it("env beats config; empty env is treated as unset", () => {
                expect(resolveToolLogSetting({ env: "/env/dir", config: true, defaultDir })).toEqual({ enabled: true, target: "/env/dir", isFile: false });
                expect(resolveToolLogSetting({ env: "off", config: "/cfg/x", defaultDir })).toEqual({ enabled: false });
                expect(resolveToolLogSetting({ env: "  ", config: true, defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
        });

        it("parseToolLogValue accepts common spellings", () => {
                expect(parseToolLogValue("on")).toBe(true);
                expect(parseToolLogValue("TRUE")).toBe(true);
                expect(parseToolLogValue("1")).toBe(true);
                expect(parseToolLogValue("off")).toBe(false);
                expect(parseToolLogValue("0")).toBe(false);
                expect(parseToolLogValue("/some/path")).toBe("/some/path");
        });
});

describe("attemptLogFilePath", () => {
        it("uses <timestamp>-<role>-attempt<N>.jsonl and avoids collisions", () => {
                const dir = fs.mkdtempSync(path.join(AGENT_DIR, "names-"));
                const now = new Date("2026-02-11T09:15:33.512Z");
                const first = attemptLogFilePath(dir, "scout", 1, now);
                expect(path.dirname(first)).toBe(dir);
                expect(path.basename(first)).toMatch(/^2026-02-11T09-15-33-512Z-scout-attempt1\.jsonl$/);
                fs.writeFileSync(first, "");
                const second = attemptLogFilePath(dir, "scout", 1, now);
                expect(second).not.toBe(first);
                expect(fs.existsSync(second)).toBe(false);
        });
});

describe("startAttemptToolLog", () => {
        it("never breaks the run when the target is not creatable", () => {
                const blocker = path.join(AGENT_DIR, "blocker.txt");
                fs.writeFileSync(blocker, "not a dir");
                const logger = startAttemptToolLog({
                        directive: { enabled: true, target: path.join(blocker, "sub"), isFile: false },
                        roleName: "scout",
                        attempt: 1,
                        modelRef: "p/m",
                        task: "t",
                });
                expect(logger).toBeNull();
        });

        it("file-target mode appends runs to the same file", () => {
                const file = path.join(AGENT_DIR, `shared-${Date.now()}.jsonl`);
                const directive = { enabled: true, target: file, isFile: true } as const;
                for (const attempt of [1, 2]) {
                        const logger = startAttemptToolLog({ directive, roleName: "worker", attempt, modelRef: "p/m", task: `task-${attempt}` });
                        logger!.finish({ exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, durationMs: 5, toolCallCount: 0 });
                }
                const lines = readLines(file);
                const runStarts = lines.filter((l) => l.type === "run_start");
                expect(runStarts.length).toBe(2);
                expect(lines[lines.length - 1]!.type).toBe("run_end");
        });
});

describe("runChild tool-call logging", () => {
        it("writes the full tool call trail to the file and collects bounded copies", async () => {
                const dir = path.join(AGENT_DIR, `run-${Date.now()}`);
                const directive = { enabled: true, target: dir, isFile: false } as const;
                const logger = startAttemptToolLog({ directive, roleName: "scout", attempt: 1, modelRef: "prov/m1", task: "the task" })!;
                expect(logger).toBeTruthy();

                const result = await runChild(fakeChild(standardChildEvents()), [], {
                        collectToolEvents: true,
                        onEvent: (event) => logger.onChildEvent(event),
                });
                logger.finish({
                        exitCode: result.exitCode,
                        timedOut: false,
                        aborted: false,
                        stopReason: result.stopReason,
                        errorMessage: null,
                        durationMs: 42,
                        toolCallCount: result.toolResultCount,
                });

                // In-memory mirror (bounded).
                expect(result.toolResultCount).toBe(1);
                expect(result.toolCalls.length).toBe(1);
                expect(result.toolCalls[0]).toMatchObject({ toolCallId: "call_1", toolName: "bash", isError: false, durationMs: 12 });
                expect(JSON.stringify(result.toolCalls[0]!.args)).toContain(SECRET_ARGS);
                expect(JSON.stringify(result.toolCalls[0]!.result)).toContain(SECRET_RESULT);
                expect(result.finalText).toBe("ALL-DONE");

                // Log file: header, full-fidelity events, footer.
                const lines = readLines(logger.path);
                const types = lines.map((l) => l.type);
                expect(types[0]).toBe("run_start");
                expect(types[types.length - 1]).toBe("run_end");
                expect(types).toEqual([
                        "run_start",
                        "assistant", // declared tool call (assistant message)
                        "tool_call_start",
                        "tool_update",
                        "tool_result_end",
                        "assistant", // final answer
                        "run_end",
                ]);

                const header = lines[0]!;
                expect(header).toMatchObject({ role: "scout", attempt: 1, model: "prov/m1", task: "the task" });

                const declared = lines.find((l) => l.type === "assistant" && (l.toolCalls as unknown[]).length > 0)!;
                expect(JSON.stringify(declared.toolCalls)).toContain(SECRET_ARGS);

                const start = lines.find((l) => l.type === "tool_call_start")!;
                expect(start).toMatchObject({ toolCallId: "call_1", toolName: "bash" });
                expect(JSON.stringify(start.args)).toContain(SECRET_ARGS);

                const update = lines.find((l) => l.type === "tool_update")!;
                expect(update.partialTextLength).toBe("partial output".length);

                const end = lines.find((l) => l.type === "tool_result_end")!;
                expect(end.isError).toBe(false);
                expect(end.durationMs).toBe(12);
                expect(JSON.stringify(end.result)).toContain(SECRET_RESULT);

                const lastAssistant = lines.filter((l) => l.type === "assistant").at(-1)!;
                expect(lastAssistant).toMatchObject({ model: "m1", provider: "prov", stopReason: "stop", textLength: 8, totalTokens: 10 });

                const runEnd = lines.at(-1)!;
                expect(runEnd).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, durationMs: 42, toolCallCount: 1 });

                // Log file permissions: owner-only (may contain tool output/secrets).
                const mode = fs.statSync(logger.path).mode & 0o777;
                expect(mode).toBe(0o600);
        });

        it("by default (logging off) collects nothing and creates no files", async () => {
                const dir = path.join(AGENT_DIR, `off-${Date.now()}`);
                const result = await runChild(fakeChild(standardChildEvents()), []);
                expect(result.toolCalls).toEqual([]);
                expect(result.toolResultCount).toBe(1); // counting still works without collection
                expect(result.finalText).toBe("ALL-DONE");
                expect(fs.existsSync(dir)).toBe(false);
        });

        it("keeps the log file full while bounding in-memory copies for huge results", async () => {
                const dir = path.join(AGENT_DIR, `big-${Date.now()}`);
                const bigText = "X".repeat(100 * 1024);
                const events: Array<Record<string, unknown>> = [
                        { type: "tool_execution_start", toolCallId: "call_big", toolName: "read", args: { file: "big.txt" } },
                        {
                                type: "tool_execution_end",
                                toolCallId: "call_big",
                                toolName: "read",
                                result: { content: [{ type: "text", text: bigText }] },
                                isError: false,
                                durationMs: 3,
                        },
                ];
                const logger = startAttemptToolLog({ directive: { enabled: true, target: dir, isFile: false }, roleName: "worker", attempt: 1, modelRef: "p/m", task: "t" })!;
                const result = await runChild(fakeChild(events), [], { collectToolEvents: true, onEvent: (event) => logger.onChildEvent(event) });
                logger.finish({ exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, durationMs: 1, toolCallCount: 1 });

                expect(result.toolCalls[0]!.resultTruncated).toBe(true);
                const inMemory = JSON.stringify(result.toolCalls[0]!.result);
                expect(inMemory.length).toBeLessThan(4000);
                expect(inMemory).toContain('"truncated":true');

                // The FILE is never truncated.
                const end = readLines(logger.path).find((l) => l.type === "tool_result_end")!;
                expect(JSON.stringify(end.result).length).toBeGreaterThan(100 * 1024);
        });
});

describe("no leak of tool call bodies into the parent context", () => {
        it("formatSingleResult shows the log path but never tool call args/results", () => {
                const attempts: AttemptRecord[] = [
                        {
                                ref: "prov/m1",
                                ok: true,
                                model: "prov/m1",
                                exitCode: 0,
                                stopReason: "stop",
                                errorClass: null,
                                errorMessage: null,
                                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
                                finalText: "ALL-DONE",
                                toolCallCount: 1,
                                toolLogPath: "/logs/2026-02-11T09-15-33-512Z-scout-attempt1.jsonl",
                        },
                ];
                const result: RoleRunResult = {
                        ok: true,
                        role: "scout",
                        attempts,
                        finalText: "ALL-DONE",
                        modelUsed: "prov/m1",
                        usage: attempts[0]!.usage,
                        aborted: false,
                };
                const text = formatSingleResult(result);
                expect(text).toContain("tool log: /logs/2026-02-11T09-15-33-512Z-scout-attempt1.jsonl");
                expect(text).not.toContain(SECRET_ARGS);
                expect(text).not.toContain(SECRET_RESULT);
                expect(text).not.toContain('"command"');

                // The trace payload (appendEntry — excluded from model context per pi docs)
                // carries only pointers and counts, never tool call bodies.
                const tracePayload = JSON.stringify({
                        role: result.role,
                        attempts: result.attempts,
                        toolLogs: result.attempts.map((a) => a.toolLogPath).filter((p): p is string => p !== null),
                });
                expect(tracePayload).toContain("/logs/2026-02-11T09-15-33-512Z-scout-attempt1.jsonl");
                expect(tracePayload).not.toContain(SECRET_ARGS);
                expect(tracePayload).not.toContain(SECRET_RESULT);
        });

        it("omits the pointer line entirely when logging is off", () => {
                const attempts: AttemptRecord[] = [
                        {
                                ref: "prov/m1",
                                ok: true,
                                model: "prov/m1",
                                exitCode: 0,
                                stopReason: "stop",
                                errorClass: null,
                                errorMessage: null,
                                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
                                finalText: "ALL-DONE",
                                toolCallCount: 1,
                                toolLogPath: null,
                        },
                ];
                const text = formatSingleResult({
                        ok: true,
                        role: "scout",
                        attempts,
                        finalText: "ALL-DONE",
                        modelUsed: "prov/m1",
                        usage: attempts[0]!.usage,
                        aborted: false,
                });
                expect(text).not.toContain("tool log");
        });
});
