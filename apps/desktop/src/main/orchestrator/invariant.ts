/**
 * The invariant DevHub holds the orchestrator to, and the subjects that break
 * it: what `needs_action` and `waiting.changed` say (`docs/orchestrator.md`,
 * "The invariant").
 *
 * **The population** is every open item of the registered Projects
 * (`[orchestrator.github] projects`) assigned to the viewer — an Issue or a
 * pull request card, one thing here (`githubItems.ts`). With no Project
 * registered it is empty. For each of them exactly one of these holds, or
 * it **needs action**:
 *
 * - (a) an agent linked to it is working (status `working` or `background`,
 *   not stopping);
 * - (b) a 要回答 (`needs_answer`) escalation is about it (its agent stopped,
 *   waiting for the person);
 * - (c) a 待機中 (`waiting`) escalation is about it (an explicit condition).
 *
 * An item one of whose linked agents is not managed is the person's own,
 * and left out.
 *
 * **Every managed agent** (the orchestrator is never one) is working, or is
 * one of the agents of a 要回答 or 待機中 escalation; one that is neither
 * needs action. So does one whose item is outside the population — closed,
 * not assigned to the viewer, on no registered Project — or that has no item
 * at all,
 * whatever it is doing: for that reason alone. One whose Issue is still to
 * be written (meta `issue=pending`, `ISSUE_PENDING`: the investigation an
 * Issue is filed from) has no item yet by its own account, and is held to
 * the first rule only, until it is linked. While the population is not
 * known (GitHub is not read, or not in full yet), only the first rule is
 * applied to agents, and no item is said.
 *
 * **Linked**, the one rule: an agent is linked to the item its meta `issue=`
 * names, by URL. DevHub writes that pair itself when `issue assign` (or the
 * window's Assign Issue) starts the agent on an Issue or a pull request, and
 * `agent meta` / `--meta` set it by hand too, as that URL. The branch a
 * Workspace is on does not link anything.
 *
 * **About an item**, for an escalation: one of its links is the item's URL,
 * or one of its agents — `--agent`, a `devhub:agent/` link, the agents of a
 * `devhub:workspace/` link or of its `--workspace` — is linked to it.
 *
 * A line names the subject and the clause it fails (`Breach`), never its
 * state: the state is read with `devhub --tell status` (`statusOf` here is
 * what it is built from). What the subject's state is still matters here, as
 * `facts`: a keeping ends when they change.
 *
 * `InvariantWatch` holds the last reading: every delivery carries one
 * `needs_action` line per subject that needs action then (`due`), whatever
 * was said before — the orchestrator is nagged every `delivery_interval`
 * while it stays so. An agent the orchestrator chose to keep as it is
 * (`agent keep A --note`) is left out while its state stays what it was
 * when it was kept; keepings are kept on disk (`keptFile.ts`), and judged
 * again once the state is known again. A 待機中 escalation whose subjects'
 * facts change is said (`waiting.changed`): what it waits on may have come.
 */

import { agentByIdOrPrefix, parseDevhubLink } from "../../model/devhubLink.js";
import { agentAtWork } from "../../model/domain.js";
import type { EscalationState } from "../../model/escalations.js";
import {
	breachWords,
	needsActionWords,
	shortId,
	subjectOf,
	type Breach,
	type EventAgent,
	type EventItem,
	type OrchestratorEvent,
	type OutsideReason,
} from "./events.js";
import type { KeptStore } from "./keptFile.js";

/**
 * The meta key the item linkage is kept under: written by DevHub when `issue
 * assign` (or Assign Issue) starts an agent on an Issue or a pull request;
 * `agent meta` and `--meta` may set it too, to an item URL only
 * (`cli/tell/service.ts`).
 */
export const ISSUE_LINK_KEY = "issue";

/**
 * The one value of `issue=` that is not an item's URL: the agent's work has
 * no Issue yet — it is the investigation an Issue is to be written from —
 * and one is to be filed and linked (`agent meta A set issue <URL>`, which
 * replaces it). Such a managed agent is held to the status rule only, not
 * `outside_population (no_item)`.
 */
export const ISSUE_PENDING = "pending";

