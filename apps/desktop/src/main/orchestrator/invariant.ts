/**
 * The invariant DevHub holds the orchestrator to, and the subjects that break
 * it: what `unsettled` and `waiting.changed` say (`docs/orchestrator.md`,
 * "The invariant").
 *
 * **The population** is every open item assigned to the viewer on GitHub — an
 * Issue or a pull request, one thing here (`githubItems.ts`); the watched
 * Projects only give an item's lane. For each of them exactly one of these
 * holds, or it is **unsettled**:
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
 * one of the agents of a 要回答 or 待機中 escalation; one that is neither is
 * unsettled. So is one whose item is outside the population — closed, not
 * assigned to the viewer, or not on GitHub — or that has no item at all,
 * whatever it is doing: for that reason alone. While the population is not
 * known (GitHub is not read, or not in full yet), only the first rule is
 * applied to agents, and no Issue is said.
 *
 * **Linked**, the one rule: an agent is linked to the item its meta
 * `issue=` names, by URL. DevHub writes that pair itself when `issue assign`
 * (or the window's Assign Issue) starts the agent on an Issue or a pull
 * request; it is not set
 * by hand. The branch a Workspace is on does not link anything.
 *
 * **About an Issue**, for an escalation: one of its links is the Issue's URL,
 * or one of its agents — `--agent`, a `devhub:agent/` link, the agents of a
 * `devhub:workspace/` link or of its `--workspace` — is linked to it.
 *
 * Nothing here says why: a line is the subject and its facts as they are
 * (state, lane, the pull request's state, review decision, unresolved
 * conversations, checks; the agent's status; the escalations about it), and
 * the orchestrator reads the rest itself.
 *
 * `InvariantWatch` keeps the time: a subject is said once it has been
 * unsettled for `UNSETTLED_GRACE_MS`, again when its facts change, and every
 * `reminder_interval` while it stays so. An agent the orchestrator chose to
 * keep as it is (`agent keep A --note`) is not said while its facts stay what
 * they were when it was kept. A 待機中 escalation whose subject's facts
 * change is said (`waiting.changed`): what it waits on may have come.
 */

import { agentByIdOrPrefix, parseDevhubLink } from "../../model/devhubLink.js";
import { agentAtWork } from "../../model/domain.js";
import type { EscalationState } from "../../model/escalations.js";
import type { EventAgent, EventItem, OrchestratorEvent } from "./events.js";
import { excerpt, shortId } from "./events.js";

/**
 * The meta key the Issue linkage is kept under: written by DevHub when
 * `issue assign` (or Assign Issue) starts an agent on an Issue, refused to
 * `agent meta` and `--meta` (`cli/tell/service.ts`).
 */
export const ISSUE_LINK_KEY = "issue";

/** A pull request as a line states it. */
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
 * assigned to the viewer, or one an agent is linked to.
 */
export interface ItemFacts {
	readonly item: EventItem;
	readonly kind: "issue" | "pr";
	readonly open: boolean;
	readonly assignedToMe: boolean;
	/** Its lane (Status) on each watched Project it is on. */
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
	/** The Issue it is linked to: its meta `issue=`. */
	readonly issue?: string;
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
	/** A 待機中 one's trigger. */
	readonly trigger?: string;
}

export interface InvariantInput {
	/**
	 * Every item as last read — the open ones assigned to the viewer, and the
	 * ones agents are linked to — undefined while the population is not known
	 * (GitHub not read, or not in full yet).
	 */
	readonly items: readonly ItemFacts[] | undefined;
	/** Whether GitHub was asked about a linked URL and has no item for it. */
	readonly missing?: (url: string) => boolean;
	/** Every agent but the orchestrator. */
	readonly agents: readonly InvariantAgent[];
	/** The open escalations. */
	readonly escalations: readonly InvariantEscalation[];
}

/** One subject that breaks the invariant now, with its facts. */
export interface UnsettledSubject {
	/** `item <url key>` or `agent <id>`: the subject. */
	readonly key: string;
	/** An Issue or a pull request item, or a managed agent. */
	readonly kind: "issue" | "pr" | "agent";
	readonly item?: EventItem;
	readonly agent?: EventAgent;
	readonly ws?: string;
	/** `key=value` facts, as the line has them. */
	readonly facts: readonly string[];
}

/** A 待機中 escalation and the facts of what it is about. */
export interface WaitingSubject {
	readonly escalationId: number;
	readonly title: string;
	readonly trigger: string;
	readonly facts: readonly string[];
}

