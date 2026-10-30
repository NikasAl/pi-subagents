import * as net from "node:net";

/**
 * Minimal SOCKS5 server for tests (RFC 1928 subset):
 * - greeting with no-auth (0x00) or username/password (0x02) method selection;
 * - CONNECT command only; ATYP 1 (IPv4), 3 (domain), 4 (IPv6);
 * - then a plain TCP relay.
 */
export interface Socks5Server {
        port: number;
        close(): Promise<void>;
        /** How many CONNECT handshakes were completed. */
        connections(): number;
}

interface PendingAuth {
        requireAuth: boolean;
        username?: string;
        password?: string;
}

export function startSocks5Server(options: { requireAuth?: boolean; username?: string; password?: string } = {}): Promise<Socks5Server> {
        const auth: PendingAuth = {
                requireAuth: Boolean(options.requireAuth),
                username: options.username,
                password: options.password,
        };
        let connectCount = 0;
        const openSockets = new Set<net.Socket>();
        const server = net.createServer((socket) => {
                openSockets.add(socket);
                socket.on("close", () => openSockets.delete(socket));
                let stage: "greeting" | "auth" | "request" | "relay" = "greeting";
                let buffered = Buffer.alloc(0);
                let target: net.Socket | null = null;
                let authOk = false;

                const cleanup = () => {
                        target?.destroy();
                        socket.destroy();
                };

                const relay = () => {
                        stage = "relay";
                        socket.on("data", (chunk) => target!.write(chunk));
                        target!.on("data", (chunk) => socket.write(chunk));
                        socket.on("error", cleanup);
                        target!.on("error", cleanup);
                        socket.on("close", cleanup);
                        target!.on("close", () => socket.destroy());
                };

                const handleData = (chunk: Buffer) => {
                        if (stage === "relay") return; // handled by pipe listeners
                        buffered = Buffer.concat([buffered, chunk]);

                        if (stage === "greeting") {
                                if (buffered.length < 2) return;
                                const ver = buffered[0]!;
                                const nmethods = buffered[1]!;
                                if (ver !== 5) return cleanup();
                                if (buffered.length < 2 + nmethods) return;
                                const methods = [...buffered.subarray(2, 2 + nmethods)];
                                buffered = buffered.subarray(2 + nmethods);
                                const wantAuth = Boolean(auth.requireAuth && auth.username);
                                const method = wantAuth && methods.includes(0x02) ? 0x02 : methods.includes(0x00) ? 0x00 : null;
                                if (method === null) {
                                        socket.write(Buffer.from([0x05, 0xff]));
                                        return cleanup();
                                }
                                socket.write(Buffer.from([0x05, method]));
                                if (method === 0x02) {
                                        stage = "auth";
                                        authOk = false;
                                } else {
                                        stage = "request";
                                        authOk = true;
                                }
                                return;
                        }

                        if (stage === "auth") {
                                // VER(1) ULEN(1) UNAME PLEN(1) PASSWD
                                if (buffered.length < 2) return;
                                const ulen = buffered[1]!;
                                if (buffered.length < 2 + ulen + 1) return;
                                const plen = buffered[2 + ulen]!;
                                if (buffered.length < 3 + ulen + plen) return;
                                const uname = buffered.subarray(2, 2 + ulen).toString("utf-8");
                                const passwd = buffered.subarray(3 + ulen, 3 + ulen + plen).toString("utf-8");
                                buffered = buffered.subarray(3 + ulen + plen);
                                const ok = uname === auth.username && passwd === auth.password;
                                socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
                                if (!ok) return cleanup();
                                authOk = true;
                                stage = "request";
                                return;
                        }

                        if (stage === "request") {
                                // VER(1) CMD(1) RSV(1) ATYP(1) ADDR(var) PORT(2)
                                if (buffered.length < 4) return;
                                const atyp = buffered[3]!;
                                let addrLen = 0;
                                if (atyp === 1) addrLen = 4;
                                else if (atyp === 3) addrLen = 1 + buffered[4]!;
                                else if (atyp === 4) addrLen = 16;
                                else {
                                        socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                                        return cleanup();
                                }
                                const total = 4 + addrLen + 2;
                                if (buffered.length < total) return;
                                const cmd = buffered[1]!;
                                let host = "";
                                if (atyp === 1) host = [...buffered.subarray(4, 8)].join(".");
                                else if (atyp === 3) host = buffered.subarray(5, 5 + (addrLen - 1)).toString("utf-8");
                                else host = [...buffered.subarray(4, 20)].join(".");
                                const port = buffered.readUInt16BE(total - 2);
                                buffered = buffered.subarray(total);

                                if (cmd !== 1) {
                                        socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                                        return cleanup();
                                }
                                if (!authOk) {
                                        socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                                        return cleanup();
                                }

                                const upstream = net.createConnection({ host, port }, () => {
                                        connectCount++;
                                        // Success reply: BND.ADDR 0.0.0.0, BND.PORT 0.
                                        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                                        target = upstream;
                                        if (buffered.length > 0) upstream.write(buffered);
                                        buffered = Buffer.alloc(0);
                                        relay();
                                });
                                upstream.on("error", () => {
                                        // Host unreachable / connection refused -> SOCKS general failure.
                                        socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                                        cleanup();
                                });
                        }
                };

                socket.on("data", handleData);
                socket.on("error", () => {
                        target?.destroy();
                });
        });

        return new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                        const address = server.address();
                        if (!address || typeof address === "string") return reject(new Error("no port"));
                        resolve({
                                port: address.port,
                                connections: () => connectCount,
                                close: () =>
                                        new Promise((res) => {
                                                server.close(() => res());
                                                for (const socket of openSockets) socket.destroy();
                                                res();
                                        }),
                        });
                });
        });
}
