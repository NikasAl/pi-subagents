/**
 * Debug: extension discovery via <agentDir>/extensions (no explicit -e flag).
 * Mirrors smoke scenario A but relies on pi's normal extension discovery.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { startMockLlm } from "../test/helpers/mock-llm.ts";
import { startSocks5Server } from "../test/helpers/socks5-server.ts";
import { agentFileContent, makeAgentDir, parseEvents, runPi, REPO_ROOT } from "../test/helpers/pi-env.ts";

const llm = await startMockLlm({ model: "test-model" });
const socks = await startSocks5Server();

const config = {
	roles: { tester: { models: ["mock-via-socks/test-model"] } },
	proxies: { main: { host: "127.0.0.1", port: socks.port } },
	providers: {
		"mock-via-socks": { proxy: "main", api: "openai-completions", baseUrl: `http://127.0.0.1:${llm.port}/v1`, apiKey: "mock-key", models: [{ id: "test-model", name: "Mock" }] },
	},
};

const agentDir = makeAgentDir({
	config,
	agents: { tester: agentFileContent({ name: "tester", description: "discovery check", body: "Answer with exactly: OK" }) },
});
// Simulate the real install: extension discovered from <agentDir>/extensions.
fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
fs.symlinkSync(REPO_ROOT, path.join(agentDir, "extensions", "pi-subagents"));

const run = await runPi({
	agentDir,
	args: ["--mode", "json", "-p", "--model", "roles/tester", "--", "Say OK"],
	timeoutMs: 90_000,
});
const events = parseEvents(run.stdout);
let text: string | null = null;
let provider: string | null = null;
for (const event of events) {
	if (event.type !== "message_end") continue;
	const message = event.message as Record<string, unknown> | undefined;
	if (message?.role === "assistant" && message.stopReason === "stop") {
		provider = (message.provider as string) ?? null;
		const content = message.content;
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
			}
			text = parts.join("");
		}
	}
}
console.log("exit:", run.code);
console.log("provider:", provider, "| text:", JSON.stringify(text), "| socks conns:", socks.connections());
if (run.code !== 0 || text === null || !text.includes("OK")) {
	console.error("STDOUT:", run.stdout.slice(0, 2500));
	console.error("STDERR:", run.stderr.slice(0, 1500));
	process.exit(1);
}
await llm.close();
await socks.close();
console.log("DISCOVERY OK");
