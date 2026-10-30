import * as http from "node:http";

/**
 * Minimal OpenAI-compatible /v1/chat/completions streaming mock.
 *
 * Scripted responses: each request consumes the next entry of `script`.
 * A text entry answers with plain content; a tool_call entry answers with an
 * OpenAI-style tool_calls delta. `usage` is reported with realistic shapes so
 * pi's openai-completions parsing is exercised end-to-end.
 */
export interface MockLlmServer {
	port: number;
	close(): Promise<void>;
	requests(): Array<{ body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>;
	/** Replace remaining script. */
	setScript(script: Array<MockLlmReply>): void;
}

export type MockLlmReply =
	| { kind: "text"; text: string }
	| { kind: "tool_call"; name: string; args: unknown }
	| { kind: "error"; status: number; body: string };

export interface StartMockLlmOptions {
	model?: string;
	/** When set, answers only after this many prior requests with tool results (helper for loops). */
	script?: Array<MockLlmReply>;
}

export function startMockLlm(options: StartMockLlmOptions = {}): Promise<MockLlmServer> {
	const model = options.model ?? "test-model";
	const seenRequests: Array<{ body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];
	let script: Array<MockLlmReply> = options.script ? [...options.script] : [{ kind: "text", text: "OK" }];

	function sseChunk(response: http.ServerResponse, payload: unknown): void {
		response.write(`data: ${JSON.stringify(payload)}\n\n`);
	}

	function finishChunk(response: http.ServerResponse, finishReason: string | null, includeUsage: boolean, promptTokens: number): void {
		const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1_700_000_000, model };
		sseChunk(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
		if (includeUsage) {
			sseChunk(response, {
				...base,
				choices: [],
				usage: {
					prompt_tokens: promptTokens,
					completion_tokens: 2,
					total_tokens: promptTokens + 2,
				},
			});
		}
		response.write("data: [DONE]\n\n");
		response.end();
	}

	const server = http.createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(raw || "{}");
			} catch {
				body = {};
			}
			seenRequests.push({ body, headers: request.headers });

			const reply = script.shift() ?? { kind: "text", text: "OK" };
			if (reply.kind === "error") {
				response.writeHead(reply.status, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: reply.body, type: "mock_error", code: reply.status } }));
				return;
			}

			const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
			const promptTokens = Math.max(1, raw.length >> 4);
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1_700_000_000, model };

			if (reply.kind === "text") {
				sseChunk(response, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] });
				void messages;
				finishChunk(response, "stop", true, promptTokens);
				return;
			}

			// tool_call
			const args = JSON.stringify(reply.args);
			sseChunk(response, {
				...base,
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: null,
							tool_calls: [{ index: 0, id: "call_test_1", type: "function", function: { name: reply.name, arguments: args } }],
						},
						finish_reason: null,
					},
				],
			});
			finishChunk(response, "tool_calls", true, promptTokens);
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("no port"));
			resolve({
				port: address.port,
				requests: () => seenRequests,
				setScript: (next) => (script = [...next]),
				close: () =>
					new Promise((res) => {
						server.close(() => res());
						server.closeAllConnections();
						res();
					}),
			});
		});
	});
}
