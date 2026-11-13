/**
 * The tasks and their escalations, and which agent is the orchestrator, on
 * disk.
 *
 * One file per profile, `<userData>/devhub/orchestrator-tasks.json`,
 * written whole and atomically (a temporary file renamed over it) after
 * every change, so a crash leaves the last change or the one before it,
 * never half of one. Kept apart from `state.json` on purpose: that file is
 * the window's arrangement, refused whole when it does not read; the
 * person's answers are worth more than that, and a DevHub that cannot read
 * this one moves it aside (`.corrupt`) and says so.
 *
 * **From before tasks.** When there is no tasks file yet, the files of the
 * escalation-only design beside it (`escalations.json`, the work records,
 * memos, priorities and requests) are converted once
 * (`model/taskMigration.ts`), the new file written, and the old ones moved
 * aside as `<name>.migrated`.
 *
 * Every change goes through the pure operations in `model/tasks.ts` and
 * `model/escalations.ts`; this class numbers, keeps the rules that span
 * tasks (an agent is bound to one open task at most), writes and tells.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	EscalationError,
	answerEscalation,
	createEscalation,
	isOpen,
	resolveEscalation,
	withdrawEscalation,
	type Escalation,
	type NewEscalation,
} from "../../model/escalations.js";
import {
	EMPTY_TASKS,
	TASKS_FILE_VERSION,
	bindAgent,
	completeTask,
	createTask,
	editTask,
	linkTask,
	observedAgent,
	setTaskStatus,
	tasksFromJson,
	unbindAgent,
	unlinkTask,
	type LiveTaskAgent,
	type NewTask,
	type StoredTaskStatus,
	type Task,
	type TaskEdit,
	type TasksFile,
} from "../../model/tasks.js";
import { migrateOldFiles, type OldFiles } from "../../model/taskMigration.js";

export interface TaskStoreIo {
	readonly exists: (path: string) => boolean;
	readonly read: (path: string) => string;
	readonly write: (path: string, text: string) => void;
	readonly moveAside: (path: string, to: string) => void;
}

const DISK: TaskStoreIo = {
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

export const TASKS_FILE = "orchestrator-tasks.json";

/** The files of the design before tasks, by what `migrateOldFiles` calls them. */
export const OLD_FILES: Readonly<Record<keyof OldFiles, string>> = {
	escalations: "escalations.json",
	work: "orchestrator-work.json",
	memos: "orchestrator-memos.json",
	priorities: "orchestrator-priorities.json",
	requests: "orchestrator-requests.json",
};

/** `agent keep`'s file: nothing reads it now; moved aside with the rest. */
const RETIRED_FILES = ["orchestrator-kept.json"];

export class TaskStore {
	#file: TasksFile;
	readonly #listeners = new Set<() => void>();

	private constructor(
		private readonly path: string | undefined,
		private readonly io: TaskStoreIo,
		file: TasksFile,
	) {
		this.#file = file;
	}

	/** Nothing on disk: for a DevHub that has not found its user data, and tests. */
	static inMemory(file: TasksFile = EMPTY_TASKS): TaskStore {
		return new TaskStore(undefined, DISK, file);
	}

	/**
	 * The store in `folder`, empty when there is nothing there yet, converted
	 * once from the files before tasks when they are there and it is not. A
	 * file that does not read is moved to `<path>.corrupt` and the store
	 * starts empty; `refused` says so, for the person; `migrated` says what
	 * was converted.
	 */
	static load(
		folder: string,
		io: TaskStoreIo = DISK,
		now: number = Date.now(),
	): {
		readonly store: TaskStore;
		readonly refused: string | undefined;
		readonly migrated?: string;
	} {
		const path = join(folder, TASKS_FILE);
		if (!io.exists(path)) return TaskStore.#migrate(folder, path, io, now);
		try {
			const file = tasksFromJson(JSON.parse(io.read(path)));
			return { store: new TaskStore(path, io, file), refused: undefined };
		} catch (error: unknown) {
			if (!(error instanceof SyntaxError || error instanceof EscalationError))
				throw error;
			const aside = `${path}.corrupt`;
			io.moveAside(path, aside);
			return {
				store: new TaskStore(path, io, EMPTY_TASKS),
				refused: `${path} could not be read (${error.message}); it was moved to ${aside}, and the board starts empty.`,
			};
		}
	}