/** An agent's meta `issue=` as the invariant reads it: a URL, or pending. */
export function issueLinkOf(
	value: string | undefined,
): Pick<InvariantAgent, "issue" | "issuePending"> {
	if (value === undefined) return {};
	return value === ISSUE_PENDING ? { issuePending: true } : { issue: value };
}

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
 * assigned to the viewer on a registered Project, or one an agent is linked
 * to (then possibly closed, unassigned, or on no registered Project).
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
	/** The item it is linked to: its meta `issue=`, an item's URL. */
	readonly issue?: string;
	/** Its meta `issue=pending`: no Issue yet, one to be filed (`ISSUE_PENDING`). */
	readonly issuePending?: boolean;
	/** Its Workspace's pull request, as the Sidebar has it. */
	readonly pull?: PullFacts;
}

export interface InvariantEscalation {
	readonly id: number;
	readonly title: string;
	readonly state: EscalationState;
	/** URLs and `devhub:` links. */
	readonly links: readonly string[];
	readonly agents: readonly string[];
	readonly workspaceId?: string;
	/** A 待機中 one's trigger, when its wait began, and its time. */
	readonly trigger?: string;
	readonly waitSince?: number;
	readonly dueAt?: number;
}

export interface InvariantInput {
	/**
	 * Every item on the registered Projects as last read; undefined while the
	 * population is not known (GitHub not read, or not every Project in full
	 * yet). Empty with no Project registered: the population is empty.
	 */
	readonly items: readonly ItemFacts[] | undefined;
	/** Every agent but the orchestrator. */
	readonly agents: readonly InvariantAgent[];
	/** The open escalations. */
	readonly escalations: readonly InvariantEscalation[];
}

/** One subject that breaks the invariant now. */
export interface NeedsActionSubject {
	/** `item <url key>` or `agent <id>`: the subject. */
	readonly key: string;
	/** An Issue or a pull request item, or a managed agent. */
	readonly kind: "issue" | "pr" | "agent";
	readonly item?: EventItem;
	readonly agent?: EventAgent;
	readonly ws?: string;
	/** The clause it fails: what its line says. */
	readonly breach: Breach;
	/** Its state, `key=value`: not said, but a change says it again. */
	readonly facts: readonly string[];
	/**
	 * An agent's state as a keeping holds it: its status, its item's, its
	 * escalations — not its Workspace's pull request, which a restart reads
	 * again later than the rest.
	 */
	readonly keepFacts?: readonly string[];
}

/** A 待機中 escalation and the facts of what it is about. */
export interface WaitingSubject {
	readonly escalationId: number;
	readonly waitSince: number;
	/** Its subjects' facts: a change is `waiting.changed`. */
	readonly facts: readonly string[];
}

/** How an agent stands, for its row, `agent status` and `status`. */
export interface AgentStanding {
	readonly settled: boolean;
	/** The clause it fails (managed agents only). */
	readonly breach?: Breach;
	/** The 待機中 escalation it is one of the agents of, and its trigger. */
	readonly waiting?: {
		readonly escalationId: number;
		readonly trigger: string;
	};
	/** The item it is linked to, as last read; absent when not known. */
	readonly item?: ItemFacts;
	/** The open escalations it is one of the agents of. */
	readonly escalations: readonly number[];
	/** Its state as facts (managed agents): a change ends a keeping. */
	readonly facts?: readonly string[];
}

/** How an item stands, for `status`. */
export interface ItemStanding {
	readonly key: string;
	readonly facts: ItemFacts;
	readonly inPopulation: boolean;
	/** The agents linked to it. */
	readonly agents: readonly string[];
	/** The open escalations about it. */
	readonly escalations: readonly number[];
	/** The clause it fails, when it is in the population and needs action. */
	readonly breach?: Breach;
}

