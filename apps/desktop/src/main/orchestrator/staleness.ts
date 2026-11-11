/**
 * Whether an open escalation may no longer match reality
 * (`docs/orchestrator.md`, "May be stale"), worked out by DevHub itself from
 * what it already reads — the GitHub poll's items, the agents, the board's
 * lanes, the other escalations — with no tokens spent:
 *
 * - **a linked pull request merged or closed**, **a linked Issue closed**: a
 *   link of the escalation (or the item one of its agents is linked to) is
 *   an item DevHub has read, and it is no longer open;
 * - **a linked agent gone**: one of its agents no longer exists;
 * - **a linked agent in another lane**: one of its agents is, in the
 *   Sidebar's lanes (`ipc/orchestratorLanes.ts`), somewhere other than where
 *   the escalation is — a 対応中 one whose agent stopped with nothing
 *   settling it (要対応), or is done (完了), a 待機中 one whose agent was
 *   asked something else (要回答);
 * - **superseded**: a newer open escalation is about the same subject (a
 *   link to the same item, an agent linked to the same item, or — with no
 *   item on either — the same agent).
 *
 * It only marks: the escalation is not changed. The board shows a quiet chip
 * with the reasons, and every `triage` lists the open escalations with them
 * for the orchestrator to confirm, update or close (charter section 7).
 *
 * Pure: the facts come in, the reasons go out.
 */

import type { LaneId } from "../../ipc/orchestratorLanes.js";
import type { EscalationState } from "../../model/escalations.js";
import { issueUrlKey } from "./invariant.js";

/** Why an escalation may be stale. */
export type StaleReason =
	| {
			readonly kind: "pr_merged" | "pr_closed" | "issue_closed";
			/** `acme/app#9`. */
			readonly ref: string;
			readonly url: string;
	  }
	| { readonly kind: "agent_gone"; readonly agentId: string }
	| {
			readonly kind: "agent_moved";
			readonly agentId: string;
			readonly name?: string;
			readonly lane: LaneId;
	  }
	| { readonly kind: "superseded"; readonly by: number };

/** An open escalation, as staleness reads it. */
export interface StaleEscalation {
	readonly id: number;
	readonly state: Exclude<EscalationState, "closed">;
	/** URLs and `devhub:` links. */
	readonly links: readonly string[];
	readonly agents: readonly string[];
}

/** An item DevHub has read, by its URL. */
export interface StaleItem {
	readonly kind: "issue" | "pr";
	readonly state: "open" | "closed" | "merged";
	/** `acme/app#9`. */
	readonly ref: string;
}

/** An agent as DevHub knows it now. */
export interface StaleAgent {
	readonly name?: string;
	/** The item its meta `issue=` links it to. */
	readonly issue?: string;
	/** Its item's lane under the Orchestrator row; absent when not there. */
	readonly lane?: LaneId;
}

export interface StaleFacts {
	/** The items read (population and linked), by `issueUrlKey`. */
	readonly item: (urlKey: string) => StaleItem | undefined;
	/** An agent that exists now; undefined: it is gone. */
	readonly agent: (agentId: string) => StaleAgent | undefined;
	/** Every open escalation (this one included). */
	readonly open: readonly StaleEscalation[];
}

/** The lane an escalation in `state` is drawn in, and its agents with it. */
const LANE_OF: Record<StaleEscalation["state"], LaneId> = {
	needs_answer: "ask",
	in_progress: "progress",
	waiting: "waiting",
};

/**
 * An item link's key: a pull request's or an Issue's URL without what
 * follows its number (`/files`, `#issuecomment-…`), as `issueUrlKey`
 * compares it. Other URLs as they are.
 */
export function itemLinkKey(url: string): string {
	const item = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+/iu.exec(
		url.trim(),
	);
	return issueUrlKey(item?.[0] ?? url);
}

function httpLinks(escalation: StaleEscalation): string[] {
	return escalation.links.filter((link) => /^https?:\/\//iu.test(link.trim()));
}

/** What an escalation is about, as keys two escalations can share. */
function subjects(
	escalation: StaleEscalation,
	facts: Pick<StaleFacts, "agent">,
): Set<string> {
	const keys = new Set<string>();
	for (const link of httpLinks(escalation))
		if (/\/(issues|pull)\/\d+/u.test(link)) keys.add(itemLinkKey(link));
	for (const id of escalation.agents) {
		const issue = facts.agent(id)?.issue;
		if (issue !== undefined && /^https?:\/\//iu.test(issue))
			keys.add(itemLinkKey(issue));
	}
	if (keys.size === 0)
		for (const id of escalation.agents) keys.add(`agent:${id}`);
	return keys;
}

/** Every reason `escalation` may be stale now, in a stable order. */
export function staleReasons(
	escalation: StaleEscalation,
	facts: StaleFacts,
): StaleReason[] {
	const reasons: StaleReason[] = [];
	// Linked items: its own links, and its agents' items.
	const urls = new Map<string, string>();
	for (const link of httpLinks(escalation))
		urls.set(itemLinkKey(link), link.trim());
	for (const id of escalation.agents) {
		const issue = facts.agent(id)?.issue;
		if (issue !== undefined && /^https?:\/\//iu.test(issue))
			urls.set(itemLinkKey(issue), issue);
	}
	for (const [key, url] of urls) {
		const item = facts.item(key);
		if (item === undefined || item.state === "open") continue;
		reasons.push({
			kind:
				item.kind === "issue"
					? "issue_closed"
					: item.state === "merged"
						? "pr_merged"
						: "pr_closed",
			ref: item.ref,
			url,
		});
	}
	// Its agents.
	const lane = LANE_OF[escalation.state];
	for (const id of escalation.agents) {
		const agent = facts.agent(id);
		if (agent === undefined) {
			reasons.push({ kind: "agent_gone", agentId: id });
			continue;
		}
		if (agent.lane !== undefined && agent.lane !== lane)
			reasons.push({
				kind: "agent_moved",
				agentId: id,
				...(agent.name === undefined ? {} : { name: agent.name }),
				lane: agent.lane,
			});
	}
	// A newer one about the same subject.
	const mine = subjects(escalation, facts);
	const newer = facts.open
		.filter((other) => other.id > escalation.id)
		.filter((other) => {
			for (const key of subjects(other, facts)) if (mine.has(key)) return true;
			return false;
		})
		.map((other) => other.id);
	if (newer.length > 0)
		reasons.push({ kind: "superseded", by: Math.max(...newer) });
	return reasons;
}

const LANE_WORDS: Record<LaneId, string> = {
	ask: "要回答",
	action: "要対応",
	progress: "対応中",
	waiting: "待機中",
	closed: "完了",
};

/** A reason in a line, as the board and the triage line say it. */
export function staleWords(reason: StaleReason): string {
	switch (reason.kind) {
		case "pr_merged":
			return `PR ${reason.ref} はマージ済み`;
		case "pr_closed":
			return `PR ${reason.ref} はクローズ済み`;
		case "issue_closed":
			return `Issue ${reason.ref} はクローズ済み`;
		case "agent_gone":
			return `エージェント ${reason.agentId.slice(0, 8)} はもういない`;
		case "agent_moved":
			return `エージェント ${reason.name ?? reason.agentId.slice(0, 8)} は今 ${LANE_WORDS[reason.lane]}`;
		case "superseded":
			return `同じ対象の新しいエスカレーション #${String(reason.by)} がある`;
	}
}
