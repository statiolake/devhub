/**
 * The decisions an Issue assignment makes on its own, the same from every door:
 * the Assign Issue sheet and the Sidebar's button (both the agent picker's
 * row), `agent new`, and `devhub --tell issue assign`.
 */

import { describe, expect, it } from "vitest";
import {
	defaultConfig,
	type AgentsConfig,
	type ConfiguredAgentProfile,
} from "../../model/config.js";
import { agentProfilesWire } from "../../model/wire.js";
import { DEFAULT_ACTION_ID } from "../../model/agentActions.js";
import { issuePromptReview, toDomainProfile } from "./issueAssignment.js";

function profile(
	kind: ConfiguredAgentProfile["kind"],
	presentation?: "gui" | "tui",
): ConfiguredAgentProfile {
	return {
		id: kind,
		display_name: kind,
		kind,
		command: kind,
		args: [],
		env: {},
		presentation,
	};
}

function agents(defaultPresentation: "gui" | "tui"): AgentsConfig {
	return {
		...defaultConfig().agents,
		default_presentation: defaultPresentation,
	};
}

describe("GUI or terminal, in the window", () => {
	const cases = [
		profile("claude"),
		profile("codex"),
		profile("claude", "tui"),
		profile("codex", "gui"),
		profile("cursor"),
		profile("custom"),
	];

	it("is the agent picker's row and New Agent's default alike, for every profile", () => {
		for (const fallback of ["gui", "tui"] as const) {
			for (const configured of cases) {
				const domain = toDomainProfile(configured, agents(fallback));
				// The row Assign Issue (sheet and Sidebar button) chooses from.
				const row = agentProfilesWire([domain], 1).profiles[0]!.presentation;
				// What `create_agent` falls back to with no presentation.
				expect({ id: configured.id, fallback, row }).toEqual({
					id: configured.id,
					fallback,
					row: domain.presentation,
				});
			}
		}
	});

	// The report's settings: `default_presentation = "gui"` and profiles that
	// say nothing. The window starts GUI agents; a kind with no GUI and a
	// profile that says otherwise keep their own.
	it("follows [agents] default_presentation when the profile says nothing", () => {
		const mode = (configured: ConfiguredAgentProfile) =>
			toDomainProfile(configured, agents("gui")).presentation;
		expect(mode(profile("claude"))).toBe("gui");
		expect(mode(profile("codex"))).toBe("gui");
		expect(mode(profile("cursor"))).toBe("tui");
		expect(mode(profile("claude", "tui"))).toBe("tui");
	});
});

describe("the first message of an Issue's agent", () => {
	const shipped = defaultConfig().agentActions.find(
		(action) => action.id === DEFAULT_ACTION_ID,
	)!;

	it("is reviewed only when the action asks and the window is the caller", () => {
		expect(issuePromptReview(shipped)).toBe(shipped.confirm_before_send);
		expect(issuePromptReview({ confirm_before_send: true })).toBe(true);
		expect(issuePromptReview({ confirm_before_send: false })).toBe(false);
		// `devhub --tell`: the command is the decision.
		expect(issuePromptReview(shipped, { review: false })).toBe(false);
	});
});
