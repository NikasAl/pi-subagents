/**
 * /ctx — "what fills the parent session's context" (observability command).
 *
 * Reads the current session branch through ctx.sessionManager (read-only) and
 * renders a compact report into the UI via ctx.ui.notify. The output NEVER
 * enters the model context: it is shown to the user only, like /roles.
 *
 * Numbers:
 *   - per assistant message ("turn"): provider-reported fresh input,
 *     cacheRead, cacheWrite, output and the estimated context size of that
 *     request (input + cacheRead + cacheWrite);
 *   - what the space goes to, estimated as serialized chars / 4 (rough by
 *     design): system prompt, user messages, assistant text + tool-call args,
 *     tool results per tool.
 *
 * Sessions with compaction: the branch still shows every turn that has an
 * assistant message; compacted-away entries are no longer message entries,
 * so they drop out of both the per-turn table and the size decomposition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Token estimate: serialized characters / 4 (rough by design). */
function est(chars: number): number {
	return Math.ceil(chars / 4);
}

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(n: number): string {
	return `$${n.toFixed(4)}`;
}

function jsonChars(value: unknown): number {
	try {
		return (JSON.stringify(value) ?? "").length;
	} catch {
		return 0;
	}
}

function messageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<Record<string, unknown>>)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("");
}

interface TurnRow {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	totalTokens: number;
	cost: number;
}

interface SizeStats {
	chars: number;
	calls: number;
	errors: number;
}

export interface SessionCtxStats {
	turns: TurnRow[];
	userChars: { chars: number; count: number };
	assistantTextChars: { chars: number; count: number };
	assistantArgsChars: { chars: number; count: number };
	tools: Map<string, SizeStats>;
	systemPromptChars: number;
}

/** Walk session entries (branch-aware) and collect usage + size statistics. */
export function buildSessionCtxStats(entries: readonly unknown[], systemPrompt?: string): SessionCtxStats {
	const turns: TurnRow[] = [];
	const userChars = { chars: 0, count: 0 };
	const assistantTextChars = { chars: 0, count: 0 };
	const assistantArgsChars = { chars: 0, count: 0 };
	const tools = new Map<string, SizeStats>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message") continue;
		const message = record.message as Record<string, unknown> | undefined;
		if (!message) continue;
		if (message.role === "assistant") {
			const usage = (message.usage ?? {}) as Record<string, unknown>;
			const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
			const cost = usage.cost as { total?: number } | undefined;
			turns.push({
				input: num("input"),
				cacheRead: num("cacheRead"),
				cacheWrite: num("cacheWrite"),
				output: num("output"),
				totalTokens: num("totalTokens"),
				cost: cost?.total ?? 0,
			});
			assistantTextChars.chars += messageText(message).length;
			assistantTextChars.count++;
			const content = message.content;
			if (Array.isArray(content)) {
				for (const block of content as Array<Record<string, unknown>>) {
					if (block.type === "toolCall") assistantArgsChars.chars += jsonChars(block.arguments);
				}
			}
			continue;
		}
		if (message.role === "user") {
			userChars.chars += messageText(message).length;
			userChars.count++;
			continue;
		}
		if (message.role === "toolResult") {
			const name = typeof message.toolName === "string" ? message.toolName : "(unknown)";
			const stats = tools.get(name) ?? { chars: 0, calls: 0, errors: 0 };
			stats.calls++;
			if (message.isError === true) stats.errors++;
			stats.chars += jsonChars(message.content);
			tools.set(name, stats);
		}
	}
	return { turns, userChars, assistantTextChars, assistantArgsChars, tools, systemPromptChars: systemPrompt?.length ?? 0 };
}

