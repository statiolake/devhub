/**
 * The decisions assigning an Issue makes that are not a person's answer,
 * written once.
 *
 * - **GUI or terminal, in the window.** One source: `profilePresentation`,
 *   the profile's own `presentation` or else `[agents] default_presentation`
 *   — what the agent picker's row says (`agentProfilesWire` over
 *   `toDomainProfile`), for the Assign Issue sheet, the Sidebar's button and
 *   New Agent alike. `devhub --tell` never asks it: a command line names
 *   `--gui` or `--tui` every time, so what an agent gets does not move with
 *   the person's settings (`tell/service.ts`).
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
import { AgentProfile, agentProfileId } from "../../model/domain.js";

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
