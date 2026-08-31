/**
 * An Agent is a tmux session.
 *
 * There is no Agent runtime any more. The previous one drove a separate
 * provider (Herdr) over a control socket, kept its own mapping journal, its own
 * tombstones and its own idea of what a pane was, and rendered the Agent's
 * screen a second time on the way to the surface. All of that existed to make a
 * foreign process's terminal look like DevHub's own. It no longer has to: an
 * Agent session lives on DevHub's own tmux socket, carries DevHub's own
 * markers, and is attached by the same `tmux attach-session` client over the
 * same PTY as every workspace terminal — so scrollback, copy mode, resize and
 * byte-for-byte input are the terminal's, not an imitation of them.
 *
 * What is left is this file, and it is small because the invariants it needs
 * are the runtime's already:
 *
 * - **Launch** creates one marked session whose *session command* is the
 *   Agent. tmux destroys a session when its command exits, so the Agent's own
 *   lifetime is the session's lifetime and nothing has to be told about it.
 * - **Reconcile** lists marked Agent sessions. An id in the list is alive; an
 *   id the model has and the list does not is an Agent that ended. That is the
 *   only signal, so there is no second answer to disagree with it.
 * - **Terminate** kills that exact session by the runtime's exact-record rule.
 *
 * What was dropped with Herdr, deliberately: the provider's own status
 * detection (restored in `detect/`, ported from herdr under Apache-2.0), the
 * pane/tab/workspace hierarchy DevHub never showed, and the cleanup journal —
 * a tmux session that outlives a crash is found again by its marker on the next
 * launch, which is what the journal was for.
 */

import {
	CancellationToken,
	type AgentSessionCommand,
	type AgentTerminalTarget,
	type OwnedSessionRecord,
} from "../terminal/ports.js";
import {
	agentSessionName,
	type TmuxTerminalRuntime,
} from "../terminal/tmux.js";

/** One Agent, as the runtime needs to see it to start it. */
export interface AgentLaunchSpec extends AgentTerminalTarget {
	readonly command: AgentSessionCommand;
}

/** One live Agent session, as reconciliation reports it. */
export interface LiveAgentSession {
	readonly agentId: string;
	readonly workspaceId: string;
}

export class AgentSessions {
	readonly #runtime: TmuxTerminalRuntime;
	/**
	 * Agents whose launch has not finished.
	 *
	 * Between the row appearing and the session existing there is a window in
	 * which the reconciler would find nothing and correctly conclude "not
	 * running" from a snapshot that is simply early. Herdr answered this
	 * statistically — three consecutive absent rounds — which also delayed
	 * every *real* exit by a second. Naming the window exactly costs one set
	 * and lets an exit be reported on the very next round, which is what the
	 * sidebar is for.
	 */
	readonly #launching = new Set<string>();

	constructor(runtime: TmuxTerminalRuntime) {
		this.#runtime = runtime;
	}

	get available(): boolean {
		return this.#runtime.adapterAvailable;
	}

	/**
	 * Start one Agent and do not return until its session has been read back.
	 *
	 * A launch that throws leaves nothing behind to clean up: either the
	 * session was created with its whole marker tuple, or tmux refused and
	 * there is no session. There is no half-created state to compensate for,
	 * which is the entire reason the marker tuple is written in the same tmux
	 * command queue as the `new-session`.
	 */
	async launch(
		spec: AgentLaunchSpec,
		cancel = new CancellationToken(),
	): Promise<void> {
		this.#launching.add(spec.agentId);
		try {
			await this.#runtime.launchAgent(
				{
					agentId: spec.agentId,
					workspaceId: spec.workspaceId,
					root: spec.root,
				},
				spec.command,
				cancel,
			);
		} finally {
			this.#launching.delete(spec.agentId);
		}
	}

	/** True while this Agent's session is still being created. */
	isLaunching(agentId: string): boolean {
		return this.#launching.has(agentId);
	}

	/** Every Agent session on the socket right now. */
	async list(cancel = new CancellationToken()): Promise<LiveAgentSession[]> {
		const records = await this.#runtime.listAgents(cancel);
		return records.flatMap((record) =>
			record.kind === "agent"
				? [{ agentId: record.agentId, workspaceId: record.workspaceId }]
				: [],
		);
	}

	/**
	 * Kill every Agent session that no row can ever show.
	 *
	 * Run once, at startup, after the state file has been restored. A marked
	 * Agent session with no Agent in the model is DevHub's own resource with
	 * nothing left that knows about it — a row lost to a state file that never
	 * got written — and it would otherwise hold its process for the life of the
	 * tmux server with no way to reach or stop it.
	 *
	 * It is deliberately not part of the reconcile loop: that loop runs only
	 * while there are Agents, so the one case this exists for is the one case
	 * it would never see.
	 */
	async reapUnknown(
		known: ReadonlySet<string>,
		cancel = new CancellationToken(),
	): Promise<number> {
		const live = await this.list(cancel);
		let reaped = 0;
		for (const session of live) {
			if (known.has(session.agentId)) continue;
			await this.terminate(session.agentId, session.workspaceId, cancel);
			reaped += 1;
		}
		return reaped;
	}

	/**
	 * Kill one Agent's session.
	 *
	 * An Agent that is already gone is not a failure: the caller asked for it
	 * to be stopped, and it is stopped. Anything else — a same-named session
	 * that is not this Agent's, a server DevHub does not own — throws, because
	 * those are resources that must stay intact.
	 */
	async terminate(
		agentId: string,
		workspaceId: string,
		cancel = new CancellationToken(),
	): Promise<void> {
		const record: OwnedSessionRecord = {
			kind: "agent",
			agentId,
			workspaceId,
			// The name is a pure function of the id, so a record built here and
			// a record read off the server are the same record without either
			// having had to be persisted.
			sessionName: agentSessionName(agentId),
		};
		await this.#runtime.closeAgent(record, cancel);
	}
}
