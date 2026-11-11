/**
 * Priority triage (`docs/orchestrator.md`, "Triage: priorities"): on a
 * schedule DevHub asks the orchestrator to rank its open work — escalations,
 * the items (Issues, pull requests) and managed agents that need action, and
 * the person's requests — and the orchestrator records each with
 * `devhub --tell orchestrator priority set SUBJECT high|normal|low`.
 *
 * **The store.** An escalation's priority is its own (`escalation rank
 * --priority`, which the board already shows); every other subject's is kept
 * here, by the subject key the dispatcher uses (`subjectOf`: `item
 * acme/app#12`, `agent <id>`, `req 3`), with when it was set and the
 * orchestrator's note. It is kept on disk across restarts (`PRIORITY_FILE`),
 * written whole on each change, at most `MAX_PRIORITIES` (the oldest go).
 *
 * **The schedule.** A `triage` event every `TRIAGE_INTERVAL_MS` in full and
 * `SAVING_TRIAGE_INTERVAL_MS` in saving, counted from the last one (or from
 * when the mode went on: `init` already has the orchestrator read the
 * board). Never while off.
 *
 * **Saving's gate** (`mode.ts`, `SAVING_CLASSES`). In saving a state change
 * about the work (an agent stopped, on a prompt, errored, its pull request's
 * review or checks, a wait that may be ready) goes with every batch whatever
 * its priority; a **nudge** (a subject said again unchanged, an item nobody
 * started, a settings timer, the usage readout, `custom.*`) goes only when
 * its subject is ranked **high** — and, while two or more tasks are in
 * progress, only when it is about one of them. Every other nudge stays
 * pending (one per subject, as always) until a batch carrying `triage` —
 * which takes everything pending and standing with it — or until the mode
 * is full. The person's words, requests, `init` and `triage` are never held
 * by it, and the orchestrator's own wake-ups (`timer set`, a wait's `--at`)
 * go on time.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { OrchestratorMode } from "./mode.js";

export type Priority = "high" | "normal" | "low";

export const PRIORITIES: readonly Priority[] = ["high", "normal", "low"];

export function isPriority(value: unknown): value is Priority {
	return value === "high" || value === "normal" || value === "low";
}

/**
 * Full's triage interval. A triage is the heaviest turn the orchestrator
 * takes — it reads the board and every subject's state, and ranks them all —
 * so it is a few times rarer than the nag (5 minutes by default): twice an
 * hour keeps the ranking within half an hour of what happened, which is as
 * often as the work it ranks (agents' turns, reviews, CI) tends to change.
 */
export const TRIAGE_INTERVAL_MS = 30 * 60_000;

/**
 * Saving's: once an hour. Saving holds every nudge that is not about a
 * high subject until the next triage, so this is also how long a low nudge
 * waits at most; an hour is a fifth of the 5-hour window, and keeps triage itself
 * to a handful of turns per window.
 */
export const SAVING_TRIAGE_INTERVAL_MS = 60 * 60_000;

export function triageIntervalMs(mode: OrchestratorMode): number | undefined {
	return mode === "full"
		? TRIAGE_INTERVAL_MS
		: mode === "saving"
			? SAVING_TRIAGE_INTERVAL_MS
			: undefined;
}

/** When the next triage is due, counted from `anchor`; never while off. */
export function nextTriageAt(
	mode: OrchestratorMode,
	anchor: number | undefined,
): number | undefined {
	const interval = triageIntervalMs(mode);
	return interval === undefined || anchor === undefined
		? undefined
		: anchor + interval;
}

/** One subject's priority, as the orchestrator set it. */
export interface PriorityEntry {
	readonly priority: Priority;
	readonly at: number;
	readonly note?: string;
}

export const MAX_PRIORITIES = 500;
export const PRIORITY_FILE_VERSION = 1;

/** Where the priorities are kept; absent: memory only (tests). */
export interface PriorityStorage {
	load(): ReadonlyMap<string, PriorityEntry>;
	save(entries: ReadonlyMap<string, PriorityEntry>): void;
}

export class PriorityBook {
	readonly #entries: Map<string, PriorityEntry>;

	constructor(private readonly storage?: PriorityStorage) {
		this.#entries = new Map(storage?.load() ?? []);
	}

