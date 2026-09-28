/**
 * How much of Claude's and Codex's rate limits is used, app-wide.
 *
 * Two kinds of reading arrive here, through the one entry `observe`. DevHub
 * asks each CLI's account itself, in the background (`usageReaders.ts`: one
 * long-lived process per CLI, polled), so the readout is there without a GUI
 * Agent having run a turn. And the running GUI Agents report the same limits
 * on their own (`usage.rateLimits` on a conversation's `usage` event —
 * Claude's `rate_limit_event`, Codex's `account/rateLimits/updated`). A limit
 * belongs to the account, not to whoever read it, so every reading of one CLI
 * is a reading of the same limits, and the readout keeps one reading per
 * window of each CLI — Claude's five-hour and seven-day, Codex's primary and
 * secondary — in the order they were first reported.
 *
 * Which reading of a window is the latest is decided by the reading, not by when it
 * arrived. A conversation replays its journal when DevHub starts, so the order
 * readings arrive in across Agents and the reader says nothing about which is
 * newer. Within one
 * window usage only grows, and a later window resets later: so the reading
 * with the later reset is newer, and between two with the same reset, the one
 * with more used. A reading that does not say when it resets cannot be
 * compared, and then the one that arrived last wins.
 *
 * Besides windows, the reader can say two things of a CLI (`note`): that the
 * sign-in has no plan limits, and that the CLI's command is not on this Mac.
 * Each is the reader's latest word, replaced by the next one; a reading of
 * windows from the reader clears it. It sits beside the windows rather than
 * replacing them, and the Sidebar shows windows when there are any.
 *
 * A CLI nothing has reported for is said to be unknown rather than zero.
 */

import type { UsageLimitsWire, UsageNoteWire } from "../../ipc/contract.js";
import type {
	ConversationEvent,
	RateLimit,
	UsageReading,
} from "../../model/conversation.js";
import type { AgentId, AgentProfileKind } from "../../model/domain.js";

/**
 * The CLIs whose accounts have plan limits DevHub reads — the background
 * reader asks them, and they are the two with a GUI Agent that reports them.
 */
export const LIMITED_CLIS = ["claude", "codex"] as const;
export type LimitedCli = (typeof LIMITED_CLIS)[number];

export class UsageLimits {
	readonly #latest = new Map<LimitedCli, Map<string, RateLimit>>();
	readonly #notes = new Map<LimitedCli, UsageNoteWire>();

	/**
	 * The reader's word on a CLI besides its windows, or `undefined` to take
	 * it back; whether it changed what the readout says.
	 */
	note(cli: LimitedCli, note: UsageNoteWire | undefined): boolean {
		if (this.#notes.get(cli) === note) return false;
		if (note === undefined) this.#notes.delete(cli);
		else this.#notes.set(cli, note);
		return true;
	}

	/** Take a reading of one window; whether it changed what the readout says. */
	observe(cli: LimitedCli, reading: RateLimit): boolean {
		const windows = this.#latest.get(cli) ?? new Map<string, RateLimit>();
		this.#latest.set(cli, windows);
		const current = windows.get(reading.window);
		if (current !== undefined && !supersedes(reading, current)) return false;
		if (
			current !== undefined &&
			current.usedPercent === reading.usedPercent &&
			current.resetsAt === reading.resetsAt
		) {
			return false;
		}
		windows.set(reading.window, reading);
		return true;
	}

	wire(): UsageLimitsWire {
		return {
			clis: LIMITED_CLIS.map((cli) => {
				const windows = [...(this.#latest.get(cli)?.values() ?? [])];
				const note = this.#notes.get(cli);
				return windows.length === 0
					? { cli, ...(note === undefined ? {} : { note }) }
					: {
							cli,
							...(note === undefined ? {} : { note }),
							windows: windows.map((reading) => ({
								window: reading.window,
								...(reading.usedPercent === undefined
									? {}
									: { usedPercent: reading.usedPercent }),
								...(reading.resetsAt === undefined
									? {}
									: { resetsAt: reading.resetsAt }),
							})),
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
		const readings = event.usage.rateLimits;
		if (readings === undefined || readings.length === 0) return;
		const kind = kindOf(agentId);
		if (kind === undefined) return;
		if (kind !== "claude" && kind !== "codex") {
			throw new Error(
				`a ${kind} Agent reported a rate limit, but only Claude and Codex have a GUI`,
			);
		}
		// Every window is observed, whether or not an earlier one changed.
		const changed = readings
			.map((reading) => limits.observe(kind, reading))
			.includes(true);
		if (changed) publish(limits.wire());
	};
}

/**
 * Feed the background readers' word into the readout (`usageReaders.ts`):
 * each window of a reading through `observe`, exactly as a GUI Agent's, so the
 * two merge by the one rule above; a reading of windows takes back the
 * reader's note, and one of no plan limits is that note.
 */
export function usageReadingListener(
	limits: UsageLimits,
	publish: (wire: UsageLimitsWire) => void,
): {
	deliver(cli: LimitedCli, reading: UsageReading): void;
	note(cli: LimitedCli, note: UsageNoteWire): void;
} {
	return {
		deliver(cli, reading) {
			// Every window is observed, whether or not an earlier one changed.
			const changed =
				reading.kind === "no_plan_limits"
					? limits.note(cli, "no_plan_limits")
					: [
							...reading.windows.map((window) => limits.observe(cli, window)),
							limits.note(cli, undefined),
						].includes(true);
			if (changed) publish(limits.wire());
		},
		note(cli, note) {
			if (limits.note(cli, note)) publish(limits.wire());
		},
	};
}
