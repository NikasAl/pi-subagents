import type { AttemptRecord } from "./tool.ts";

/** Human-readable attempt trace used in tool results and /roles output. */
export function formatAttempts(attempts: AttemptRecord[]): string {
	if (attempts.length === 0) return "attempts: (none — no model was available)";
	return attempts
		.map((attempt, index) => {
			const status = attempt.ok ? "ok" : `failed[${attempt.errorClass ?? "error"}]`;
			const detail = attempt.ok
				? `model=${attempt.model ?? attempt.ref}`
				: `${attempt.errorMessage?.split("\n").slice(-1)[0] ?? "(no error text)"} (exit ${attempt.exitCode}${attempt.stopReason ? `, stop=${attempt.stopReason}` : ""})`;
			return `attempt ${index + 1}: ${attempt.ref} → ${status}: ${detail}`;
		})
		.join("\n");
}