	static #migrate(
		folder: string,
		path: string,
		io: TaskStoreIo,
		now: number,
	): {
		readonly store: TaskStore;
		readonly refused: string | undefined;
		readonly migrated?: string;
	} {
		const old: Record<string, unknown> = {};
		const found: string[] = [];
		const unread: string[] = [];
		for (const [key, name] of Object.entries(OLD_FILES)) {
			const at = join(folder, name);
			if (!io.exists(at)) continue;
			found.push(at);
			try {
				old[key] = JSON.parse(io.read(at));
			} catch {
				unread.push(name);
			}
		}
		if (found.length === 0)
			return {
				store: new TaskStore(path, io, EMPTY_TASKS),
				refused: undefined,
			};
		const file = migrateOldFiles(old as OldFiles, now);
		const store = new TaskStore(path, io, file);
		store.#commit(file);
		for (const at of [
			...found,
			...RETIRED_FILES.map((name) => join(folder, name)).filter((at) =>
				io.exists(at),
			),
		])
			io.moveAside(at, `${at}.migrated`);
		const open = file.tasks.filter((one) => one.done === undefined).length;
		return {
			store,
			refused:
				unread.length === 0
					? undefined
					: `${unread.join(", ")} could not be read and was left out of the conversion to tasks (moved aside as .migrated).`,
			migrated: `the orchestrator's escalations, work records, memos, priorities and requests were converted to ${String(file.tasks.length)} tasks (${String(open)} open) and ${String(file.escalations.length)} escalations; the old files were moved aside as .migrated.`,
		};
	}

	// --- reading -----------------------------------------------------------------

	tasks(): readonly Task[] {
		return this.#file.tasks;
	}

	escalations(): readonly Escalation[] {
		return this.#file.escalations;
	}

	task(id: number): Task | undefined {
		return this.#file.tasks.find((one) => one.id === id);
	}

	/** The one with `id`, or the sentence that says there is none. */
	requireTask(id: number): Task {
		const found = this.task(id);
		if (found === undefined)
			throw new EscalationError(
				`there is no task #${String(id)}. Run 'devhub --tell task list'.`,
			);
		return found;
	}

	escalation(id: number): Escalation | undefined {
		return this.#file.escalations.find((one) => one.id === id);
	}

	requireEscalation(id: number): Escalation {
		const found = this.escalation(id);
		if (found === undefined)
			throw new EscalationError(
				`there is no escalation #${String(id)}. Run 'devhub --tell escalation list'.`,
			);
		return found;
	}

	/** A task's escalations, oldest first. */
	escalationsOf(taskId: number): readonly Escalation[] {
		return this.#file.escalations.filter((one) => one.taskId === taskId);
	}

	/** The open task `agentId` is bound to, if any. */
	taskOfAgent(agentId: string): Task | undefined {
		return this.#file.tasks.find(
			(one) =>
				one.done === undefined &&
				one.agents.some((agent) => agent.agentId === agentId),
		);
	}

	get nextEscalationId(): number {
		return this.#file.nextEscalation;
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

	// --- tasks -------------------------------------------------------------------

	createTask(request: NewTask, now: number): Task {
		const made = createTask(this.#file.nextTask, request, now);
		this.#commit({
			...this.#file,
			nextTask: this.#file.nextTask + 1,
			tasks: [...this.#file.tasks, made],
		});
		return made;
	}

	edit(id: number, edit: TaskEdit, now: number): Task {
		return this.#replace(editTask(this.requireTask(id), edit, now));
	}

	setStatus(
		id: number,
		status: StoredTaskStatus,
		wait: { readonly note?: string; readonly checkAt?: number },
		now: number,
	): Task {
		return this.#replace(
			setTaskStatus(this.requireTask(id), status, wait, now),
		);
	}

	link(
		id: number,
		links: readonly string[],
		labels: Readonly<Record<string, string>> | undefined,
		now: number,
	): Task {
		return this.#replace(linkTask(this.requireTask(id), links, labels, now));
	}

	unlink(id: number, links: readonly string[], now: number): Task {
		return this.#replace(unlinkTask(this.requireTask(id), links, now));
	}

	/**
	 * Bind `agents` to task `id`: each leaves the other open task it was on
	 * (an agent works on one task at a time; a done task keeps it, as the
	 * work's history).
	 */
	bind(
		id: number,
		agents: readonly { readonly agentId: string; readonly name: string }[],
		now: number,
	): Task {
		let bound = this.requireTask(id);
		for (const agent of agents) bound = bindAgent(bound, agent, now);
		const ids = new Set(agents.map((one) => one.agentId));
		const tasks = this.#file.tasks.map((one) => {
			if (one.id === id) return bound;
			if (one.done !== undefined) return one;
			if (!one.agents.some((agent) => ids.has(agent.agentId))) return one;
			return {
				...one,
				agents: one.agents.filter((agent) => !ids.has(agent.agentId)),
				updatedAt: now,
			};
		});
		this.#commit({ ...this.#file, tasks });
		return bound;
	}

	unbind(id: number, agentId: string, now: number): Task {
		return this.#replace(unbindAgent(this.requireTask(id), agentId, now));
	}

	/**
	 * `task done`: completed. A question still open on it no longer stands:
	 * it is withdrawn with the completion, never left waiting on a task that
	 * is over.
	 */
	complete(id: number, note: string | undefined, now: number): Task {
		const done = completeTask(this.requireTask(id), note, now);
		this.#commit({
			...this.#file,
			tasks: this.#file.tasks.map((one) => (one.id === id ? done : one)),
			escalations: this.#file.escalations.map((one) =>
				one.taskId === id && isOpen(one)
					? withdrawEscalation(one, "タスク完了で取り下げ", now)
					: one,
			),
		});
		return done;
	}

	/** The person's request was delivered to the orchestrator. */
	requestSent(id: number, now: number): void {
		const task = this.task(id);
		if (task?.request === undefined || task.request.sentAt !== undefined)
			return;
		this.#replace({ ...task, request: { ...task.request, sentAt: now } });
	}

	/**
	 * DevHub's bookkeeping: a bound agent went to work, so a 待機 task is
	 * 処理中 again (its wait is over; nothing is decided by it).
	 */
	agentWorking(agentId: string, now: number): Task | undefined {
		const task = this.taskOfAgent(agentId);
		if (task === undefined || task.status !== "waiting") return undefined;
		return this.#replace(setTaskStatus(task, "in_progress", {}, now));
	}

	/**
	 * The managed agents open now: each bound agent's entry brought up to
	 * date (its sessions, folder, branch), one that continues a recorded
	 * session taking that entry's place under its new id, and every bound
	 * agent not among them marked stopped. Writes only what moved.
	 */
	observe(live: readonly LiveTaskAgent[], now: number): void {
		const byId = new Map(live.map((one) => [one.agentId, one]));
		const bySession = new Map<string, LiveTaskAgent>();
		for (const one of live)
			if (one.session !== undefined) bySession.set(one.session, one);
		let changed = false;
		const tasks = this.#file.tasks.map((task) => {
			let moved = false;
			const agents = task.agents.map((entry) => {
				const seen =
					byId.get(entry.agentId) ??
					entry.sessions.map((one) => bySession.get(one)).find(Boolean);
				// A done task's agents are history: only their stopping is kept.
				const next =
					task.done !== undefined && seen === undefined
						? entry
						: observedAgent(entry, seen, now);
				if (next !== entry) moved = true;
				return next;
			});
			if (!moved) return task;
			changed = true;
			// Resumed under a new id twice over: one entry per conversation.
			const unique = agents.filter(
				(one, index) =>
					agents.findIndex((other) => other.agentId === one.agentId) === index,
			);
			return { ...task, agents: unique };
		});
		if (changed) this.#commit({ ...this.#file, tasks });
	}

	// --- escalations ---------------------------------------------------------------

	raise(request: NewEscalation, now: number): Escalation {
		const task = this.requireTask(request.taskId);
		if (task.done !== undefined)
			throw new EscalationError(
				`task #${String(task.id)} is done: an escalation is about open work.`,
			);
		const made = createEscalation(this.#file.nextEscalation, request, now);
		this.#commit({
			...this.#file,
			nextEscalation: this.#file.nextEscalation + 1,
			escalations: [...this.#file.escalations, made],
		});
		return made;
	}

	/**
	 * The person's answer. Reached from the window's bridge, and nothing
	 * else. Its task goes 処理中: the answer is work to carry out.
	 */
	answer(id: number, markdown: string, now: number): Escalation {
		return this.#settle(
			answerEscalation(this.requireEscalation(id), markdown, now),
			now,
		);
	}

	/**
	 * Settled by the person directly (`resolveEscalation`): closed as
	 * answered, with their words to the agent, and its task 処理中 as an
	 * answer leaves it. The service checks the instruction was theirs.
	 */
	resolve(
		id: number,
		direct: Parameters<typeof resolveEscalation>[1],
		now: number,
	): Escalation {
		return this.#settle(
			resolveEscalation(this.requireEscalation(id), direct, now),
			now,
		);
	}

	#settle(answered: Escalation, now: number): Escalation {
		const id = answered.id;
		const task = this.task(answered.taskId);
		this.#commit({
			...this.#file,
			escalations: this.#file.escalations.map((one) =>
				one.id === id ? answered : one,
			),
			tasks: this.#file.tasks.map((one) =>
				one.id === task?.id && one.done === undefined
					? one.status === "in_progress"
						? { ...one, updatedAt: now }
						: setTaskStatus(one, "in_progress", {}, now)
					: one,
			),
		});
		return answered;
	}

	withdraw(id: number, note: string | undefined, now: number): Escalation {
		const withdrawn = withdrawEscalation(this.requireEscalation(id), note, now);
		this.#commit({
			...this.#file,
			escalations: this.#file.escalations.map((one) =>
				one.id === id ? withdrawn : one,
			),
		});
		return withdrawn;
	}

	#replace(next: Task): Task {
		this.#commit({
			...this.#file,
			tasks: this.#file.tasks.map((one) => (one.id === next.id ? next : one)),
		});
		return next;
	}

	#commit(file: TasksFile): void {
		const next: TasksFile = { ...file, version: TASKS_FILE_VERSION };
		if (this.path !== undefined)
			this.io.write(this.path, `${JSON.stringify(next, null, 1)}\n`);
		this.#file = next;
		for (const listener of this.#listeners) listener();
	}
}
