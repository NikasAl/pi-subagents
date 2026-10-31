import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../router/config.ts";
import { HealthTracker } from "../router/health.ts";
import type { ModelRef, RoleSticky, SubagentsConfig } from "../router/types.ts";
import { DEFAULT_POLICY } from "../router/types.ts";
import { parseExcludeList } from "../router/router.ts";

/** A role after merging the agent markdown file (prompt/tools) with config (fallback list). */
export interface EffectiveRole {
        name: string;
        description: string;
        /** System prompt sent to the child via --system-prompt (replaces pi's default). */
        systemPrompt: string;
        tools?: string[];
        /** Priority-ordered fallback list; index 0 = primary. */
        models: ModelRef[];
        sticky: RoleSticky;
        maxAttempts: number;
        timeoutMs: number;
        cwd?: string;
        thinking?: string;
        source: "agent-file" | "config" | "both";
        filePath?: string;
}

export interface AgentFileInfo {
        name: string;
        description: string;
        tools?: string[];
        model?: string;
        systemPrompt: string;
        filePath: string;
}

export const VIRTUAL_PROVIDER = "roles";

/** Discover role markdown files from `<agentDir>/agents/*.md` (user scope only). */
export function discoverAgentFiles(agentDir: string = getAgentDir()): AgentFileInfo[] {
        const dir = path.join(agentDir, "agents");
        let entries: fs.Dirent[];
        try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
                return [];
        }
        const files: AgentFileInfo[] = [];
        for (const entry of entries) {
                if (!entry.name.endsWith(".md")) continue;
                if (!entry.isFile() && !entry.isSymbolicLink()) continue;
                const filePath = path.join(dir, entry.name);
                let content: string;
                try {
                        content = fs.readFileSync(filePath, "utf-8");
                } catch {
                        continue;
                }
                const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
                if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
                const rawTools = frontmatter.tools;
                let tools: string[] | undefined;
                if (typeof rawTools === "string") {
                        tools = rawTools
                                .split(",")
                                .map((t) => t.trim())
                                .filter(Boolean);
                } else if (Array.isArray(rawTools)) {
                        tools = rawTools.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
                }
                files.push({
                        name: frontmatter.name,
                        description: frontmatter.description,
                        tools: tools && tools.length > 0 ? tools : undefined,
                        model: typeof frontmatter.model === "string" && frontmatter.model.trim() !== "" ? frontmatter.model.trim() : undefined,
                        systemPrompt: body.trim(),
                        filePath,
                });
        }
        return files;
}

export interface RuntimeOptions {
        /** Override the agent dir (tests). */
        agentDir?: string;
        /** Extra model refs considered configured (tests with mock providers). */
        alwaysConfigured?: Set<ModelRef>;
}

/**
 * Process-wide state of the extension: validated config, role registry,
 * shared health tracker, and the pi ModelRegistry captured from the first
 * available context (session_start / tool / command).
 */
export class Runtime {
        readonly agentDir: string;
        readonly config: SubagentsConfig;
        readonly configPath: string;
        readonly configMissing: boolean;
        readonly configError: Error | null;
        readonly health: HealthTracker;
        readonly envExcluded: Set<ModelRef>;
        /** Max parallel children (tool parallel mode). */
        readonly parallelLimit: number;
        /** Default directory for verbose tool-call logs. */
        readonly toolLogDir: string;
        /** Default directory for per-run context reports. */
        readonly ctxLogDir: string;
        modelRegistry: ModelRegistry | null = null;

        private readonly rolesByName = new Map<string, EffectiveRole>();
        private readonly alwaysConfigured: Set<ModelRef> | undefined;

