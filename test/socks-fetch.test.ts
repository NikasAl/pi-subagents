import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSocksFetch } from "../src/socks/socks-fetch.ts";
import { startSocks5Server, type Socks5Server } from "./helpers/socks5-server.ts";

describe("createSocksFetch against a real local SOCKS5 server", () => {
	let socks: Socks5Server;
	let httpServer: http.Server;
	let httpPort = 0;
	let hits = 0;

	beforeAll(async () => {
		socks = await startSocks5Server();
		httpServer = http.createServer((request, response) => {
			hits++;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, url: request.url, hits }));
		});
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		httpPort = (httpServer.address() as { port: number }).port;
	});

	afterAll(async () => {
		await socks.close();
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	});

	it("routes a GET through the SOCKS5 tunnel", async () => {
		const socksFetch = createSocksFetch({ host: "127.0.0.1", port: socks.port });
		const response = await socksFetch(`http://127.0.0.1:${httpPort}/hello?x=1`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; url: string };
		expect(body.ok).toBe(true);
		expect(body.url).toBe("/hello?x=1");
		expect(socks.connections()).toBeGreaterThan(0);
	});

	it("routes a POST with a JSON body through the tunnel", async () => {
		const socksFetch = createSocksFetch({ host: "127.0.0.1", port: socks.port });
		const response = await socksFetch(`http://127.0.0.1:${httpPort}/chat`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer test" },
			body: JSON.stringify({ model: "m", stream: true }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	it("surfaces a SOCKS failure when the tunnel target refuses", async () => {
		const socksFetch = createSocksFetch({ host: "127.0.0.1", port: socks.port });
		await expect(socksFetch("http://127.0.0.1:1/refused")).rejects.toThrow();
	});

	it("supports username/password auth (RFC 1929)", async () => {
		const authedSocks = await startSocks5Server({ requireAuth: true, username: "user", password: "pass" });
		try {
			const good = createSocksFetch({ host: "127.0.0.1", port: authedSocks.port, username: "user", password: "pass" });
			const response = await good(`http://127.0.0.1:${httpPort}/authed`);
			expect(response.status).toBe(200);

			const bad = createSocksFetch({ host: "127.0.0.1", port: authedSocks.port, username: "user", password: "wrong" });
			await expect(bad(`http://127.0.0.1:${httpPort}/authed`)).rejects.toThrow();
		} finally {
			await authedSocks.close();
		}
	});

	it("uses independent dispatchers per proxy config", async () => {
		const another = await startSocks5Server();
		try {
			const fetchA = createSocksFetch({ host: "127.0.0.1", port: socks.port });
			const fetchB = createSocksFetch({ host: "127.0.0.1", port: another.port });
			const a = await fetchA(`http://127.0.0.1:${httpPort}/a`);
			const b = await fetchB(`http://127.0.0.1:${httpPort}/b`);
			expect(a.status).toBe(200);
			expect(b.status).toBe(200);
			expect(another.connections()).toBeGreaterThan(0);
		} finally {
			await another.close();
		}
	});

	it("rejects SOCKS4 configs", () => {
		expect(() => createSocksFetch({ host: "127.0.0.1", port: 1080, type: 4 })).toThrow(/SOCKS4/);
	});
});
