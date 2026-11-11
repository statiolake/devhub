/**
 * Who worked on what (`docs/orchestrator.md`, "Resuming the agent that did
 * the work"): per subject, the managed agents that worked on it and the CLI
 * sessions they ran, kept after the agent is stopped or closed and across
 * restarts, so the orchestrator brings **that** agent back — its
 * conversation, its folder — when the work goes on (review feedback, a CI
 * failure, a follow-up), with `devhub --tell agent resume <subject|agent>`.
 *
 * **The subject** is the triage's key (`subjects.ts`): the item the agent's
 * meta `issue=` links it to (`item OWNER/REPO#N`, an Issue or a pull request
 * alike), or, for a managed agent linked to no item yet (`issue=pending`, or
 * nothing), `agent <id>`. One key: the memo of the work is kept under the
 * same one (`memos.ts`).
 *
 * **What is kept** of each agent (`WorkAgent`): its id and name, its
 * profile, the machine and folder it ran in (a Workspace, an SSH host's
 * included), the branch, and the sessions its CLI named (Claude's session,
 * Codex's thread; newest last), when it was last seen and when it stopped.
 * The same agent is the same conversation: an agent that goes on with a
 * session already recorded (`agent resume`, Reopen Closed, `/resume`) takes
 * that entry's place, under its new id, so a subject has one entry per line
 * of conversation, not one per launch.
 *
 * **Fed** by `observe` (every save of the state: the managed agents open
 * now, with the session the session-meta keeper knows) and by `closed` (an
 * agent closed, with the session it was asked for at its close). An agent
 * gone from the live list is marked stopped.
 *
 * **Kept** in `<userData>/devhub/orchestrator-work.json`, and pruned
 * (`prune`): a record of an item `WORK_DONE_GRACE_MS` (7 days) after the item
 * was first read closed or merged; any record not seen for `WORK_MAX_AGE_MS`
 * (180 days, the session metadata's own bound); beyond `MAX_WORK` records the
 * least recently seen; each record at most `MAX_WORK_AGENTS` agents, each
 * agent at most `MAX_WORK_SESSIONS` sessions.
 */

import { VersionedJsonFile, type JsonFileIo } from "./jsonFile.js";
import { itemKey, itemOfUrl, normalSubject } from "./subjects.js";

export interface WorkAgent {
	readonly agentId: string;
	readonly name: string;
	/** The name was given by a person or the orchestrator (`--name`). */
	readonly named?: boolean;
	readonly profileId: string;
	/** The CLI: only Claude's and Codex's sessions are resumed. */
	readonly kind: string;
	readonly presentation: "gui" | "tui";
	/** `local`, or `ssh:<host>`. */
	readonly machine: string;
	/** The Workspace's folder it ran in. */
	readonly folder: string;
	readonly branch?: string;
	/** The CLI sessions it ran, oldest first: the last is the one to resume. */
	readonly sessions: readonly string[];
	readonly startedAt: number;
	readonly seenAt: number;
	/** Gone from the window (stopped, closed, its CLI ended) since. */
	readonly stoppedAt?: number;
}

export interface WorkRecord {
	readonly subject: string;
	/** The item's URL, for an item subject. */
	readonly url?: string;
	readonly itemKind?: "issue" | "pr";
	/** Oldest first; the last is the one `agent resume <subject>` brings back. */
	readonly agents: readonly WorkAgent[];
	/** When its item was first read closed or merged. */
	readonly doneSince?: number;
}

/** A managed agent open now, as `observe` reads it. */
export interface LiveWorkAgent {
	readonly agentId: string;
	readonly name: string;
	readonly named: boolean;
	readonly profileId: string;
	readonly kind: string;
	readonly presentation: "gui" | "tui";
	readonly machine: string;
	readonly folder: string;
	readonly branch?: string;
	/** Its meta `issue=`: an item URL, `pending`, or absent. */
	readonly issue?: string;
	/** The session its CLI runs, when known. */
	readonly session?: string;
}

export const MAX_WORK = 300;
export const MAX_WORK_AGENTS = 5;
export const MAX_WORK_SESSIONS = 10;
export const WORK_DONE_GRACE_MS = 7 * 24 * 60 * 60_000;
export const WORK_MAX_AGE_MS = 180 * 24 * 60 * 60_000;
export const WORK_FILE_VERSION = 1;

/** The subject an agent's work is kept under: its item, else itself. */
export function workSubjectOf(agent: {
	readonly agentId: string;
	readonly issue?: string;
}): {
	readonly subject: string;
	readonly url?: string;
	readonly itemKind?: "issue" | "pr";
} {
	const item = agent.issue === undefined ? undefined : itemOfUrl(agent.issue);
	return item === undefined
		? { subject: `agent ${agent.agentId}` }
		: { subject: itemKey(item.ref), url: agent.issue!, itemKind: item.kind };
}