/** Render the /ctx report text from collected statistics. */
export function renderCtxReport(stats: SessionCtxStats, header: { sessionFile?: string; model?: string }): string {
	const turns = stats.turns;
	const lines: string[] = [];
	if (header.sessionFile) lines.push(`context of ${header.sessionFile}`);
	if (header.model) lines.push(`model: ${header.model}`);

	if (turns.length === 0) {
		lines.push("no assistant turns yet — nothing to report");
		return lines.join("\n");
	}

	const peak = Math.max(...turns.map((t) => t.input + t.cacheRead + t.cacheWrite));
	const totals = turns.reduce(
		(acc, t) => ({
			input: acc.input + t.input,
			cacheRead: acc.cacheRead + t.cacheRead,
			cacheWrite: acc.cacheWrite + t.cacheWrite,
			output: acc.output + t.output,
			cost: acc.cost + t.cost,
		}),
		{ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 },
	);
	lines.push(
		`requests: ${turns.length} · peak ctx ~${fmtTok(peak)} tok (in+cacheRead+cacheWrite) · cost ${fmtCost(totals.cost)}`,
		`totals: in ${fmtTok(totals.input)} · out ${fmtTok(totals.output)} · cacheRead ${fmtTok(totals.cacheRead)} · cacheWrite ${fmtTok(totals.cacheWrite)}`,
		"",
		"per turn (ctx~ = input + cacheRead + cacheWrite):",
		"  #    in       cacheRd  cacheWr  out      ctx~     cost",
	);
	const shown = turns.slice(-20);
	if (turns.length > shown.length) {
		const earlierPeak = Math.max(...turns.slice(0, -shown.length).map((t) => t.input + t.cacheRead + t.cacheWrite));
		lines.push(`  … ${turns.length - shown.length} earlier turns (peak ctx ~${fmtTok(earlierPeak)})`);
	}
	shown.forEach((t, i) => {
		const n = turns.length - shown.length + i + 1;
		lines.push(
			`  ${String(n).padStart(3)}  ${fmtTok(t.input).padStart(8)}  ${fmtTok(t.cacheRead).padStart(8)}  ${fmtTok(t.cacheWrite).padStart(8)}  ${fmtTok(t.output).padStart(8)}  ${fmtTok(t.input + t.cacheRead + t.cacheWrite).padStart(8)}  ${fmtCost(t.cost)}`,
		);
	});

	const toolItems = [...stats.tools.entries()]
		.map(([name, s]) => ({ name, tokens: est(s.chars), calls: s.calls, errors: s.errors }))
		.sort((a, b) => b.tokens - a.tokens);
	const items = [
		{ kind: "system prompt", tokens: est(stats.systemPromptChars), detail: "" },
		{
			kind: "user messages",
			tokens: est(stats.userChars.chars),
			detail: `(${stats.userChars.count} msg)`,
		},
		{
			kind: "assistant text",
			tokens: est(stats.assistantTextChars.chars),
			detail: `(${stats.assistantTextChars.count} msg)`,
		},
		{ kind: "tool-call args", tokens: est(stats.assistantArgsChars.chars), detail: "" },
		{
			kind: "tool results",
			tokens: toolItems.reduce((sum, t) => sum + t.tokens, 0),
			detail: toolItems
				.slice(0, 8)
				.map((t) => `${t.name} ${fmtTok(t.tokens)} (${t.calls} calls${t.errors ? `, ${t.errors} err` : ""})`)
				.join(", "),
		},
	].sort((a, b) => b.tokens - a.tokens);
	lines.push("", "top consumers of the current context (est tokens, chars/4):");
	for (const item of items) {
		lines.push(`  ${fmtTok(item.tokens).padStart(8)}  ${item.kind}${item.detail ? ` — ${item.detail}` : ""}`);
	}
	return lines.join("\n");
}

/** Build and register the /ctx command. */
export function registerCtxCommand(pi: ExtensionAPI): void {
	pi.registerCommand("ctx", {
		description: "Show what fills the current session context (usage per turn, top consumers)",
		handler: async (_name, ctx) => {
			let systemPrompt: string | undefined;
			try {
				systemPrompt = ctx.getSystemPrompt();
			} catch {
				/* some contexts (json -p) may not build a system prompt */
			}
			const stats = buildSessionCtxStats(ctx.sessionManager.buildContextEntries(), systemPrompt);
			const text = renderCtxReport(stats, {
				sessionFile: ctx.sessionManager.getSessionFile?.(),
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			});
			ctx.ui.notify(text, "info");
		},
	});
}
