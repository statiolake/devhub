/**
 * What DevHub means to say to an Agent, and when it is safe to say it.
 *
 * **An intent, not a string.** What is queued is not text but a *decision to
 * say something*, and that decision has a life: it is composed from a template,
 * it may still be under the person's eye in the review sheet, and only once
 * they have confirmed the wording is it something DevHub is entitled to type.
 * So an intent is `pending-review` or `confirmed`, and the idle gate below acts
 * on `confirmed` intents only. The two waits are independent and either may
 * finish first — a person who confirms while the Agent is still booting has
 * their text go the moment the prompt settles, and a prompt that settled
 * minutes ago sends on the round after the sheet is confirmed.
 *
 * There is one state machine here and not a flag per caller. A caller that
 * could choose "send this one without asking" by taking a different code path
 * would be a second description of the same act; what a caller may vary is only
 * the state an intent *starts* in, which is a setting (`confirm_before_send`)
 * and not a branch.
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
	type AgentInjectionResult,
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

/** One thing DevHub means to say, and how far along saying it is. */
export interface AgentInjectionIntent {
	/** Names this intent for the sheet that is reviewing it. */
	readonly id: string;
	/** The wording as it stands: rendered from the template, then edited. */
	readonly text: string;
	/**
	 * `pending-review` is a sentence nobody has agreed to yet.
	 *
	 * It is not sent, however idle the Agent gets. Confirming is the only thing
	 * that moves it on, and cancelling is the only thing that removes it —
	 * there is no timeout, because a sheet that gave up on its own would send
	 * nothing and say nothing.
	 */
	readonly state: "pending-review" | "confirmed";
}

interface Entry {
	readonly intents: AgentInjectionIntent[];
	/** When the current unbroken run of idle readings began. */
	idleSince: number | undefined;
	/** How many idle readings that run contains. */
	idleReadings: number;
	/**
	 * What became of the last intent that stopped being queued.
	 *
	 * Kept so a row can say it. The rule for when it goes is the same wherever
	 * it came from — it is replaced by the next thing that happens to this
	 * Agent's queue, and cleared when something new is queued — so no caller has
	 * to choose whether its own failure is the kind that lingers.
	 */
	lastResult: AgentInjectionResult | undefined;
}

export class AgentInjectionQueue {
	readonly #entries = new Map<string, Entry>();

	/**
	 * Hold an intent for an Agent until it is both agreed and deliverable.
	 *
	 * Empty text is refused rather than queued. A caller that computed an empty
	 * instruction has a bug, and sending a bare Enter into an Agent's prompt is
	 * not a harmless version of doing nothing.
	 *
	 * Queueing clears whatever the last one came to. A row that still said
	 * "cancelled" while a fresh sentence waited behind it would be describing
	 * the wrong intent.
	 */
	queue(agentId: string, intent: AgentInjectionIntent): void {
		if (intent.text.trim().length === 0) {
			throw new Error("an Agent cannot be sent empty text");
		}
		const entry = this.#entry(agentId);
		entry.intents.push(intent);
		entry.lastResult = undefined;
	}

	/**
	 * The person has read the wording — this is what they settled on.
	 *
	 * The text comes back with the confirmation rather than being read from the
	 * sheet's own copy, because the sheet is where it was edited. Confirming
	 * does not send: it removes the only reason `due` was refusing to.
	 */
	confirm(agentId: string, intentId: string, text: string): boolean {
		if (text.trim().length === 0) {
			throw new Error("an Agent cannot be sent empty text");
		}
		const entry = this.#entries.get(agentId);
		const index = entry?.intents.findIndex((one) => one.id === intentId) ?? -1;
		if (entry === undefined || index === -1) return false;
		entry.intents[index] = { id: intentId, text, state: "confirmed" };
		return true;
	}

	/**
	 * The person closed the sheet without agreeing. Nothing is sent.
	 *
	 * The Agent stays exactly as it is — it was started for a reason and that
	 * reason has not gone away — and the cancellation is *recorded*, because an
	 * intent that vanished with no trace is indistinguishable from one still
	 * waiting for a prompt that never comes.
	 */
	cancel(agentId: string, intentId: string): boolean {
		const entry = this.#entries.get(agentId);
		const index = entry?.intents.findIndex((one) => one.id === intentId) ?? -1;
		if (entry === undefined || index === -1) return false;
		entry.intents.splice(index, 1);
		entry.lastResult = { kind: "cancelled" };
		return true;
	}

	/** The intent under review for this Agent, if one is. */
	pending(agentId: string, intentId: string): AgentInjectionIntent | undefined {
		return this.#entries
			.get(agentId)
			?.intents.find((one) => one.id === intentId);
	}

	/**
	 * This round's reading, and the text that is now due — if any.
	 *
	 * Called once per Agent per reconcile round with the status that round
	 * settled on. Returns the text the caller should send; the caller then says
	 * whether it went, because only the caller knows.
	 *
	 * The idle run is counted before the head intent's state is looked at, and
	 * that ordering is the whole of "either wait may finish first": the screen's
	 * settle is a fact about the screen, true whether or not anybody has agreed
	 * to a sentence yet, so an Agent that sat idle through the whole review
	 * sends on the very next round after the sheet is confirmed.
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
		const head = entry.intents[0];
		if (head === undefined || head.state !== "confirmed") return undefined;
		return head.text;
	}

	/** The text went. Drop the intent and say so. */
	sent(agentId: string): void {
		const entry = this.#entries.get(agentId);
		if (entry === undefined) return;
		entry.intents.shift();
		entry.lastResult = { kind: "sent" };
		// The next text does not follow immediately: the Agent has just been
		// given something to do, so it has to be seen idle again on its own,
		// for the whole settle window.
		entry.idleSince = undefined;
		entry.idleReadings = 0;
	}

	/**
	 * The send failed. The intent stays queued and the reason is kept.
	 *
	 * Not dropped: a failure to deliver is not a delivery, and a queue that
	 * quietly discarded what it could not send would leave a person waiting for
	 * something that will never arrive with nothing to read about it.
	 */
	failed(agentId: string, reason: string): void {
		const entry = this.#entries.get(agentId);
		if (entry === undefined) return;
		entry.lastResult = { kind: "failed", reason };
		entry.idleSince = undefined;
		entry.idleReadings = 0;
	}

	/** What this Agent's queue is doing, for the row to show. */
	state(agentId: string, status: AgentStatus): AgentInjection {
		const entry = this.#entries.get(agentId);
		if (entry === undefined) return NO_INJECTION;
		const head = entry.intents[0];
		return {
			queued: entry.intents.length,
			waitingFor:
				head === undefined
					? "nothing_queued"
					: head.state === "pending-review"
						? "awaiting_review"
						: waitFor(status),
			lastResult: entry.lastResult,
		};
	}

	/**
	 * An Agent that ended, and whatever it was never told.
	 *
	 * The undelivered intents come back rather than being dropped, because the
	 * session going away is the one failure the queue cannot retry: there is no
	 * longer anything to send to. The caller is the only place that can still
	 * say so where a person will see it.
	 */
	forget(agentId: string): readonly AgentInjectionIntent[] {
		const entry = this.#entries.get(agentId);
		this.#entries.delete(agentId);
		return entry?.intents ?? [];
	}

	#entry(agentId: string): Entry {
		const existing = this.#entries.get(agentId);
		if (existing) return existing;
		const created: Entry = {
			intents: [],
			idleSince: undefined,
			idleReadings: 0,
			lastResult: undefined,
		};
		this.#entries.set(agentId, created);
		return created;
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
