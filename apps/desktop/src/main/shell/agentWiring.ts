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

import { AgentActivityReader } from "../agent/activity.js";
import { AgentStatusDetector } from "../agent/detect/detector.js";
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

export function wireAgents(options: AgentWiringOptions): AgentSessions {
	const sessions = new AgentSessions(options.runtime);
	const detector = new AgentStatusDetector();
	const activity = new AgentActivityReader();

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
			} catch (failure: unknown) {
				// The model needs to know no Agent is running, so this stays a
				// `failed` result rather than a throw — the row has to be
				// retryable rather than pretending.
				//
				// But it used to stop there, and "the agent runtime is
				// unavailable" was the whole of what anyone could learn from a
				// launch that failed for a reason the runtime knew exactly. The
				// reason travels with the failure now, to the same error surface
				// every other failure is read on.
				return {
					kind: "failed",
					diagnostic: "runtime_unavailable",
					detail: failure instanceof Error ? failure.message : String(failure),
				};
			}
		},

		stop: (agentId) => terminate(sessions, agentId),
		terminate: (agentId) => terminate(sessions, agentId),

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
			// The Agents this round is *about*, read before the socket is asked.
			//
			// This order is the whole of the exit rule's correctness. A round
			// that listed sessions first and then read the model would judge an
			// Agent launched in between against a list taken before it existed,
			// and report a running Agent as ended — which is exactly what it did
			// until this line moved. An Agent that appears after the list is
			// simply not this round's business.
			const asked = new Map<
				AgentId,
				{ workspaceId: WorkspaceId; kind: string }
			>();
			for (const workspace of options.model().workspaces) {
				for (const agent of workspace.agents) {
					if (agentId !== undefined && agent.id !== agentId) continue;
					asked.set(agent.id, {
						workspaceId: workspace.id,
						kind: agent.profile.kind,
					});
				}
			}
			const live = new Set((await sessions.list()).map((one) => one.agentId));
			const observations: {
				agentId: AgentId;
				status: AgentStatus;
				runtimeHealth: RuntimeHealth;
				activity: string | undefined;
			}[] = [];
			const exited: AgentId[] = [];
			for (const [id, about] of asked) {
				// And read the model again at the end: an Agent that went away
				// while the screens were being captured is news the model already
				// has, and reporting it back would name an Agent it cannot find.
				if (options.model().workspaceForAgent(id) === undefined) continue;
				if (!live.has(id)) {
					if (sessions.isLaunching(id)) continue;
					detector.forget(id);
					activity.forget(id);
					exited.push(id);
					continue;
				}
				const reading = await observe(
					sessions,
					detector,
					activity,
					id,
					about.workspaceId,
					about.kind,
				);
				observations.push({
					agentId: id,
					status: reading.status,
					activity: reading.activity,
					runtimeHealth: health,
				});
			}
			return { observations, exited };
		},

		async closeWorkspaceAgents(workspaceId: WorkspaceId): Promise<void> {
			const workspace = options.model().workspace(workspaceId);
			if (!workspace) return;
			for (const agent of workspace.agents) {
				await terminate(sessions, agent.id);
			}
		},
	});

	return sessions;
}

/**
 * One Agent's status this round, and what it says it is doing.
 *
 * Both come off the same capture, because they are two readings of one moment:
 * `capture-pane` returns the screen and the pane title in a single tmux
 * command, and asking for them separately would let a row show a status from
 * one instant beside a sentence from another.
 *
 * A capture that fails is not a status: the Agent's session is there — it was
 * in the list a moment ago — and DevHub could not read its screen. Claiming
 * `error` would report the Agent as broken for a failure of DevHub's own, so
 * the reading is simply not taken and the row keeps what it had until the next
 * round, which is the same thing a screen the manifest does not describe does.
 * Its word keeps what it had for the same reason, by the same call shape.
 */
async function observe(
	sessions: AgentSessions,
	detector: AgentStatusDetector,
	activity: AgentActivityReader,
	agentId: AgentId,
	workspaceId: WorkspaceId,
	kind: string,
): Promise<{
	readonly status: AgentStatus;
	readonly activity: string | undefined;
}> {
	const screen = await sessions
		.screen(agentId, workspaceId)
		.catch(() => undefined);
	if (screen === undefined) {
		return {
			status: detector.showing(agentId),
			activity: activity.showing(agentId),
		};
	}
	return {
		status: detector.status(kind, screen),
		activity: activity.activity(screen),
	};
}

async function terminate(
	sessions: AgentSessions,
	agentId: AgentId,
): Promise<AgentStopResult> {
	try {
		await sessions.terminate(agentId);
		return { kind: "stopped" };
	} catch {
		// A stop that did not stop leaves the Agent retryable rather than
		// pretending it is gone.
		return { kind: "failed", diagnostic: "cleanup_failed" };
	}
}
