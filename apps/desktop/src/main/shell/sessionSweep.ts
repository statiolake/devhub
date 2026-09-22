/**
 * The sessions DevHub owns that nothing in DevHub accounts for any more.
 *
 * A DevHub session outlives the app on purpose: a terminal is a tmux session,
 * an Agent *is* a tmux session, and quitting detaches rather than kills. The
 * price of that is a session whose row is gone — a state file that never got
 * written, a Workspace closed while its host was unreachable (see
 * `sessionsLeftRunning`), an Agent whose launch was compensated for. Such a
 * session holds a process for the life of its tmux server with nothing left
 * that can reach or stop it, which is the opposite of the owner's rule: *as
 * few resources as possible left behind*.
 *
 * So there is one sweep, and it is machine-parameterised, because the sessions
 * are one tmux server's and DevHub owns one socket on each machine. It asks
 * **every machine DevHub has ever owned sessions on** — not only the ones a
 * Workspace is still open on, which was the hole: the machine leaves the model
 * with the last Workspace on it, so the host that most needs asking is exactly
 * the one nothing would ask. That set is persisted (`session_machines`), and a
 * machine leaves it once a sweep found nothing there and no Workspace remains.
 *
 * **What it may kill.** Only what `markedSessions` returns, which is only what
 * carries DevHub's whole marker tuple on DevHub's own socket under DevHub's
 * own server protocol marker — so another DevHub profile's sessions (a
 * different socket) and anybody's own tmux (no markers) are not merely spared,
 * they are never seen. Of those, `scratch` — the server's bootstrap anchor,
 * which was the folderless Scratch's terminal before Scratch was a Workspace —
 * is accounted for by nothing and reaped; a `ws-` session is accounted for by its Workspace and
 * an `ag-` session by its Agent, both read out of the model at sweep time. The
 * kill itself is the runtime's exact-record rule, which re-reads the marker
 * and the listing immediately before destroying anything.
 *
 * **A machine that does not answer is not a failure.** It stays in the set and
 * in `pending`, is visible in `devhub --metrics` as `pendingSweeps`, and is
 * swept when a runtime for it next connects — which is the transition
 * `onRuntimeConnected` reports. Retrying on *any* failure and not only on an
 * unreachable one is deliberate: a retry costs one listing on a machine DevHub
 * is talking to anyway, and one rule here is worth more than a second
 * classification of failures that could disagree with `sessionsLeftRunning`.
 */

import { runtimeMachine } from "../runtime/registry.js";
import {
	CancellationToken,
	type OwnedSessionRecord,
} from "../terminal/ports.js";
import type { RuntimeId } from "../runtime/runtime.js";

/** As much of a machine's tmux adapter as a sweep uses. */
export interface SweepAdapter {
	/** False on a machine with no tmux: no server, so no sessions. */
	readonly adapterAvailable: boolean;
	markedSessions(
		cancel?: CancellationToken,
	): Promise<readonly OwnedSessionRecord[]>;
	closeMarkedSession(
		record: OwnedSessionRecord,
		cancel?: CancellationToken,
	): Promise<void>;
}

/** What the model still accounts for, read fresh for every sweep. */
export interface SweepAccounting {
	readonly workspaces: ReadonlySet<string>;
	readonly agents: ReadonlySet<string>;
}

export interface SessionSweepWorld {
	/** One machine's adapter. Rejects when the machine cannot be reached. */
	adapterFor(machine: RuntimeId): Promise<SweepAdapter>;
	accounted(): SweepAccounting;
	/** Every machine a Workspace is on right now, this one always among them. */
	workspaceMachines(): readonly RuntimeId[];
	/** The persisted set, as it was written: strings, not yet machines. */
	remembered(): readonly string[];
	/** Take one machine out of the persisted set, and save. */
	forget(machine: RuntimeId): void;
}

/** How one machine's sweep ended. */
export type SweepOutcome =
	| { readonly kind: "swept"; readonly reaped: number }
	| { readonly kind: "postponed"; readonly reason: string };

/**
 * The sessions on one machine that nothing accounts for.
 *
 * A pure function, because "which of these may be killed" is the whole of the
 * decision and it must be readable without a tmux. Every kind is named: a new
 * kind of owned session is a compile error here rather than a session that is
 * silently either always kept or always killed.
 */