export interface InvariantReading {
	readonly needsAction: readonly NeedsActionSubject[];
	readonly waiting: readonly WaitingSubject[];
	readonly agents: ReadonlyMap<string, AgentStanding>;
	/** Every item read, by its URL key. */
	readonly items: ReadonlyMap<string, ItemStanding>;
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

function linked(agent: InvariantAgent, item: EventItem): boolean {
	return (
		agent.issue !== undefined &&
		item.url !== undefined &&
		issueUrlKey(agent.issue) === issueUrlKey(item.url)
	);
}

/** At work, by the one rule (`agentAtWork`), and not stopping. */
function atWork(agent: InvariantAgent): boolean {
	return !agent.stopping && agentAtWork(agent.status);
}

/** The agents an escalation names: `--agent`, `devhub:` links, its Workspace's. */
function escalationAgents(
	escalation: InvariantEscalation,
	agents: readonly InvariantAgent[],
): InvariantAgent[] {
	const out = new Set<InvariantAgent>();
	for (const id of escalation.agents) {
		const agent = agents.find((one) => one.id === id);
		if (agent !== undefined) out.add(agent);
	}
	const inWorkspace = (name: string) =>
		agents.filter(
			(one) =>
				one.workspaceId === name ||
				one.ws === name ||
				one.workspaceLabel === name,
		);
	for (const link of escalation.links) {
		const parsed = parseDevhubLink(link);
		if (!parsed.ok) continue;
		if (parsed.link.kind === "agent") {
			const agent = agentByIdOrPrefix(parsed.link.agent, agents);
			if (agent !== undefined) out.add(agent);
		} else if (parsed.link.kind === "workspace")
			for (const agent of inWorkspace(parsed.link.workspace)) out.add(agent);
	}
	if (escalation.workspaceId !== undefined)
		for (const agent of inWorkspace(escalation.workspaceId)) out.add(agent);
	return [...out];
}

/** Whether the escalation is about the item: see the module's comment. */
export function escalationAbout(
	escalation: InvariantEscalation,
	item: EventItem,
	agents: readonly InvariantAgent[],
): boolean {
	if (
		item.url !== undefined &&
		escalation.links.some(
			(link) =>
				/^https?:\/\//iu.test(link.trim()) &&
				issueUrlKey(link) === issueUrlKey(item.url!),
		)
	)
		return true;
	return escalationAgents(escalation, agents).some((agent) =>
		linked(agent, item),
	);
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

function escalationFacts(
	escalations: readonly InvariantEscalation[],
): string[] {
	return escalations.length === 0
		? ["esc=none"]
		: [
				`esc=${escalations
					.map((one) => `${String(one.id)}:${one.state}`)
					.join(",")}`,
			];
}

function inPopulation(item: ItemFacts): boolean {
	return outsideReason(item) === undefined;
}

/**
 * Why an item is outside the population, as `outside_population` says it:
 * an item read only because an agent is linked to it may be on no
 * registered Project (`projects` empty).
 */
function outsideReason(item: ItemFacts): OutsideReason | undefined {
	if (item.state !== "open") return "closed";
	if (!item.assignedToMe) return "unassigned";
	if (item.projects.length === 0) return "not_in_project";
	return undefined;
}

const parkedState = (one: InvariantEscalation) =>
	one.state === "needs_answer" || one.state === "waiting";

/** The invariant, read off one moment's state. */
export function readInvariant(input: InvariantInput): InvariantReading {
	const { items, agents, escalations } = input;
	const needsAction: NeedsActionSubject[] = [];
	const standings = new Map<string, AgentStanding>();
	const itemStandings = new Map<string, ItemStanding>();
	const about = (agent: InvariantAgent) =>
		escalations.filter((one) => escalationAgents(one, agents).includes(agent));
	const byKey = new Map<string, ItemFacts>();
	for (const one of items ?? [])
		if (one.item.url !== undefined) {
			const key = issueUrlKey(one.item.url);
			if (!byKey.has(key)) byKey.set(key, one);
		}
	// The items.
	for (const [key, item] of byKey) {
		const on = agents.filter((agent) => linked(agent, item.item));
		const its = escalations.filter((one) =>
			escalationAbout(one, item.item, agents),
		);
		const population = inPopulation(item);
		const settled =
			!population ||
			on.some((agent) => !agent.managed) ||
			on.some(atWork) ||
			its.some(parkedState);
		const breach: Breach | undefined = settled
			? undefined
			: { clause: on.length === 0 ? "no_agent" : "idle_no_escalation" };
		itemStandings.set(key, {
			key,
			facts: item,
			inPopulation: population,
			agents: on.map((agent) => agent.id),
			escalations: its.map((one) => one.id),
			...(breach === undefined ? {} : { breach }),
		});
		if (breach === undefined) continue;
		needsAction.push({
			key: `item ${key}`,
			kind: item.kind,
			item: item.item,
			...(on[0] === undefined ? {} : { ws: on[0].ws }),
			breach,
			facts: [
				...itemFacts(item),
				`agents=${on.length === 0 ? "none" : on.map((agent) => `${shortId(agent.id)}:${agent.status}`).join(",")}`,
				...escalationFacts(its),
			],
		});
	}
	// The agents.
	for (const agent of agents) {
		const mine = about(agent);
		const waitingIn = mine.find((one) => one.state === "waiting");
		const item =
			agent.issue === undefined
				? undefined
				: byKey.get(issueUrlKey(agent.issue));
		const common = {
			...(waitingIn === undefined
				? {}
				: {
						waiting: {
							escalationId: waitingIn.id,
							trigger: waitingIn.trigger ?? "",
						},
					}),
			...(item === undefined ? {} : { item }),
			escalations: mine.map((one) => one.id),
		};
		if (!agent.managed) {
			standings.set(agent.id, { settled: true, ...common });
			continue;
		}
		const outside: OutsideReason | undefined =
			items === undefined
				? undefined
				: agent.issue === undefined
					? agent.issuePending === true
						? undefined
						: "no_item"
					: item === undefined
						? "not_in_project"
						: outsideReason(item);
		const breach: Breach | undefined =
			outside !== undefined
				? { clause: "outside_population", outside }
				: atWork(agent) || mine.some(parkedState)
					? undefined
					: { clause: "idle_no_escalation" };
		const keepFacts = [
			`status=${agent.stopping ? "stopping" : agent.status}`,
			`issue=${agent.issue ?? (agent.issuePending === true ? ISSUE_PENDING : "none")}`,
			...(item === undefined ? [] : itemFacts(item)),
			...escalationFacts(mine),
		];
		const facts = [
			...keepFacts,
			...(item === undefined ? pullFacts(agent.pull) : []),
		];
		standings.set(agent.id, {
			settled: breach === undefined,
			...(breach === undefined ? {} : { breach }),
			facts,
			...common,
		});
		if (breach === undefined) continue;
		needsAction.push({
			key: `agent ${agent.id}`,
			kind: "agent",
			agent: { id: agent.id, name: agent.name },
			ws: agent.ws,
			breach,
			facts,
			keepFacts,
		});
	}
	// The 待機中 escalations, and the facts of what they are about.
	const waiting: WaitingSubject[] = [];
	for (const one of escalations) {
		if (one.state !== "waiting") continue;
		const facts: string[] = [];
		for (const item of byKey.values())
			if (escalationAbout(one, item.item, agents))
				facts.push(itemToken(item.kind, item.item), ...itemFacts(item));
		for (const agent of escalationAgents(one, agents))
			facts.push(
				`agent=${shortId(agent.id)}`,
				`status=${agent.status}`,
				...(agent.issue !== undefined && byKey.has(issueUrlKey(agent.issue))
					? []
					: pullFacts(agent.pull)),
			);
		waiting.push({
			escalationId: one.id,
			waitSince: one.waitSince ?? 0,
			facts,
		});
	}
	return {
		needsAction,
		waiting,
		agents: standings,
		items: itemStandings,
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

/** An agent the orchestrator chose to keep as it is, and why. */
export interface KeptAgent {
	readonly note: string;
	readonly at: number;
	/** Its facts when it was kept: a change ends the keeping. */
	readonly facts: string;
}

/** A subject that needs action now, as the board and `status` show it. */
export interface NeedsActionView {
	readonly key: string;
	/** The dispatcher's subject for it (`subjectOf`): what a priority is kept under. */
	readonly subject: string;
	readonly kind: "issue" | "pr" | "agent";
	/** Its words, as its `needs_action` line has them, without the `[type]`. */
	readonly line: string;
	/** The clause it fails: `no_agent`, `outside_population (closed)`. */
	readonly clause: string;
	/** Since when it has needed action, as DevHub saw it. */
	readonly since: number;
	/** `agent keep`: why it is left as it is. */
	readonly kept?: { readonly note: string; readonly at: number };
}

export interface InvariantWatchPorts {
	readonly dispatch: (event: OrchestratorEvent) => void;
	readonly now: () => number;
	/** Where the keepings are kept across restarts; absent: in memory only. */
	readonly kept?: KeptStore;
}

/** The event a subject is said as. */
function eventOf(subject: NeedsActionSubject): OrchestratorEvent {
	return {
		type: "needs_action",
		subject:
			subject.kind !== "agent"
				? { kind: subject.kind, item: subject.item! }
				: { kind: "agent", agent: subject.agent! },
		...(subject.ws === undefined ? {} : { ws: subject.ws }),
		breach: subject.breach,
	};
}

/** What a keeping holds an agent to: its clause and its state. */
function keepPrint(subject: NeedsActionSubject): string {
	return [
		breachWords(subject.breach),
		...(subject.keepFacts ?? subject.facts),
	].join(" ");
}

export class InvariantWatch {
	/** Since when each subject has needed action (for `status` and the board). */
	readonly #since = new Map<string, number>();
	/** By `agent <id>`; kept on disk when the ports say where. */
	readonly #kept = new Map<string, KeptAgent>();
	/** Each 待機中 escalation's facts as last seen. */
	readonly #waiting = new Map<number, string>();
	#reading: InvariantReading = {
		needsAction: [],
		waiting: [],
		agents: new Map(),
		items: new Map(),
		known: false,
	};

	constructor(private readonly ports: InvariantWatchPorts) {
		for (const [agentId, kept] of ports.kept?.load() ?? [])
			this.#kept.set(`agent ${agentId}`, kept);
	}

	#saveKept(): void {
		this.ports.kept?.save(
			new Map(
				[...this.#kept].map(([key, kept]) => [
					key.slice("agent ".length),
					kept,
				]),
			),
		);
	}

	get reading(): InvariantReading {
		return this.#reading;
	}

	/**
	 * A new reading: the keepings are judged, and each 待機中 escalation
	 * whose subjects moved is said. `speak` false: nothing is said (no
	 * orchestrator).
	 */
	observe(reading: InvariantReading, speak: boolean): void {
		const now = this.ports.now();
		this.#reading = reading;
		const keys = new Set(reading.needsAction.map((one) => one.key));
		for (const key of [...this.#since.keys()])
			if (!keys.has(key)) this.#since.delete(key);
		let keptMoved = false;
		for (const [key, kept] of [...this.#kept]) {
			// Not judged before the state is known again: GitHub's items not
			// read yet, or the agent not read yet (a restart, a resume).
			const agentId = key.slice("agent ".length);
			const standing = reading.agents.get(agentId);
			if (
				!reading.known ||
				standing?.facts?.includes("status=unknown") === true
			)
				continue;
			const subject = reading.needsAction.find((one) => one.key === key);
			// Settled, gone, or its state moved: the keeping is over.
			if (subject === undefined || keepPrint(subject) !== kept.facts) {
				this.#kept.delete(key);
				keptMoved = true;
			}
		}
		if (keptMoved) this.#saveKept();
		for (const subject of reading.needsAction)
			if (!this.#since.has(subject.key)) this.#since.set(subject.key, now);
		const open = new Set(reading.waiting.map((one) => one.escalationId));
		for (const id of [...this.#waiting.keys()])
			if (!open.has(id)) this.#waiting.delete(id);
		for (const one of reading.waiting) {
			const facts = one.facts.join(" ");
			const before = this.#waiting.get(one.escalationId);
			this.#waiting.set(one.escalationId, facts);
			// The first look is where it stands: nothing has moved yet.
			if (!speak || before === undefined || before === facts) continue;
			this.ports.dispatch({
				type: "waiting.changed",
				escalationId: one.escalationId,
				reasons: ["subjects_changed"],
				waitSince: one.waitSince,
			});
		}
	}

	/**
	 * What a delivery says of the invariant: one `needs_action` per subject
	 * that needs action now and is not kept.
	 */
	due(): readonly OrchestratorEvent[] {
		return this.#reading.needsAction
			.filter((subject) => !this.#kept.has(subject.key))
			.map(eventOf);
	}

	/**
	 * `agent keep A --note`: leave a managed agent as it is, for `note`, until
	 * its facts change. Refused for one that does not need action now.
	 */
	keep(agentId: string, note: string): KeptAgent {
		const key = `agent ${agentId}`;
		const subject = this.#reading.needsAction.find((one) => one.key === key);
		if (subject === undefined)
			throw new Error(
				"that agent does not need action: there is nothing to keep (devhub --tell status shows how it stands).",
			);
		const kept = { note, at: this.ports.now(), facts: keepPrint(subject) };
		this.#kept.set(key, kept);
		this.#saveKept();
		return kept;
	}

	/** `agent keep A --clear`: whether there was a keeping to end. */
	unkeep(agentId: string): boolean {
		const was = this.#kept.delete(`agent ${agentId}`);
		if (was) this.#saveKept();
		return was;
	}

	kept(agentId: string): KeptAgent | undefined {
		return this.#kept.get(`agent ${agentId}`);
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
		const kept = this.#kept.get(subject.key);
		const event = eventOf(subject);
		return {
			key: subject.key,
			subject: subjectOf(event),
			kind: subject.kind,
			line: event.type === "needs_action" ? needsActionWords(event) : "",
			clause: breachWords(subject.breach),
			since: this.#since.get(subject.key) ?? this.ports.now(),
			...(kept === undefined ? {} : { kept: { note: kept.note, at: kept.at } }),
		};
	}

	/** Every subject that needs action now. */
	needsAction(): readonly NeedsActionView[] {
		return this.#reading.needsAction.map((subject) => this.#view(subject));
	}
}
