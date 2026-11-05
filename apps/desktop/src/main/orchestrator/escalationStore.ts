/**
 * The escalations, and which agent is the orchestrator, on disk.
 *
 * One file per profile, `<userData>/devhub/escalations.json`, written whole
 * and atomically (a temporary file renamed over it) after every change, so a
 * crash leaves the last change or the one before it, never half of one. It is
 * small — text, a few hundred tickets at most — and changes when somebody
 * writes something, so there is nothing to batch.
 *
 * Kept apart from `state.json` on purpose: that file is the window's
 * arrangement, rewritten on every move, and refused whole when it does not
 * read; a thread the person wrote answers in is worth more than that, and a
 * DevHub that cannot read this one moves it aside (`.corrupt`) and says so
 * rather than losing it with the layout.
 *
 * Every change goes through the pure operations in `model/escalations.ts`;
 * this class only numbers, keeps, writes and tells.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	EMPTY_ESCALATIONS,
	ESCALATIONS_FILE_VERSION,
	EscalationError,
	answerEscalation,
	askAgain,
	closeEscalation,
	createEscalation,
	escalationsFromJson,
	linkAgent,
	rankEscalation,
	type EscalationRank,
	noteWorking,
	holdEscalation,
	resumeEscalation,
	waitEscalation,
	type Escalation,
	type EscalationsFile,
	type NewEscalation,
	type WaitRequest,
} from "../../model/escalations.js";

export interface EscalationStoreIo {
	readonly exists: (path: string) => boolean;
	readonly read: (path: string) => string;
	readonly write: (path: string, text: string) => void;
	readonly moveAside: (path: string, to: string) => void;
}

const DISK: EscalationStoreIo = {
	exists: existsSync,
	read: (path) => readFileSync(path, "utf8"),
	write: (path, text) => {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${String(process.pid)}.tmp`;
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, path);
	},
	moveAside: renameSync,
};

export class EscalationStore {
	#file: EscalationsFile;
	readonly #listeners = new Set<() => void>();

	private constructor(
		private readonly path: string | undefined,
		private readonly io: EscalationStoreIo,
		file: EscalationsFile,
	) {
		this.#file = file;
	}

	/** Nothing on disk: for a DevHub that has not found its user data, and tests. */
	static inMemory(file: EscalationsFile = EMPTY_ESCALATIONS): EscalationStore {
		return new EscalationStore(undefined, DISK, file);
	}

	/**
	 * The store at `path`, empty when there is no file yet. A file that does
	 * not read is moved to `<path>.corrupt` and the store starts empty;
	 * `refused` says so, for the person.
	 */
	static load(
		path: string,
		io: EscalationStoreIo = DISK,
	): { readonly store: EscalationStore; readonly refused: string | undefined } {
		if (!io.exists(path))
			return {
				store: new EscalationStore(path, io, EMPTY_ESCALATIONS),
				refused: undefined,
			};
		try {
			const file = escalationsFromJson(JSON.parse(io.read(path)));
			return { store: new EscalationStore(path, io, file), refused: undefined };
		} catch (error: unknown) {
			if (!(error instanceof SyntaxError || error instanceof EscalationError))
				throw error;
			const aside = `${path}.corrupt`;
			io.moveAside(path, aside);
			return {
				store: new EscalationStore(path, io, EMPTY_ESCALATIONS),
				refused: `${path} could not be read (${error.message}); it was moved to ${aside}, and the board starts empty.`,
			};
		}
	}

	/** Every escalation, closed ones included, by id. */
	all(): readonly Escalation[] {
		return this.#file.escalations;
	}

	get(id: number): Escalation | undefined {
		return this.#file.escalations.find((one) => one.id === id);
	}

	/** The one with `id`, or the sentence that says there is none. */
	require(id: number): Escalation {
		const found = this.get(id);
		if (found === undefined)
			throw new EscalationError(
				`there is no escalation #${String(id)}. Run 'devhub --tell escalation list'.`,
			);
		return found;
	}

	/** The number the next escalation will get. */
	get nextId(): number {
		return this.#file.next;
	}

	get orchestratorAgentId(): string | undefined {
		return this.#file.orchestratorAgentId;
	}

	setOrchestrator(agentId: string | undefined): void {
		if (agentId === this.#file.orchestratorAgentId) return;
		const { orchestratorAgentId: _old, ...rest } = this.#file;
		this.#commit(
			agentId === undefined ? rest : { ...rest, orchestratorAgentId: agentId },
		);
	}

	/** Called after every change, once it is on disk. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	create(request: NewEscalation, now: number): Escalation {
		const made = createEscalation(this.#file.next, request, now);
		this.#commit({
			...this.#file,
			next: this.#file.next + 1,
			escalations: [...this.#file.escalations, made],
		});
		return made;
	}

	ask(
		id: number,
		markdown: string,
		options: readonly string[] | undefined,
		now: number,
		links: readonly string[] = [],
	): Escalation {
		return this.#replace(
			askAgain(this.require(id), markdown, options, now, links),
		);
	}

	/** The person's answer. Reached from the window's bridge, and nothing else. */
	answer(id: number, markdown: string, now: number): Escalation {
		return this.#replace(answerEscalation(this.require(id), markdown, now));
	}

	close(id: number, note: string | undefined, now: number): Escalation {
		return this.#replace(closeEscalation(this.require(id), note, now));
	}

	/**
	 * DevHub's note that `agentId` went back to work (`noteWorking`): the
	 * person talked to it directly, or it resumed. Reached from the
	 * orchestrator service seeing it happen, and nothing else.
	 */
	note(
		id: number,
		kind: "direct" | "resumed",
		agentId: string,
		now: number,
	): Escalation {
		return this.#replace(noteWorking(this.require(id), kind, agentId, now));
	}

	/** To `in_progress` without an answer: the orchestrator's `escalation hold`. */
	hold(id: number, note: string | undefined, now: number): Escalation {
		return this.#replace(holdEscalation(this.require(id), note, now));
	}

	/** Parked on an outside condition: the orchestrator's `escalation wait`. */
	wait(id: number, request: WaitRequest, now: number): Escalation {
		return this.#replace(waitEscalation(this.require(id), request, now));
	}

	/** Off its wait, to `in_progress`: the orchestrator's `escalation resume`. */
	resume(id: number, note: string | undefined, now: number): Escalation {
		return this.#replace(resumeEscalation(this.require(id), note, now));
	}

	link(id: number, agentId: string, now: number): Escalation {
		return this.#replace(linkAgent(this.require(id), agentId, now));
	}

	/** The orchestrator's ranking, given again (`escalation rank`). */
	rank(id: number, rank: EscalationRank, now: number): Escalation {
		return this.#replace(rankEscalation(this.require(id), rank, now));
	}

	#replace(next: Escalation): Escalation {
		this.#commit({
			...this.#file,
			escalations: this.#file.escalations.map((one) =>
				one.id === next.id ? next : one,
			),
		});
		return next;
	}

	#commit(file: EscalationsFile): void {
		const next: EscalationsFile = {
			...file,
			version: ESCALATIONS_FILE_VERSION,
		};
		if (this.path !== undefined)
			this.io.write(this.path, `${JSON.stringify(next, null, 1)}\n`);
		this.#file = next;
		for (const listener of this.#listeners) listener();
	}
}
