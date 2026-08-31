/**
 * What an Agent is doing, decided once per reconcile round.
 *
 * The rule engine (`rules.ts`) reads one screen and says what it sees. This is
 * everything around that: which screen, how often, and what makes a reading
 * become the row's status.
 *
 * **One source.** The screen comes from `capture-pane` on the reconcile
 * cadence, never from the attached client's stream. The sidebar has to show
 * every Agent's status whether or not anybody is looking at it, and a stream
 * only exists while a surface is open — so a design that read the stream when
 * there was one and captured when there was not would have two answers with
 * different latencies and different content, and the row would change meaning
 * depending on which surface happened to be on screen. `capture-pane` works
 * with zero surfaces attached, so it is the only source.
 *
 * **Debounce.** A CLI redraws its screen many times a second, and a frame taken
 * mid-redraw can show anything. So a *new* state has to be read twice in a row
 * before it replaces the one the row is showing. The exception is a reading
 * that carries `visibleBlocker`: an Agent that has stopped to ask a question is
 * the one thing nobody should have to wait an extra round to be told about, and
 * a visible blocker is live chrome rather than a stray line of scrollback.
 *
 * The state machine is deliberately per Agent and in memory. It describes the
 * last second of a screen; a restart has no screen to describe yet, and
 * persisting a guess about one would be persisting a stale reading.
 */

import type { AgentStatus } from "../../../model/domain.js";
import { manifestFor } from "./manifests.js";
import { read, type DetectionInput, type ScreenState } from "./rules.js";

/** How many consecutive rounds a new state needs before the row takes it. */
export const DEBOUNCE_ROUNDS = 2;

/** The screen of one Agent, as `capture-pane` and tmux's pane title give it. */
export interface AgentScreen extends DetectionInput {
	readonly agentId: string;
}

interface Pending {
	readonly state: AgentStatus;
	rounds: number;
}

/**
 * herdr's four screen states, in DevHub's vocabulary.
 *
 * `blocked` is DevHub's `waiting` — an Agent that has stopped to ask you
 * something. `unknown` stays `unknown`: it is what the sidebar draws a `?` for,
 * and it is reached both by a screen no rule described and by a profile whose
 * kind has no manifest at all. DevHub's `error` has no screen state, because no
 * screen says "this went wrong" — only the runtime does.
 */
function statusOf(state: ScreenState): AgentStatus {
	switch (state) {
		case "idle":
			return "idle";
		case "working":
			return "working";
		case "blocked":
			return "waiting";
		case "unknown":
			return "unknown";
	}
}

export class AgentStatusDetector {
	/** What each Agent's row is showing, and what is trying to replace it. */
	readonly #current = new Map<string, AgentStatus>();
	readonly #pending = new Map<string, Pending>();

	/**
	 * The status for one Agent's screen this round.
	 *
	 * `kind` is the profile's, and a kind with no manifest never reads a screen
	 * at all: its status is `unknown` for the life of the Agent, which is the
	 * point of allowing a profile that is just a command.
	 */
	status(kind: string, screen: AgentScreen): AgentStatus {
		const manifest = manifestFor(kind);
		if (manifest === undefined) return "unknown";
		const reading = read(manifest, screen);
		const showing = this.#current.get(screen.agentId) ?? "unknown";
		// A transcript or picker overlay is the Agent's own viewer, not its
		// state. The row keeps what it had, and the debounce keeps counting
		// nothing, so the screen underneath decides when it comes back.
		if (reading.skipStateUpdate) return showing;
		const next = statusOf(reading.state);
		if (next === showing) {
			this.#pending.delete(screen.agentId);
			return showing;
		}
		if (reading.visibleBlocker) return this.#commit(screen.agentId, next);
		const pending = this.#pending.get(screen.agentId);
		if (pending?.state === next) {
			pending.rounds += 1;
			if (pending.rounds >= DEBOUNCE_ROUNDS) {
				return this.#commit(screen.agentId, next);
			}
			return showing;
		}
		this.#pending.set(screen.agentId, { state: next, rounds: 1 });
		return DEBOUNCE_ROUNDS <= 1 ? this.#commit(screen.agentId, next) : showing;
	}

	/** What this Agent's row is showing now, for a round that read nothing. */
	showing(agentId: string): AgentStatus {
		return this.#current.get(agentId) ?? "unknown";
	}

	/** An Agent that ended takes its screen history with it. */
	forget(agentId: string): void {
		this.#current.delete(agentId);
		this.#pending.delete(agentId);
	}

	#commit(agentId: string, status: AgentStatus): AgentStatus {
		this.#current.set(agentId, status);
		this.#pending.delete(agentId);
		return status;
	}
}
