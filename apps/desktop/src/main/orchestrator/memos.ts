/**
 * The orchestrator's memos (`docs/orchestrator.md`, "Memos"): per subject,
 * one short plain-text note of what the orchestrator means to do next with
 * that piece of work — written when it sets the work aside or hands it
 * off, so that, busy with everything else, it does not forget. The note
 * shows wherever the work is listed or shown (`board`, `memo list`,
 * `status`, `escalation show`), and goes with the prompt of the agent that
 * picks the work up.
 *
 * **The subject** is the triage's key (`subjects.ts`): `item OWNER/REPO#N`,
 * `agent <id>`, `esc N`, `req N`. `memo set` replaces its note, `memo
 * clear` takes it away; the note keeps only when it was last set.
 *
 * **Kept** on disk across restarts (`<userData>/devhub/orchestrator-memos.json`,
 * written whole and atomically), and pruned (`MemoBook.prune`):
 *
 * - an item's note, `MEMO_DONE_GRACE_MS` (7 days) after the item was first
 *   read closed or merged; an escalation's, that long after it was closed;
 *   a request's, that long after it was filed; an escalation or request no
 *   longer in its store, at once;
 * - an agent's note (work with no item, `issue=pending`), `MEMO_AGENT_GRACE_MS`
 *   (30 days) after it was set once no agent and no work record has that
 *   id — its subject moves with the work (`rename`) when it is linked to an
 *   Issue or resumed under a new id;
 * - any note not set for `MEMO_MAX_AGE_MS` (180 days);
 * - beyond `MAX_MEMOS` subjects, the least recently set.
 *
 * A version 1 file (a log of timestamped entries per subject) loads as its
 * latest entry's text, at that entry's time.
 */

import { VersionedJsonFile, type JsonFileIo } from "./jsonFile.js";
import { normalSubject } from "./subjects.js";

export interface Memo {
	readonly subject: string;
	/** Plain text (light Markdown at most): the next step. */
	readonly text: string;
	/** When it was last set. */
	readonly at: number;
	/** When its subject was first read done (closed, merged, filed); cleared when open again. */
	readonly doneSince?: number;
}

export const MAX_MEMOS = 300;
/** A note's most characters: the next step, not a report. */
export const MAX_MEMO_TEXT = 500;
export const MEMO_DONE_GRACE_MS = 7 * 24 * 60 * 60_000;
export const MEMO_AGENT_GRACE_MS = 30 * 24 * 60 * 60_000;
export const MEMO_MAX_AGE_MS = 180 * 24 * 60 * 60_000;
export const MEMO_FILE_VERSION = 2;

