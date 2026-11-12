/**
 * Whether an open task may no longer match reality (`docs/orchestrator.md`,
 * "May be stale"), worked out by DevHub itself from what it already reads —
 * the GitHub poll's items and the agents' Workspace pull requests — with no
 * tokens spent:
 *
 * - **a linked pull request merged or closed**;
 * - **a linked Issue closed**.
 *
 * It only marks: the task is not changed, and no event is sent for it. The
 * board shows a quiet chip with the reasons, and every `triage` lists the
 * open tasks with them for the orchestrator to complete, re-link or keep
 * (charter section 7).
 *
 * Pure: the facts come in, the reasons go out.
 */

import { itemLinkKey } from "./invariant.js";

/** Why a task may be stale. */
export interface StaleReason {
	readonly kind: "pr_merged" | "pr_closed" | "issue_closed";
	/** `acme/app#9`. */
	readonly ref: string;
	readonly url: string;
}

/** An item DevHub has read, by its URL. */
export interface StaleItem {
	readonly kind: "issue" | "pr";
	readonly state: "open" | "closed" | "merged";
	/** `acme/app#9`. */
	readonly ref: string;
}

/** Every reason a task with these links may be stale now, in link order. */
export function staleReasons(
	links: readonly string[],
	item: (urlKey: string) => StaleItem | undefined,
): StaleReason[] {
	const reasons: StaleReason[] = [];
	const seen = new Set<string>();
	for (const link of links) {
		const key = itemLinkKey(link);
		if (key === undefined || seen.has(key)) continue;
		seen.add(key);
		const read = item(key);
		if (read === undefined || read.state === "open") continue;
		reasons.push({
			kind:
				read.kind === "issue"
					? "issue_closed"
					: read.state === "merged"
						? "pr_merged"
						: "pr_closed",
			ref: read.ref,
			url: link.trim(),
		});
	}
	return reasons;
}

/** A reason in a line, as the board and the triage line say it. */
export function staleWords(reason: StaleReason): string {
	switch (reason.kind) {
		case "pr_merged":
			return `PR ${reason.ref} はマージ済み`;
		case "pr_closed":
			return `PR ${reason.ref} はクローズ済み`;
		case "issue_closed":
			return `Issue ${reason.ref} はクローズ済み`;
	}
}