export function lastSeen(record: WorkRecord): number {
	return Math.max(0, ...record.agents.map((agent) => agent.seenAt));
}

/** A subject that moved, for the memos to follow (`MemoBook.rename`). */
export interface WorkMove {
	readonly from: string;
	readonly to: string;
}

export interface WorkStorage {
	load(): readonly WorkRecord[];
	save(records: readonly WorkRecord[]): void;
}

export class WorkBook {
	readonly #records = new Map<string, WorkRecord>();

	constructor(private readonly storage?: WorkStorage) {
		for (const record of storage?.load() ?? [])
			this.#records.set(normalSubject(record.subject), record);
	}

	get(subject: string): WorkRecord | undefined {
		return this.#records.get(normalSubject(subject));
	}

	/** Most recently seen first. */
	all(): readonly WorkRecord[] {
		return [...this.#records.values()].toSorted(
			(a, b) => lastSeen(b) - lastSeen(a),
		);
	}

	/** The record holding `agentId`, and its entry. */
	byAgent(
		agentId: string,
	): { readonly record: WorkRecord; readonly agent: WorkAgent } | undefined {
		for (const record of this.#records.values()) {
			const agent = record.agents.find((one) => one.agentId === agentId);
			if (agent !== undefined) return { record, agent };
		}
		return undefined;
	}

	/**
	 * The managed agents open now: each recorded (or brought up to date)
	 * under its subject, and every recorded agent not among them marked
	 * stopped. Answers the subjects that moved.
	 */
	observe(live: readonly LiveWorkAgent[], now: number): readonly WorkMove[] {
		let changed = false;
		const moves: WorkMove[] = [];
		const ids = new Set(live.map((agent) => agent.agentId));
		for (const agent of live) {
			const result = this.#upsert(agent, now, undefined);
			changed ||= result.changed;
			moves.push(...result.moves);
		}
		for (const [key, record] of this.#records) {
			let touched = false;
			const agents = record.agents.map((agent) => {
				if (ids.has(agent.agentId) || agent.stoppedAt !== undefined)
					return agent;
				touched = true;
				return { ...agent, stoppedAt: now };
			});
			if (touched) {
				this.#records.set(key, { ...record, agents });
				changed = true;
			}
		}
		if (changed) this.#save();
		return moves;
	}

	/** An agent is being closed, on `session` (when it could be told). */
	closed(agent: LiveWorkAgent, now: number): readonly WorkMove[] {
		const result = this.#upsert(agent, now, now);
		if (result.changed) this.#save();
		return result.moves;
	}

	/** Apply the pruning rules at `now`: `doneAt` says when an item was read done. */
	prune(doneAt: (subject: string) => number | undefined, now: number): boolean {
		let changed = false;
		for (const [key, record] of [...this.#records]) {
			if (now - lastSeen(record) > WORK_MAX_AGE_MS) {
				this.#records.delete(key);
				changed = true;
				continue;
			}
			if (!key.startsWith("item ")) continue;
			const done = doneAt(key);
			if (done === undefined) {
				if (record.doneSince !== undefined) {
					const { doneSince: _, ...open } = record;
					this.#records.set(key, open);
					changed = true;
				}
				continue;
			}
			const since = record.doneSince ?? done;
			if (now - since > WORK_DONE_GRACE_MS) {
				this.#records.delete(key);
				changed = true;
			} else if (record.doneSince === undefined) {
				this.#records.set(key, { ...record, doneSince: since });
				changed = true;
			}
		}
		if (changed) this.#save();
		return changed;
	}

	#upsert(
		live: LiveWorkAgent,
		now: number,
		stoppedAt: number | undefined,
	): { changed: boolean; moves: WorkMove[] } {
		const moves: WorkMove[] = [];
		const where = workSubjectOf(live);
		const key = normalSubject(where.subject);
		// The entry this agent continues: its own id, or a session it runs.
		let earlier: WorkAgent | undefined;
		let earlierKey: string | undefined;
		for (const [subject, record] of this.#records) {
			const found =
				record.agents.find((one) => one.agentId === live.agentId) ??
				(live.session === undefined
					? undefined
					: record.agents.find((one) => one.sessions.includes(live.session!)));
			if (found !== undefined) {
				earlier = found;
				earlierKey = subject;
				break;
			}
		}
		const sessions =
			live.session === undefined
				? (earlier?.sessions ?? [])
				: [
						...(earlier?.sessions ?? []).filter((one) => one !== live.session),
						live.session,
					].slice(-MAX_WORK_SESSIONS);
		const entry: WorkAgent = {
			agentId: live.agentId,
			name: live.name,
			...(live.named ? { named: true } : {}),
			profileId: live.profileId,
			kind: live.kind,
			presentation: live.presentation,
			machine: live.machine,
			folder: live.folder,
			...(live.branch === undefined ? {} : { branch: live.branch }),
			sessions,
			startedAt: earlier?.startedAt ?? now,
			seenAt: now,
			...(stoppedAt === undefined ? {} : { stoppedAt }),
		};
		if (earlier !== undefined && earlierKey !== undefined) {
			const same =
				earlierKey === key &&
				JSON.stringify({ ...earlier, seenAt: 0 }) ===
					JSON.stringify({ ...entry, seenAt: 0 }) &&
				now - earlier.seenAt < 60 * 60_000;
			if (same) return { changed: false, moves };
			const record = this.#records.get(earlierKey)!;
			const rest = record.agents.filter((one) => one !== earlier);
			if (earlierKey !== key) {
				// The work moved: linked to its Issue, or resumed under a new id.
				if (rest.length === 0) {
					this.#records.delete(earlierKey);
					moves.push({ from: earlierKey, to: key });
				} else this.#records.set(earlierKey, { ...record, agents: rest });
			} else {
				this.#records.set(key, { ...record, agents: [...rest, entry] });
				return { changed: true, moves };
			}
		}
		const there = this.#records.get(key);
		this.#records.delete(key);
		this.#records.set(key, {
			subject: key,
			...(where.url === undefined ? {} : { url: where.url }),
			...(where.itemKind === undefined ? {} : { itemKind: where.itemKind }),
			...(there?.doneSince === undefined ? {} : { doneSince: there.doneSince }),
			agents: [
				...(there?.agents ?? []).filter((one) => one.agentId !== live.agentId),
				entry,
			].slice(-MAX_WORK_AGENTS),
		});
		while (this.#records.size > MAX_WORK) {
			const oldest = this.all().at(-1);
			if (oldest === undefined) break;
			this.#records.delete(normalSubject(oldest.subject));
		}
		return { changed: true, moves };
	}

	#save(): void {
		this.storage?.save([...this.#records.values()]);
	}
}

