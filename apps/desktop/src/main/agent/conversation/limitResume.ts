/**
 * Going on with a GUI Agent's conversation once the usage limit that stopped
 * it has reset.
 *
 * A turn a usage limit stopped ends with the limit on its `turn-end` entry
 * (the adapter reads its CLI's own signals for it), and while that end is
 * the last thing in the conversation the conversation stands stopped at the
 * limit (`limitStop`). DevHub then writes a fixed message for the person
 * (`[agents] resume_after_limit_message`) through the conversation's one
 * send, `RESET_MARGIN_MS` after the window resets — never sooner than
 * `SOONEST_MS` after it was set to — and says so meanwhile as one line at
 * the end of the conversation (`Transcript.limitResume`).
 *
 * # One rule ends it
 *
 * The resume is for one stop, and it holds exactly while that stop stands.
 * Whatever moves the conversation on ends it: the person's words, a turn the
 * Agent starts on its own, a restart of its CLI, a rewind, another session —
 * each of them leaves the stop no longer standing, and that is the only
 * thing looked at. So is the person pressing Cancel, and the Agent going
 * away (its conversation stops, and its record goes with it).
 *
 * # Across a restart of DevHub
 *
 * What DevHub decided about a stop is kept per Agent (`LimitResumeRecord`,
 * in `limit-resumes.json`): which stop, where in the journal it first stood,
 * and when its resume is due — or that it is over (sent, cancelled, failed).
 * A new DevHub replays the journal from the start, and the stops it passes
 * on the way are told apart by that record: the recorded stop picks up its
 * resume again (a time that passed while DevHub was down is `SOONEST_MS`
 * after it is seen), a stop before it in the journal is history, and a stop
 * after it is new. A new stop whose reset has already passed is not resumed:
 * it is one the journal holds from before, or one that ended while nobody
 * was following, and a message nobody asked for long after is not what the
 * person set this up for.
 */

import {
	limitStop,
	type EntryId,
	type LimitResume,
	type Transcript,
} from "../../../model/conversation.js";
import { RecordRefused, type AgentRecordsKind } from "./agentRecords.js";

/** How long after the reset the CLI reported the message is written: its clock and ours differ. */
export const RESET_MARGIN_MS = 30_000;
/** The soonest a resume is written after it was set: time to see it, and to cancel it. */
export const SOONEST_MS = 30_000;

export interface LimitResumeSettings {
	/** `[agents] resume_after_limit`. */
	readonly enabled: boolean;
	/** `[agents] resume_after_limit_message`: what is written for the person. */
	readonly message: string;
}

/** What DevHub decided about the last usage-limit stop of one Agent. */
export interface LimitResumeRecord {
	/** The stop's `turn-end` entry. */
	readonly entry: string;
	/** The journal offset the conversation had read when the stop first stood. */
	readonly since: number;
	/** When the message is due, in epoch ms; undefined once it is over. */
	readonly at: number | undefined;
}

export const LIMIT_RESUME_RECORDS: AgentRecordsKind<LimitResumeRecord> = {
	key: "resumes",
	lost: "no GUI Agent resumes by itself after a usage limit it had stopped at",
	decode: (value, agentId) => {
		const record = value as Partial<Record<keyof LimitResumeRecord, unknown>>;
		if (
			typeof value !== "object" ||
			value === null ||
			typeof record.entry !== "string" ||
			typeof record.since !== "number" ||
			!(record.at === undefined || typeof record.at === "number")
		) {
			throw new RecordRefused(
				`the resume of ${agentId} is not an entry, an offset and a time`,
			);
		}
		return { entry: record.entry, since: record.since, at: record.at };
	},
};

/** When things happen: the real clock in DevHub, a hand-turned one in a test. */
export interface LimitResumeClock {
	now(): number;
	/** Call `then` after `ms`; the function returned calls it off. */
	after(ms: number, then: () => void): () => void;
}

/** The longest delay a timer takes; a resume further off is timed again when it comes. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

export const REAL_CLOCK: LimitResumeClock = {
	now: () => Date.now(),
	after: (ms, then) => {
		const timer = setTimeout(then, Math.min(ms, LONGEST_TIMER_MS));
		return () => clearTimeout(timer);
	},
};

export interface LimitResumeOptions {
	readonly settings: () => LimitResumeSettings;
	/** This Agent's record, kept across restarts. */
	readonly record: {
		get(): LimitResumeRecord | undefined;
		set(record: LimitResumeRecord): void;
	};
	readonly clock: LimitResumeClock;
}

/** The stop standing now, as first seen. */
interface Standing {
	readonly entry: EntryId;
	readonly resetsAt: number | undefined;
	readonly since: number;
}

