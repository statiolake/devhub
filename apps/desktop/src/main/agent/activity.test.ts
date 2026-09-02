import { describe, expect, it } from "vitest";
import { AgentActivityReader } from "./activity.js";
import type { AgentScreen } from "./detect/detector.js";

function screen(agentId: string, oscTitle: string): AgentScreen {
	return { agentId, screen: "", oscTitle, oscProgress: "" };
}

describe("what an Agent says it is doing", () => {
	/**
	 * The rule, whole: an empty title is an Agent that has not spoken.
	 *
	 * DevHub blanks the title when it creates the session, so anything in it
	 * afterwards was put there by the Agent. What this replaces was an
	 * inference — the title at the first reading was taken to be that pane's
	 * silence — which raced the Agent's own startup and answered differently
	 * depending on when DevHub happened to look.
	 */
	it("says nothing while the title is empty", () => {
		const reader = new AgentActivityReader();
		expect(reader.activity(screen("a", ""))).toBeUndefined();
		expect(reader.activity(screen("a", "   "))).toBeUndefined();
	});

	it("takes a title the Agent set as the Agent's own word", () => {
		const reader = new AgentActivityReader();
		expect(reader.activity(screen("a", "Reading agentReconciler.ts"))).toBe(
			"Reading agentReconciler.ts",
		);
	});

	/**
	 * The same answer on the first reading as on the hundredth. An Agent that
	 * outlived DevHub is read mid-task, and what is in its title is its word —
	 * not, as before, a baseline that silenced it for the rest of its life.
	 */
	it("reads a running Agent's title as a word, not as a baseline", () => {
		const reader = new AgentActivityReader();
		expect(reader.activity(screen("restored", "Running the tests"))).toBe(
			"Running the tests",
		);
	});

	it("falls silent when the Agent clears its title", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "Reading agentReconciler.ts"));
		expect(reader.activity(screen("a", ""))).toBeUndefined();
	});

	it("keeps each Agent's word to itself", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "Reading agentReconciler.ts"));
		expect(reader.activity(screen("b", "Running the tests"))).toBe(
			"Running the tests",
		);
		expect(reader.showing("a")).toBe("Reading agentReconciler.ts");
	});

	it("re-reports the last word for a round that read nothing", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "Reading agentReconciler.ts"));
		expect(reader.showing("a")).toBe("Reading agentReconciler.ts");
	});

	it("has no word for an Agent it has never read", () => {
		expect(new AgentActivityReader().showing("a")).toBeUndefined();
	});

	it("forgets an Agent that ended", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "Reading agentReconciler.ts"));
		reader.forget("a");
		expect(reader.showing("a")).toBeUndefined();
	});
});