/** `M/D HH:MM`, in local time: how a line says when. */
export function memoClock(at: number): string {
	const date = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The note on one line, for a listing. */
export function memoLine(memo: Memo): string {
	return memo.text.replace(/\s+/gu, " ").trim();
}

/** Why `text` is not a note, or undefined when it is one. */
export function memoRefusal(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return "the note is empty.";
	if (trimmed.length > MAX_MEMO_TEXT)
		return `the note is ${String(trimmed.length)} characters; keep it to ${String(MAX_MEMO_TEXT)}: what you will do next with this work, in a line or a few. The details belong to the agent, the Issue or the escalation.`;
	return undefined;
}

export interface MemoStorage {
	load(): readonly Memo[];
	save(memos: readonly Memo[]): void;
}

/** What `MemoBook.prune` reads of a subject now. */
export interface MemoFacts {
	/** It is done (item closed/merged, escalation closed, request filed): since when. */
	doneAt(subject: string): number | undefined;
	/** It no longer exists where it is kept (an escalation, a request): gone. */
	gone(subject: string): boolean;
	/** An agent subject whose agent runs, or whose work is still recorded. */
	agentKnown(subject: string): boolean;
}

export class MemoBook {
	/** By normal subject; insertion order is least recently set first. */
	readonly #memos = new Map<string, Memo>();

	constructor(private readonly storage?: MemoStorage) {
		for (const memo of storage?.load() ?? [])
			this.#memos.set(normalSubject(memo.subject), memo);
	}

	get(subject: string): Memo | undefined {
		return this.#memos.get(normalSubject(subject));
	}

	/** Most recently set first. */
	all(): readonly Memo[] {
		return [...this.#memos.values()].reverse();
	}

	/** `memo set`: the subject's note is now `text` (refused past `MAX_MEMO_TEXT`). */
	set(subject: string, text: string, at: number): Memo {
		const refusal = memoRefusal(text);
		if (refusal !== undefined) throw new Error(refusal);
		const key = normalSubject(subject);
		const memo: Memo = { subject: key, text: text.trim(), at };
		this.#put(key, memo);
		return memo;
	}

	clear(subject: string): boolean {
		const had = this.#memos.delete(normalSubject(subject));
		if (had) this.#save();
		return had;
	}

	/**
	 * The work moved to another subject (`agent X` linked to its Issue, or
	 * resumed as agent Y): its note goes with it; of two, the later set stays.
	 */
	rename(from: string, to: string): boolean {
		const fromKey = normalSubject(from);
		const toKey = normalSubject(to);
		const moving = this.#memos.get(fromKey);
		if (moving === undefined || fromKey === toKey) return false;
		const there = this.#memos.get(toKey);
		this.#memos.delete(fromKey);
		const kept = there !== undefined && there.at > moving.at ? there : moving;
		this.#put(toKey, { subject: toKey, text: kept.text, at: kept.at });
		return true;
	}

	/** Apply the pruning rules at `now`; whether anything went or changed. */
	prune(facts: MemoFacts, now: number): boolean {
		let changed = false;
		for (const [key, memo] of [...this.#memos]) {
			if (now - memo.at > MEMO_MAX_AGE_MS || facts.gone(key)) {
				this.#memos.delete(key);
				changed = true;
				continue;
			}
			if (key.startsWith("agent ")) {
				if (!facts.agentKnown(key) && now - memo.at > MEMO_AGENT_GRACE_MS) {
					this.#memos.delete(key);
					changed = true;
				}
				continue;
			}
			const done = facts.doneAt(key);
			if (done === undefined) {
				if (memo.doneSince !== undefined) {
					const { doneSince: _, ...open } = memo;
					this.#memos.set(key, open);
					changed = true;
				}
				continue;
			}
			const since = memo.doneSince ?? done;
			if (now - since > MEMO_DONE_GRACE_MS) {
				this.#memos.delete(key);
				changed = true;
			} else if (memo.doneSince === undefined) {
				this.#memos.set(key, { ...memo, doneSince: since });
				changed = true;
			}
		}
		if (changed) this.#save();
		return changed;
	}

	#put(key: string, memo: Memo): void {
		this.#memos.delete(key);
		this.#memos.set(key, memo);
		while (this.#memos.size > MAX_MEMOS) {
			const oldest = this.#memos.keys().next().value;
			if (oldest === undefined) break;
			this.#memos.delete(oldest);
		}
		this.#save();
	}

	#save(): void {
		this.storage?.save([...this.#memos.values()]);
	}
}

/**
 * The file's notes, or a `TypeError` when it is not this file. Version 1
 * (`entries: [{at, text, by?}]` per subject) loads as the latest entry.
 */
export function memosFromJson(value: unknown): Memo[] {
	const file = value as { version?: unknown; memos?: unknown } | null;
	if (
		typeof file !== "object" ||
		file === null ||
		(file.version !== MEMO_FILE_VERSION && file.version !== 1) ||
		!Array.isArray(file.memos)
	)
		throw new TypeError(
			`not a version ${String(MEMO_FILE_VERSION)} memos file`,
		);
	const out: Memo[] = [];
	for (const one of file.memos as unknown[]) {
		const memo = one as {
			subject?: unknown;
			text?: unknown;
			at?: unknown;
			entries?: unknown;
			doneSince?: unknown;
		} | null;
		if (typeof memo?.subject !== "string") continue;
		let text: unknown = memo.text;
		let at: unknown = memo.at;
		if (file.version === 1) {
			const latest = (Array.isArray(memo.entries) ? memo.entries : [])
				.filter(
					(entry): entry is { at: number; text: string } =>
						typeof (entry as { at?: unknown } | null)?.at === "number" &&
						typeof (entry as { text?: unknown }).text === "string",
				)
				.at(-1);
			text = latest?.text;
			at = latest?.at;
		}
		if (typeof text !== "string" || typeof at !== "number") continue;
		const trimmed = text.trim();
		if (trimmed.length === 0) continue;
		out.push({
			subject: memo.subject,
			text:
				trimmed.length <= MAX_MEMO_TEXT
					? trimmed
					: `${trimmed.slice(0, MAX_MEMO_TEXT - 1)}…`,
			at,
			...(typeof memo.doneSince === "number"
				? { doneSince: memo.doneSince }
				: {}),
		});
	}
	return out;
}

/** `<userData>/devhub/orchestrator-memos.json`. */
export class MemoFile implements MemoStorage {
	readonly #file: VersionedJsonFile<Memo[]>;

	constructor(path: string, log?: (line: string) => void, io?: JsonFileIo) {
		this.#file = new VersionedJsonFile(
			path,
			"memos",
			() => [],
			memosFromJson,
			io,
			log,
		);
	}

	get refused(): string | undefined {
		return this.#file.refused;
	}

	load(): readonly Memo[] {
		return this.#file.load();
	}

	save(memos: readonly Memo[]): void {
		this.#file.write({ version: MEMO_FILE_VERSION, memos });
	}
}
