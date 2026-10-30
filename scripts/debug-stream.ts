/** Debug: pi-ai streamSimple with SOCKS fetch override (no pi extension machinery). */
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { startMockLlm } from "../test/helpers/mock-llm.ts";
import { startSocks5Server } from "../test/helpers/socks5-server.ts";
import { createSocksFetch } from "../src/socks/socks-fetch.ts";

const llm = await startMockLlm({ model: "test-model" });
const socks = await startSocks5Server();
const socksFetch = createSocksFetch({ host: "127.0.0.1", port: socks.port });

const model = {
	type: "chat",
	api: "openai-completions",
	provider: "mock-via-socks",
	id: "test-model",
	name: "Mock",
	baseUrl: `http://127.0.0.1:${llm.port}/v1`,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
} as never;

const context = {
	systemPrompt: "You are a test.",
	messages: [{ role: "user", content: "Say OK" }],
	tools: [],
} as never;

const stream = openAICompletionsApi().streamSimple(model, context, {
	apiKey: "mock-key",
	fetch: socksFetch as never,
} as never);

const timer = setTimeout(() => {
	console.error("TIMEOUT waiting for stream");
	process.exit(1);
}, 20_000);

for await (const event of stream) {
	if (event.type === "start") console.log("event: start");
	else if (event.type === "text_delta") console.log("text_delta:", event.delta);
	else if (event.type === "done") {
		console.log("done. stopReason:", event.reason);
		console.log("message:", JSON.stringify(event.message?.content)?.slice(0, 200));
	} else if (event.type === "error") {
		console.log("stream error:", event.error?.errorMessage);
	}
}
clearTimeout(timer);
console.log("socks connections:", socks.connections(), "llm requests:", llm.requests().length);
await llm.close();
await socks.close();
process.exit(0);
