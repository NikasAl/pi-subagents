import type { FailureClass } from "./types.ts";

/**
 * Classify a provider/model failure from its message so the router can pick a
 * matching cooldown. Recognizes common shapes from OpenAI/Anthropic-compatible
 * APIs plus Node network errors. Conservative default: "unknown".
 */
export function classifyFailure(...texts: Array<string | null | undefined>): FailureClass {
	const text = texts.filter(Boolean).join(" ").toLowerCase();
	if (!text) return "unknown";

	if (/(429|rate.?limit|too many requests|throttl)/.test(text)) return "rate_limit";
	if (/(quota|billing|insufficient|exceeded your (current|spend)|credit|payment)/.test(text)) return "quota";
	if (/(5\d\d|overloaded|overload|temporarily unavailable|capacity|server error|bad gateway|service unavailable)/.test(text))
		return "overloaded";
	if (/(401|403|unauthorized|forbidden|invalid api key|invalid_api_key|authentication|permission)/.test(text)) return "auth";
	if (
		/(econnrefused|econnreset|econnaborted|epipe|ehostunreach|enetunreach|enotfound|eai_again|etimedout|timeout|timed out|socket hang up|fetch failed|network|dns|aborted.*before.*response)/.test(
			text,
		)
	)
		return "network";

	return "unknown";
}
