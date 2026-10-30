import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Events we extract from the child's JSON stream. */
export interface ChildMessageSummary {
        role: string;
        /** Physical model id reported by the assistant message. */
        model?: string;
        /** Physical provider reported by the assistant message. */
        provider?: string;
        stopReason?: string;
        errorMessage?: string;
        text?: string;
        usage?: {
                input: number;
                output: number;
                cacheRead: number;
                cacheWrite: number;
                totalTokens: number;
                cost: number;
        };
}

export interface ChildRunResult {
        exitCode: number;
        /** Assistant messages observed (final responses), in order. */
        assistantMessages: ChildMessageSummary[];
        /** Tool result texts observed (for transparency/debugging). */
        toolResultCount: number;
        stderr: string;
        /** Last assistant text, if any. */
        finalText: string | null;
        /** Physical model of the last successful assistant message. */
        modelUsed: string | null;
        stopReason: string | null;
        errorMessage: string | null;
        /** Aggregate usage across assistant messages. */
        usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
        timedOut: boolean;
        aborted: boolean;
}

export interface RunChildOptions {
        cwd?: string;
        signal?: AbortSignal;
        timeoutMs?: number;
        /** Extra env entries (e.g. PI_SUBAGENTS_EXCLUDE). */
        env?: Record<string, string>;
        /** Called for each parsed JSONL record (transparency hook). */
        onEvent?: (event: Record<string, unknown>) => void;
}

