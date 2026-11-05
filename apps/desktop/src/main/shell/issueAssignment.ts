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
 * - **How the first message goes out.** Always sent, as the new Agent's
 *   first message; behind the review sheet only when the action asks for one
 *   (`confirm_before_send`) and the caller is the window — a command line is
 *   the decision (`review: false`).
 */

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

/**
 * Whether an Issue action's first message is shown for review before it is
 * sent: the action's `confirm_before_send`, unless the caller says there is to
 * be no sheet.
 */
export function issuePromptReview(
	action: { readonly confirm_before_send: boolean },
	how: { readonly review?: boolean } = {},
): boolean {
	return how.review ?? action.confirm_before_send;
}
