/**
 * The command an Agent profile starts, as the Agent's own machine names it.
 */

import type {
	SettingsResolvedRuntimeWire,
	SettingsUnavailableRuntimeWire,
} from "../../ipc/settings.js";
import type { Runtime } from "../runtime/runtime.js";

/**
 * A profile with its command looked up and a launch's extra arguments added.
 *
 * The combination rule, in one place: **the profile's own arguments first,
 * then the caller's, appended in the order they were given.** Nothing is
 * deduplicated and nothing is reordered, because the profile is the base
 * command and the extra arguments are what a person added to this one run —
 * and an agent command reads its last flag as the winning one.
 *
 * They go into the profile *snapshot* rather than being carried alongside it,
 * because that snapshot is what the Agent keeps for its whole life: an Agent's
 * record then says what it was actually started with, and a later edit to the
 * configured profile still cannot rewrite a running Agent.
 *
 * The command is looked up on `runtime`, which is the Workspace's machine and
 * so the Agent's: a Workspace in a container runs its Agent in that container,
 * and a profile naming `/workspaces/api/agent.sh` names a file there, not on
 * this Mac. `searchPath` is this Mac's launch PATH, which only the local
 * runtime reads; a remote one searches under its own login environment.
 */
export async function resolveAgentProfile<
	Profile extends {
		readonly command: string;
		readonly args: readonly string[];
	},
>(
	runtime: Pick<Runtime, "resolveProgram">,
	profile: Profile,
	extraArgs: readonly string[],
	searchPath: string,
): Promise<
	| { readonly kind: "resolved"; readonly profile: Profile }
	| SettingsUnavailableRuntimeWire
> {
	const resolved: SettingsResolvedRuntimeWire = await runtime.resolveProgram(
		profile.command,
		searchPath,
	);
	if (resolved.kind === "unavailable") return resolved;
	return {
		kind: "resolved",
		profile: {
			...profile,
			command: resolved.value,
			args: [...profile.args, ...extraArgs],
		},
	};
}