/** Find `<root>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` walking up from `fromDir`. */
function findPiCliWalkingUp(fromDir: string): string | null {
        let current = fromDir;
        while (true) {
                const candidate = path.join(current, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
                if (fs.existsSync(candidate)) return candidate;
                const parent = path.dirname(current);
                if (parent === current) return null;
                current = parent;
        }
}

/** Resolve the pi CLI script of the bundled package (same install as this extension). */
export function resolvePiCli(): { command: string; baseArgs: string[] } | null {
        try {
                const here = path.dirname(fileURLToPath(import.meta.url));
                const cliPath = findPiCliWalkingUp(here);
                if (cliPath) return { command: process.execPath, baseArgs: [cliPath] };
        } catch {
                /* fall through */
        }
        // Fallback 1: the running pi CLI itself (process.argv[1]). Follow symlinks:
        // managed installs exec the npm shim `node_modules/.bin/pi`, which resolves to
        // `dist/bundle/cli.js` — the shim path itself does not end in cli.js.
        const running = process.argv[1];
        if (running && fs.existsSync(running)) {
                let real = running;
                try {
                        real = fs.realpathSync(running);
                } catch {
                        /* keep raw path */
                }
                if (/cli\.js$|rpc-entry\.js$/.test(real) || /cli\.js$|rpc-entry\.js$/.test(running)) {
                        return { command: process.execPath, baseArgs: [real] };
                }
        }
        // Fallback 2: managed pi install root (PI_MANAGED_INSTALL_ROOT is set by the pi launcher).
        const managedRoot = process.env["PI_MANAGED_INSTALL_ROOT"];
        if (managedRoot) {
                try {
                        const version = fs.readFileSync(path.join(managedRoot, "current-version"), "utf-8").trim();
                        const cliPath = path.join(
                                managedRoot,
                                "releases",
                                version,
                                "node_modules",
                                "@earendil-works",
                                "pi-coding-agent",
                                "dist",
                                "bundle",
                                "cli.js",
                        );
                        if (fs.existsSync(cliPath)) return { command: process.execPath, baseArgs: [cliPath] };
                } catch {
                        /* fall through */
                }
        }
        return null;
}

/** Absolute path of this package's extension entry (used with `-e` in children). */
export function extensionEntryPath(): string {
        // index.ts is the entry; resolve relative to this module (src/subagents -> ../index.ts).
        return fileURLToPath(new URL("../index.ts", import.meta.url));
}

/** Build the child pi argument list for one role attempt. */
export function buildChildArgs(options: {
        roleName: string;
        task: string;
        systemPromptPath: string;
        tools?: string[];
        thinking?: string;
        entryPath?: string;
}): string[] {
        const entry = options.entryPath ?? extensionEntryPath();
        const args = [
                "--mode",
                "json",
                "-p",
                "--no-session",
                // Deterministic child environment: no discovered extensions/skills/context files.
                "-ne",
                "-e",
                entry,
                "-nc",
                "--no-skills",
                // Role owns the whole system prompt (replaces pi's default).
                "--system-prompt",
                options.systemPromptPath,
                "--model",
                `roles/${options.roleName}`,
        ];
        if (options.thinking) args.push("--thinking", options.thinking);
        if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
        args.push("--", options.task);
        return args;
}

export function writeTempPromptFile(roleName: string, systemPrompt: string): { dir: string; filePath: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
        const safeName = roleName.replace(/[^\w.-]+/g, "_");
        const filePath = path.join(dir, `system-prompt-${safeName}.md`);
        fs.writeFileSync(filePath, systemPrompt, { encoding: "utf-8", mode: 0o600 });
        return { dir, filePath };
}

export function cleanupTempPromptFile(file: { dir: string; filePath: string } | null): void {
        if (!file) return;
        try {
                fs.rmSync(file.dir, { recursive: true, force: true });
        } catch {
                /* ignore */
        }
}

interface UsageAccumulator {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: number;
}

function emptyUsage(): UsageAccumulator {
        return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function addUsage(target: UsageAccumulator, usage: Record<string, unknown> | undefined): void {
        if (!usage) return;
        target.input += (usage.input as number) || 0;
        target.output += (usage.output as number) || 0;
        target.cacheRead += (usage.cacheRead as number) || 0;
        target.cacheWrite += (usage.cacheWrite as number) || 0;
        target.totalTokens += (usage.totalTokens as number) || 0;
        const cost = usage.cost as { total?: number } | undefined;
        target.cost += cost?.total || 0;
}

/**
 * Spawn a child `pi --mode json -p --no-session ...` and collect its events.
 *
 * The child prints JSONL on stdout; we parse strictly line-by-line (no
 * readline: Unicode line/paragraph separators inside JSON strings are not
 * record boundaries, matching docs/json.md framing rules).
 */
export function runChild(cli: { command: string; baseArgs: string[] }, args: string[], options: RunChildOptions = {}): Promise<ChildRunResult> {
        return new Promise((resolve) => {
                const childEnv = { ...process.env, ...(options.env ?? {}) };
                const proc = spawn(cli.command, [...cli.baseArgs, ...args], {
                        cwd: options.cwd ?? process.cwd(),
                        env: childEnv,
                        shell: false,
                        stdio: ["ignore", "pipe", "pipe"],
                });

                const result: ChildRunResult = {
                        exitCode: -1,
                        assistantMessages: [],
                        toolResultCount: 0,
                        stderr: "",
                        finalText: null,
                        modelUsed: null,
                        stopReason: null,
                        errorMessage: null,
                        usage: emptyUsage(),
                        timedOut: false,
                        aborted: false,
                };

                let buffer = "";
                let settled = false;
                let timeout: NodeJS.Timeout | null = null;
                const abortHandler = () => {
                        result.aborted = true;
                        proc.kill("SIGTERM");
                        setTimeout(() => {
                                if (!proc.killed) proc.kill("SIGKILL");
                        }, 5000).unref();
                };

                const finish = (exitCode: number) => {
                        if (settled) return;
                        settled = true;
                        if (timeout) clearTimeout(timeout);
                        if (options.signal) options.signal.removeEventListener("abort", abortHandler);
                        result.exitCode = exitCode;
                        resolve(result);
                };

                if (options.timeoutMs && options.timeoutMs > 0) {
                        timeout = setTimeout(() => {
                                result.timedOut = true;
                                proc.kill("SIGTERM");
                                setTimeout(() => {
                                        if (!proc.killed) proc.kill("SIGKILL");
                                }, 5000).unref();
                        }, options.timeoutMs);
                        timeout.unref?.();
                }
                if (options.signal) {
                        if (options.signal.aborted) abortHandler();
                        else options.signal.addEventListener("abort", abortHandler, { once: true });
                }

                const processLine = (line: string) => {
                        if (!line.trim()) return;
                        let event: Record<string, unknown>;
                        try {
                                event = JSON.parse(line) as Record<string, unknown>;
                        } catch {
                                return; // not JSON: ignore (child diagnostics)
                        }
                        options.onEvent?.(event);
                        const type = event.type as string | undefined;

                        if (type === "message_end" && event.message) {
                                const message = event.message as Record<string, unknown>;
                                const role = message.role as string;
                                if (role === "assistant") {
                                        const summary: ChildMessageSummary = { role };
                                        if (typeof message.model === "string") summary.model = message.model;
                                        if (typeof message.provider === "string") summary.provider = message.provider;
                                        if (typeof message.stopReason === "string") summary.stopReason = message.stopReason;
                                        if (typeof message.errorMessage === "string") summary.errorMessage = message.errorMessage;
                                        const content = message.content;
                                        let text: string | undefined;
                                        if (typeof content === "string") {
                                                text = content;
                                        } else if (Array.isArray(content)) {
                                                const parts: string[] = [];
                                                for (const block of content as Array<Record<string, unknown>>) {
                                                        if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
                                                }
                                                text = parts.join("");
                                        }
                                        summary.text = text;
                                        summary.usage = {
                                                input: 0,
                                                output: 0,
                                                cacheRead: 0,
                                                cacheWrite: 0,
                                                totalTokens: 0,
                                                cost: 0,
                                        };
                                        const usage = message.usage as Record<string, unknown> | undefined;
                                        addUsage(summary.usage, usage);
                                        addUsage(result.usage, usage);
                                        if (summary.stopReason !== "aborted" && summary.stopReason !== "error" && text && text.trim()) {
                                                result.finalText = text;
                                                // Physical executor that actually answered, as provider/id.
                                                result.modelUsed = summary.provider
                                                        ? `${summary.provider}/${summary.model ?? ""}`.replace(/\/$/, "")
                                                        : (summary.model ?? result.modelUsed);
                                        }
                                        result.assistantMessages.push(summary);
                                        result.stopReason = summary.stopReason ?? result.stopReason;
                                        if (summary.errorMessage) result.errorMessage = summary.errorMessage;
                                }
                        } else if (type === "tool_result_end") {
                                result.toolResultCount++;
                        }
                };

                proc.stdout!.on("data", (data: Buffer) => {
                        buffer += data.toString("utf-8");
                        const lines = buffer.split("\n");
                        buffer = lines.pop() ?? "";
                        for (const line of lines) processLine(line);
                });
                proc.stderr!.on("data", (data: Buffer) => {
                        result.stderr += data.toString("utf-8");
                });
                proc.on("error", (error) => {
                        result.stderr += `spawn error: ${error.message}\n`;
                        finish(1);
                });
                proc.on("close", (code) => {
                        if (buffer.trim()) processLine(buffer);
                        finish(code ?? 0);
                });
        });
}

/**
 * Whether a child run should trigger a level-1 respawn with the next model:
 * the child failed before producing any usable final text.
 * User aborts never respawn.
 */
export function shouldRespawn(result: ChildRunResult): boolean {
        if (result.aborted) return false;
        if (result.finalText && result.finalText.trim()) return false;
        if (result.timedOut) return true;
        if (result.exitCode !== 0) return true;
        if (result.stopReason === "error" || result.stopReason === "aborted") return result.stopReason === "error";
        return false;
}

/** Best-effort error text from a failed child run. */
export function childErrorText(result: ChildRunResult): string {
        return (
                result.errorMessage ||
                (result.stopReason === "aborted" ? "aborted" : null) ||
                result.finalText?.slice(0, 2000) ||
                result.stderr.trim().split("\n").filter(Boolean).slice(-3).join("\n") ||
                `(exit code ${result.exitCode})`
        );
}
