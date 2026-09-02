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

import {
	NO_INJECTION,
	type AgentInjection,
	type AgentInjectionWait,
	type AgentStatus,
} from "../../model/domain.js";

/**
 * How long a prompt must have been continuously idle before anything is sent.
 *
 * A clock rather than a count of rounds. The reconcile cadence is an
 * implementation detail that has changed before, and "three readings" means a
 * different amount of patience at 300ms than at 50ms — but what the Agent
 * needs is *time*: a CLI that is starting up flickers through screens, and a
 * prompt that has looked free for a full second is one that is actually free
 * rather than one caught between two frames.
 */
export const IDLE_SETTLE_MS = 1_000;

/**
 * And it has to have been *watched* for that second, not merely dated.
 *
 * Elapsed time alone is a reading about the clock, not about the Agent. If the
 * rounds stop — the app is suspended, the machine sleeps, a capture hangs —
 * and one idle frame arrives ten seconds after the last one, the wall clock
 * says "idle for ten seconds" about nine seconds nobody looked at. So the
 * settle window must also contain at least two observations, which is what
 * makes "continuously idle" a statement about the screen.
 */
export const IDLE_READINGS_BEFORE_SEND = 2;

/*
 * The shape a row reads — `AgentInjection` in `model/domain.ts` — is the one
 * this returns. There is no second vocabulary for the same fact here: a queue
 * state that had to be translated on the way out would be two descriptions of
 * one thing, and one of them would drift.
 */

interface Entry {
	readonly texts: string[];
	/** When the current unbroken run of idle readings began. */
	idleSince: number | undefined;
	/** How many idle readings that run contains. */
	idleReadings: number;
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
			idleSince: undefined,
			idleReadings: 0,
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
	due(
		agentId: string,
		status: AgentStatus,
		now: number = Date.now(),
	): string | undefined {
		const entry = this.#entries.get(agentId);
		if (entry === undefined) return undefined;
		if (status !== "idle") {
			// Any reading that is not idle starts the wait over. The Agent has
			// to be *continuously* idle, not idle as often as not.
			entry.idleSince = undefined;
			entry.idleReadings = 0;
			return undefined;
		}
		entry.idleSince ??= now;
		entry.idleReadings += 1;
		if (entry.idleReadings < IDLE_READINGS_BEFORE_SEND) return undefined;
		if (now - entry.idleSince < IDLE_SETTLE_MS) return undefined;
		return entry.texts[0];
	}

	/** The text went. Drop it, and clear the last failure it may have had. */
	sent(agentId: string): void {
		const entry = this.#entries.get(agentId);
		if (entry === undefined) return;
		entry.texts.shift();
		entry.lastFailure = undefined;
		// The next text does not follow immediately: the Agent has just been
		// given something to do, so it has to be seen idle again on its own,
		// for the whole settle window.
		entry.idleSince = undefined;
		entry.idleReadings = 0;
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
		entry.idleSince = undefined;
		entry.idleReadings = 0;
	}

	/** What this Agent's queue is doing, for the row to show. */
	state(agentId: string, status: AgentStatus): AgentInjection {
		const entry = this.#entries.get(agentId);
		if (entry === undefined || entry.texts.length === 0) return NO_INJECTION;
		return {
			queued: entry.texts.length,
			waitingFor: waitFor(status),
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

function waitFor(status: AgentStatus): AgentInjectionWait {
	switch (status) {
		case "idle":
			return "settling";
		case "working":
			return "agent_busy";
		case "waiting":
			return "agent_asking";
		default:
			return "agent_unreadable";
	}
}
