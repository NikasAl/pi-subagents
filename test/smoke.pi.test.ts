/**
 * Integration smoke tests against a REAL pi (1.4.0) sandbox.
 *
 * Everything is local: no network, no API keys.
 *  - mock LLM: OpenAI-compatible SSE endpoint on 127.0.0.1;
 *  - local SOCKS5 server relays to it (proves the SOCKS5 fetch path);
 *  - temp agent dir with pi-subagents config + role agent file;
 *  - real `pi` parent process (json mode), real `pi` child processes.
 *
 * Scenario A: virtual model routing + SOCKS5 provider end-to-end.
 * Scenario B: subagent tool where the primary provider is dead — the child's
 *             router must fall back to the live provider (level-2 fallback
 *             via pi's agent-level retry), and the tool must report the trace.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockLlm, type MockLlmServer } from "./helpers/mock-llm.ts";
import { agentFileContent, makeAgentDir, parseEvents, runPi, ENTRY_TS } from "./helpers/pi-env.ts";
import { startSocks5Server, type Socks5Server } from "./helpers/socks5-server.ts";

let llm: MockLlmServer;
let llmDirect: MockLlmServer;
let socks: Socks5Server;
let agentDir: string;

const TESTER_ROLE_FILE = agentFileContent({
        name: "tester",
        description: "Smoke-test role",
        body: "You are a smoke-test subagent. Answer with exactly: OK",
});

beforeAll(async () => {
        llm = await startMockLlm({ model: "test-model" });
        llmDirect = await startMockLlm({ model: "parent-model" });
        socks = await startSocks5Server();

        const config = {
                roles: {
                        tester: { models: ["dead-socks/test-model", "mock-via-socks/test-model"], maxAttempts: 2 },
                },
                proxies: {
                        main: { host: "127.0.0.1", port: socks.port },
                },
                providers: {
                        // Primary for the role: nothing listens here -> network failure.
                        "dead-socks": {
                                proxy: "main",
                                api: "openai-completions",
                                baseUrl: "http://127.0.0.1:1/v1",
                                apiKey: "dead-key",
                                models: [{ id: "test-model", name: "Dead Model" }],
                        },
                        // Live: reachable only through the local SOCKS5 tunnel.
                        "mock-via-socks": {
                                proxy: "main",
                                api: "openai-completions",
                                baseUrl: `http://127.0.0.1:${llm.port}/v1`,
                                apiKey: "mock-key",
                                models: [{ id: "test-model", name: "Mock Model" }],
                        },
                        // Parent model (also through socks5: every custom provider is tunneled).
                        "parent-via-socks": {
                                proxy: "main",
                                api: "openai-completions",
                                baseUrl: `http://127.0.0.1:${llmDirect.port}/v1`,
                                apiKey: "mock-key",
                                models: [{ id: "parent-model", name: "Parent Model" }],
                        },
                },
        };

        agentDir = makeAgentDir({
                config,
                agents: { tester: TESTER_ROLE_FILE },
        });
}, 60_000);

afterAll(async () => {
        await llm.close();
        await llmDirect.close();
        await socks.close();
});

describe("smoke: real pi sandbox", () => {
        it(
                "A: `pi --model roles/tester` routes through SOCKS5 to the mock LLM",
                async () => {
                        const run = await runPi({
                                agentDir,
                                args: ["--mode", "json", "-p", "-e", ENTRY_TS, "--model", "roles/tester", "--", "Say OK"],
                                timeoutMs: 90_000,
                        });
                        const events = parseEvents(run.stdout);
                        const text = (() => {
                                let t: string | null = null;
                                for (const event of events) {
                                        if (event.type !== "message_end") continue;
                                        const message = event.message as Record<string, unknown> | undefined;
                                        if (!message || message.role !== "assistant") continue;
                                        const content = message.content;
                                        if (typeof content === "string") t = content;
                                        else if (Array.isArray(content)) {
                                                const parts: string[] = [];
                                                for (const block of content as Array<Record<string, unknown>>) {
                                                        if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
                                                }
                                                if (parts.length > 0) t = parts.join("");
                                        }
                                }
                                return t;
                        })();

                        expect(run.code, `pi exited ${run.code}; stderr: ${run.stderr.slice(0, 2000)}`).toBe(0);
                        expect(text).toContain("OK");

                        // The physical model that SUCCESSFULLY answered is the SOCKS5-tunnelled one.
                        // (The failed dead-socks attempt also emits an assistant message with
                        // stopReason "error" — that's the visible fallback trace, not a success.)
                        const successModels = new Set<string>();
                        for (const event of events) {
                                if (event.type !== "message_end") continue;
                                const message = event.message as Record<string, unknown> | undefined;
                                if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
                                if (typeof message.model === "string") {
                                        successModels.add(typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model);
                                }
                        }
                        expect([...successModels]).toEqual(["mock-via-socks/test-model"]);

                        // Traffic really went through the SOCKS5 tunnel.
                        expect(socks.connections()).toBeGreaterThan(0);
                        expect(llm.requests().length).toBeGreaterThan(0);
                },
                120_000,
        );

        it(
                "B: subagent tool falls back from a dead provider to the live one",
                async () => {
                        llmDirect.setScript([
                                { kind: "tool_call", name: "subagent", args: { role: "tester", task: "Say OK" } },
                                { kind: "text", text: "PARENT-DONE" },
                        ]);

                        const run = await runPi({
                                agentDir,
                                args: ["--mode", "json", "-p", "-e", ENTRY_TS, "--model", "parent-via-socks/parent-model", "--", "Use the subagent tool"],
                                timeoutMs: 150_000,
                        });

                        expect(run.code, `pi exited ${run.code}; stderr: ${run.stderr.slice(0, 2000)}`).toBe(0);
                        const events = parseEvents(run.stdout);

                        // The tool result must show the fallback trace: attempt 1 dead, attempt 2 live.
                        const toolResultTexts: string[] = [];
                        for (const event of events) {
                                if (event.type !== "tool_execution_end") continue;
                                const result = event.result as Record<string, unknown> | undefined;
                                const content = result?.content;
                                if (Array.isArray(content)) {
                                        for (const block of content as Array<Record<string, unknown>>) {
                                                if (block.type === "text" && typeof block.text === "string") toolResultTexts.push(block.text);
                                        }
                                }
                        }
                        const trace = toolResultTexts.find((t) => t.includes("[subagent role=tester]"));
                        expect(trace, `tool result trace not found; stdout: ${run.stdout.slice(0, 3000)}`).toBeTruthy();
                        expect(trace!).toContain("done");
                        expect(trace!).toContain("mock-via-socks/test-model");
                        expect(trace).toContain("OK");

                        // Parent finishes normally after the tool result.
                        const finalText = (() => {
                                let t: string | null = null;
                                for (const event of events) {
                                        if (event.type !== "message_end") continue;
                                        const message = event.message as Record<string, unknown> | undefined;
                                        if (!message || message.role !== "assistant") continue;
                                        const content = message.content;
                                        if (typeof content === "string") t = content;
                                        else if (Array.isArray(content)) {
                                                const parts: string[] = [];
                                                for (const block of content as Array<Record<string, unknown>>) {
                                                        if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
                                                }
                                                if (parts.length > 0) t = parts.join("");
                                        }
                                }
                                return t;
                        })();
                        expect(finalText).toContain("PARENT-DONE");
                },
                180_000,
        );

        it(
                "C: verboseLog writes child tool calls to a JSONL file without leaking into the parent context",
                async () => {
                        // Child #1 and child #2 each consume two script entries:
                        // request 1 -> bash tool call, request 2 -> final text.
                        llm.setScript([
                                { kind: "tool_call", name: "bash", args: { command: "echo TOOLLOG-MARKER-1" } },
                                { kind: "text", text: "CHILD-OK-1" },
                                { kind: "tool_call", name: "bash", args: { command: "echo TOOLLOG-MARKER-2" } },
                                { kind: "text", text: "CHILD-OK-2" },
                        ]);
                        // Parent: verbose subagent call, then a default (non-verbose) one.
                        llmDirect.setScript([
                                { kind: "tool_call", name: "subagent", args: { role: "tester", task: "Run the echo", verboseLog: true } },
                                { kind: "tool_call", name: "subagent", args: { role: "tester", task: "Run the echo" } },
                                { kind: "text", text: "PARENT-DONE-C" },
                        ]);

                        const run = await runPi({
                                agentDir,
                                args: ["--mode", "json", "-p", "-e", ENTRY_TS, "--model", "parent-via-socks/parent-model", "--", "Use the subagent tool twice"],
                                timeoutMs: 180_000,
                        });
                        expect(run.code, `pi exited ${run.code}; stderr: ${run.stderr.slice(0, 2000)}`).toBe(0);
                        const events = parseEvents(run.stdout);

                        // The two subagent tool results, in order (text blocks = model-visible part).
                        const toolResultTexts: string[] = [];
                        for (const event of events) {
                                if (event.type !== "tool_execution_end") continue;
                                if (event.toolName !== "subagent") continue;
                                const result = event.result as Record<string, unknown> | undefined;
                                const content = result?.content;
                                if (Array.isArray(content)) {
                                        for (const block of content as Array<Record<string, unknown>>) {
                                                if (block.type === "text" && typeof block.text === "string") toolResultTexts.push(block.text);
                                        }
                                }
                        }
                        expect(toolResultTexts.length, `subagent tool results: ${JSON.stringify(toolResultTexts).slice(0, 1500)}`).toBe(2);
                        const [verboseText, plainText] = toolResultTexts as [string, string];
                        expect(verboseText).toContain("[subagent role=tester] done");
                        expect(plainText).toContain("[subagent role=tester] done");

                        // (a) Verbose run: a tool log file exists and contains the trail.
                        expect(verboseText).toContain("tool log: ");
                        const logPath = verboseText.match(/tool log: (\S+)/)?.[1];
                        expect(logPath, `verbose result: ${verboseText}`).toBeTruthy();
                        const logLines = fs
                                .readFileSync(logPath!, "utf-8")
                                .split("\n")
                                .filter((l) => l.trim())
                                .map((l) => JSON.parse(l) as Record<string, unknown>);
                        const logTypes = logLines.map((l) => l.type);
                        expect(logTypes[0]).toBe("run_start");
                        expect(logTypes[logTypes.length - 1]).toBe("run_end");
                        expect(logTypes).toContain("tool_call_start");
                        expect(logTypes).toContain("tool_result_end");

                        const callStart = logLines.find((l) => l.type === "tool_call_start")!;
                        expect(callStart.toolName).toBe("bash");
                        expect(JSON.stringify(callStart.args)).toContain("TOOLLOG-MARKER-1");
                        const callEnd = logLines.find((l) => l.type === "tool_result_end")!;
                        expect(callEnd.isError).toBe(false);
                        expect(JSON.stringify(callEnd.result)).toContain("TOOLLOG-MARKER-1");
                        const runStart = logLines[0]!;
                        expect(runStart).toMatchObject({ role: "tester", attempt: 1 });
                        // Owner-readable only: the log may contain tool output/secrets.
                        expect(fs.statSync(logPath!).mode & 0o777).toBe(0o600);

                        // (c) The model-visible tool result carries the pointer, never the bodies.
                        expect(verboseText).not.toContain("TOOLLOG-MARKER-1");
                        expect(verboseText).not.toContain('"command"');
                        expect(verboseText).toContain("CHILD-OK-1");

                        // (b) Default run: no tool log pointer and no new file.
                        expect(plainText).not.toContain("tool log:");
                        const toolLogDir = path.join(agentDir, "pi-subagents", "toollogs");
                        expect(fs.existsSync(toolLogDir)).toBe(true);
                        const files = fs.readdirSync(toolLogDir).filter((f) => f.endsWith(".jsonl"));
                        expect(files.length, `tool log files: ${files.join(", ")}`).toBe(1);

                        // Trace entry (appendEntry — excluded from the model context per pi docs):
                        // carries the log path, never tool call bodies.
                        const traceEvents = events.filter((e) => e.type === "entry_appended");
                        const tracePayload = JSON.stringify(traceEvents);
                        expect(tracePayload).toContain("pi-subagents.trace");
                        expect(tracePayload).toContain(logPath!);
                        expect(tracePayload).not.toContain("TOOLLOG-MARKER-1");
                },
                240_000,
        );
});
