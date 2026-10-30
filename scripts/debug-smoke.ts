/**
 * Manual smoke debug: runs both scenarios and prints full JSONL.
 * Usage: node --experimental-strip-types scripts/debug-smoke.ts
 */
import { startMockLlm } from "../test/helpers/mock-llm.ts";
import { startSocks5Server } from "../test/helpers/socks5-server.ts";
import { agentFileContent, makeAgentDir, parseEvents, runPi, ENTRY_TS } from "../test/helpers/pi-env.ts";

const scenario = process.argv[2] ?? "A";
const llm = await startMockLlm({ model: "test-model" });
const llmDirect = await startMockLlm({ model: "parent-model" });
const socks = await startSocks5Server();

const config = {
	roles: { tester: { models: ["dead-socks/test-model", "mock-via-socks/test-model"], maxAttempts: 2 } },
	proxies: { main: { host: "127.0.0.1", port: socks.port } },
	providers: {
		"dead-socks": { proxy: "main", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "dead-key", models: [{ id: "test-model", name: "Dead" }] },
		"mock-via-socks": { proxy: "main", api: "openai-completions", baseUrl: `http://127.0.0.1:${llm.port}/v1`, apiKey: "mock-key", models: [{ id: "test-model", name: "Mock" }] },
		"parent-via-socks": { proxy: "main", api: "openai-completions", baseUrl: `http://127.0.0.1:${llmDirect.port}/v1`, apiKey: "mock-key", models: [{ id: "parent-model", name: "Parent" }] },
	},
};

const agentDir = makeAgentDir({
	config,
	agents: {
		tester: agentFileContent({ name: "tester", description: "smoke", body: "You are a smoke-test subagent. Answer with exactly: OK" }),
	},
});

if (scenario === "B") {
	llmDirect.setScript([
		{ kind: "tool_call", name: "subagent", args: { role: "tester", task: "Say OK" } },
		{ kind: "text", text: "PARENT-DONE" },
	]);
}

const args =
	scenario === "A"
		? ["--mode", "json", "-p", "-e", ENTRY_TS, "--model", "roles/tester", "--", "Say OK"]
		: ["--mode", "json", "-p", "-e", ENTRY_TS, "--model", "parent-via-socks/parent-model", "--", "Use the subagent tool"];

console.error("== running scenario", scenario);
const run = await runPi({ agentDir, args, timeoutMs: 180_000 });
console.error("== exit code:", run.code);
console.error("== STDERR (last 3000):\n", run.stderr.slice(-3000));
console.error("== STDOUT:\n", run.stdout);
console.error("== parsed events:", parseEvents(run.stdout).map((e) => e.type).join(","));
console.error("== llm(socks) requests:", llm.requests().length, "llm(parent) requests:", llmDirect.requests().length, "socks conns:", socks.connections());
await llm.close();
await llmDirect.close();
await socks.close();
process.exit(0);
