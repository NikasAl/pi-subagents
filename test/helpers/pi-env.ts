import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePiCli } from "../../src/subagents/child.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ENTRY_TS = path.join(REPO_ROOT, "src", "index.ts");

/** Build an isolated agent dir with settings, config and role agent files. */
export function makeAgentDir(options: { config: unknown; agents?: Record<string, string>; settings?: Record<string, unknown> }): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
        fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
        fs.writeFileSync(
                path.join(dir, "settings.json"),
                JSON.stringify(
                        options.settings ?? {
                                defaultThinkingLevel: "off",
                                retry: { enabled: true, maxRetries: 3, baseDelayMs: 100, maxAgentDelayMs: 500 },
                        },
                        null,
                        2,
                ),
        );
        fs.writeFileSync(path.join(dir, "pi-subagents.json"), JSON.stringify(options.config, null, 2));
        for (const [name, body] of Object.entries(options.agents ?? {})) {
                fs.writeFileSync(path.join(dir, "agents", `${name}.md`), body);
        }
        return dir;
}

export function agentFileContent(input: { name: string; description: string; model?: string; tools?: string; body: string }): string {
        const lines = ["---", `name: ${input.name}`, `description: ${input.description}`];
        if (input.model) lines.push(`model: ${input.model}`);
        if (input.tools) lines.push(`tools: ${input.tools}`);
        lines.push("---", "", input.body);
        return lines.join("\n");
}

/** Child pi invocation: `[node, cli.js]`. */
export function piCommand(): { command: string; baseArgs: string[] } {
        const cli = resolvePiCli();
        if (!cli) throw new Error("pi CLI not found; run npm install in the repo root");
        return cli;
}

export interface RunPiOptions {
        agentDir: string;
        args: string[];
        env?: Record<string, string>;
        timeoutMs?: number;
        cwd?: string;
}

/** Run pi as an end user would (json mode), collecting stdout/stderr. */
export function runPi(options: RunPiOptions): Promise<{ code: number; stdout: string; stderr: string }> {
        const cli = piCommand();
        return new Promise((resolve) => {
                // Async spawn: the test process must keep its event loop free — the mock
                // LLM and SOCKS5 servers live in this same process.
                const child = spawn(cli.command, [...cli.baseArgs, ...options.args], {
                        cwd: options.cwd ?? os.tmpdir(),
                        env: {
                                ...process.env,
                                PI_CODING_AGENT_DIR: options.agentDir,
                                PI_OFFLINE: "1",
                                ...options.env,
                        },
                        stdio: ["ignore", "pipe", "pipe"],
                });
                let stdout = "";
                let stderr = "";
                const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
                child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
                child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
                child.on("error", (error) => {
                        stderr += `spawn error: ${error.message}\n`;
                });
                child.on("close", (code) => {
                        if (timer) clearTimeout(timer);
                        resolve({ code: code ?? -1, stdout, stderr });
                });
        });
}

/** Parse JSONL events from `pi --mode json` stdout. */
export function parseEvents(stdout: string): Array<Record<string, unknown>> {
        const events: Array<Record<string, unknown>> = [];
        for (const line of stdout.split("\n")) {
                if (!line.trim()) continue;
                try {
                        events.push(JSON.parse(line));
                } catch {
                        /* non-JSON diagnostics */
                }
        }
        return events;
}

export function finalAssistantText(events: Array<Record<string, unknown>>): string | null {
        let text: string | null = null;
        for (const event of events) {
                if (event.type !== "message_end") continue;
                const message = event.message as Record<string, unknown> | undefined;
                if (!message || message.role !== "assistant") continue;
                const content = message.content;
                if (typeof content === "string") text = content;
                else if (Array.isArray(content)) {
                        const parts: string[] = [];
                        for (const block of content as Array<Record<string, unknown>>) {
                                if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
                        }
                        if (parts.length > 0) text = parts.join("");
                }
        }
        return text;
}
