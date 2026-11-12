/**
 * The invariant DevHub holds the orchestrator to, and the subjects that
 * break it: what `needs_action` and `task.changed` say
 * (`docs/orchestrator.md`, "The invariant").
 *
 * Everything is said about **tasks** (`model/tasks.ts`). Every open task
 * is, in exactly one way, settled:
 *
 * - 回答待ち: an escalation on it is open — waiting for the person;
 * - 待機: parked by the orchestrator on purpose, with what it waits for;
 * - 処理中 and one of its bound agents at work (`working` or `background`,
 *   not stopping; a maintenance turn is not work).
 *
 * Otherwise it **needs action** (要対応, a flag on the task, not a status):
 * `no_agent` (処理中 with no bound agent open) or `idle` (its bound agents
 * all stopped).
 *
 * Work outside tasks is said so it gets one:
 *
 * - **a managed agent** (the orchestrator is never one) bound to no open
 *   task: `no_task`, whatever it is doing — the charter asks the
 *   orchestrator to give it a task, or stop it;
 * - **an item of the population** — an open Issue or pull request of the
 *   registered Projects (`[orchestrator.github] projects`) assigned to the
 *   viewer (`githubItems.ts`) — that no open task links: `no_task`. One an
 *   agent the person started is on (meta `issue=` naming it, an unmanaged
 *   agent) is the person's own, and left out.
 *
 * A line names the subject and the clause, never its state: the state is
 * `devhub --tell task show` / `status`. The state still matters here, as
 * `facts`: saving tells a line with something new from one said again by
 * them, and a 待機 task whose facts move — its linked items (state, pull
 * request, review, checks), its agents — is said as `task.changed`.
 */

import { agentAtWork } from "../../model/domain.js";
import type { TaskStatus } from "../../model/tasks.js";
import {
	breachWords,
	needsActionWords,
	shortId,
	subjectOf,
	type Breach,
	type EventAgent,
	type EventItem,
	type EventTask,
	type OrchestratorEvent,
} from "./events.js";

/**
 * The meta key `issue assign` (and Assign Issue) writes with the item an
 * agent was started on, by URL: what the Sidebar and the person read. The
 * invariant reads it only to leave the person's own work out.
 */
export const ISSUE_LINK_KEY = "issue";

/** A pull request's state, as `status` gives it. */
export interface PullFacts {
	readonly number: number;
	readonly url?: string;
	readonly state: "open" | "draft" | "closed" | "merged";
	/** GitHub's review decision; `none` when it has none. */
	readonly review:
		| "approved"
		| "changes_requested"
		| "review_required"
		| "none";
	readonly unresolved: number;
	/** Its head commit's checks; `none` when nothing reported. */
	readonly checks: "passing" | "failing" | "pending" | "none";
}

/**
 * An item — an Issue or a pull request, one thing here — as last read: one
 * assigned to the viewer on a registered Project, or one a task links (then
 * possibly closed, unassigned, or on no registered Project).
 */
export interface ItemFacts {
	readonly item: EventItem;
	readonly kind: "issue" | "pr";
	readonly state: "open" | "closed" | "merged";
	readonly assignedToMe: boolean;
	/** Its lane (Status) on each registered Project it is on; empty: on none. */
	readonly projects: readonly {
		readonly project: string;
		readonly lane: string | null;
	}[];
	/**
	 * Its pull request: a pull request item's own; an Issue's, the one that
	 * closes it (the open one, else the latest).
	 */
	readonly pull?: PullFacts;
}

export interface InvariantAgent {
	readonly id: string;
	readonly name: string;
	/** Its Workspace as `ws=` names it, its id and its label. */
	readonly ws: string;
	readonly workspaceId: string;
	readonly workspaceLabel?: string;
	readonly managed: boolean;
	/** working, background, waiting, idle, error, unknown. */
	readonly status: string;
	readonly stopping: boolean;
	/** Its meta `issue=`: the item it was started on. */
	readonly issue?: string;
	/** Its Workspace's pull request, as the Sidebar has it. */
	readonly pull?: PullFacts;
}

/** An open task, as the invariant reads it. */
export interface InvariantTask {
	readonly id: number;
	readonly title: string;
	/** Derived: `answer` while an escalation on it is open. */
	readonly status: Exclude<TaskStatus, "done">;
	readonly links: readonly string[];
	/** Its bound agents, by id (open or not). */
	readonly agents: readonly string[];
	/** Its open escalations, by id. */
	readonly escalations: readonly number[];
}

