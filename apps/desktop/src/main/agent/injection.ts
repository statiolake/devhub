/**
 * Text DevHub sends an Agent, and when it is safe to send it.
 *
 * Something in DevHub — a template, a flow, a person clicking once — decides
 * an Agent should be told something. That text cannot simply be typed into the
 * pane: an Agent's terminal is a live UI, and what a keystroke means depends
 * entirely on what is on screen at that moment. So this is a queue with a
 * gate, and the gate is the status detector.
 *
 * **Only into an idle prompt.** `idle` is the one state where the Agent is
 * showing a prompt box and waiting for a person to type, which is the only
 * screen on which a sentence is a sentence.
 *
 * - `working` — a turn is running. The box accepts text, but the Agent is not
 *   reading it, and the text would sit there until the turn ended and then be
 *   submitted with whatever else had been typed.
 * - `waiting` — the Agent has stopped to ask a question. That screen wants
 *   `y`, or a number, or Enter; free text answers nothing and, worse, the
 *   first character may *be* the answer to a menu. Nothing is ever sent here.
 * - `unknown` — the screen is one no manifest describes, which is exactly the
 *   case where DevHub does not know what a keystroke would mean. A custom
 *   runtime lives here permanently and is never typed into.
 *
 * **And only after it has settled.** One idle reading is not an idle Agent: a
 * CLI redraws constantly and a frame caught between two states can read as
 * anything, so the text goes only after several consecutive rounds of idle.
 * The detector already debounces a state change; this waits again on top of
 * that, because the cost of the two mistakes is not symmetric. Waiting a
 * second longer costs nothing. Typing into a turn that had not finished puts
 * DevHub's words in the middle of somebody's work.
 *
 * Nothing here talks to tmux. It decides *whether* and *what*; the caller
 * sends and reports back, so the rule can be tested without a terminal.
 */

import type { AgentStatus } from "../../model/domain.js";

/** Consecutive idle rounds required before anything is sent. */
export const IDLE_ROUNDS_BEFORE_SEND = 3;

/**
 * Why a queued text has not gone yet — the Agent's side of the answer.
 *
 * This exists to be shown. A queue that holds text without saying why is the
 * thing a person reads as "DevHub did nothing", and the reason is always known
 * here, so it is always available to say.
 */
export type InjectionWait =
	| { readonly kind: "nothing_queued" }
	| { readonly kind: "settling"; readonly rounds: number }
	| { readonly kind: "agent_busy" }
	| { readonly kind: "agent_asking" }
	| { readonly kind: "agent_unreadable" };

export interface InjectionState {
	/** How many texts are waiting for this Agent. */
	readonly queued: number;
	readonly waitingFor: InjectionWait;
	/** The last send that failed, kept until one succeeds. */
	readonly lastFailure: string | undefined;
}

const NOTHING: InjectionState = {
	queued: 0,
	waitingFor: { kind: "nothing_queued" },
	lastFailure: undefined,
};

interface Entry {
	readonly texts: string[];
	idleRounds: number;
	lastFailure: string | undefined;
}

export class AgentInjectionQueue {
	readonly #entries = new Map<string, Entry>();

	/**
	 * Hold text for an Agent until its prompt is free.
	 *
	 * Empty text is refused rather than queued. A caller that computed an empty
	 * instruction has a bug, and sending a bare Enter into an Agent's prompt is
	 * not a harmless version of doing nothing.
	 */
	queue(agentId: string, text: string): void {
		if (text.trim().length === 0) {
			throw new Error("an Agent cannot be sent empty text");
		}
		const entry = this.#entries.get(agentId);
		if (entry) {
			entry.texts.push(text);
			return;
		}
		this.#entries.set(agentId, {
			texts: [text],
			idleRounds: 0,
			lastFailure: undefined,
		});
	}

	/**
	 * This round's reading, and the text that is now due — if any.
	 *
	 * Called once per Agent per reconcile round with the status that round
	 * settled on. Returns the text the caller should send; the caller then says
	 * whether it went, because only the caller knows.
	 */
	due(agentId: string, status: AgentStatus): string | undefined {
		const entry = this.#entries.get(agentId);
		if (entry === undefined) return undefined;
		if (status !== "idle") {
			// Any reading that is not idle restarts the count. The Agent has to
			// be *continuously* idle, not idle as often as not.
			entry.idleRounds = 0;
			return undefined;
		}
		entry.idleRounds += 1;
		if (entry.idleRounds < IDLE_ROUNDS_BEFORE_SEND) return undefined;
		return entry.texts[0];
	}

	/** The text went. Drop it, and clear the last failure it may have had. */
	sent(agentId: string): void {
		const entry = this.#entries.get(agentId);
		if (entry === undefined) return;
		entry.texts.shift();
		entry.lastFailure = undefined;
		// The next text does not follow immediately: the Agent has just been
		// given something to do, so it has to be seen idle again on its own.
		entry.idleRounds = 0;
		if (entry.texts.length === 0) this.#entries.delete(agentId);
	}

	/**
	 * The send failed. The text stays queued and the reason is kept.
	 *
	 * Not dropped: a failure to deliver is not a delivery, and a queue that
	 * quietly discarded what it could not send would leave a person waiting for
	 * something that will never arrive with nothing to read about it.
	 */
	failed(agentId: string, reason: string): void {
		const entry = this.#entries.get(agentId);
		if (entry === undefined) return;
		entry.lastFailure = reason;
		entry.idleRounds = 0;
	}

	/** What this Agent's queue is doing, for the row to show. */
	state(agentId: string, status: AgentStatus): InjectionState {
		const entry = this.#entries.get(agentId);
		if (entry === undefined || entry.texts.length === 0) return NOTHING;
		return {
			queued: entry.texts.length,
			waitingFor: waitFor(status, entry.idleRounds),
			lastFailure: entry.lastFailure,
		};
	}

	/**
	 * An Agent that ended, and whatever it was never told.
	 *
	 * The undelivered texts come back rather than being dropped, because the
	 * session going away is the one failure the queue cannot retry: there is no
	 * longer anything to send to. The caller is the only place that can still
	 * say so where a person will see it.
	 */
	forget(agentId: string): readonly string[] {
		const entry = this.#entries.get(agentId);
		this.#entries.delete(agentId);
		return entry?.texts ?? [];
	}
}

function waitFor(status: AgentStatus, idleRounds: number): InjectionWait {
	switch (status) {
		case "idle":
			return { kind: "settling", rounds: idleRounds };
		case "working":
			return { kind: "agent_busy" };
		case "waiting":
			return { kind: "agent_asking" };
		default:
			return { kind: "agent_unreadable" };
	}
}
