/**
 * The decisions assigning an Issue makes that are not a person's answer —
 * written once, so the window's sheet, the Sidebar's button and
 * `devhub --tell issue assign` cannot make them differently.
 *
 * - **GUI or terminal.** One source: `profilePresentation`, the profile's own
 *   `presentation` or else `[agents] default_presentation`. It is what the
 *   agent picker's row says (`agentProfilesWire` over `toDomainProfile`), what
 *   `agent new` gets, and what `issue assign` gets unless `--gui`/`--tui`
 *   says otherwise. `issue assign` used to read the profile's own key alone
 *   and fall back to the terminal, so a configuration that left the choice to
 *   `default_presentation = "gui"` — the usual one — started a GUI Agent from
 *   the sheet and a terminal one from the command line.
 * - **Which clone.** The only one found, or the one named. Several, with none
 *   named, is the sheet's "Which …" question, and the order they were found in
 *   is no answer to it.
 * - **How the first message goes out.** An action that drafts puts its
 *   wording in the new Agent's input box and draws nothing over the window;
 *   one that sends shows its review sheet only when it asks for one and the
 *   caller is the window (a command line is the decision: `review: false`).
 */

import type {
	ActionStart,
	AgentActionTrigger,
} from "../../model/agentActions.js";
import {
	profilePresentation,
	type AgentsConfig,
	type ConfiguredAgentProfile,
} from "../../model/config.js";
import {
	AgentProfile,
	agentProfileId,
	type AgentPresentation,
} from "../../model/domain.js";
import { placeLabel, type WorkspacePlaceWire } from "../../ipc/contract.js";

/** A configured profile as the model runs it, its default presentation decided. */
export function toDomainProfile(
	profile: ConfiguredAgentProfile,
	agents: AgentsConfig,
): AgentProfile {
	return AgentProfile.create(
		agentProfileId(profile.id),
		profile.display_name,
		profile.kind,
		profile.command,
		profile.args,
		new Map(Object.entries(profile.env)),
		profilePresentation(profile, agents),
	);
}

/** GUI or terminal for an assignment: what was asked for, or the profile's default. */
export function assignmentPresentation(
	requested: AgentPresentation | undefined,
	profile: Pick<ConfiguredAgentProfile, "kind" | "presentation">,
	agents: AgentsConfig,
): AgentPresentation {
	return requested ?? profilePresentation(profile, agents);
}

/**
 * The clone a command-line assignment works in when none was named: the only
 * one there is. Refused, with what there is and the flag, otherwise.
 */
export function onlyClone(
	found: readonly { readonly place: WorkspacePlaceWire }[],
	repository: string,
): WorkspacePlaceWire {
	const [first, ...others] = found;
	if (first === undefined)
		throw new Error(
			`DevHub found no clone of ${repository}. Clone it, or pass --repo <path>.`,
		);
	if (others.length > 0)
		throw new Error(
			`this machine has ${String(found.length)} clones of ${repository}; choose one with --repo <path>:\n${found.map((one) => `  ${placeLabel(one.place)}`).join("\n")}`,
		);
	return first.place;
}

/** What happens to an Issue action's wording once the Agent is started. */
export type IssuePromptDelivery =
	| { readonly kind: "draft" }
	| { readonly kind: "send"; readonly review: boolean };

/**
 * How the first message goes out: the action's `start` unless the caller
 * overrides it for this one assignment, and — when it is sent — its review
 * sheet unless the caller says there is to be none.
 */
export function issuePromptDelivery(
	action: {
		readonly trigger: AgentActionTrigger;
		readonly start: ActionStart;
		readonly confirm_before_send: boolean;
	},
	how: { readonly start?: ActionStart; readonly review?: boolean } = {},
): IssuePromptDelivery {
	if ((how.start ?? action.start) === "draft") return { kind: "draft" };
	return { kind: "send", review: how.review ?? action.confirm_before_send };
}
