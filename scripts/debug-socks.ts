/** Direct debug of createSocksFetch against the mock LLM (no pi). */
import { startMockLlm } from "../test/helpers/mock-llm.ts";
import { startSocks5Server } from "../test/helpers/socks5-server.ts";
import { createSocksFetch } from "../src/socks/socks-fetch.ts";

const llm = await startMockLlm({ model: "test-model" });
const socks = await startSocks5Server();
console.log("llm port:", llm.port, "socks port:", socks.port);

const socksFetch = createSocksFetch({ host: "127.0.0.1", port: socks.port });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15_000);
try {
	const response = await socksFetch(`http://127.0.0.1:${llm.port}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer mock-key" },
		body: JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
		signal: controller.signal,
	});
	console.log("status:", response.status);
	const text = await response.text();
	console.log("body (first 500):", text.slice(0, 500));
} catch (error) {
	console.log("FETCH ERROR:", error);
} finally {
	clearTimeout(timer);
}
console.log("socks connections:", socks.connections());
console.log("llm requests:", llm.requests().length);
await llm.close();
await socks.close();
process.exit(0);
