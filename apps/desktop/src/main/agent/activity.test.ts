import { describe, expect, it } from "vitest";
import { AgentActivityReader } from "./activity.js";
import type { AgentScreen } from "./detect/detector.js";

function screen(agentId: string, oscTitle: string): AgentScreen {
	return { agentId, screen: "", oscTitle, oscProgress: "" };
}

describe("what an Agent says it is doing", () => {
	it("says nothing on the first reading, whatever the pane is called", () => {
		const reader = new AgentActivityReader();
		// Whatever a shell's precmd or tmux itself put there; DevHub does not
		// know the string and does not have to.
		expect(reader.activity(screen("a", "some-machine.local"))).toBeUndefined();
	});

	it("takes any later title as the Agent's own word", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "some-machine.local"));
		expect(reader.activity(screen("a", "Reading agentReconciler.ts"))).toBe(
			"Reading agentReconciler.ts",
		);
	});

	it("falls silent again when the pane goes back to what it was called", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "some-machine.local"));
		reader.activity(screen("a", "Reading agentReconciler.ts"));
		expect(reader.activity(screen("a", "some-machine.local"))).toBeUndefined();
	});

	it("treats an empty title as silence", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "some-machine.local"));
		expect(reader.activity(screen("a", "   "))).toBeUndefined();
	});

	it("keeps each Agent's silence to itself", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "some-machine.local"));
		// The second Agent's pane starts at the same string, and that string is
		// its silence too — but only because its own first reading said so.
		expect(reader.activity(screen("b", "some-machine.local"))).toBeUndefined();
		expect(reader.activity(screen("b", "Running the tests"))).toBe(
			"Running the tests",
		);
		expect(reader.activity(screen("a", "Running the tests"))).toBe(
			"Running the tests",
		);
	});

	it("re-reports the last word for a round that read nothing", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "some-machine.local"));
		reader.activity(screen("a", "Reading agentReconciler.ts"));
		expect(reader.showing("a")).toBe("Reading agentReconciler.ts");
	});

	it("has no word for an Agent it has never read", () => {
		expect(new AgentActivityReader().showing("a")).toBeUndefined();
	});

	it("forgets an Agent that ended, silence and all", () => {
		const reader = new AgentActivityReader();
		reader.activity(screen("a", "some-machine.local"));
		reader.activity(screen("a", "Reading agentReconciler.ts"));
		reader.forget("a");
		expect(reader.showing("a")).toBeUndefined();
		// A new Agent that reuses the id starts over: its first reading is its
		// own silence, not the dead one's word.
		expect(reader.activity(screen("a", "some-machine.local"))).toBeUndefined();
	});
});