/** How an agent stands, for its row and `agent status`. */
export interface AgentStanding {
	readonly settled: boolean;
	/** The 待機中 escalation it is one of the agents of, and its trigger. */
	readonly waiting?: {
		readonly escalationId: number;
		readonly trigger: string;
	};
	/** Its facts, as an `unsettled` line would say them (managed agents). */
	readonly facts?: readonly string[];
}

export interface InvariantReading {
	readonly unsettled: readonly UnsettledSubject[];
	readonly waiting: readonly WaitingSubject[];
	readonly agents: ReadonlyMap<string, AgentStanding>;
}

/** An Issue URL, compared without case, a trailing slash or a fragment. */
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

/** Whether the escalation is about the Issue: see the module's comment. */
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

/** A lane as `lane=` says it: quoted when it has a space in it. */
function laneToken(lane: string | null): string {
	if (lane === null) return "lane=none";
	return `lane=${/^\S+$/u.test(lane) ? lane : JSON.stringify(lane)}`;
}

/** `repo#123` for `issue=` / `pr=`: the repository and the number. */
export function issueToken(item: EventItem): string {
	return `${item.repo === "" ? "" : item.repo}#${String(item.number)}`;
}

/** An item as a line names it: `issue=acme/app#1`, `pr=acme/app#9`. */
export function itemToken(kind: "issue" | "pr", item: EventItem): string {
	return `${kind}=${issueToken(item)}`;
}

export function pullFacts(pull: PullFacts | undefined): string[] {
	if (pull === undefined) return ["pr=none"];
	return [
		`pr=#${String(pull.number)}`,
		`pr_state=${pull.state}`,
		`review=${pull.review}`,
		`unresolved=${String(pull.unresolved)}`,
		`checks=${pull.checks}`,
	];
}

function issueFacts(issue: ItemFacts): string[] {
	return [
		`state=${issue.open ? "open" : "closed"}`,
		`assigned=${issue.assignedToMe ? "yes" : "no"}`,
		laneToken(issue.projects[0]?.lane ?? null),
		...pullFacts(issue.pull),
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

function inPopulation(issue: ItemFacts): boolean {
	return issue.open && issue.assignedToMe;
}

/** The invariant, read off one moment's state. */
export function readInvariant(input: InvariantInput): InvariantReading {
	const { items: issues, agents, escalations } = input;
	const unsettled: UnsettledSubject[] = [];
	const standings = new Map<string, AgentStanding>();
	const parked = (agent: InvariantAgent) =>
		escalations.filter(
			(one) =>
				(one.state === "needs_answer" || one.state === "waiting") &&
				escalationAgents(one, agents).includes(agent),
		);
	const about = (agent: InvariantAgent) =>
		escalations.filter((one) => escalationAgents(one, agents).includes(agent));
	const byKey = new Map(
		(issues ?? []).flatMap((issue) =>
			issue.item.url === undefined
				? []
				: [[issueUrlKey(issue.item.url), issue] as const],
		),
	);
	// The Issues.
	const seen = new Set<string>();
	for (const issue of issues ?? []) {
		if (!inPopulation(issue) || issue.item.url === undefined) continue;
		const key = issueUrlKey(issue.item.url);
		if (seen.has(key)) continue;
		seen.add(key);
		const on = agents.filter((agent) => linked(agent, issue.item));
		if (on.some((agent) => !agent.managed)) continue;
		if (on.some(atWork)) continue;
		const its = escalations.filter((one) =>
			escalationAbout(one, issue.item, agents),
		);
		if (
			its.some((one) => one.state === "needs_answer" || one.state === "waiting")
		)
			continue;
		unsettled.push({
			key: `item ${key}`,
			kind: issue.kind,
			item: issue.item,
			...(on[0] === undefined ? {} : { ws: on[0].ws }),
			facts: [
				...issueFacts(issue),
				on.length === 0
					? "agents=none"
					: `agents=${on.map((agent) => `${shortId(agent.id)}:${agent.status}`).join(",")}`,
				...escalationFacts(its),
			],
		});
	}
	// The agents.
	for (const agent of agents) {
		const waitingIn = escalations.find(
			(one) =>
				one.state === "waiting" &&
				escalationAgents(one, agents).includes(agent),
		);
		const waiting =
			waitingIn === undefined
				? {}
				: {
						waiting: {
							escalationId: waitingIn.id,
							trigger: waitingIn.trigger ?? "",
						},
					};
		if (!agent.managed) {
			standings.set(agent.id, { settled: true, ...waiting });
			continue;
		}
		const issue =
			agent.issue === undefined
				? undefined
				: byKey.get(issueUrlKey(agent.issue));
		// Linked to a URL GitHub has no item for (deleted, or not visible).
		const missing =
			agent.issue !== undefined &&
			issue === undefined &&
			input.missing?.(agent.issue) === true;
		const issueWords =
			agent.issue === undefined
				? ["issue=none"]
				: issue === undefined
					? [`issue=${agent.issue}`, ...(missing ? ["item=none"] : [])]
					: [itemToken(issue.kind, issue.item), ...issueFacts(issue)];
		const outside =
			issues !== undefined &&
			(agent.issue === undefined ||
				missing ||
				(issue !== undefined && !inPopulation(issue)));
		const settled = !outside && (atWork(agent) || parked(agent).length > 0);
		const facts = [
			`status=${agent.stopping ? "stopping" : agent.status}`,
			...issueWords,
			...(issue === undefined ? pullFacts(agent.pull) : []),
			...escalationFacts(about(agent)),
		];
		standings.set(agent.id, { settled, facts, ...waiting });
		if (settled) continue;
		unsettled.push({
			key: `agent ${agent.id}`,
			kind: "agent",
			agent: { id: agent.id, name: agent.name },
			ws: agent.ws,
			facts,
		});
	}
	// The 待機中 escalations, and the facts of what they are about.
	const waiting: WaitingSubject[] = [];
	for (const one of escalations) {
		if (one.state !== "waiting") continue;
		const facts: string[] = [];
		for (const issue of issues ?? [])
			if (escalationAbout(one, issue.item, agents))
				facts.push(itemToken(issue.kind, issue.item), ...issueFacts(issue));
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
			title: one.title,
			trigger: one.trigger ?? "",
			facts,
		});
	}
	return { unsettled, waiting, agents: standings };
}

