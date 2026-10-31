/**
 * Unit tests for the /ctx command core (src/subagents/ctx-command.ts):
 * statistics from session entries and report rendering. The command shows the
 * report via ctx.ui.notify only — it never writes entries or touches the
 * model context.
 */
import { describe, expect, it } from "vitest";
import { buildSessionCtxStats, renderCtxReport } from "../src/subagents/ctx-command.ts";

function entry(message: Record<string, unknown>): Record<string, unknown> {
        return { type: "message", id: `e-${Math.random().toString(36).slice(2)}`, parentId: null, timestamp: "2026-02-11T09:00:00.000Z", message };
}

const TOOL_RESULT_BODY = "CTX-COMMAND-SECRET-BODY";

function sampleEntries(): Record<string, unknown>[] {
        return [
                entry({ role: "user", content: "Review this repository please" }),
                entry({
                        role: "assistant",
                        content: [{ type: "text", text: "Let me look." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } }],
                        usage: { input: 1200, output: 40, cacheRead: 30_000, cacheWrite: 4_000, totalTokens: 35_240, cost: { total: 0.12 } },
                }),
                entry({ role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: [{ type: "text", text: TOOL_RESULT_BODY.repeat(500) }] }),
                entry({
                        role: "assistant",
                        content: [{ type: "text", text: "Done." }],
                        stopReason: "stop",
                        usage: { input: 900, output: 25, cacheRead: 60_000, cacheWrite: 0, totalTokens: 60_925, cost: { total: 0.05 } },
                }),
        ];
}

describe("buildSessionCtxStats", () => {
        it("collects per-turn usage and per-tool sizes from session entries", () => {
                const stats = buildSessionCtxStats(sampleEntries(), "You are the orchestrator.");
                expect(stats.turns).toHaveLength(2);
                expect(stats.turns[0]).toMatchObject({ input: 1200, cacheRead: 30_000, cacheWrite: 4_000, output: 40, totalTokens: 35_240, cost: 0.12 });
                expect(stats.turns[1]).toMatchObject({ input: 900, cacheRead: 60_000, cacheWrite: 0, output: 25, cost: 0.05 });
                // system prompt: length preserved (tokens estimated at render time)
                expect(stats.systemPromptChars).toBe("You are the orchestrator.".length);
                // tool result sizing: JSON of the content array
                expect(stats.tools.get("read")?.calls).toBe(1);
                expect(stats.tools.get("read")?.errors).toBe(0);
                const expectedJson = JSON.stringify([{ type: "text", text: TOOL_RESULT_BODY.repeat(500) }]);
                expect(stats.tools.get("read")?.chars).toBe(expectedJson.length);
                // user + assistant text
                expect(stats.userChars.count).toBe(1);
                expect(stats.assistantTextChars.count).toBe(2);
                expect(stats.assistantArgsChars.chars).toBe(JSON.stringify({ path: "README.md" }).length);
        });

        it("ignores non-message entries and malformed messages", () => {
                const stats = buildSessionCtxStats([
                        { type: "compaction", id: "x", parentId: null, timestamp: "t" },
                        { type: "message", id: "y", parentId: null, timestamp: "t" }, // no message field
                        null,
                        "junk",
                ]);
                expect(stats.turns).toEqual([]);
                expect(stats.tools.size).toBe(0);
        });
});

describe("renderCtxReport", () => {
        it("renders totals, per-turn table and top consumers", () => {
                const stats = buildSessionCtxStats(sampleEntries(), "You are the orchestrator.");
                const text = renderCtxReport(stats, { sessionFile: "/sessions/2026-02-11.jsonl", model: "prov/main-model" });
                expect(text).toContain("context of /sessions/2026-02-11.jsonl");
                expect(text).toContain("model: prov/main-model");
                expect(text).toContain("requests: 2");
                // peak ctx = max(1200+30000+4000, 900+60000+0) = 60900 -> 60.9k
                expect(text).toContain("peak ctx ~60.9k tok");
                expect(text).toContain("cacheRead 90.0k");
                // per-turn rows: ctx~ of turn 1 = 35200 -> 35.2k, turn 2 = 60900 -> 60.9k
                expect(text).toContain("35.2k");
                expect(text).toContain("60.9k");
                // top consumers: tool results dominate; per-tool breakdown names the tool
                expect(text).toContain("top consumers of the current context (est tokens, chars/4):");
                expect(text).toContain("tool results — read");
                expect(text).toContain("system prompt");
                // The report shows SIZES, never the underlying bodies.
                expect(text).not.toContain(TOOL_RESULT_BODY);
        });

        it("reports an empty session without crashing", () => {
                const stats = buildSessionCtxStats([], "sp");
                const text = renderCtxReport(stats, {});
                expect(text).toContain("no assistant turns yet");
        });

        it("caps the per-turn table at the last 20 turns with an earlier-peak line", () => {
                const entries: Record<string, unknown>[] = [];
                for (let i = 0; i < 25; i++) {
                        entries.push(
                                entry({
                                        role: "assistant",
                                        content: [{ type: "text", text: "t" }],
                                        usage: { input: 100 + i, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101 + i, cost: { total: 0.001 } },
                                }),
                        );
                }
                const stats = buildSessionCtxStats(entries);
                const text = renderCtxReport(stats, {});
                // 25 turns -> 5 earlier turns hidden, their peak (turn 5: 100+4=104) mentioned
                expect(text).toContain("… 5 earlier turns (peak ctx ~104)");
                const table = text.split("per turn")[1]!.split("top consumers")[0]!;
                const rowNumbers = [...table.matchAll(/^\s+(\d+)\s{2}/gm)].map((m) => Number(m[1]));
                expect(rowNumbers[0]).toBe(6);
                expect(rowNumbers.at(-1)).toBe(25);
        });
});