export interface InvariantInput {
	/**
	 * Every item on the registered Projects as last read, and the ones tasks
	 * link; undefined while the population is not known (GitHub not read, or
	 * not in full yet). Empty with no Project registered.
	 */
	readonly items: readonly ItemFacts[] | undefined;
	/** Every agent but the orchestrator. */
	readonly agents: readonly InvariantAgent[];
	/** The open tasks. */
	readonly tasks: readonly InvariantTask[];
}

/** One subject that breaks the invariant now. */
export interface NeedsActionSubject {
	/** `task <id>`, `item <url key>` or `agent <id>`. */
	readonly key: string;
	readonly kind: "task" | "issue" | "pr" | "agent";
	readonly task?: EventTask;
	readonly item?: EventItem;
	readonly agent?: EventAgent;
	readonly ws?: string;
	/** The clause it fails: what its line says. */
	readonly breach: Breach;
	/** Its state, `key=value`: not said, but a change is new. */
	readonly facts: readonly string[];
}

/** A 待機 task and the facts of what it is about. */
export interface WaitingTask {
	readonly taskId: number;
	readonly facts: readonly string[];
}

/** How an agent stands, for its row, `agent status` and `status`. */
export interface AgentStanding {
	readonly settled: boolean;
	/** The clause it fails, when it is its own subject (`no_task`). */
	readonly breach?: Breach;
	/** The open task it is bound to. */
	readonly task?: number;
	/** That task's clause, when the task needs action. */
	readonly taskBreach?: Breach;
}

/** How an item stands, for `status`. */
export interface ItemStanding {
	readonly key: string;
	readonly facts: ItemFacts;
	readonly inPopulation: boolean;
	/** The open tasks that link it. */
	readonly tasks: readonly number[];
	/** The clause it fails, when it is in the population and needs a task. */
	readonly breach?: Breach;
}

export interface InvariantReading {
	readonly needsAction: readonly NeedsActionSubject[];
	readonly waiting: readonly WaitingTask[];
	readonly agents: ReadonlyMap<string, AgentStanding>;
	/** Every item read, by its URL key. */
	readonly items: ReadonlyMap<string, ItemStanding>;
	/** Each open task's clause, when it needs action. */
	readonly tasks: ReadonlyMap<number, Breach>;
	/** The population is known (GitHub's items read in full). */
	readonly known: boolean;
}