// --- the watch ---------------------------------------------------------------

/** How long a subject must stay unsettled before it is said. */
export const UNSETTLED_GRACE_MS = 60_000;

/** An agent the orchestrator chose to keep as it is, and why. */
export interface KeptAgent {
	readonly note: string;
	readonly at: number;
	/** Its facts when it was kept: a change ends the keeping. */
	readonly facts: string;
}

/** A subject unsettled now, as the board and `agent status` show it. */
export interface UnsettledView {
	readonly key: string;
	readonly kind: "issue" | "pr" | "agent";
	readonly line: string;
	/** Since when it has been unsettled, as DevHub saw it. */
	readonly since: number;
	/** When it was last said; absent while in its grace. */
	readonly toldAt?: number;
	/** `agent keep`: why it is left as it is. */
	readonly kept?: { readonly note: string; readonly at: number };
}

export interface InvariantWatchPorts {
	readonly dispatch: (event: OrchestratorEvent) => void;
	readonly now: () => number;
	/** `[orchestrator] reminder_interval`, in ms. */
	readonly reminderMs: () => number;
	readonly graceMs?: number;
}

/** The words of a subject, without its `[type]`: what `--tell` shows. */
export function subjectWords(subject: UnsettledSubject): string {
	const head =
		subject.kind !== "agent" && subject.item !== undefined
			? `${itemToken(subject.kind, subject.item)}${subject.item.title === undefined || subject.item.title.length === 0 ? "" : `「${excerpt(subject.item.title, 40)}」`}`
			: `agent=${shortId(subject.agent?.id ?? "")}${subject.agent?.name === undefined ? "" : ` (${excerpt(subject.agent.name, 40)})`}`;
	return [
		head,
		...(subject.ws === undefined ? [] : [`ws=${subject.ws}`]),
		...subject.facts,
	].join(" ");
}