export class LimitResumer {
	readonly #options: LimitResumeOptions;
	readonly #show: (resume: LimitResume | undefined) => void;
	readonly #due: () => void;
	#standing: Standing | undefined;
	#armed: { readonly at: number; readonly disarm: () => void } | undefined;
	#shown: LimitResume | undefined;
	/** The conversation is no longer followed: nothing is timed again. */
	#stopped = false;

	constructor(
		options: LimitResumeOptions,
		/** Put what DevHub will do in the transcript (`limit-resume`). */
		show: (resume: LimitResume | undefined) => void,
		/** The message is due: the conversation takes it (`take`) in its turn. */
		due: () => void,
	) {
		this.#options = options;
		this.#show = show;
		this.#due = due;
	}

	/**
	 * The conversation after an event (any but a `limit-resume`, which this
	 * made), and the journal offset it had read then.
	 */
	observe(transcript: Transcript, offset: number): void {
		const stop = limitStop(transcript);
		const previous = this.#standing;
		if (stop !== undefined && stop.entry === previous?.entry) {
			this.#standing = { ...previous, resetsAt: stop.resetsAt };
		} else {
			// The stop that stood is over, and so is anything about it.
			if (this.#armed !== undefined) this.#over();
			this.#display(undefined);
			this.#standing =
				stop === undefined ? undefined : { ...stop, since: offset };
		}
		this.#decide();
	}

	/**
	 * The person pressed Cancel (or Dismiss): nothing is written for this
	 * stop, now or after a restart.
	 */
	cancel(): void {
		const standing = this.#standing;
		if (standing === undefined) return;
		this.#armed?.disarm();
		this.#armed = undefined;
		this.#record(standing, undefined);
		this.#display(undefined);
	}

	/**
	 * The message is due: its words, once, or nothing when it is not due
	 * after all — cancelled meanwhile, turned off in Settings, or a timer that
	 * came early. Whatever it returns, the resume is over; the caller writes
	 * the words and says, through `failed`, if that did not happen.
	 */
	take(): string | undefined {
		const armed = this.#armed;
		const standing = this.#standing;
		if (armed === undefined || standing === undefined) return undefined;
		const left = armed.at - this.#options.clock.now();
		if (left > 0) {
			this.#armed = {
				at: armed.at,
				disarm: this.#options.clock.after(left, this.#due),
			};
			return undefined;
		}
		this.#armed = undefined;
		this.#record(standing, undefined);
		this.#display(undefined);
		const settings = this.#options.settings();
		return settings.enabled ? settings.message : undefined;
	}

	/** Writing the message failed, for `why`: said until the conversation moves on or it is dismissed. */
	failed(why: string): void {
		if (this.#standing === undefined) return;
		this.#display({ kind: "failed", failure: why });
	}

	/** Stop timing: the conversation is no longer followed. What was decided is kept. */
	stop(): void {
		this.#stopped = true;
		this.#armed?.disarm();
		this.#armed = undefined;
	}

	#decide(): void {
		const standing = this.#standing;
		if (standing === undefined || this.#armed !== undefined) return;
		if (this.#shown?.kind === "failed") return;
		const record = this.#options.record.get();
		if (record?.entry === standing.entry) {
			if (record.at !== undefined) this.#arm(record.at);
			return;
		}
		// A stop before the recorded one, passed on the way through the
		// journal: what happened to it is history.
		if (record !== undefined && standing.since < record.since) return;
		const settings = this.#options.settings();
		if (!settings.enabled) return;
		if (standing.resetsAt === undefined) {
			this.#display({
				kind: "unscheduled",
				reason: "the CLI did not say when the limit resets",
			});
			return;
		}
		if (standing.resetsAt <= this.#options.clock.now()) {
			this.#display({
				kind: "unscheduled",
				reason: "the limit had already reset when DevHub read it",
			});
			return;
		}
		const at = standing.resetsAt + RESET_MARGIN_MS;
		this.#record(standing, at);
		this.#arm(at);
	}

	#arm(due: number): void {
		if (this.#stopped) return;
		const now = this.#options.clock.now();
		const at = Math.max(due, now + SOONEST_MS);
		this.#armed = {
			at,
			disarm: this.#options.clock.after(at - now, this.#due),
		};
		this.#display({ kind: "scheduled", at });
	}

	#over(): void {
		this.#armed?.disarm();
		this.#armed = undefined;
		if (this.#standing !== undefined) this.#record(this.#standing, undefined);
	}

	#record(standing: Standing, at: number | undefined): void {
		this.#options.record.set({
			entry: standing.entry,
			since: standing.since,
			at,
		});
	}

	#display(resume: LimitResume | undefined): void {
		if (JSON.stringify(resume) === JSON.stringify(this.#shown)) return;
		this.#shown = resume;
		this.#show(resume);
	}
}