export function unaccountedSessions(
	sessions: readonly OwnedSessionRecord[],
	accounted: SweepAccounting,
): readonly OwnedSessionRecord[] {
	return sessions.filter((session) => {
		switch (session.kind) {
			case "scratch":
				// Scratch is a Workspace now, and its terminal is that
				// Workspace's session. This one is only the tmux server's
				// bootstrap anchor (see `TerminalTarget` in `ports.ts`) — and the
				// folderless Scratch's terminal, for a state from before that —
				// and nothing accounts for it, so it goes like anything else
				// nothing accounts for.
				return true;
			case "workspace":
				return !accounted.workspaces.has(session.workspaceId);
			case "agent":
				return !accounted.agents.has(session.agentId);
		}
	});
}

export class SessionSweeper {
	readonly #world: SessionSweepWorld;
	readonly #pending = new Set<RuntimeId>();
	/** One sweep per machine at a time: two would race on the same kills. */
	readonly #running = new Map<RuntimeId, Promise<SweepOutcome>>();

	constructor(world: SessionSweepWorld) {
		this.#world = world;
	}

	/** The machines a sweep could not finish with, for `devhub --metrics`. */
	get pending(): readonly RuntimeId[] {
		return [...this.#pending];
	}

	/**
	 * Every machine to ask: the persisted set and the machines in use now.
	 *
	 * The union is what makes a state file written by an older DevHub — which
	 * has no persisted set — sweep exactly the machines its Workspaces name,
	 * without this file owning a second copy of how a machine is named.
	 */
	machines(): readonly RuntimeId[] {
		const machines = new Set<RuntimeId>(this.#world.workspaceMachines());
		for (const raw of this.#world.remembered()) {
			try {
				machines.add(runtimeMachine(raw));
			} catch (error: unknown) {
				// A name this build cannot read is not a reason to refuse the
				// state file, and not a machine either: say so once and go on.
				console.error(
					`[devhub] sweep: ${raw} in session_machines names no machine`,
					error instanceof Error ? error.message : error,
				);
			}
		}
		return [...machines];
	}

	/** Ask every machine, at startup. One machine's failure is its own. */
	async sweepAll(): Promise<void> {
		for (const machine of this.machines()) await this.sweep(machine);
	}

	/**
	 * A machine started answering again.
	 *
	 * Only the ones a sweep is waiting on: every other machine is one DevHub
	 * has already finished with, and reconnecting to it is not news.
	 */
	machineCameBack(machine: RuntimeId): void {
		if (!this.#pending.has(machine)) return;
		void this.sweep(machine);
	}

	async sweep(machine: RuntimeId): Promise<SweepOutcome> {
		const running = this.#running.get(machine);
		if (running) return running;
		const sweep = this.#sweep(machine).finally(() => {
			this.#running.delete(machine);
		});
		this.#running.set(machine, sweep);
		return sweep;
	}

	async #sweep(machine: RuntimeId): Promise<SweepOutcome> {
		let reaped = 0;
		try {
			const adapter = await this.#world.adapterFor(machine);
			// No tmux on that machine is no server on it, and therefore no
			// DevHub sessions: a clean answer, not an unreachable one.
			if (adapter.adapterAvailable) {
				const cancel = new CancellationToken();
				const stray = unaccountedSessions(
					await adapter.markedSessions(cancel),
					this.#world.accounted(),
				);
				for (const session of stray) {
					await adapter.closeMarkedSession(session, cancel);
					reaped += 1;
				}
			}
		} catch (error: unknown) {
			const reason = error instanceof Error ? error.message : String(error);
			this.#pending.add(machine);
			console.error(
				`[devhub] sweep: ${machine} could not be swept (${reason}); it will ` +
					`be asked again when it next connects`,
				error instanceof Error ? error.stack : error,
			);
			return { kind: "postponed", reason };
		}
		this.#pending.delete(machine);
		if (reaped > 0) {
			console.info(
				`[devhub] sweep: closed ${String(reaped)} session(s) on ${machine} ` +
					`that nothing in DevHub accounts for`,
			);
		} else if (!this.#world.workspaceMachines().includes(machine)) {
			// Nothing left there and nothing here that uses it. Asking it again
			// on every launch for the rest of time would be DevHub keeping a
			// host it has finished with, and reopening a Workspace on it puts it
			// back in the set before there is anything to sweep.
			this.#world.forget(machine);
		}
		return { kind: "swept", reaped };
	}
}
