/**
 * How much of Claude's and Codex's rate limits is used, app-wide.
 *
 * DevHub does not ask either CLI's account for its limits: it reads what the
 * running GUI Agents already report (`usage.rateLimit` on a conversation's
 * `usage` event — Claude's `rate_limit_event`, Codex's
 * `account/rateLimits/updated`). A limit belongs to the account, not to the
 * Agent, so every Agent of one CLI is reporting on the same limit, and the
 * readout keeps one reading per CLI.
 *
 * Which reading is the latest is decided by the reading, not by when it
 * arrived. A conversation replays its journal when DevHub starts, so the order
 * events arrive in across Agents says nothing about which is newer. Within one
 * window usage only grows, and a later window resets later: so the reading
 * with the later reset is newer, and between two with the same reset, the one
 * with more used. A reading that does not say when it resets cannot be
 * compared, and then the one that arrived last wins.
 *
 * A CLI no Agent has reported for is said to be unknown rather than zero.
 */

import type { UsageLimitsWire } from "../../ipc/contract.js";
import type { ConversationEvent, RateLimit } from "../../model/conversation.js";
import type { AgentId, AgentProfileKind } from "../../model/domain.js";

/** The CLIs that have a GUI, and so report their limits to DevHub. */
export const LIMITED_CLIS = ["claude", "codex"] as const;
export type LimitedCli = (typeof LIMITED_CLIS)[number];

export class UsageLimits {
	readonly #latest = new Map<LimitedCli, RateLimit>();

	/** Take a reading; whether it changed what the readout says. */
	observe(cli: LimitedCli, reading: RateLimit): boolean {
		const current = this.#latest.get(cli);
		if (current !== undefined && !supersedes(reading, current)) return false;
		if (
			current !== undefined &&
			current.usedPercent === reading.usedPercent &&
			current.resetsAt === reading.resetsAt
		) {
			return false;
		}
		this.#latest.set(cli, reading);
		return true;
	}

	wire(): UsageLimitsWire {
		return {
			clis: LIMITED_CLIS.map((cli) => {
				const reading = this.#latest.get(cli);
				return reading === undefined
					? { cli }
					: {
							cli,
							limit: {
								...(reading.usedPercent === undefined
									? {}
									: { usedPercent: reading.usedPercent }),
								...(reading.resetsAt === undefined
									? {}
									: { resetsAt: reading.resetsAt }),
							},
						};
			}),
		};
	}
}

function supersedes(next: RateLimit, current: RateLimit): boolean {
	if (next.resetsAt === undefined || current.resetsAt === undefined) {
		return true;
	}
	if (next.resetsAt !== current.resetsAt) {
		return next.resetsAt > current.resetsAt;
	}
	return (next.usedPercent ?? 0) >= (current.usedPercent ?? 0);
}

/**
 * Feed a conversation's events into the readout.
 *
 * `kindOf` answers which CLI an Agent runs, from the model. An Agent the
 * model no longer has is one whose row has already gone while its
 * conversation was being closed: its last word cannot be attributed, and is
 * not a limit anybody is looking at, so it is not taken. A GUI Agent of any
 * other kind is a broken rule — only Claude and Codex have a GUI — and says
 * so.
 */
export function usageLimitsListener(
	limits: UsageLimits,
	kindOf: (agentId: AgentId) => AgentProfileKind | undefined,
	publish: (wire: UsageLimitsWire) => void,
): (agentId: AgentId, revision: number, event: ConversationEvent) => void {
	return (agentId, _revision, event) => {
		if (event.type !== "usage") return;
		const reading = event.usage.rateLimit;
		if (reading === undefined) return;
		const kind = kindOf(agentId);
		if (kind === undefined) return;
		if (kind !== "claude" && kind !== "codex") {
			throw new Error(
				`a ${kind} Agent reported a rate limit, but only Claude and Codex have a GUI`,
			);
		}
		if (limits.observe(kind, reading)) publish(limits.wire());
	};
}
