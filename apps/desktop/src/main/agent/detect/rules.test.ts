/**
 * The ported rule engine, against the screens it exists to read.
 *
 * The transcripts are written here rather than captured, because what a rule
 * matches is the manifest's claim about a screen and a test that replays a
 * capture only proves the capture. Each case names the herdr rule it is about,
 * so a rule that drifts from herdr's fails here by name.
 */

import { describe, expect, it } from "vitest";
import { AgentStatusDetector, type AgentScreen } from "./detector.js";
import { CLAUDE, CODEX, manifestFor } from "./manifests.js";
import { read, region, type DetectionInput } from "./rules.js";

function input(
	screen: string,
	oscTitle = "",
	oscProgress = "",
): DetectionInput {
	return { screen, oscTitle, oscProgress };
}

const RULE = "─".repeat(40);

describe("screen regions", () => {
	it("takes the prompt box as the text between the last two rules", () => {
		const screen = [
			"some output",
			RULE,
			"  ❯ ",
			RULE,
			"  ? for shortcuts",
		].join("\n");
		expect(region(input(screen), "prompt_box_body")).toBe("  ❯ ");
		expect(region(input(screen), "after_last_horizontal_rule")).toBe(
			"  ? for shortcuts",
		);
	});

	it("counts non-empty lines from the bottom, keeping the blanks between", () => {
		const screen = ["a", "", "b", "", "", "c"].join("\n");
		expect(
			region(input(screen), { kind: "bottom_non_empty_lines", count: 2 }),
		).toBe(["b", "", "", "c"].join("\n"));
		expect(
			region(input(screen), { kind: "top_non_empty_lines", count: 2 }),
		).toBe(["a", "", "b"].join("\n"));
	});

	it("reads the title from the title, never from the screen", () => {
		// A spinner printed into the pane is not the same fact as a spinner in
		// the window title, and a title rule must not match one for the other.
		const reading = read(CLAUDE, input("⠋ thinking", ""));
		expect(reading.state).not.toBe("working");
	});
});

describe("the Claude manifest", () => {
	it("reads the title spinner as working", () => {
		const reading = read(CLAUDE, input("", "⠋ Doing the thing"));
		expect(reading.matchedRuleId).toBe("osc_title_working");
		expect(reading.state).toBe("working");
		expect(reading.visibleWorking).toBe(true);
	});

	it("reads the live prompt box as idle", () => {
		const screen = ["done.", RULE, " ❯ ", RULE, " ? for shortcuts"].join("\n");
		const reading = read(CLAUDE, input(screen, "✳ DevHub"));
		expect(reading.state).toBe("idle");
		expect(reading.visibleIdle).toBe(true);
	});

	it("reads a permission question as blocked, over the idle prompt", () => {
		const screen = [
			"Bash command",
			"  npm test",
			RULE,
			"Do you want to proceed?",
			" ❯ 1. Yes",
			"   2. No, and tell Claude what to do differently (esc to cancel)",
		].join("\n");
		const reading = read(CLAUDE, input(screen, "✳ DevHub"));
		expect(reading.state).toBe("blocked");
		expect(reading.visibleBlocker).toBe(true);
	});

	it("treats the transcript viewer as no reading at all", () => {
		const screen = ["Showing detailed transcript", "ctrl+o to toggle"].join(
			"\n",
		);
		const reading = read(CLAUDE, input(screen));
		expect(reading.skipStateUpdate).toBe(true);
	});
});

describe("the Codex manifest", () => {
	it("reads its title spinner and its Action Required", () => {
		expect(read(CODEX, input("", "⠹ codex")).state).toBe("working");
		const blocked = read(CODEX, input("", "Action Required — codex"));
		expect(blocked.state).toBe("blocked");
		expect(blocked.visibleBlocker).toBe(true);
	});

	it("reads the working footer when there is no title to read", () => {
		const screen = "• Working (12s · esc to interrupt)";
		expect(read(CODEX, input(screen)).state).toBe("working");
	});

	it("reads a live blocker after the prompt marker", () => {
		const screen = ["› run the tests", "Allow command?"].join("\n");
		const reading = read(CODEX, input(screen));
		expect(reading.state).toBe("blocked");
		expect(reading.visibleBlocker).toBe(true);
	});

	it("reads a plain title as idle", () => {
		const reading = read(CODEX, input("", "codex — devhub"));
		expect(reading.state).toBe("idle");
	});
});

describe("a kind with no manifest", () => {
	it("has none, permanently", () => {
		expect(manifestFor("custom")).toBeUndefined();
		expect(manifestFor("nothing-like-this")).toBeUndefined();
	});
});

describe("the debounce", () => {
	const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const screen = (text: string, title = ""): AgentScreen => ({
		agentId: AGENT,
		screen: text,
		oscTitle: title,
		oscProgress: "",
	});
	const idle = ["x", RULE, " ❯ ", RULE, ""].join("\n");

	it("makes a new state prove itself for two rounds", () => {
		const detector = new AgentStatusDetector();
		expect(detector.status("claude", screen("", "⠋ working"))).toBe("unknown");
		expect(detector.status("claude", screen("", "⠋ working"))).toBe("working");
		// One stray frame does not move the row.
		expect(detector.status("claude", screen(idle))).toBe("working");
		expect(detector.status("claude", screen(idle))).toBe("idle");
	});

	it("lets a visible blocker through at once", () => {
		const detector = new AgentStatusDetector();
		detector.status("claude", screen("", "⠋ working"));
		detector.status("claude", screen("", "⠋ working"));
		const blocked = [
			"Bash command",
			RULE,
			"Do you want to proceed?",
			" ❯ 1. Yes",
			"   2. No (esc to cancel)",
		].join("\n");
		// Waiting for a person is the one thing nobody should be told a round
		// late, and a visible blocker is live chrome rather than scrollback.
		expect(detector.status("claude", screen(blocked))).toBe("waiting");
	});

	it("never reads a screen for a kind it has no manifest for", () => {
		const detector = new AgentStatusDetector();
		// The same screen that reads as working for Claude reads as nothing at
		// all here, for ever.
		expect(detector.status("custom", screen("", "⠋ working"))).toBe("unknown");
		expect(detector.status("custom", screen("", "⠋ working"))).toBe("unknown");
	});

	it("keeps the row's status while the Agent's own viewer is up", () => {
		const detector = new AgentStatusDetector();
		detector.status("claude", screen(idle));
		detector.status("claude", screen(idle));
		expect(detector.status("claude", screen(idle))).toBe("idle");
		const transcript = "Showing detailed transcript\nctrl+o to toggle";
		expect(detector.status("claude", screen(transcript))).toBe("idle");
	});
});
