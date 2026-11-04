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
import { issuePromptDelivery, toDomainProfile } from "./issueAssignment.js";

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

	// The quick pick at the agent's start: the review sheet, drawn over the
	// window for the default action. A draft is read in the input box itself.
	it("is drafted, with no sheet, for the action DevHub ships", () => {
		expect(shipped.start).toBe("draft");
		expect(issuePromptDelivery(shipped)).toEqual({ kind: "draft" });
		expect(issuePromptDelivery(shipped, { review: false })).toEqual({
			kind: "draft",
		});
	});

	it("is sent behind the review sheet only when the action asks and the window is the caller", () => {
		const send = { ...shipped, start: "send" as const };
		expect(issuePromptDelivery(send)).toEqual({ kind: "send", review: true });
		expect(
			issuePromptDelivery({ ...send, confirm_before_send: false }),
		).toEqual({ kind: "send", review: false });
		// `devhub --tell`: the command is the decision.
		expect(issuePromptDelivery(send, { review: false })).toEqual({
			kind: "send",
			review: false,
		});
	});

	it("follows --send and --draft over the action", () => {
		expect(
			issuePromptDelivery(shipped, { start: "send", review: false }),
		).toEqual({ kind: "send", review: false });
		expect(
			issuePromptDelivery({ ...shipped, start: "send" }, { start: "draft" }),
		).toEqual({ kind: "draft" });
	});
});