/** An item URL, compared without case, a trailing slash or a fragment. */
export function issueUrlKey(url: string): string {
	return url
		.trim()
		.replace(/[#?].*$/u, "")
		.replace(/\/+$/u, "")
		.toLowerCase();
}

/**
 * An Issue's or pull request's link key: its URL without what follows its
 * number (`/files`, `#issuecomment-…`). Undefined for any other link.
 */
export function itemLinkKey(link: string): string | undefined {
	const item = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+/iu.exec(
		link.trim(),
	);
	return item === null ? undefined : issueUrlKey(item[0]);
}

/** At work, by the one rule (`agentAtWork`), and not stopping. */
function atWork(agent: InvariantAgent): boolean {
	return !agent.stopping && agentAtWork(agent.status);
}

/** `repo#123`: the repository and the number. */
export function issueToken(item: EventItem): string {
	return `${item.repo === "" ? "" : item.repo}#${String(item.number)}`;
}

/** An item as a line names it: `issue=acme/app#1`, `pr=acme/app#9`. */
export function itemToken(kind: "issue" | "pr", item: EventItem): string {
	return `${kind}=${issueToken(item)}`;
}

// --- facts: a subject's state, kept to see it move --------------------------------

function pullFacts(pull: PullFacts | undefined): string[] {
	if (pull === undefined) return ["pr=none"];
	return [
		`pr=#${String(pull.number)}`,
		`pr_state=${pull.state}`,
		`review=${pull.review}`,
		`unresolved=${String(pull.unresolved)}`,
		`checks=${pull.checks}`,
	];
}

function itemFacts(item: ItemFacts): string[] {
	return [
		`state=${item.state}`,
		`assigned=${item.assignedToMe ? "yes" : "no"}`,
		...item.projects.map((one) => `lane=${one.project}:${one.lane ?? "none"}`),
		...pullFacts(item.pull),
	];
}

function inPopulation(item: ItemFacts): boolean {
	return item.state === "open" && item.assignedToMe && item.projects.length > 0;
}

/** The invariant, read off one moment's state. */
export function readInvariant(input: InvariantInput): InvariantReading {
	const { items, agents, tasks } = input;
	const needsAction: NeedsActionSubject[] = [];
	const standings = new Map<string, AgentStanding>();
	const itemStandings = new Map<string, ItemStanding>();
	const taskBreaches = new Map<number, Breach>();
	const byKey = new Map<string, ItemFacts>();
	for (const one of items ?? [])
		if (one.item.url !== undefined) {
			const key = issueUrlKey(one.item.url);
			if (!byKey.has(key)) byKey.set(key, one);
		}
	const agentById = new Map(agents.map((one) => [one.id, one]));
	const taskOf = new Map<string, InvariantTask>();
	for (const task of tasks)
		for (const id of task.agents) if (!taskOf.has(id)) taskOf.set(id, task);
	const linkedItems = (task: InvariantTask) =>
		task.links.flatMap((link) => {
			const key = itemLinkKey(link);
			const item = key === undefined ? undefined : byKey.get(key);
			return item === undefined ? [] : [item];
		});
	const facts = (task: InvariantTask, on: readonly InvariantAgent[]) => [
		`status=${task.status}`,
		`agents=${on.length === 0 ? "none" : on.map((agent) => `${shortId(agent.id)}:${agent.stopping ? "stopping" : agent.status}`).join(",")}`,
		...linkedItems(task).flatMap((item) => [
			itemToken(item.kind, item.item),
			...itemFacts(item),
		]),
		...on.flatMap((agent) =>
			agent.pull === undefined
				? []
				: [`ws=${agent.ws}`, ...pullFacts(agent.pull)],
		),
		`esc=${task.escalations.length === 0 ? "none" : task.escalations.join(",")}`,
	];
	// The tasks.
	const waiting: WaitingTask[] = [];
	for (const task of tasks) {
		const on = task.agents.flatMap((id) => {
			const agent = agentById.get(id);
			return agent === undefined ? [] : [agent];
		});
		if (task.status === "waiting")
			waiting.push({ taskId: task.id, facts: facts(task, on) });
		if (task.status !== "in_progress" || on.some(atWork)) continue;
		const breach: Breach = { clause: on.length === 0 ? "no_agent" : "idle" };
		taskBreaches.set(task.id, breach);
		needsAction.push({
			key: `task ${String(task.id)}`,
			kind: "task",
			task: { id: task.id, title: task.title },
			...(on[0] === undefined ? {} : { ws: on[0].ws }),
			breach,
			facts: facts(task, on),
		});
	}
	// The items: in the population, and no open task links them.
	for (const [key, item] of byKey) {
		const linking = tasks
			.filter((task) => task.links.some((link) => itemLinkKey(link) === key))
			.map((task) => task.id);
		const population = inPopulation(item);
		const own = agents.some(
			(agent) =>
				!agent.managed &&
				agent.issue !== undefined &&
				issueUrlKey(agent.issue) === key,
		);
		const breach: Breach | undefined =
			population && linking.length === 0 && !own
				? { clause: "no_task" }
				: undefined;
		itemStandings.set(key, {
			key,
			facts: item,
			inPopulation: population,
			tasks: linking,
			...(breach === undefined ? {} : { breach }),
		});
		if (breach === undefined) continue;
		needsAction.push({
			key: `item ${key}`,
			kind: item.kind,
			item: item.item,
			breach,
			facts: itemFacts(item),
		});
	}
	// The agents.
	for (const agent of agents) {
		const task = taskOf.get(agent.id);
		const taskBreach =
			task === undefined ? undefined : taskBreaches.get(task.id);
		if (!agent.managed || task !== undefined) {
			standings.set(agent.id, {
				settled: taskBreach === undefined,
				...(task === undefined ? {} : { task: task.id }),
				...(taskBreach === undefined ? {} : { taskBreach }),
			});
			continue;
		}
		const breach: Breach = { clause: "no_task" };
		standings.set(agent.id, { settled: false, breach });
		needsAction.push({
			key: `agent ${agent.id}`,
			kind: "agent",
			agent: { id: agent.id, name: agent.name },
			ws: agent.ws,
			breach,
			facts: [
				`status=${agent.stopping ? "stopping" : agent.status}`,
				...pullFacts(agent.pull),
			],
		});
	}
	return {
		needsAction,
		waiting,
		agents: standings,
		items: itemStandings,
		tasks: taskBreaches,
		known: items !== undefined,
	};
}

/**
 * The item a `status` reference names, in a reading: its URL, or
 * `owner/repo#N` (an Issue's or a pull request's number alike).
 */
export function findItem(
	reading: InvariantReading,
	ref: string,
): ItemStanding | undefined {
	const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/u.exec(ref.trim());
	if (short === null) return reading.items.get(issueUrlKey(ref));
	const repo = short[1]!.toLowerCase();
	const number = Number(short[2]);
	return [...reading.items.values()].find(
		(one) =>
			one.facts.item.repo.toLowerCase() === repo &&
			one.facts.item.number === number,
	);
}

// --- the watch ---------------------------------------------------------------

/** A subject that needs action now, as the board and `status` show it. */
export interface NeedsActionView {
	readonly key: string;
	/** The dispatcher's subject for it (`subjectOf`). */
	readonly subject: string;
	readonly kind: "task" | "issue" | "pr" | "agent";
	/** Its words, as its `needs_action` line has them, without the `[type]`. */
	readonly line: string;
	/** The clause it fails: `idle`, `no_task`. */
	readonly clause: string;
	/** Since when it has needed action, as DevHub saw it. */
	readonly since: number;
}

export interface InvariantWatchPorts {
	readonly dispatch: (event: OrchestratorEvent) => void;
	readonly now: () => number;
}

/** The event a subject is said as. */
function eventOf(subject: NeedsActionSubject): OrchestratorEvent {
	return {
		type: "needs_action",
		subject:
			subject.kind === "task"
				? { kind: "task", task: subject.task! }
				: subject.kind === "agent"
					? { kind: "agent", agent: subject.agent! }
					: { kind: subject.kind, item: subject.item! },
		...(subject.ws === undefined ? {} : { ws: subject.ws }),
		breach: subject.breach,
	};
}

export class InvariantWatch {
	/** Since when each subject has needed action (for `status` and the board). */
	readonly #since = new Map<string, number>();
	/** Each 待機 task's facts as last seen. */
	readonly #waiting = new Map<number, string>();
	#reading: InvariantReading = {
		needsAction: [],
		waiting: [],
		agents: new Map(),
		items: new Map(),
		tasks: new Map(),
		known: false,
	};

	constructor(private readonly ports: InvariantWatchPorts) {}

	get reading(): InvariantReading {
		return this.#reading;
	}

	/**
	 * A new reading: each 待機 task whose facts moved is said. `speak`
	 * false: nothing is said (no orchestrator).
	 */
	observe(reading: InvariantReading, speak: boolean): void {
		const now = this.ports.now();
		this.#reading = reading;
		const keys = new Set(reading.needsAction.map((one) => one.key));
		for (const key of [...this.#since.keys()])
			if (!keys.has(key)) this.#since.delete(key);
		for (const subject of reading.needsAction)
			if (!this.#since.has(subject.key)) this.#since.set(subject.key, now);
		const open = new Set(reading.waiting.map((one) => one.taskId));
		for (const id of [...this.#waiting.keys()])
			if (!open.has(id)) this.#waiting.delete(id);
		for (const one of reading.waiting) {
			const facts = one.facts.join(" ");
			const before = this.#waiting.get(one.taskId);
			this.#waiting.set(one.taskId, facts);
			// The first look is where it stands: nothing has moved yet.
			if (!speak || before === undefined || before === facts) continue;
			this.ports.dispatch({
				type: "task.changed",
				taskId: one.taskId,
				reasons: ["subjects_changed"],
			});
		}
	}

	/** What a delivery says of the invariant: one `needs_action` per subject. */
	due(): readonly OrchestratorEvent[] {
		return this.#reading.needsAction.map(eventOf);
	}

	/**
	 * A `needs_action` line's state, for saving to tell a line with
	 * something new from one said again (`EventDelivery.statePrint`): since
	 * when its subject has needed action, its clause and its facts.
	 * Undefined: the subject does not need action now.
	 */
	print(event: OrchestratorEvent): string | undefined {
		if (event.type !== "needs_action") return undefined;
		const subject = subjectOf(event);
		const one = this.#reading.needsAction.find(
			(candidate) => subjectOf(eventOf(candidate)) === subject,
		);
		if (one === undefined) return undefined;
		return [
			String(this.#since.get(one.key) ?? 0),
			breachWords(one.breach),
			...one.facts,
		].join(" ");
	}

	/** How an agent stands, as of the last reading. */
	standing(agentId: string): AgentStanding | undefined {
		return this.#reading.agents.get(agentId);
	}

	/** One subject's view, if it needs action now. */
	view(key: string): NeedsActionView | undefined {
		const subject = this.#reading.needsAction.find((one) => one.key === key);
		return subject === undefined ? undefined : this.#view(subject);
	}

	#view(subject: NeedsActionSubject): NeedsActionView {
		const event = eventOf(subject);
		return {
			key: subject.key,
			subject: subjectOf(event),
			kind: subject.kind,
			line: event.type === "needs_action" ? needsActionWords(event) : "",
			clause: breachWords(subject.breach),
			since: this.#since.get(subject.key) ?? this.ports.now(),
		};
	}

	/** Every subject that needs action now. */
	needsAction(): readonly NeedsActionView[] {
		return this.#reading.needsAction.map((subject) => this.#view(subject));
	}
}
