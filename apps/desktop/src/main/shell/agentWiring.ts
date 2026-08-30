/**
 * Where DevHub's Agents get built, and how the model's vocabulary meets the
 * Herdr adapter's.
 *
 * The two sides agree about almost everything — status, health and profile kind
 * are literally the same values — but a `Workspace` identity is a branded string
 * in the model and a validated plain string in the adapter, and a profile's
 * environment is a `Map` in one and a record in the other. Those are the only
 * two differences, and they are converted here, once, rather than in every
 * effect that crosses.
 */

import { randomUUID } from "node:crypto";
import { AgentService } from "../agent/index.js";
import type { AgentProfile as AdapterProfile } from "../agent/ports.js";
import { CancellationToken } from "../agent/ports.js";
import type { AppModel } from "../../model/appModel.js";
import {
	agentId as parseAgentId,
	type AgentId,
	type AgentProfile,
	type AgentReconciliation,
	type WorkspaceId,
} from "../../model/domain.js";
import type {
	AgentLaunchResult,
	AgentStopResult,
} from "../../model/intents.js";
import { registerAgentAdapter } from "./adapters.js";

/**
 * A fresh cancellation token.
 *
 * The adapter identifies a cancellable operation by a UUID. The coordinator
 * already gave every effect an operation identity, but the effect runner does
 * not hand it down here, so each call gets its own — nothing in the shell
 * cancels an Agent operation from outside yet, and inventing a shared token
 * would suggest something can.
 */
function token(): CancellationToken {
	return new CancellationToken(randomUUID());
}

/** The adapter's spelling of a profile: the same values, a plain record. */
function toAdapterProfile(profile: AgentProfile): AdapterProfile {
	return {
		id: profile.id,
		displayName: profile.displayName,
		kind: profile.kind,
		args: [...profile.args],
		env: Object.fromEntries(
			[...profile.env].sort(([a], [b]) => (a < b ? -1 : 1)),
		),
	};
}

export interface AgentWiringOptions {
	readonly journalPath: string;
	readonly configuredHerdr: string;
	readonly home: string;
	readonly model: () => AppModel;
	/**
	 * An observation the adapter made on its own — an attach that saw a status,
	 * or a control stream that failed. It reaches the model the same way every
	 * other observation does, through a reconcile.
	 */
	readonly onObserved: (agentId: AgentId) => void;
}

export function wireAgents(options: AgentWiringOptions): AgentService {
	const service = new AgentService({
		journalPath: options.journalPath,
		configuredHerdr: options.configuredHerdr,
		home: options.home,
		onObservation: (observation) => {
			options.onObserved(parseAgentId(observation.agentId));
		},
		onSurfaceFailure: (agentId) => {
			// A dead control stream is a health fact, not a row change: the model
			// learns it by reconciling, which is the one path that can also decide
			// the Agent is gone.
			options.onObserved(parseAgentId(agentId));
		},
	});
	service.register();

	registerAgentAdapter({
		async launch(
			workspaceId: WorkspaceId,
			agentId: AgentId,
			profile: AgentProfile,
			workspaceRoot: string,
		): Promise<AgentLaunchResult> {
			service.runtime.registerAgentWorkspace(
				agentId,
				workspaceId,
				workspaceRoot,
			);
			try {
				await service.runtime.launchForWorkspace(
					workspaceId,
					workspaceRoot,
					agentId,
					toAdapterProfile(profile),
					token(),
				);
				return { kind: "started" };
			} catch {
				// Why it failed is the adapter's business and is already recorded
				// there; what the model needs is that it did not start.
				return { kind: "failed", diagnostic: "runtime_unavailable" };
			}
		},

		stop(agentId: AgentId): Promise<AgentStopResult> {
			return terminate(service, agentId);
		},

		terminate(agentId: AgentId): Promise<AgentStopResult> {
			return terminate(service, agentId);
		},

		async reconcile(agentId?: AgentId): Promise<AgentReconciliation> {
			const reconciliation = await service.runtime.reconcile(token());
			const observations = reconciliation.observations.map((observation) => ({
				agentId: parseAgentId(observation.agentId),
				status: observation.status,
				runtimeHealth: observation.runtimeHealth,
			}));
			const exited = reconciliation.exited.map((id) => parseAgentId(id));
			if (agentId === undefined) {
				return { observations, exited };
			}
			// A single-Agent reconcile answers about that Agent only; the rest of
			// the provider's view belongs to the next full reconcile.
			return {
				observations: observations.filter(
					(observation) => observation.agentId === agentId,
				),
				exited: exited.filter((id) => id === agentId),
			};
		},

		async closeWorkspaceAgents(workspaceId: WorkspaceId): Promise<void> {
			const workspace = options.model().workspace(workspaceId);
			if (!workspace) return;
			for (const agent of workspace.agents) {
				await terminate(service, agent.id);
			}
		},
	});

	return service;
}

async function terminate(
	service: AgentService,
	agentId: AgentId,
): Promise<AgentStopResult> {
	try {
		await service.runtime.terminate(agentId, token());
		return { kind: "stopped" };
	} catch {
		// A stop that did not stop leaves the Agent retryable rather than
		// pretending it is gone.
		return { kind: "failed", diagnostic: "cleanup_failed" };
	}
}
