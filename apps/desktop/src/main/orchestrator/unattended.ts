/**
 * `github.unattended`: which of the viewer's Issues has no DevHub agent at
 * work on it. This is a state check, unlike the edge events: it is run again
 * on every successful poll (the baseline included) and whenever the
 * Workspaces, Agents or escalations move (`GitHubEventSource.reconsider`).
 *
 * **Unattended** means a card on a watched board that is
 *
 * - an Issue (not a pull request),
 * - assigned to the viewer,
 * - open (a closed Issue is done; the lane does not decide it and is shown
 *   for information only),
 * - has no **linked** live agent (`linkedAgent`),
 * - and is not covered by a 待機中 escalation (`coveringEscalation`).
 *
 * **Linked**, the one definition, in `linkedAgent`. An Issue is linked to a
 * live agent when either
 *
 * 1. an open Workspace's Issue is this one — the Issue its checked-out
 *    branch names (`123-fix-login`, in the repository the Workspace numbers
 *    Issues in), which is how DevHub links a Workspace to an Issue: Issue
 *    assignment checks out such a branch, and the Sidebar shows its Issue
 *    off it — and the Workspace has at least one agent that is not stopped
 *    or stopping; or
 * 2. a live agent's meta `issue=` names it: the Issue's URL, or its number
 *    (`123`, `#123`) when the agent's Workspace numbers Issues in the
 *    Issue's repository (or DevHub does not know where it numbers them).
 *
 * The orchestrator itself is never the linked agent.
 *
 * **Covered by a waiting escalation**, the one definition, in
 * `coveringEscalation`. An Issue an escalation in a `COVERING_STATES` state
 * (待機中 only, for now) is about is being handled — it waits on a known
 * condition — and is not unattended either. An escalation is about the
 * Issue when
 *
 * 1. one of its `links` is the Issue's URL, or a `devhub:` link to a
 *    Workspace whose branch names it, or to an agent linked to it;
 * 2. its `workspaceId` is a Workspace whose branch names it; or
 * 3. one of its agents is linked to it, by `linkedAgent`'s two rules —
 *    whether or not that agent is live now.
 *
 * When it leaves the state (resumed, asked again, answered, closed) the
 * Issue is unattended again, if nothing else attends it: a new episode.
 *
 * A Workspace whose branch DevHub has not read yet is not linked by it.
 * Should it turn out to be on the Issue, the delivery's stale check
 * (`stillUnattended`) and the `reconsider` the repository round runs drop
 * what was not yet delivered.
 */

import { agentByIdOrPrefix, parseDevhubLink } from "../../model/devhubLink.js";
import type { EscalationState } from "../../model/escalations.js";
import type { EventAgent, EventItem } from "./events.js";

/** One open Workspace, as the link check reads it. */
export interface LinkWorkspace {
	/** The Workspace as `ws=` names it. */
	readonly ws: string;
	/** Its id, as an escalation's `workspaceId` and `devhub:workspace/` name it. */
	readonly id: string;
	/** Its name, as `devhub:workspace/<name>` may name it. */
	readonly label?: string;
	/** The URLs of the Issues it is for: the one its branch names. */
	readonly issueUrls: readonly string[];
	/** `owner/name` where its Issues are numbered, when known. */
	readonly repo?: string;
	/** Its agents, the orchestrator left out. */
	readonly agents: readonly LinkAgent[];
}

export interface LinkAgent {
	readonly id: string;
	readonly name?: string;
	/** Not stopped, not stopping. */
	readonly live: boolean;
	readonly meta: Readonly<Record<string, string>>;
}