        constructor(options: RuntimeOptions = {}) {
                this.agentDir = options.agentDir ?? getAgentDir();
                this.alwaysConfigured = options.alwaysConfigured;
                this.envExcluded = parseExcludeList(process.env["PI_SUBAGENTS_EXCLUDE"]);

                let config: SubagentsConfig = {};
                let configPathUsed = "";
                let configMissing = true;
                let configError: Error | null = null;
                try {
                        const loaded = loadConfig(this.agentDir);
                        config = loaded.config;
                        configPathUsed = loaded.path;
                        configMissing = loaded.missing;
                } catch (error) {
                        configError = error instanceof Error ? error : new Error(String(error));
                        configPathUsed = process.env["PI_SUBAGENTS_CONFIG"]?.trim() || path.join(this.agentDir, "pi-subagents.json");
                }
                this.config = config;
                this.configPath = configPathUsed;
                this.configMissing = configMissing;
                this.configError = configError;
                this.parallelLimit = config.defaults?.parallel ?? 4;
                this.toolLogDir = path.join(this.agentDir, "pi-subagents", "toollogs");
                this.ctxLogDir = path.join(this.agentDir, "pi-subagents", "ctxlogs");

                this.health = new HealthTracker(undefined, {
                        cooldowns: config.defaults?.cooldowns ?? {},
                        recoverySuccesses: config.defaults?.recoverySuccesses,
                });
                this.reloadRoles();
        }

        /** Merge agent markdown files with config role entries into effective roles. */
        reloadRoles(agentFiles?: AgentFileInfo[]): void {
                this.rolesByName.clear();
                const files = agentFiles ?? discoverAgentFiles(this.agentDir);
                const configRoles = this.config.roles ?? {};
                const names = new Set([...Object.keys(configRoles), ...files.map((f) => f.name)]);
                for (const name of names) {
                        const file = files.find((f) => f.name === name);
                        const cfg = configRoles[name];
                        const models = cfg?.models?.length ? [...cfg.models] : file?.model ? [file.model] : [];
                        if (models.length === 0) continue; // a role without any model is not runnable
                        const role: EffectiveRole = {
                                name,
                                description: file?.description ?? `Configured role (fallback list: ${models.join(", ")})`,
                                systemPrompt:
                                        file?.systemPrompt ||
                                        `You are the "${name}" subagent. Complete the assigned task autonomously and return a concise final report.`,
                                tools: file?.tools,
                                models,
                                sticky: cfg?.sticky ?? "turn",
                                maxAttempts: Math.max(1, Math.min(cfg?.maxAttempts ?? 2, models.length)),
                                timeoutMs: cfg?.timeoutMs ?? 600_000,
                                cwd: cfg?.cwd,
                                thinking: cfg?.thinking,
                                source: file && cfg ? "both" : file ? "agent-file" : "config",
                                filePath: file?.filePath,
                        };
                        this.rolesByName.set(name, role);
                }
        }

        getRole(name: string): EffectiveRole | undefined {
                return this.rolesByName.get(name);
        }

        roles(): EffectiveRole[] {
                return [...this.rolesByName.values()];
        }

        /** Availability predicate bound to the captured pi ModelRegistry. */
        isConfigured = (ref: ModelRef): boolean => {
                if (this.alwaysConfigured?.has(ref)) return true;
                const registry = this.modelRegistry;
                if (!registry) return false;
                const slash = ref.indexOf("/");
                if (slash <= 0) return false;
                const model = registry.find(ref.slice(0, slash), ref.slice(slash + 1));
                return model !== undefined && registry.hasConfiguredAuth(model);
        };

        isHealthy = (ref: ModelRef): boolean => {
                if (this.envExcluded.has(ref)) return false;
                return this.health.isHealthy(ref);
        };

        /** Cooldown policy merged with config defaults. */
        get policy() {
                return {
                        ...DEFAULT_POLICY,
                        cooldowns: { ...DEFAULT_POLICY.cooldowns, ...(this.config.defaults?.cooldowns ?? {}) },
                        recoverySuccesses: this.config.defaults?.recoverySuccesses ?? DEFAULT_POLICY.recoverySuccesses,
                };
        }
}

/** Default project agents dir note: we deliberately do NOT load `.pi/agents`. */
export const AGENTS_DIR_HINT = `roles are read from <agentDir>/agents (project .pi/${CONFIG_DIR_NAME}/agents is intentionally not loaded)`;