	get(subject: string): PriorityEntry | undefined {
		return this.#entries.get(subject);
	}

	all(): ReadonlyMap<string, PriorityEntry> {
		return this.#entries;
	}

	set(subject: string, entry: PriorityEntry): void {
		this.#entries.delete(subject);
		this.#entries.set(subject, entry);
		while (this.#entries.size > MAX_PRIORITIES) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
		this.storage?.save(this.#entries);
	}

	clear(subject: string): boolean {
		const had = this.#entries.delete(subject);
		if (had) this.storage?.save(this.#entries);
		return had;
	}
}

/** `<userData>/devhub/orchestrator-priorities.json`, written atomically. */
export class PriorityFile implements PriorityStorage {
	refused: string | undefined;

	constructor(
		private readonly path: string,
		private readonly log: (line: string) => void = () => undefined,
	) {}

	load(): ReadonlyMap<string, PriorityEntry> {
		if (!existsSync(this.path)) return new Map();
		try {
			const file = JSON.parse(readFileSync(this.path, "utf8")) as {
				version?: unknown;
				priorities?: Record<string, Partial<PriorityEntry>>;
			};
			if (
				file.version !== PRIORITY_FILE_VERSION ||
				typeof file.priorities !== "object"
			)
				throw new TypeError("not a priorities file");
			const out = new Map<string, PriorityEntry>();
			for (const [subject, one] of Object.entries(file.priorities)) {
				if (!isPriority(one.priority) || typeof one.at !== "number") continue;
				out.set(subject, {
					priority: one.priority,
					at: one.at,
					...(typeof one.note === "string" ? { note: one.note } : {}),
				});
			}
			return out;
		} catch (error: unknown) {
			const aside = `${this.path}.corrupt`;
			try {
				renameSync(this.path, aside);
			} catch {
				// Gone already: nothing to move.
			}
			this.refused = `${this.path} could not be read (${error instanceof Error ? error.message : String(error)}); it was moved to ${aside}, and the priorities start empty.`;
			return new Map();
		}
	}

	save(entries: ReadonlyMap<string, PriorityEntry>): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.${String(process.pid)}.tmp`;
			writeFileSync(
				temporary,
				JSON.stringify({
					version: PRIORITY_FILE_VERSION,
					priorities: Object.fromEntries(entries),
				}),
				{ mode: 0o600 },
			);
			renameSync(temporary, this.path);
		} catch (error: unknown) {
			this.log(
				`[devhub] could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/**
 * A subject as the CLI names it — `esc=12`, `issue=acme/app#3`,
 * `pr=acme/app#9`, `agent=ab12cd34`, `req=3`, as the event lines write
 * them — parsed; undefined when it is none of those. An agent's id may be
 * a prefix: the caller resolves it.
 */
export type SubjectRef =
	| { readonly kind: "esc"; readonly id: number }
	| { readonly kind: "item"; readonly ref: string }
	| { readonly kind: "agent"; readonly id: string }
	| { readonly kind: "req"; readonly id: number };

export function parseSubject(text: string): SubjectRef | undefined {
	const match = /^(esc|issue|pr|agent|req)=(.+)$/u.exec(text.trim());
	if (match === null) return undefined;
	const [, kind, value] = match;
	switch (kind) {
		case "esc":
		case "req":
			return /^\d+$/u.test(value!) ? { kind, id: Number(value) } : undefined;
		case "issue":
		case "pr":
			return /^[\w.-]+\/[\w.-]+#\d+$/u.test(value!)
				? { kind: "item", ref: value! }
				: undefined;
		default:
			return /^[0-9a-z-]+$/iu.test(value!)
				? { kind: "agent", id: value! }
				: undefined;
	}
}

/** The dispatcher's key for a subject (`subjectOf`): what is stored. */
export function subjectKey(
	ref: Exclude<SubjectRef, { kind: "esc" }> & {
		readonly kind: "item" | "agent" | "req";
	},
): string {
	switch (ref.kind) {
		case "item":
			return `item ${ref.ref}`;
		case "agent":
			return `agent ${ref.id}`;
		case "req":
			return `req ${String(ref.id)}`;
	}
}
