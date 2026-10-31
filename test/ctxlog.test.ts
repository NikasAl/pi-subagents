/**
 * Unit tests for the per-run context report (src/subagents/ctxlog.ts) and its
 * wiring through runChild (src/subagents/child.ts) — modeled on toollog.test.ts.
 *
 * The child side is faked with a tiny node script that prints canned pi JSONL
 * events (with provider-reported usage) on stdout, exercising the exact
 * parsing → aggregation → report-writing path without a real pi process.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runChild } from "../src/subagents/child.ts";
import { contextEstimate, estimateTokens, resolveCtxLogSetting, startAttemptCtxLog } from "../src/subagents/ctxlog.ts";
import { formatSingleResult, type AttemptRecord, type RoleRunResult } from "../src/subagents/tool.ts";

const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ctxlog-"));

function fakeChild(lines: Array<Record<string, unknown>>): { command: string; baseArgs: string[] } {
        const payload = JSON.stringify(lines);
        return {
                command: process.execPath,
                baseArgs: ["-e", `const lines = JSON.parse(process.argv[1]); for (const l of lines) console.log(JSON.stringify(l));`, payload],
        };
}

const RESULT_MARKER = "CTX-RESULT-MARKER-BODY";

function standardChildEvents(): Array<Record<string, unknown>> {
        const bigText = "Y".repeat(40_000); // 40k chars -> ~10k tokens, the top consumer
        return [
                { type: "session", id: "fake" },
                { type: "message_end", message: { role: "user", content: "do the thing" } },
                {
                        type: "message_end",
                        message: {
                                role: "assistant",
                                content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } }],
                                stopReason: "toolUse",
                                model: "m1",
                                provider: "prov",
                                usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 50, totalTokens: 1070, cost: { input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0.001, total: 0.01 } },
                        },
                },
                { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } },
                {
                        type: "tool_execution_end",
                        toolCallId: "call_1",
                        toolName: "bash",
                        result: { content: [{ type: "text", text: "hi\n" }] },
                        isError: false,
                        durationMs: 7,
                },
                { type: "tool_execution_start", toolCallId: "call_2", toolName: "read", args: { file: "big.txt" } },
                {
                        type: "tool_execution_end",
                        toolCallId: "call_2",
                        toolName: "read",
                        result: { content: [{ type: "text", text: bigText }, { type: "text", text: RESULT_MARKER }] },
                        isError: false,
                        durationMs: 11,
                },
                {
                        type: "message_end",
                        message: {
                                role: "assistant",
                                content: [{ type: "text", text: "ALL-DONE" }],
                                stopReason: "stop",
                                model: "m1",
                                provider: "prov",
                                usage: { input: 150, output: 30, cacheRead: 2000, cacheWrite: 0, totalTokens: 2180, cost: { input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0, total: 0.02 } },
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

describe("resolveCtxLogSetting", () => {
        const defaultDir = "/default/ctxlogs";

        it("is disabled by default (toollog off, no env, no config)", () => {
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, defaultDir })).toEqual({ enabled: false });
        });

        it("inherits the toollog directory target", () => {
                expect(resolveCtxLogSetting({ toolLog: { enabled: true, target: "/logs/dir", isFile: false }, defaultDir })).toEqual({
                        enabled: true,
                        target: "/logs/dir",
                        isFile: false,
                });
        });

        it("falls back to its own default dir when the toollog targets a single file", () => {
                expect(resolveCtxLogSetting({ toolLog: { enabled: true, target: "/logs/run.jsonl", isFile: true }, defaultDir })).toEqual({
                        enabled: true,
                        target: defaultDir,
                        isFile: false,
                });
        });

        it("env on enables independently of the toollog", () => {
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, env: "on", defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
        });

        it("env off wins over an enabled toollog", () => {
                expect(resolveCtxLogSetting({ toolLog: { enabled: true, target: "/logs/dir", isFile: false }, env: "off", defaultDir })).toEqual({ enabled: false });
        });

        it("env path: .jsonl is a file, other paths are directories", () => {
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, env: "/tmp/ctx.jsonl", defaultDir })).toEqual({ enabled: true, target: "/tmp/ctx.jsonl", isFile: true });
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, env: "/tmp/ctxdir", defaultDir })).toEqual({ enabled: true, target: "/tmp/ctxdir", isFile: false });
        });

        it("config applies when env is unset and beats inheritance", () => {
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, config: true, defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, config: "on", defaultDir })).toEqual({ enabled: true, target: defaultDir, isFile: false });
                expect(resolveCtxLogSetting({ toolLog: { enabled: true, target: "/d", isFile: false }, config: false, defaultDir })).toEqual({ enabled: false });
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, config: "/cfg/dir", defaultDir })).toEqual({ enabled: true, target: "/cfg/dir", isFile: false });
        });

        it("env beats config", () => {
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, env: "off", config: true, defaultDir })).toEqual({ enabled: false });
                expect(resolveCtxLogSetting({ toolLog: { enabled: false }, env: "/env/dir", config: false, defaultDir })).toEqual({ enabled: true, target: "/env/dir", isFile: false });
        });
});

describe("estimateTokens / contextEstimate", () => {
        it("estimates tokens as chars/4 rounded up", () => {
                expect(estimateTokens(0)).toBe(0);
                expect(estimateTokens(1)).toBe(1);
                expect(estimateTokens(4)).toBe(1);
                expect(estimateTokens(5)).toBe(2);
        });

        it("context size estimate is input + cacheRead + cacheWrite", () => {
                expect(contextEstimate({ input: 100, cacheRead: 900, cacheWrite: 50 })).toBe(1050);
        });
});

describe("startAttemptCtxLog", () => {
        it("never breaks the run when the target is not creatable", () => {
                const blocker = path.join(AGENT_DIR, "blocker.txt");
                fs.writeFileSync(blocker, "not a dir");
                const logger = startAttemptCtxLog({
                        directive: { enabled: true, target: path.join(blocker, "sub"), isFile: false },
                        roleName: "scout",
                        attempt: 1,
                        modelRef: "p/m",
                        task: "t",
                        systemPrompt: "sp",
                });
                expect(logger).toBeNull();
        });

        it("finish is idempotent and returns the report only once", () => {
                const dir = path.join(AGENT_DIR, `idem-${Date.now()}`);
                const logger = startAttemptCtxLog({
                        directive: { enabled: true, target: dir, isFile: false },
                        roleName: "worker",
                        attempt: 1,
                        modelRef: "p/m",
                        task: "t",
                        systemPrompt: "sp",
                })!;
                const first = logger.finish({ exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, durationMs: 5 });
                const second = logger.finish({ exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, durationMs: 5 });
                expect(first).toBeTruthy();
                expect(first?.schema).toBe("pi-subagents.ctx-report/1");
                expect(second).toBeNull();
        });
});

describe("runChild context report", () => {
        it("collects per-turn usage, per-tool sizes and a final report without result bodies", async () => {
                const dir = path.join(AGENT_DIR, `run-${Date.now()}`);
                const systemPrompt = "You are a scout. ".repeat(20); // 20 * 18 = 360 chars
                const task = `do the thing ${"filler ".repeat(15)}Un1que-Tail-9a7c31-END`; // >80 chars -> preview only
                const logger = startAttemptCtxLog({
                        directive: { enabled: true, target: dir, isFile: false },
                        roleName: "scout",
                        attempt: 1,
                        modelRef: "prov/m1",
                        task,
                        systemPrompt,
                })!;
                expect(logger).toBeTruthy();

                const result = await runChild(fakeChild(standardChildEvents()), [], {
                        onEvent: (event) => logger.onChildEvent(event),
                });
                const report = logger.finish({
                        exitCode: result.exitCode,
                        timedOut: false,
                        aborted: false,
                        stopReason: result.stopReason,
                        errorMessage: null,
                        durationMs: 42,
                })!;

                // --- per-turn usage (provider-reported numbers, exact) ---
                expect(report.turns).toHaveLength(2);
                expect(report.turns[0]).toMatchObject({
                        turn: 1,
                        input: 100,
                        cacheRead: 900,
                        cacheWrite: 50,
                        output: 20,
                        totalTokens: 1070,
                        cost: 0.01,
                        contextEstimate: 1050,
                        provider: "prov",
                        stopReason: "toolUse",
                });
                expect(report.turns[1]).toMatchObject({
                        turn: 2,
                        input: 150,
                        cacheRead: 2000,
                        cacheWrite: 0,
                        output: 30,
                        contextEstimate: 2150,
                        stopReason: "stop",
                });

                // --- totals ---
                expect(report.totals).toMatchObject({
                        input: 250,
                        output: 50,
                        cacheRead: 2900,
                        cacheWrite: 50,
                        totalTokens: 3250,
                        cost: 0.03,
                        requests: 2,
                        maxContextEstimate: 2150,
                        lastContextEstimate: 2150,
                });

                // --- budget decomposition (chars/4 estimates, exact) ---
                const bigResultJson = JSON.stringify({
                        content: [{ type: "text", text: "Y".repeat(40_000) }, { type: "text", text: RESULT_MARKER }],
                });
                const bashResultJson = JSON.stringify({ content: [{ type: "text", text: "hi\n" }] });
                expect(report.budget.systemPromptTokens).toBe(estimateTokens(systemPrompt.length));
                expect(report.budget.taskTokens).toBe(estimateTokens(task.length));
                // assistant text: "ALL-DONE" (8) from turn 2; turn 1 has none
                expect(report.budget.assistantTextTokens).toBe(estimateTokens(8));
                // tool args: bash {"command":"echo hi"} + read {"file":"big.txt"}
                expect(report.budget.toolCallArgsTokens).toBe(estimateTokens(JSON.stringify({ command: "echo hi" }).length) + estimateTokens(JSON.stringify({ file: "big.txt" }).length));
                expect(report.budget.toolResultTokens).toBe(estimateTokens(bigResultJson.length) + estimateTokens(bashResultJson.length));

                // --- top items: the big read result wins ---
                expect(report.items).toEqual([...report.items].sort((a, b) => b.tokens - a.tokens));
                const read = report.items.find((i) => i.kind === "tool-results" && i.name === "read")!;
                expect(read.tokens).toBe(estimateTokens(bigResultJson.length));
                expect(read.calls).toBe(1);
                expect(read.errors).toBe(0);
                expect(report.top[0]).toEqual(read);
                const shareSum = Math.round(report.items.reduce((sum, i) => sum + i.share, 0));
                expect(shareSum).toBeGreaterThanOrEqual(99);
                expect(shareSum).toBeLessThanOrEqual(101);

                // --- outcome embedded in the report ---
                expect(report.outcome).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", durationMs: 42 });

                // --- file shape: run_start first, report last; numbers only, no bodies ---
                expect(fs.statSync(logger.path).mode & 0o777).toBe(0o600);
                const lines = readLines(logger.path);
                expect(lines[0]!.type).toBe("run_start");
                expect(lines[lines.length - 1]!.type).toBe("report");
                expect(lines.filter((l) => l.type === "turn_usage")).toHaveLength(2);
                expect(lines.filter((l) => l.type === "tool_result")).toHaveLength(2);
                const toolResultRow = lines.find((l) => l.type === "tool_result" && l.toolName === "read")!;
                expect(toolResultRow).toMatchObject({ isError: false, resultTokens: estimateTokens(bigResultJson.length) });
                const raw = fs.readFileSync(logger.path, "utf-8");
                expect(raw).not.toContain("Y".repeat(1000)); // never the result body
                expect(raw).not.toContain(RESULT_MARKER);
                // run_start carries sizes and the task PREVIEW only (first 80 chars + …)
                expect(raw).toContain("do the thing");
                expect(raw).not.toContain("Un1que-Tail-9a7c31-END");
        });

        it("writes per-attempt files with collision-safe names", () => {
                const dir = path.join(AGENT_DIR, `names-${Date.now()}`);
                const now = new Date("2026-02-11T09:15:33.512Z");
                const a = startAttemptCtxLog({ directive: { enabled: true, target: dir, isFile: false }, roleName: "scout", attempt: 1, modelRef: "p/m", task: "t", systemPrompt: "s", now })!;
                const b = startAttemptCtxLog({ directive: { enabled: true, target: dir, isFile: false }, roleName: "scout", attempt: 1, modelRef: "p/m", task: "t", systemPrompt: "s", now })!;
                expect(path.basename(a.path)).toMatch(/^2026-02-11T09-15-33-512Z-scout-attempt1\.ctx\.jsonl$/);
                expect(b.path).not.toBe(a.path);
                a.finish({ exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, durationMs: 1 });
                b.finish({ exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, durationMs: 1 });
        });

        it("keeps counting when the child errors or aborts mid-run", async () => {
                const dir = path.join(AGENT_DIR, `err-${Date.now()}`);
                const logger = startAttemptCtxLog({
                        directive: { enabled: true, target: dir, isFile: false },
                        roleName: "scout",
                        attempt: 1,
                        modelRef: "p/m",
                        task: "t",
                        systemPrompt: "s",
                })!;
                const events: Array<Record<string, unknown>> = [
                        {
                                type: "message_end",
                                message: {
                                        role: "assistant",
                                        content: [],
                                        stopReason: "error",
                                        errorMessage: "Connection error.",
                                        usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500, cost: { total: 0 } },
                                },
                        },
                ];
                const result = await runChild(fakeChild(events), [], { onEvent: (event) => logger.onChildEvent(event) });
                const report = logger.finish({ exitCode: result.exitCode, timedOut: false, aborted: false, stopReason: result.stopReason, errorMessage: "Connection error.", durationMs: 9 })!;
                expect(report.totals.requests).toBe(1);
                expect(report.totals.lastContextEstimate).toBe(500);
                expect(report.outcome.stopReason).toBe("error");
        });
});

describe("no leak of the context report into the parent context", () => {
        function attemptsWith(ctxLogPath: string | null): AttemptRecord {
                return {
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
                        ctxLogPath,
                };
        }

        it("formatSingleResult shows the report path but never sizes or bodies", () => {
                const result: RoleRunResult = {
                        ok: true,
                        role: "scout",
                        attempts: [attemptsWith("/logs/2026-02-11T09-15-33-512Z-scout-attempt1.ctx.jsonl")],
                        finalText: "ALL-DONE",
                        modelUsed: "prov/m1",
                        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
                        aborted: false,
                };
                const text = formatSingleResult(result);
                expect(text).toContain("context report: /logs/2026-02-11T09-15-33-512Z-scout-attempt1.ctx.jsonl");
                // Only the pointer — no report numbers, no decomposition, no bodies.
                expect(text).not.toContain("tool-result");
                expect(text).not.toContain("chars/4");
                expect(text).not.toContain(RESULT_MARKER);

                // The trace payload (appendEntry — excluded from model context per pi docs)
                // carries only pointers, never report contents.
                const tracePayload = JSON.stringify({
                        ctxLogs: result.attempts.map((a) => a.ctxLogPath).filter((p): p is string => p !== null),
                });
                expect(tracePayload).toContain(".ctx.jsonl");
                expect(tracePayload).not.toContain("totals");
        });

        it("omits the pointer line entirely when reporting is off", () => {
                const text = formatSingleResult({
                        ok: true,
                        role: "scout",
                        attempts: [attemptsWith(null)],
                        finalText: "ALL-DONE",
                        modelUsed: "prov/m1",
                        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
                        aborted: false,
                });
                expect(text).not.toContain("context report");
        });
});
