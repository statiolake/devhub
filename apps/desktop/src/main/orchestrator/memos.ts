/**
 * The orchestrator's memos (`docs/orchestrator.md`, "Memos"): per subject,
 * plain Markdown notes of where a piece of work stands — what remains, what
 * to do next, what was decided and why — written when work stops or is
 * handed over, and read before it goes on, by a later turn of the
 * orchestrator or by the agent that picks the work up.
 *
 * **The subject** is the triage's key (`subjects.ts`): `item OWNER/REPO#N`,
 * `agent <id>`, `esc N`, `req N`. A memo is a list of entries, each with
 * its time and who wrote it (`by`: the agent's name, or the caller's label);
 * `memo add` appends one, `memo edit` replaces them all with one, `memo
 * clear` takes the memo away.
 *
 * **Kept** on disk across restarts (`<userData>/devhub/orchestrator-memos.json`,
 * written whole and atomically), and pruned (`pruneMemos`):
 *
 * - an item's memo, `MEMO_DONE_GRACE_MS` (7 days) after the item was first
 *   read closed or merged; an escalation's, that long after it was closed;
 *   a request's, that long after it was filed; an escalation or request no
 *   longer in its store, at once — the work is over, and a week is long
 *   enough for a follow-up to read what was left;
 * - an agent's memo (work with no item, `issue=pending`), `MEMO_AGENT_GRACE_MS`
 *   (30 days) after its last entry once no agent and no work record has that
 *   id — its subject moves with the work (`rename`) when it is linked to an
 *   Issue or resumed under a new id;
 * - any memo nothing has written to for `MEMO_MAX_AGE_MS` (180 days);
 * - beyond `MAX_MEMOS` subjects the least recently written go, and beyond
 *   `MAX_MEMO_ENTRIES` entries a memo's oldest go.
 */

import { VersionedJsonFile, type JsonFileIo } from "./jsonFile.js";
import { normalSubject } from "./subjects.js";

export interface MemoEntry {
	readonly at: number;
	/** Markdown, as written. */
	readonly text: string;
	/** Who wrote it: an agent's name, or an outside caller's `--as` label. */
	readonly by?: string;
}

export interface Memo {
	readonly subject: string;
	/** Oldest first. */
	readonly entries: readonly MemoEntry[];
	/** When its subject was first read done (closed, merged, filed); cleared when open again. */
	readonly doneSince?: number;
}

export const MAX_MEMOS = 300;
export const MAX_MEMO_ENTRIES = 50;
/** One entry's most characters: a memo is a note, not a document. */
export const MAX_MEMO_TEXT = 20_000;
export const MEMO_DONE_GRACE_MS = 7 * 24 * 60 * 60_000;
export const MEMO_AGENT_GRACE_MS = 30 * 24 * 60 * 60_000;
export const MEMO_MAX_AGE_MS = 180 * 24 * 60 * 60_000;
export const MEMO_FILE_VERSION = 1;

export function memoUpdatedAt(memo: Memo): number {
	return memo.entries.at(-1)?.at ?? 0;
}