export class InvariantWatch {
	/** Since when each subject has been unsettled. */
	readonly #since = new Map<string, number>();
	/** When each was last said, and with which facts. */
	readonly #told = new Map<string, { at: number; facts: string }>();
	readonly #kept = new Map<string, KeptAgent>();
	/** Each 待機中 escalation's facts as last seen. */
	readonly #waiting = new Map<number, string>();
	#reading: InvariantReading = {
		unsettled: [],
		waiting: [],
		agents: new Map(),
	};

	constructor(private readonly ports: InvariantWatchPorts) {}

	get #grace(): number {
		return this.ports.graceMs ?? UNSETTLED_GRACE_MS;
	}

	/** Everything is said again from now: a new orchestrator has heard none. */
	reset(): void {
		this.#told.clear();
		this.#waiting.clear();
	}

	/**
	 * A new reading: what has been unsettled past the grace is said (first,
	 * with new facts, or as a reminder), and each 待機中 escalation whose
	 * subject moved. `speak` false: the time is kept, nothing is said (no
	 * orchestrator).
	 */
	observe(reading: InvariantReading, speak: boolean): void {
		const now = this.ports.now();
		this.#reading = reading;
		const keys = new Set(reading.unsettled.map((one) => one.key));
		for (const key of [...this.#since.keys()])
			if (!keys.has(key)) {
				this.#since.delete(key);
				this.#told.delete(key);
			}
		for (const [key, kept] of [...this.#kept]) {
			const subject = reading.unsettled.find((one) => one.key === key);
			// Settled, or its facts moved: the keeping is over.
			if (subject === undefined || subject.facts.join(" ") !== kept.facts)
				this.#kept.delete(key);
		}
		for (const subject of reading.unsettled) {
			const since = this.#since.get(subject.key) ?? now;
			this.#since.set(subject.key, since);
			if (!speak || now - since < this.#grace) continue;
			if (this.#kept.has(subject.key)) continue;
			const facts = subject.facts.join(" ");
			const told = this.#told.get(subject.key);
			if (
				told !== undefined &&
				told.facts === facts &&
				now - told.at < this.ports.reminderMs()
			)
				continue;
			this.#told.set(subject.key, { at: now, facts });
			this.ports.dispatch({
				type: "unsettled",
				subject:
					subject.kind !== "agent"
						? { kind: subject.kind, item: subject.item! }
						: { kind: "agent", agent: subject.agent! },
				...(subject.ws === undefined ? {} : { ws: subject.ws }),
				facts: subject.facts,
			});
		}
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
				title: one.title,
				trigger: one.trigger,
				facts: one.facts,
			});
		}
	}

	/** When a grace or a reminder is up next, if any is. */
	nextDue(): number | undefined {
		const due: number[] = [];
		for (const [key, since] of this.#since) {
			if (this.#kept.has(key)) continue;
			const told = this.#told.get(key);
			due.push(
				told === undefined
					? since + this.#grace
					: told.at + this.ports.reminderMs(),
			);
		}
		return due.length === 0 ? undefined : Math.min(...due);
	}

	/** Whether the subject still breaks the invariant (for a pending line). */
	stillUnsettled(key: string): boolean {
		return (
			this.#reading.unsettled.some((one) => one.key === key) &&
			!this.#kept.has(key)
		);
	}

	/**
	 * `agent keep A --note`: leave a managed agent as it is, for `note`, until
	 * its facts change. Refused for one that is not unsettled now.
	 */
	keep(agentId: string, note: string): KeptAgent {
		const key = `agent ${agentId}`;
		const subject = this.#reading.unsettled.find((one) => one.key === key);
		if (subject === undefined)
			throw new Error(
				"that agent is not unsettled: there is nothing to keep (agent status shows how it stands).",
			);
		const kept = {
			note,
			at: this.ports.now(),
			facts: subject.facts.join(" "),
		};
		this.#kept.set(key, kept);
		return kept;
	}

	/** `agent keep A --clear`: whether there was a keeping to end. */
	unkeep(agentId: string): boolean {
		return this.#kept.delete(`agent ${agentId}`);
	}

	kept(agentId: string): KeptAgent | undefined {
		return this.#kept.get(`agent ${agentId}`);
	}

	/** How an agent stands, as of the last reading. */
	standing(agentId: string): AgentStanding | undefined {
		return this.#reading.agents.get(agentId);
	}

	/** Every subject unsettled now. */
	unsettled(): readonly UnsettledView[] {
		return this.#reading.unsettled.map((subject) => {
			const told = this.#told.get(subject.key);
			const kept = this.#kept.get(subject.key);
			return {
				key: subject.key,
				kind: subject.kind,
				line: subjectWords(subject),
				since: this.#since.get(subject.key) ?? this.ports.now(),
				...(told === undefined ? {} : { toldAt: told.at }),
				...(kept === undefined
					? {}
					: { kept: { note: kept.note, at: kept.at } }),
			};
		});
	}

	/** Whether a subject has been unsettled past the grace. */
	pastGrace(key: string): boolean {
		const since = this.#since.get(key);
		return since !== undefined && this.ports.now() - since >= this.#grace;
	}
}
