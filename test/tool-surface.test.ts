/**
 * Model-facing surface of the `subagent` tool.
 *
 * Regression guard for the failure observed in real sessions: the role roster
 * was absent from the tool description, so the model invented role names
 * (`vision`, `coder`, `recon`, `review`) and learned the real ones only from
 * the error message — one wasted round trip per first delegation.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Runtime } from "../src/subagents/runtime.ts";
import { buildParams, buildSubagentDescription, registerSubagentTool, resolveRole, roleRoster } from "../src/subagents/tool.ts";
import { agentFileContent, makeAgentDir } from "./helpers/pi-env.ts";

const ROLES = [
        { name: "scout", purpose: "Fast read-only recon of the codebase", body: "You are scout." },
        { name: "worker", purpose: "Implements one task end-to-end", body: "You are worker." },
        { name: "reviewer", purpose: "Reviews changes and ranks findings by severity", body: "You are reviewer." },
        { name: "vision", purpose: "Inspects image files and reports findings as text", body: "You are vision." },
];

function makeRuntime(): Runtime {
        const agentDir = makeAgentDir({
                config: { roles: Object.fromEntries(ROLES.map((role) => [role.name, { models: ["mock/model"] }])) },
                agents: Object.fromEntries(
                        ROLES.map((role) => [
                                role.name,
                                agentFileContent({ name: role.name, description: role.purpose, model: "mock/model", tools: "read", body: role.body }),
                        ]),
                ),
        });
        return new Runtime({ agentDir, alwaysConfigured: new Set(["mock/model"]) });
}

function captureTool(runtime: Runtime) {
        let definition: Record<string, unknown> | undefined;
        const pi = {
                registerTool: (candidate: Record<string, unknown>) => {
                        definition = candidate;
                },
        } as unknown as ExtensionAPI;
        registerSubagentTool(pi, runtime);
        if (!definition) throw new Error("subagent tool was not registered");
        return definition;
}

describe("subagent tool description", () => {
        it("lists every role together with its purpose", () => {
                const runtime = makeRuntime();
                const description = buildSubagentDescription(runtime);
                for (const role of ROLES) {
                        expect(description).toContain(`- ${role.name}: ${role.purpose}`);
                }
        });

        it("states the child isolation contract instead of leaving it implicit", () => {
                const description = buildSubagentDescription(makeRuntime());
                expect(description).toContain("AGENTS.md");
                expect(description).toContain("skills");
                expect(description).toContain("does not see this conversation");
        });

        it("never points the model at the /roles command as the only source of role names", () => {
                const description = buildSubagentDescription(makeRuntime());
                // /roles may still be mentioned (model fallbacks), but the roster must be inline.
                expect(description).toContain("- scout:");
                expect(description).toContain("- worker:");
        });

        it("says so when no roles are configured", () => {
                const agentDir = makeAgentDir({ config: {}, agents: {} });
                const description = buildSubagentDescription(new Runtime({ agentDir }));
                expect(description).toContain("none configured");
        });
});

describe("subagent tool parameters", () => {
        it("restricts role to a closed enum in single and parallel mode", () => {
                const schema = buildParams(["planner", "scout"]);
                const json = JSON.stringify(schema);
                expect(json).toContain('"enum":["planner","scout"]');
                // one enum on the single-mode role, one on the parallel task item
                expect(json.match(/"enum":\["planner","scout"\]/g)).toHaveLength(2);
        });

        it("generates the enum from the live roster", () => {
                const runtime = makeRuntime();
                const json = JSON.stringify(buildParams(runtime.roles().map((role) => role.name)));
                for (const role of ROLES) expect(json).toContain(role.name);
        });

        it("keeps role enumeration out of the way when no roles exist", () => {
                const schema = buildParams([]);
                expect(JSON.stringify(schema)).not.toContain('"enum"');
        });
});

describe("role resolution", () => {
        it("accepts exact names", () => {
                expect(resolveRole(makeRuntime(), "scout")?.role.name).toBe("scout");
        });

        it("accepts names in a different case", () => {
                const resolved = resolveRole(makeRuntime(), " Reviewer ");
                expect(resolved?.role.name).toBe("reviewer");
                expect(resolved?.correctedFrom).toBe("Reviewer");
        });

        it("maps the near-synonyms models actually invent onto real roles", () => {
                const runtime = makeRuntime();
                expect(resolveRole(runtime, "recon")?.role.name).toBe("scout");
                expect(resolveRole(runtime, "review")?.role.name).toBe("reviewer");
                expect(resolveRole(runtime, "coder")?.role.name).toBe("worker");
                expect(resolveRole(runtime, "implementation")?.role.name).toBe("worker");
                expect(resolveRole(runtime, "image-check")?.role.name).toBe("vision");
                expect(resolveRole(runtime, "screenshots")?.role.name).toBe("vision");
        });

        it("reports unknown names instead of guessing", () => {
                expect(resolveRole(makeRuntime(), "oracle")).toBeNull();
        });
});

describe("registration and error surface", () => {
        it("registers a description containing the roster", () => {
                const tool = captureTool(makeRuntime());
                const description = String(tool.description);
                for (const role of ROLES) expect(description).toContain(`- ${role.name}: ${role.purpose}`);
                expect(JSON.stringify(tool.parameters)).toContain('"enum":["reviewer","scout","vision","worker"]');
        });

        it("names the subagent tool and the roster in its prompt guidelines", () => {
                const tool = captureTool(makeRuntime());
                const guidelines = (tool.promptGuidelines as string[]).join("\n");
                expect(guidelines).toContain("subagent tool");
                expect(guidelines).toContain("roster");
                expect(guidelines).toContain("never invent a role name");
        });

        it("answers an unknown role with the roster plus purposes", async () => {
                const tool = captureTool(makeRuntime());
                const execute = tool.execute as (
                        id: string,
                        params: unknown,
                        signal: AbortSignal | undefined,
                        onUpdate: undefined,
                        ctx: unknown,
                ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
                const result = await execute("call-1", { role: "oracle", task: "look at the screenshots" }, undefined, undefined, {});
                expect(result.isError).toBe(true);
                const text = result.content[0]!.text;
                expect(text).toContain('Unknown role "oracle"');
                for (const role of ROLES) expect(text).toContain(`${role.name} — ${role.purpose}`);
        });

        it("formats the roster for error messages in a stable order", () => {
                expect(roleRoster(makeRuntime()).startsWith("reviewer — ")).toBe(true);
        });
});
