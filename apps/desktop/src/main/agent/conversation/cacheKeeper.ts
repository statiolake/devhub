/**
 * Compacting an idle GUI Agent's conversation just before its prompt cache
 * goes cold (`[agents] auto_compact_before_cache_expiry`).
 *
 * The adapter works out when the main conversation's cached prefix expires
 * (`Usage.promptCache.expiresAt`: the last response's time plus the TTL of
 * the last cache write). A conversation left idle past that point costs a
 * full re-write of its whole prefix on the next message. Sending `/compact`
 * while the cache is still warm reads that prefix from cache for the
 * summary, and leaves a much smaller conversation whose next re-write is
 * cheap. The cache matters only when the compaction's request starts, so
 * `lead` has to cover the time to get it written and sent, with margin.
 *
 * It fires at most once per warm period (one `expiresAt`), only while the
 * Agent is fully idle — no turn, no question, nothing held, sending or
 * compacting, no usage-limit resume standing — only for a conversation of at
 * least `minTokens` of context, and never when the conversation has not
 * moved on since its last compaction. A timer that comes late (the Mac
 * slept) finds less than `MIN_REMAINING_MS` left, or the cache already cold,
 * and does nothing. Anything the person does moves the conversation on,
 * which is re-observed: a busy Agent at the deadline is skipped.
 */

import type { Transcript } from "../../../model/conversation.js";
import type { LimitResumeClock } from "./limitResume.js";

export interface CacheKeepSettings {
	/** `[agents] auto_compact_before_cache_expiry`. */
	readonly enabled: boolean;
	/** `[agents] auto_compact_lead_seconds`: how long before expiry it fires. */
	readonly leadSeconds: number;
	/** `[agents] auto_compact_min_tokens`: smaller conversations are left alone. */
	readonly minTokens: number;
}

export const CACHE_KEEP_OFF: CacheKeepSettings = {
	enabled: false,
	leadSeconds: 60,
	minTokens: 20_000,
};

/** With less than this left, a compaction would not start in time to read the cache. */
export const MIN_REMAINING_MS = 15_000;

export const AUTO_COMPACT_COMMAND = "/compact";

/** When the conversation should be compacted, or undefined when it should not. */
export function compactDue(
	transcript: Transcript,
	settings: CacheKeepSettings,
): { readonly expiresAt: number; readonly at: number } | undefined {
	if (!settings.enabled) return undefined;
	if (!idleForCompaction(transcript)) return undefined;
	const usage = transcript.usage;
	const expiresAt = usage?.promptCache?.expiresAt;
	if (expiresAt === undefined) return undefined;
	if ((usage?.contextTokens ?? 0) < settings.minTokens) return undefined;
	if (compactedLast(transcript)) return undefined;
	return { expiresAt, at: expiresAt - settings.leadSeconds * 1000 };
}

function idleForCompaction(transcript: Transcript): boolean {
	const { state } = transcript;
	return (
		state.phase === "ready" &&
		state.turn === "none" &&
		transcript.requests.length === 0 &&
		transcript.pending.length === 0 &&
		transcript.sending.length === 0 &&
		!transcript.compacting &&
		transcript.limitResume === undefined
	);
}

/** Whether nothing was said since the conversation's last compaction. */
function compactedLast(transcript: Transcript): boolean {
	for (let i = transcript.entries.length - 1; i >= 0; i -= 1) {
		const entry = transcript.entries[i]!;
		if ("parent" in entry && entry.parent !== null) continue;
		if (entry.kind === "compaction") return true;
		if (entry.kind === "user" || entry.kind === "assistant") return false;
	}
	return false;
}

export class CacheKeeper {
	readonly #settings: () => CacheKeepSettings;
	readonly #clock: LimitResumeClock;
	readonly #due: () => void;
	#armed:
		| { readonly expiresAt: number; readonly at: number; disarm: () => void }
		| undefined;
	/** The warm period (its `expiresAt`) already compacted for. */
	#fired: number | undefined;
	#latest: Transcript | undefined;
	#stopped = false;

	constructor(
		settings: () => CacheKeepSettings,
		clock: LimitResumeClock,
		/** The compaction is due: the conversation asks `take` in its turn. */
		due: () => void,
	) {
		this.#settings = settings;
		this.#clock = clock;
		this.#due = due;
	}

	/** The conversation after an event. */
	observe(transcript: Transcript): void {
		this.#latest = transcript;
		if (this.#stopped) return;
		const due = compactDue(transcript, this.#settings());
		if (due === undefined || due.expiresAt === this.#fired) {
			this.#disarm();
			return;
		}
		const armed = this.#armed;
		if (armed?.expiresAt === due.expiresAt && armed.at === due.at) return;
		this.#disarm();
		const wait = Math.max(0, due.at - this.#clock.now());
		this.#armed = {
			...due,
			disarm: this.#clock.after(wait, this.#due),
		};
	}

	/**
	 * Whether to write `/compact` now: the conversation still qualifies, the
	 * time has come, and the cache is still warm enough. Either way the warm
	 * period's chance is used up unless the timer came early.
	 */
	take(transcript: Transcript | undefined = this.#latest): boolean {
		const armed = this.#armed;
		if (armed === undefined || transcript === undefined) return false;
		const now = this.#clock.now();
		if (armed.at > now) {
			armed.disarm = this.#clock.after(armed.at - now, this.#due);
			return false;
		}
		this.#armed = undefined;
		this.#fired = armed.expiresAt;
		const due = compactDue(transcript, this.#settings());
		if (due === undefined || due.expiresAt !== armed.expiresAt) return false;
		return armed.expiresAt - now >= MIN_REMAINING_MS;
	}

	stop(): void {
		this.#stopped = true;
		this.#disarm();
	}

	#disarm(): void {
		this.#armed?.disarm();
		this.#armed = undefined;
	}
}
