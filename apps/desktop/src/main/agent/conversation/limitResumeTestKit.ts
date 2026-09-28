/**
 * What a test gives a conversation for going on after a usage limit
 * (`limitResume.ts`): the settings, the records kept across a restart, and a
 * clock the test turns by hand.
 */

import type { AgentRecordStore } from "./agentRecords.js";
import type {
	LimitResumeClock,
	LimitResumeOptions,
	LimitResumeRecord,
	LimitResumeSettings,
} from "./limitResume.js";

export const RESUME_ON: LimitResumeSettings = {
	enabled: true,
	message: "続けて",
};

export const RESUME_OFF: LimitResumeSettings = {
	enabled: false,
	message: "続けて",
};

/** Records kept in memory, per Agent, as the file would keep them. */
export function memoryRecords(): AgentRecordStore<LimitResumeRecord> & {
	readonly records: Map<string, LimitResumeRecord>;
} {
	const records = new Map<string, LimitResumeRecord>();
	return {
		records,
		get: (agentId) => records.get(agentId),
		set: (agentId, record) => {
			if (record === undefined) records.delete(agentId);
			else records.set(agentId, record);
		},
	};
}

/** A clock that moves only when the test says. */
export class HandClock implements LimitResumeClock {
	#now: number;
	#timers: { at: number; then: () => void; off: boolean }[] = [];

	constructor(now: number) {
		this.#now = now;
	}

	now(): number {
		return this.#now;
	}

	after(ms: number, then: () => void): () => void {
		const timer = { at: this.#now + ms, then, off: false };
		this.#timers.push(timer);
		return () => {
			timer.off = true;
		};
	}

	/** The timers set and not called off. */
	get pending(): number {
		return this.#timers.filter((each) => !each.off).length;
	}

	/** Move on by `ms`, calling every timer that comes due, in order. */
	advance(ms: number): void {
		this.#now += ms;
		for (;;) {
			const due = this.#timers
				.filter((each) => !each.off && each.at <= this.#now)
				.sort((a, b) => a.at - b.at)[0];
			if (due === undefined) return;
			due.off = true;
			due.then();
		}
	}
}

/** A conversation that never goes on by itself: the setting is off. */
export function resumeOff(): LimitResumeOptions {
	const records = memoryRecords();
	return {
		settings: () => RESUME_OFF,
		record: {
			get: () => records.get("agent"),
			set: (record) => records.set("agent", record),
		},
		clock: new HandClock(0),
	};
}
