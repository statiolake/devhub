import { describe, expect, it } from "vitest";
import type { AppConditionWire } from "../../ipc/contract.js";
import { AppConditions } from "./appConditions.js";

function conditions() {
	const sent: AppConditionWire[] = [];
	const subject = new AppConditions((condition) => {
		sent.push(condition);
	});
	return { subject, sent };
}

describe("standing conditions, keyed by source", () => {
	it("keeps one source's condition when another source clears its own", () => {
		const { subject, sent } = conditions();
		subject.observe("repository_status", "`gh` is not on the PATH.");
		subject.observe("machine:ssh:box", "DevHub is not getting an answer.");
		subject.observe("repository_status", undefined);

		expect([...subject.active]).toEqual([
			["machine:ssh:box", "DevHub is not getting an answer."],
		]);
		expect(sent).toEqual([
			{ source: "repository_status", summary: "`gh` is not on the PATH." },
			{
				source: "machine:ssh:box",
				summary: "DevHub is not getting an answer.",
			},
			{ source: "repository_status" },
		]);
	});

	it("replaces only the raising source's entry", () => {
		const { subject } = conditions();
		subject.observe("repository_status", "`gh` is not on the PATH.");
		subject.observe("machine:ssh:box", "DevHub is not getting an answer.");
		subject.observe("repository_status", "The network dropped.");

		expect(subject.active.get("repository_status")).toBe(
			"The network dropped.",
		);
		expect(subject.active.get("machine:ssh:box")).toBe(
			"DevHub is not getting an answer.",
		);
	});

	it("sends only what changed", () => {
		const { subject, sent } = conditions();
		// A look that succeeds retracts on every round; nothing was up.
		subject.observe("repository_status", undefined);
		subject.observe("repository_status", "`gh` is not on the PATH.");
		subject.observe("repository_status", "`gh` is not on the PATH.");
		subject.observe("repository_status", undefined);
		subject.observe("repository_status", undefined);

		expect(sent).toEqual([
			{ source: "repository_status", summary: "`gh` is not on the PATH." },
			{ source: "repository_status" },
		]);
	});

	it("tells a page that has just started listening everything that holds", () => {
		const { subject, sent } = conditions();
		subject.observe("repository_status", "`gh` is not on the PATH.");
		subject.observe("machine:ssh:box", "DevHub is not getting an answer.");
		subject.observe("repository_status", undefined);
		sent.length = 0;

		subject.replay();
		expect(sent).toEqual([
			{
				source: "machine:ssh:box",
				summary: "DevHub is not getting an answer.",
			},
		]);
	});
});