/** An Issue URL, compared without case, a trailing slash or a fragment. */
export function issueUrlKey(url: string): string {
	return url
		.trim()
		.replace(/[#?].*$/u, "")
		.replace(/\/+$/u, "")
		.toLowerCase();
}

function metaNames(
	value: string | undefined,
	issue: EventItem,
	repo: string | undefined,
): boolean {
	if (value === undefined) return false;
	const text = value.trim();
	if (/^https?:\/\//iu.test(text))
		return (
			issue.url !== undefined && issueUrlKey(text) === issueUrlKey(issue.url)
		);
	const match = /^#?(\d+)$/u.exec(text);
	if (match === null || Number(match[1]) !== issue.number) return false;
	return (
		repo === undefined ||
		issue.repo === "" ||
		repo.toLowerCase() === issue.repo.toLowerCase()
	);
}

/**
 * The live agent the Issue is linked to (and its Workspace), if any: see the
 * module's comment for what links one.
 */
export function linkedAgent(
	issue: EventItem,
	workspaces: readonly LinkWorkspace[],
): { readonly ws: string; readonly agent: EventAgent } | undefined {
	const found = (workspace: LinkWorkspace, agent: LinkAgent) => ({
		ws: workspace.ws,
		agent: {
			id: agent.id,
			...(agent.name === undefined ? {} : { name: agent.name }),
		},
	});
	for (const workspace of workspaces) {
		if (!branchNames(workspace, issue)) continue;
		const agent = workspace.agents.find((one) => one.live);
		if (agent !== undefined) return found(workspace, agent);
	}
	for (const workspace of workspaces)
		for (const agent of workspace.agents)
			if (agent.live && metaNames(agent.meta["issue"], issue, workspace.repo))
				return found(workspace, agent);
	return undefined;
}

/** Rule 1's half: the Workspace's branch names the Issue. */
function branchNames(workspace: LinkWorkspace, issue: EventItem): boolean {
	if (issue.url === undefined) return false;
	const key = issueUrlKey(issue.url);
	return workspace.issueUrls.some((url) => issueUrlKey(url) === key);
}

/** Linked by either of `linkedAgent`'s rules, live or not. */
function agentIsOn(
	workspace: LinkWorkspace,
	agent: LinkAgent,
	issue: EventItem,
): boolean {
	return (
		branchNames(workspace, issue) ||
		metaNames(agent.meta["issue"], issue, workspace.repo)
	);
}

/** One open escalation, as the cover check reads it. */
export interface LinkEscalation {
	readonly id: number;
	readonly state: EscalationState;
	/** URLs and `devhub:` links. */
	readonly links: readonly string[];
	/** The agents it is about, by id. */
	readonly agents: readonly string[];
	readonly workspaceId?: string;
}

/**
 * The states in which an escalation that is about an Issue keeps it from
 * being unattended. 待機中 only, for now; add 要回答 / 対応中 here.
 */
export const COVERING_STATES: ReadonlySet<EscalationState> = new Set([
	"waiting",
]);

/** The Workspace a `devhub:workspace/` link names: id, unique name, id prefix. */
function workspaceNamed(
	name: string,
	workspaces: readonly LinkWorkspace[],
): LinkWorkspace | undefined {
	const byId = workspaces.find((one) => one.id === name);
	if (byId !== undefined) return byId;
	const named = workspaces.filter((one) => one.label === name);
	if (named.length === 1) return named[0];
	if (named.length > 1 || name.length < 4) return undefined;
	const prefixed = workspaces.filter((one) => one.id.startsWith(name));
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** Whether the escalation is about the Issue: see the module's comment. */
function escalationIsOn(
	escalation: LinkEscalation,
	issue: EventItem,
	workspaces: readonly LinkWorkspace[],
): boolean {
	const agentOn = (id: string): boolean =>
		workspaces.some((workspace) =>
			workspace.agents.some(
				(agent) => agent.id === id && agentIsOn(workspace, agent, issue),
			),
		);
	const all = workspaces.flatMap((workspace) => workspace.agents);
	for (const link of escalation.links) {
		if (/^https?:\/\//iu.test(link.trim())) {
			if (
				issue.url !== undefined &&
				issueUrlKey(link) === issueUrlKey(issue.url)
			)
				return true;
			continue;
		}
		const parsed = parseDevhubLink(link);
		if (!parsed.ok) continue;
		if (parsed.link.kind === "workspace") {
			const workspace = workspaceNamed(parsed.link.workspace, workspaces);
			if (workspace !== undefined && branchNames(workspace, issue)) return true;
		} else if (parsed.link.kind === "agent") {
			const agent = agentByIdOrPrefix(parsed.link.agent, all);
			if (agent !== undefined && agentOn(agent.id)) return true;
		}
	}
	if (escalation.workspaceId !== undefined) {
		const workspace = workspaces.find(
			(one) => one.id === escalation.workspaceId,
		);
		if (workspace !== undefined && branchNames(workspace, issue)) return true;
	}
	return escalation.agents.some(agentOn);
}

/**
 * The escalation in a `COVERING_STATES` state that is about the Issue, if
 * any (the lowest id): see the module's comment for what makes it so.
 */
export function coveringEscalation(
	issue: EventItem,
	escalations: readonly LinkEscalation[],
	workspaces: readonly LinkWorkspace[],
): LinkEscalation | undefined {
	return escalations
		.filter((one) => COVERING_STATES.has(one.state))
		.sort((left, right) => left.id - right.id)
		.find((one) => escalationIsOn(one, issue, workspaces));
}

/** Why an Issue on a board is, or is not, unattended. */
export type UnattendedVerdict =
	| { readonly unattended: true }
	| {
			readonly unattended: false;
			readonly why:
				| "not an Issue"
				| "not assigned to me"
				| "closed"
				| "has an agent"
				| "waiting in an escalation";
			readonly ws?: string;
			readonly agent?: EventAgent;
			/** The escalation it waits in, for `waiting in an escalation`. */
			readonly escalation?: number;
	  };

/** The one predicate: whether this card is an unattended Issue of the viewer's. */
export function unattendedVerdict(
	entry: {
		readonly kind: "issue" | "pr";
		readonly item: EventItem;
		readonly state: string;
		readonly assignees: readonly string[];
	},
	viewer: string,
	workspaces: readonly LinkWorkspace[],
	escalations: readonly LinkEscalation[] = [],
): UnattendedVerdict {
	if (entry.kind !== "issue") return { unattended: false, why: "not an Issue" };
	if (
		!entry.assignees.some((one) => one.toLowerCase() === viewer.toLowerCase())
	)
		return { unattended: false, why: "not assigned to me" };
	if (entry.state !== "OPEN") return { unattended: false, why: "closed" };
	const linked = linkedAgent(entry.item, workspaces);
	if (linked !== undefined)
		return {
			unattended: false,
			why: "has an agent",
			ws: linked.ws,
			agent: linked.agent,
		};
	const covering = coveringEscalation(entry.item, escalations, workspaces);
	if (covering !== undefined)
		return {
			unattended: false,
			why: "waiting in an escalation",
			escalation: covering.id,
		};
	return { unattended: true };
}
