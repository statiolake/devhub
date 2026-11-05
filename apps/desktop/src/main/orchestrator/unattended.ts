/**
 * `github.unattended`: which of the viewer's Issues has no DevHub agent at
 * work on it. This is a state check, unlike the edge events: it is run again
 * on every successful poll (the baseline included) and whenever the
 * Workspaces or Agents move (`GitHubEventSource.reconsider`).
 *
 * **Unattended** means a card on a watched board that is
 *
 * - an Issue (not a pull request),
 * - assigned to the viewer,
 * - open (a closed Issue is done; the lane does not decide it and is shown
 *   for information only),
 * - and has no **linked** live agent (`linkedAgent`).
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
 * A Workspace whose branch DevHub has not read yet is not linked by it.
 * Should it turn out to be on the Issue, the delivery's stale check
 * (`stillUnattended`) and the `reconsider` the repository round runs drop
 * what was not yet delivered.
 */

import type { EventAgent, EventItem } from "./events.js";

/** One open Workspace, as the link check reads it. */
export interface LinkWorkspace {
	/** The Workspace as `ws=` names it. */
	readonly ws: string;
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
	const key = issue.url === undefined ? undefined : issueUrlKey(issue.url);
	const found = (workspace: LinkWorkspace, agent: LinkAgent) => ({
		ws: workspace.ws,
		agent: {
			id: agent.id,
			...(agent.name === undefined ? {} : { name: agent.name }),
		},
	});
	for (const workspace of workspaces) {
		if (
			key === undefined ||
			!workspace.issueUrls.some((url) => issueUrlKey(url) === key)
		)
			continue;
		const agent = workspace.agents.find((one) => one.live);
		if (agent !== undefined) return found(workspace, agent);
	}
	for (const workspace of workspaces)
		for (const agent of workspace.agents)
			if (agent.live && metaNames(agent.meta["issue"], issue, workspace.repo))
				return found(workspace, agent);
	return undefined;
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
				| "has an agent";
			readonly ws?: string;
			readonly agent?: EventAgent;
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
	return { unattended: true };
}
