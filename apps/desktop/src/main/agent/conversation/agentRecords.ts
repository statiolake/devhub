/**
 * Something main keeps for each GUI Agent across a restart of DevHub, in a
 * file of its own beside `state.json`: an Agent's unsent draft
 * (`drafts.ts`), what DevHub is to do about the usage limit it stopped at
 * (`limitResume.ts`).
 *
 * A record lives exactly as long as its Agent, and the store is told which
 * Agents there are (`accounted`) rather than trusting anyone to remember to
 * say one went away: a record set for an Agent that is not there is dropped,
 * and `prune` (run whenever the projection changes, and at load) drops every
 * record whose Agent has gone. That is why these are not in the Agent's own
 * host directory, which lives as long but sits on the Agent's machine — an
 * SSH round trip per write, and a write that could not finish after main is
 * told to quit — nor in `state.json`, whose every save is a snapshot of the
 * whole model.
 *
 * Each write replaces the file whole (a temporary file renamed over it) and
 * is synchronous, so a record main has set is on disk before anything after
 * it — a quit included — can run.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const VERSION = 1;

/** A record in the file that is not one: what was wrong with it. */
export class RecordRefused extends Error {}

export interface AgentRecordsKind<T> {
	/** The key the records are under in the file: `drafts`. */
	readonly key: string;
	/** What starts empty when the file cannot be read, in a clause: `the Agents' unsent drafts start empty`. */
	readonly lost: string;
	/** One record as the file has it; throws `RecordRefused` for one that is not. */
	readonly decode: (value: unknown, agentId: string) => T;
}

/** What of the store a user of one kind of record needs: each Agent's, read and set. */
export interface AgentRecordStore<T> {
	get(agentId: string): T | undefined;
	set(agentId: string, record: T | undefined): void;
}

export class AgentRecords<T> implements AgentRecordStore<T> {
	readonly #path: string;
	readonly #kind: AgentRecordsKind<T>;
	readonly #accounted: () => ReadonlySet<string>;
	readonly #records: Map<string, T>;

	private constructor(
		path: string,
		kind: AgentRecordsKind<T>,
		accounted: () => ReadonlySet<string>,
		records: Map<string, T>,
	) {
		this.#path = path;
		this.#kind = kind;
		this.#accounted = accounted;
		this.#records = records;
	}

	/**
	 * The records at `path`, none when there is no file yet. A file that does
	 * not read as records is moved aside to `<path>.corrupt` and the store
	 * starts empty; `refused` says so, for the caller to tell the person.
	 */
	static load<T>(
		path: string,
		kind: AgentRecordsKind<T>,
		accounted: () => ReadonlySet<string>,
	): {
		readonly records: AgentRecords<T>;
		readonly refused: string | undefined;
	} {
		if (!existsSync(path)) {
			return {
				records: new AgentRecords(path, kind, accounted, new Map()),
				refused: undefined,
			};
		}
		const text = readFileSync(path, "utf8");
		let decoded: Map<string, T>;
		try {
			decoded = decode(JSON.parse(text), kind);
		} catch (error: unknown) {
			if (!(error instanceof SyntaxError || error instanceof RecordRefused)) {
				throw error;
			}
			const aside = `${path}.corrupt`;
			renameSync(path, aside);
			return {
				records: new AgentRecords(path, kind, accounted, new Map()),
				refused: `${path} could not be read (${error.message}); it was moved to ${aside}, and ${kind.lost}.`,
			};
		}
		const records = new AgentRecords(path, kind, accounted, decoded);
		records.prune();
		return { records, refused: undefined };
	}

	get(agentId: string): T | undefined {
		return this.#records.get(agentId);
	}

	/**
	 * The Agent's record is now `record`; undefined is none. Dropped when the
	 * Agent is not there: a record set after its Agent went away is a record
	 * of nothing.
	 */
	set(agentId: string, record: T | undefined): void {
		if (!this.#accounted().has(agentId)) {
			if (this.#records.delete(agentId)) this.#write();
			return;
		}
		const current = this.#records.get(agentId);
		if (JSON.stringify(current) === JSON.stringify(record)) return;
		if (record === undefined) this.#records.delete(agentId);
		else this.#records.set(agentId, record);
		this.#write();
	}

	/** Drop the record of every Agent that is not there any more. */
	prune(): void {
		const accounted = this.#accounted();
		let dropped = false;
		for (const agentId of [...this.#records.keys()]) {
			if (accounted.has(agentId)) continue;
			this.#records.delete(agentId);
			dropped = true;
		}
		if (dropped) this.#write();
	}

	#write(): void {
		mkdirSync(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.tmp`;
		writeFileSync(
			temporary,
			`${JSON.stringify({
				version: VERSION,
				[this.#kind.key]: Object.fromEntries(this.#records),
			})}\n`,
		);
		renameSync(temporary, this.#path);
	}
}

function decode<T>(value: unknown, kind: AgentRecordsKind<T>): Map<string, T> {
	if (typeof value !== "object" || value === null)
		throw new RecordRefused("it is not an object");
	const { version, [kind.key]: records } = value as Record<string, unknown>;
	if (version !== VERSION)
		throw new RecordRefused(`its version is ${JSON.stringify(version)}`);
	if (typeof records !== "object" || records === null || Array.isArray(records))
		throw new RecordRefused(`its ${kind.key} are not an object`);
	const decoded = new Map<string, T>();
	for (const [agentId, record] of Object.entries(records))
		decoded.set(agentId, kind.decode(record, agentId));
	return decoded;
}
