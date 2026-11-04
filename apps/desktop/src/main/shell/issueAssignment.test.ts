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
import {
	assignmentPresentation,
	issuePromptDelivery,
	onlyClone,
	toDomainProfile,
} from "./issueAssignment.js";

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

describe("GUI or terminal, for an Issue's agent", () => {
	const cases = [
		profile("claude"),
		profile("codex"),
		profile("claude", "tui"),
		profile("codex", "gui"),
		profile("cursor"),
		profile("custom"),
	];

	it("is the agent picker's row, agent new's default and issue assign's, for every profile", () => {
		for (const fallback of ["gui", "tui"] as const) {
			for (const configured of cases) {
				const settings = agents(fallback);
				const domain = toDomainProfile(configured, settings);
				// The row the sheet and the Sidebar's Assign issue choose from.
				const row = agentProfilesWire([domain], 1).profiles[0]!.presentation;
				// What `create_agent` falls back to with no presentation: agent new.
				const agentNew = domain.presentation;
				// What `--tell issue assign` without --gui/--tui asks for.
				const cli = assignmentPresentation(undefined, configured, settings);
				expect({ id: configured.id, fallback, row, agentNew, cli }).toEqual({
					id: configured.id,
					fallback,
					row: agentNew,
					agentNew,
					cli: agentNew,
				});
			}
		}
	});

	// The report: settings.toml says `default_presentation = "gui"` and the
	// profiles say nothing, and the command line started a terminal agent.
	it("follows [agents] default_presentation when the profile says nothing", () => {
		expect(
			assignmentPresentation(undefined, profile("claude"), agents("gui")),
		).toBe("gui");
		expect(
			assignmentPresentation(undefined, profile("codex"), agents("gui")),
		).toBe("gui");
		// A kind with no GUI is a terminal whatever the default says.
		expect(
			assignmentPresentation(undefined, profile("cursor"), agents("gui")),
		).toBe("tui");
		// A profile's own word wins over the default.
		expect(
			assignmentPresentation(
				undefined,
				profile("claude", "tui"),
				agents("gui"),
			),
		).toBe("tui");
	});

	it("is what --gui or --tui asks for, when one does", () => {
		expect(
			assignmentPresentation("tui", profile("claude"), agents("gui")),
		).toBe("tui");
		expect(
			assignmentPresentation("gui", profile("claude"), agents("tui")),
		).toBe("gui");
	});
});

describe("the clone of a command-line assignment", () => {
	const one = { place: { kind: "local" as const, path: "/src/widget" } };
	const two = { place: { kind: "local" as const, path: "/work/widget" } };

	it("is the only one found", () => {
		expect(onlyClone([one], "o/widget")).toEqual(one.place);
	});

	it("is a question when there are several, answered by --repo", () => {
		expect(() => onlyClone([one, two], "o/widget")).toThrow(
			"this machine has 2 clones of o/widget; choose one with --repo <path>:\n  /src/widget\n  /work/widget",
		);
	});

	it("is a clone to make when there is none", () => {
		expect(() => onlyClone([], "o/widget")).toThrow(/--repo <path>/u);
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