/** The latest entry, on one line, cut at `max` characters. */
export function memoExcerpt(memo: Memo, max = 120): string {
	const text = (memo.entries.at(-1)?.text ?? "")
		.replace(/^#+\s*/gmu, "")
		.replace(/\s+/gu, " ")
		.trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `M/D HH:MM`, in local time: how a line says when. */
export function memoClock(at: number): string {
	const date = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The whole memo as Markdown: each entry under its time and author. */
export function memoMarkdown(memo: Memo): string {
	return memo.entries
		.map(
			(entry) =>
				`### ${new Date(entry.at).toISOString()}${entry.by === undefined ? "" : ` — ${entry.by}`}\n\n${entry.text}`,
		)
		.join("\n\n");
}

export interface MemoStorage {
	load(): readonly Memo[];
	save(memos: readonly Memo[]): void;
}

/** What `pruneMemos` reads of a subject now. */
export interface MemoFacts {
	/** It is done (item closed/merged, escalation closed, request filed): since when. */
	doneAt(subject: string): number | undefined;
	/** It no longer exists where it is kept (an escalation, a request): gone. */
	gone(subject: string): boolean;
	/** An agent subject whose agent runs, or whose work is still recorded. */
	agentKnown(subject: string): boolean;
}

export class MemoBook {
	/** By normal subject; insertion order is least recently written first. */
	readonly #memos = new Map<string, Memo>();

	constructor(private readonly storage?: MemoStorage) {
		for (const memo of storage?.load() ?? [])
			this.#memos.set(normalSubject(memo.subject), memo);
	}

	get(subject: string): Memo | undefined {
		return this.#memos.get(normalSubject(subject));
	}

	/** Most recently written first. */
	all(): readonly Memo[] {
		return [...this.#memos.values()].reverse();
	}

	add(subject: string, entry: MemoEntry): Memo {
		const key = normalSubject(subject);
		const earlier = this.#memos.get(key);
		const memo: Memo = {
			subject: key,
			entries: [...(earlier?.entries ?? []), clipped(entry)].slice(
				-MAX_MEMO_ENTRIES,
			),
		};
		this.#put(key, memo);
		return memo;
	}

	/** `memo edit`: one entry in place of them all. */
	replace(subject: string, entry: MemoEntry): Memo {
		const key = normalSubject(subject);
		const memo: Memo = { subject: key, entries: [clipped(entry)] };
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
	 * resumed as agent Y): its memo goes with it, after any the new one had.
	 */
	rename(from: string, to: string): boolean {
		const fromKey = normalSubject(from);
		const toKey = normalSubject(to);
		const moving = this.#memos.get(fromKey);
		if (moving === undefined || fromKey === toKey) return false;
		const there = this.#memos.get(toKey);
		this.#memos.delete(fromKey);
		this.#put(toKey, {
			subject: toKey,
			entries: [...(there?.entries ?? []), ...moving.entries]
				.toSorted((a, b) => a.at - b.at)
				.slice(-MAX_MEMO_ENTRIES),
		});
		return true;
	}

	/** Apply the pruning rules at `now`; whether anything went or changed. */
	prune(facts: MemoFacts, now: number): boolean {
		let changed = false;
		for (const [key, memo] of [...this.#memos]) {
			const updated = memoUpdatedAt(memo);
			if (now - updated > MEMO_MAX_AGE_MS || facts.gone(key)) {
				this.#memos.delete(key);
				changed = true;
				continue;
			}
			if (key.startsWith("agent ")) {
				if (!facts.agentKnown(key) && now - updated > MEMO_AGENT_GRACE_MS) {
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

function clipped(entry: MemoEntry): MemoEntry {
	return entry.text.length <= MAX_MEMO_TEXT
		? entry
		: { ...entry, text: `${entry.text.slice(0, MAX_MEMO_TEXT)}…` };
}

/** The file's memos, or a `TypeError` when it is not this file. */
export function memosFromJson(value: unknown): Memo[] {
	const file = value as { version?: unknown; memos?: unknown } | null;
	if (
		typeof file !== "object" ||
		file === null ||
		file.version !== MEMO_FILE_VERSION ||
		!Array.isArray(file.memos)
	)
		throw new TypeError(
			`not a version ${String(MEMO_FILE_VERSION)} memos file`,
		);
	const out: Memo[] = [];
	for (const one of file.memos as unknown[]) {
		const memo = one as Partial<Memo> | null;
		if (typeof memo?.subject !== "string" || !Array.isArray(memo.entries))
			continue;
		const entries = memo.entries.filter(
			(entry): entry is MemoEntry =>
				typeof entry?.at === "number" &&
				typeof entry.text === "string" &&
				(entry.by === undefined || typeof entry.by === "string"),
		);
		if (entries.length === 0) continue;
		out.push({
			subject: memo.subject,
			entries,
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
