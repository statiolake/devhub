/**
 * Where DevHub's Agents get built.
 *
 * An Agent is a tmux session on the same socket, with the same markers and the
 * same client, as a workspace terminal (`main/agent/sessions.ts`). So this file
 * has shrunk to what it always should have been: turning a launch effect into a
 * session command, and turning the list of live sessions into the model's
 * vocabulary.
 *
 * The two vocabularies now differ in exactly one place — a profile's
 * environment is a `Map` in the model and a record on the wire to tmux — and
 * that is converted here, once.
 */

import { AgentSessions } from "../agent/sessions.js";
import type { AppModel } from "../../model/appModel.js";
import type {
	AgentId,
	AgentProfile,
	AgentReconciliation,
	AgentStatus,
	RuntimeHealth,
	WorkspaceId,
} from "../../model/domain.js";
import type {
	AgentLaunchResult,
	AgentStopResult,
} from "../../model/intents.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";
import { registerAgentAdapter } from "./adapters.js";

export interface AgentWiringOptions {
	readonly runtime: TmuxTerminalRuntime;
	/** The live model: the authority on which Agents exist and where they run. */
	readonly model: () => AppModel;
}

/**
 * What an Agent's status is, before anything has read its screen.
 *
 * There is no detector yet, so every Agent reports this and the row says so.
 * The alternative — reporting `working` because a process exists — would be a
 * claim about a screen nobody looked at, and it is exactly the claim that made
 * the previous runtime's status hard to trust.
 */
const UNREAD_STATUS: AgentStatus = "unknown";

export function wireAgents(options: AgentWiringOptions): AgentSessions {
	const sessions = new AgentSessions(options.runtime);

	registerAgentAdapter({
		async launch(
			workspaceId: WorkspaceId,
			agentId: AgentId,
			profile: AgentProfile,
			workspaceRoot: string,
		): Promise<AgentLaunchResult> {
			try {
				await sessions.launch({
					agentId,
					workspaceId,
					root: workspaceRoot,
					command: {
						file: profile.command,
						args: [...profile.args],
						env: Object.fromEntries(profile.env),
					},
				});
				return { kind: "started" };
			} catch {
				// Why it failed belongs to the runtime, which has already refused
				// in its own vocabulary; what the model needs is that no Agent is
				// running, so the row stays retryable rather than pretending.
				return { kind: "failed", diagnostic: "runtime_unavailable" };
			}
		},

		stop: (agentId) => terminate(sessions, options.model, agentId),
		terminate: (agentId) => terminate(sessions, options.model, agentId),

		/**
		 * One round: the socket's Agent sessions, matched against the model's.
		 *
		 * There is a single source of truth and it is `list-sessions`. An id it
		 * carries is an Agent whose command is still running, because tmux
		 * destroys the session when that command exits; an id the model has and
		 * the list does not is an Agent that ended. The only exception is an
		 * Agent whose launch has not returned yet, which is a snapshot taken
		 * early rather than a process that is gone.
		 */
		async reconcile(agentId?: AgentId): Promise<AgentReconciliation> {
			const health: RuntimeHealth = sessions.available
				? "healthy"
				: "unavailable";
			const live = new Set((await sessions.list()).map((one) => one.agentId));
			const observations: {
				agentId: AgentId;
				status: AgentStatus;
				runtimeHealth: RuntimeHealth;
			}[] = [];
			const exited: AgentId[] = [];
			for (const workspace of options.model().workspaces) {
				for (const agent of workspace.agents) {
					if (agentId !== undefined && agent.id !== agentId) continue;
					if (!live.has(agent.id)) {
						if (sessions.isLaunching(agent.id)) continue;
						exited.push(agent.id);
						continue;
					}
					observations.push({
						agentId: agent.id,
						status: UNREAD_STATUS,
						runtimeHealth: health,
					});
				}
			}
			return { observations, exited };
		},

		async closeWorkspaceAgents(workspaceId: WorkspaceId): Promise<void> {
			const workspace = options.model().workspace(workspaceId);
			if (!workspace) return;
			for (const agent of workspace.agents) {
				await terminate(sessions, options.model, agent.id);
			}
		},
	});

	return sessions;
}

async function terminate(
	sessions: AgentSessions,
	model: () => AppModel,
	agentId: AgentId,
): Promise<AgentStopResult> {
	const workspace = model().workspaceForAgent(agentId);
	if (workspace === undefined) {
		// The model does not have this Agent, so there is no workspace to name
		// its session with. Nothing to kill, and nothing to retry.
		return { kind: "stopped" };
	}
	try {
		await sessions.terminate(agentId, workspace.id);
		return { kind: "stopped" };
	} catch {
		// A stop that did not stop leaves the Agent retryable rather than
		// pretending it is gone.
		return { kind: "failed", diagnostic: "cleanup_failed" };
	}
}
