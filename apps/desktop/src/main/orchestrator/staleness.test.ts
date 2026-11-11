/**
 * May be stale (`staleness.ts`): what DevHub sees on its own that an open
 * escalation may no longer match.
 */

import { describe, expect, it } from "vitest";
import { issueUrlKey } from "./invariant.js";
import {
	staleReasons,
	staleWords,
	type StaleAgent,
	type StaleEscalation,
	type StaleFacts,
	type StaleItem,
} from "./staleness.js";

const PR = "https://github.com/acme/pay/pull/12";
const ISSUE = "https://github.com/acme/pay/issues/7";

function esc(overrides: Partial<StaleEscalation> = {}): StaleEscalation {
	return {
		id: 1,
		state: "needs_answer",
		links: [],
		agents: [],
		...overrides,
	};
}

function facts(
	options: {
		readonly items?: Record<string, StaleItem>;
		readonly agents?: Record<string, StaleAgent>;
		readonly open?: readonly StaleEscalation[];
	} = {},
): StaleFacts {
	const items = new Map(
		Object.entries(options.items ?? {}).map(([url, item]) => [
			issueUrlKey(url),
			item,
		]),
	);
	return {
		item: (key) => items.get(key),
		agent: (id) => options.agents?.[id],
		open: options.open ?? [],
	};
}

const words = (one: StaleEscalation, given: StaleFacts) =>
	staleReasons(one, given).map(staleWords);

describe("may be stale", () => {
	it("is nothing while what it links is open and its agents are where it is", () => {
		const one = esc({ links: [PR], agents: ["a1"], state: "in_progress" });
		expect(
			words(
				one,
				facts({
					items: { [PR]: { kind: "pr", state: "open", ref: "acme/pay#12" } },
					agents: { a1: { name: "fix", lane: "progress" } },
					open: [one],
				}),
			),
		).toEqual([]);
	});

	it("says a linked pull request merged or closed, and a linked Issue closed", () => {
		const one = esc({ links: [`${PR}/files`, ISSUE, "devhub:agent/x"] });
		expect(
			words(
				one,
				facts({
					items: {
						[PR]: { kind: "pr", state: "merged", ref: "acme/pay#12" },
						[ISSUE]: { kind: "issue", state: "closed", ref: "acme/pay#7" },
					},
				}),
			),
		).toEqual([
			"PR acme/pay#12 はマージ済み",
			"Issue acme/pay#7 はクローズ済み",
		]);
		expect(
			words(
				esc({ links: [PR] }),
				facts({
					items: { [PR]: { kind: "pr", state: "closed", ref: "acme/pay#12" } },
				}),
			),
		).toEqual(["PR acme/pay#12 はクローズ済み"]);
	});

	it("reads its agents' items too: the pull request an agent is linked to merged", () => {
		expect(
			words(
				esc({ agents: ["a1"] }),
				facts({
					items: { [PR]: { kind: "pr", state: "merged", ref: "acme/pay#12" } },
					agents: { a1: { name: "fix", issue: PR, lane: "ask" } },
				}),
			),
		).toEqual(["PR acme/pay#12 はマージ済み"]);
	});

	it("says a linked agent gone, or in another lane than the escalation", () => {
		expect(
			words(
				esc({ state: "in_progress", agents: ["gone0000-1", "a1", "a2"] }),
				facts({
					agents: {
						a1: { name: "fix", lane: "closed" },
						// Not under the Orchestrator row: no lane to compare.
						a2: { name: "mine" },
					},
				}),
			),
		).toEqual([
			"エージェント gone0000 はもういない",
			"エージェント fix は今 完了",
		]);
	});

	it("says a newer open escalation about the same subject: a link, an agent's item, or the same agent", () => {
		const first = esc({ id: 3, links: [ISSUE] });
		const byLink = esc({ id: 5, links: [`${ISSUE}#issuecomment-1`] });
		const byAgentItem = esc({ id: 8, agents: ["a1"] });
		const other = esc({
			id: 9,
			links: ["https://github.com/acme/pay/issues/8"],
		});
		const given = facts({
			agents: { a1: { name: "fix", issue: ISSUE, lane: "ask" } },
			open: [first, byLink, byAgentItem, other],
		});
		expect(words(first, given)).toEqual([
			"同じ対象の新しいエスカレーション #8 がある",
		]);
		expect(words(other, given)).toEqual([]);
		// An older one does not supersede a newer one.
		expect(words(byAgentItem, given)).toEqual([]);
		const lone = esc({ id: 1, agents: ["a2"] });
		const again = esc({ id: 2, agents: ["a2"] });
		expect(
			words(
				lone,
				facts({
					agents: { a2: { name: "research", lane: "ask" } },
					open: [lone, again],
				}),
			),
		).toEqual(["同じ対象の新しいエスカレーション #2 がある"]);
	});
});