function workAgentOf(value: unknown): WorkAgent | undefined {
	const one = value as Partial<WorkAgent> | null;
	if (
		typeof one?.agentId !== "string" ||
		typeof one.name !== "string" ||
		typeof one.profileId !== "string" ||
		typeof one.kind !== "string" ||
		(one.presentation !== "gui" && one.presentation !== "tui") ||
		typeof one.machine !== "string" ||
		typeof one.folder !== "string" ||
		!Array.isArray(one.sessions) ||
		!one.sessions.every((session) => typeof session === "string") ||
		typeof one.startedAt !== "number" ||
		typeof one.seenAt !== "number"
	)
		return undefined;
	return {
		agentId: one.agentId,
		name: one.name,
		...(one.named === true ? { named: true } : {}),
		profileId: one.profileId,
		kind: one.kind,
		presentation: one.presentation,
		machine: one.machine,
		folder: one.folder,
		...(typeof one.branch === "string" ? { branch: one.branch } : {}),
		sessions: one.sessions,
		startedAt: one.startedAt,
		seenAt: one.seenAt,
		...(typeof one.stoppedAt === "number" ? { stoppedAt: one.stoppedAt } : {}),
	};
}

/** The file's records, or a `TypeError` when it is not this file. */
export function workFromJson(value: unknown): WorkRecord[] {
	const file = value as { version?: unknown; work?: unknown } | null;
	if (
		typeof file !== "object" ||
		file === null ||
		file.version !== WORK_FILE_VERSION ||
		!Array.isArray(file.work)
	)
		throw new TypeError(`not a version ${String(WORK_FILE_VERSION)} work file`);
	const out: WorkRecord[] = [];
	for (const value of file.work as unknown[]) {
		const one = value as Partial<WorkRecord> | null;
		if (typeof one?.subject !== "string" || !Array.isArray(one.agents))
			continue;
		const agents = one.agents.flatMap((agent) => {
			const read = workAgentOf(agent);
			return read === undefined ? [] : [read];
		});
		if (agents.length === 0) continue;
		out.push({
			subject: one.subject,
			...(typeof one.url === "string" ? { url: one.url } : {}),
			...(one.itemKind === "issue" || one.itemKind === "pr"
				? { itemKind: one.itemKind }
				: {}),
			...(typeof one.doneSince === "number"
				? { doneSince: one.doneSince }
				: {}),
			agents,
		});
	}
	return out;
}

/** `<userData>/devhub/orchestrator-work.json`. */
export class WorkFile implements WorkStorage {
	readonly #file: VersionedJsonFile<WorkRecord[]>;

	constructor(path: string, log?: (line: string) => void, io?: JsonFileIo) {
		this.#file = new VersionedJsonFile(
			path,
			"work records",
			() => [],
			workFromJson,
			io,
			log,
		);
	}

	get refused(): string | undefined {
		return this.#file.refused;
	}

	load(): readonly WorkRecord[] {
		return this.#file.load();
	}

	save(records: readonly WorkRecord[]): void {
		this.#file.write({ version: WORK_FILE_VERSION, work: records });
	}
}
