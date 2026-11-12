import { describe, expect, it } from "vitest";
import { staleReasons, staleWords, type StaleItem } from "./staleness.js";

const PR = "https://github.com/acme/pay/pull/12";
const ISSUE = "https://github.com/acme/pay/issues/3";

function items(
	read: Record<string, StaleItem>,
): (key: string) => StaleItem | undefined {
	return (key) => read[key];
}

describe("a task that may be stale", () => {
	it("is one whose linked pull request merged or closed, or whose linked Issue closed", () => {
		const reasons = staleReasons(
			[`${PR}/files`, ISSUE, "https://notion.so/x"],
			items({
				[PR]: { kind: "pr", state: "merged", ref: "acme/pay#12" },
				[ISSUE]: { kind: "issue", state: "closed", ref: "acme/pay#3" },
			}),
		);
		expect(reasons.map(staleWords)).toEqual([
			"PR acme/pay#12 はマージ済み",
			"Issue acme/pay#3 はクローズ済み",
		]);
		expect(
			staleReasons(
				[PR],
				items({ [PR]: { kind: "pr", state: "closed", ref: "acme/pay#12" } }),
			).map(staleWords),
		).toEqual(["PR acme/pay#12 はクローズ済み"]);
	});

	it("is not one whose links are open, or not read", () => {
		expect(
			staleReasons(
				[PR, ISSUE],
				items({ [PR]: { kind: "pr", state: "open", ref: "acme/pay#12" } }),
			),
		).toEqual([]);
		// The same item linked twice is one reason.
		expect(
			staleReasons(
				[PR, `${PR}#discussion`],
				items({ [PR]: { kind: "pr", state: "merged", ref: "acme/pay#12" } }),
			),
		).toHaveLength(1);
	});
});
