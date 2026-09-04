/**
 * The gate in front of an Agent's keyboard.
 *
 * Every case here is a way of typing into a pane at the wrong moment, which is
 * the only way this feature can do harm: the text itself is whatever a caller
 * built, and the queue's whole job is choosing the instant.
 */

import { describe, expect, it } from "vitest";
import {
	AgentInjectionQueue,
	IDLE_READINGS_BEFORE_SEND,
	IDLE_SETTLE_MS,
} from "./injection.js";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

/**
 * A message somebody has already agreed to.
 *
 * Most of the cases below are about the *screen*, and were written before a
 * message had a second wait in front of it. They still say exactly what they
 * said: an intent that is already confirmed is what those tests always had.
 */
function confirmed(text: string, id = "intent-1") {
	return { id, text, state: "confirmed" as const };
}

/** A message composed but not yet read by anybody. */
function underReview(text: string, id = "intent-1") {
	return { id, text, state: "pending-review" as const };
}

/**
 * Reconcile rounds on a clock the test controls, at the real cadence.
 *
 * The clock is explicit because the rule is about time. A test that leaned on
 * the real one would either sleep for whole seconds or pass for the wrong
 * reason on a slow machine.
 */
class Rounds {
	now = 1_000_000;
	constructor(readonly queue: AgentInjectionQueue) {}
	step(
		status: Parameters<AgentInjectionQueue["due"]>[1],
		count = 1,
		everyMs = 300,
	): (string | undefined)[] {
		return Array.from({ length: count }, () => {
			this.now += everyMs;
			return this.queue.due(AGENT, status, this.now);
		});
	}
}

/** Enough rounds at the real cadence to cover the settle window. */
const ENOUGH = Math.ceil(IDLE_SETTLE_MS / 300) + 1;

describe("the Agent injection queue", () => {
	it("sends nothing until the prompt has been idle for a whole second", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, confirmed("do the thing"));
		const seen = rounds.step("idle", ENOUGH);
		const sentAt = seen.findIndex((one) => one !== undefined);
		expect(seen[sentAt]).toBe("do the thing");
		// Nothing went out before the window had actually elapsed.
		expect((sentAt + 1) * 300).toBeGreaterThanOrEqual(IDLE_SETTLE_MS);
	});

	/**
	 * Why this is a clock and not a count of rounds: a CLI that is starting up
	 * flickers through screens, and a burst of quick frames must never add up
	 * to a prompt that is free.
	 */
	it("is not satisfied by readings that arrive faster than the window", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, confirmed("do the thing"));
		expect(
			new Rounds(queue).step("idle", 20, 10).every((o) => o === undefined),
		).toBe(true);
	});

	/**
	 * And not by a clock that ran while nobody was looking. If the rounds stop
	 * — the app is suspended, a capture hangs — and one idle frame arrives long
	 * after the last, that is one reading, not a second of watching.
	 */
	it("is not satisfied by a single reading long after the last", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, confirmed("do the thing"));
		expect(new Rounds(queue).step("idle", 1, 60_000).at(-1)).toBeUndefined();
		expect(IDLE_READINGS_BEFORE_SEND).toBeGreaterThan(1);
	});

	it("never types into a turn that is running", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, confirmed("do the thing"));
		expect(
			new Rounds(queue).step("working", 30).every((o) => o === undefined),
		).toBe(true);
	});

	/**
	 * The sharpest case. That screen is a menu: free text does not answer it,
	 * and the first character may be taken as the answer — which is how an
	 * instruction meant for the Agent becomes a reply to "trust this folder?".
	 */
	it("never types into an Agent that has stopped to ask a question", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, confirmed("do the thing"));
		expect(
			new Rounds(queue).step("waiting", 30).every((o) => o === undefined),
		).toBe(true);
	});

	it("never types into a screen it cannot read", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, confirmed("do the thing"));
		expect(
			new Rounds(queue).step("unknown", 30).every((o) => o === undefined),
		).toBe(true);
	});

	it("starts the wait again when the Agent stops being idle", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, confirmed("do the thing"));
		rounds.step("idle", ENOUGH - 1);
		rounds.step("working");
		// The window restarts here, so the next idle round is not enough.
		expect(rounds.step("idle").at(-1)).toBeUndefined();
		expect(rounds.step("idle", ENOUGH).some((o) => o !== undefined)).toBe(true);
	});

	it("sends one text once, and not again", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, confirmed("do the thing"));
		rounds.step("idle", ENOUGH);
		queue.sent(AGENT);
		expect(rounds.step("idle", 30).every((o) => o === undefined)).toBe(true);
	});

	/** The Agent has just been given work; it must be seen settled again. */
	it("makes a second text wait for its own settled prompt", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, confirmed("first", "one"));
		queue.queue(AGENT, confirmed("second", "two"));
		rounds.step("idle", ENOUGH);
		queue.sent(AGENT);
		expect(rounds.step("idle").at(-1)).toBeUndefined();
		expect(rounds.step("idle", ENOUGH).some((o) => o === "second")).toBe(true);
	});

	it("keeps text that failed to send, with the reason, and tries again", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, confirmed("do the thing"));
		rounds.step("idle", ENOUGH);
		queue.failed(AGENT, "the session went away");
		expect(queue.state(AGENT, "idle").lastResult).toEqual({
			kind: "failed",
			reason: "the session went away",
		});
		expect(queue.state(AGENT, "idle").queued).toBe(1);
		expect(rounds.step("idle", ENOUGH).some((o) => o === "do the thing")).toBe(
			true,
		);
	});

	it("says why it is holding text, in the Agent's own terms", () => {
		const queue = new AgentInjectionQueue();
		expect(queue.state(AGENT, "idle").waitingFor).toBe("nothing_queued");
		queue.queue(AGENT, confirmed("do the thing"));
		expect(queue.state(AGENT, "working").waitingFor).toBe("agent_busy");
		expect(queue.state(AGENT, "waiting").waitingFor).toBe("agent_asking");
		expect(queue.state(AGENT, "unknown").waitingFor).toBe("agent_unreadable");
		expect(queue.state(AGENT, "idle").waitingFor).toBe("settling");
	});

	/** An ended Agent's undelivered text is handed back, never dropped quietly. */
	it("hands back what an Agent that ended was never told", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, confirmed("first", "one"));
		queue.queue(AGENT, confirmed("second", "two"));
		expect(queue.forget(AGENT).map((one) => one.text)).toEqual([
			"first",
			"second",
		]);
		expect(queue.state(AGENT, "idle").queued).toBe(0);
	});

	it("refuses empty text rather than queueing a bare Enter", () => {
		const queue = new AgentInjectionQueue();
		expect(() => queue.queue(AGENT, confirmed("   \n "))).toThrow();
	});

	/*
	 * The review gate. Everything above is about the Agent's screen; these are
	 * about whether DevHub is entitled to say the sentence at all, and the two
	 * are independent on purpose — which is why they are tested in both orders.
	 */

	it("never sends a message nobody has agreed to, however idle the prompt", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, underReview("implement the Issue"));
		expect(
			new Rounds(queue).step("idle", 30).every((one) => one === undefined),
		).toBe(true);
		expect(queue.state(AGENT, "idle").waitingFor).toBe("awaiting_review");
	});

	it("sends it once the prompt settles, when the wording was agreed first", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, underReview("draft"));
		queue.confirm(AGENT, "intent-1", "edited by hand");
		expect(
			rounds.step("idle", ENOUGH).some((one) => one === "edited by hand"),
		).toBe(true);
	});

	/**
	 * The other order, and the reason `due` counts the idle run before it looks
	 * at the intent: the Agent may have been sitting at a free prompt for the
	 * whole time the sheet was up, and that second of watching is not spent
	 * again once the person presses Send.
	 */
	it("sends on the next round when the prompt settled first", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, underReview("draft"));
		expect(rounds.step("idle", 30).every((one) => one === undefined)).toBe(
			true,
		);
		queue.confirm(AGENT, "intent-1", "edited by hand");
		expect(rounds.step("idle").at(-1)).toBe("edited by hand");
	});

	it("sends the wording that came back from the sheet, not the draft", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, underReview("the rendered template"));
		queue.confirm(AGENT, "intent-1", "what the person typed instead");
		expect(rounds.step("idle", ENOUGH).at(-1)).toBe(
			"what the person typed instead",
		);
	});

	it("refuses to confirm empty wording", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, underReview("draft"));
		expect(() => queue.confirm(AGENT, "intent-1", "  ")).toThrow();
	});

	/** Escape: the message goes, the Agent stays, and the fact is recorded. */
	it("drops a cancelled message and says it was cancelled", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, underReview("draft"));
		expect(queue.cancel(AGENT, "intent-1")).toBe(true);
		expect(queue.state(AGENT, "idle").queued).toBe(0);
		expect(queue.state(AGENT, "idle").lastResult).toEqual({
			kind: "cancelled",
		});
		expect(
			new Rounds(queue).step("idle", 30).every((one) => one === undefined),
		).toBe(true);
	});

	it("says a message went, which an empty queue on its own does not", () => {
		const queue = new AgentInjectionQueue();
		const rounds = new Rounds(queue);
		queue.queue(AGENT, confirmed("do the thing"));
		rounds.step("idle", ENOUGH);
		queue.sent(AGENT);
		expect(queue.state(AGENT, "idle").lastResult).toEqual({ kind: "sent" });
	});

	/** One thing at a time: a new message replaces what the last one came to. */
	it("clears the last outcome when something new is queued", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, underReview("draft"));
		queue.cancel(AGENT, "intent-1");
		queue.queue(AGENT, underReview("another", "intent-2"));
		expect(queue.state(AGENT, "idle").lastResult).toBeUndefined();
	});

	/**
	 * The Agent ended while its sheet stood. The intent comes back — including
	 * the one nobody had agreed to — because the sheet is the only place left
	 * that can say so.
	 */
	it("hands back a message that was still under review when the Agent ended", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, underReview("implement the Issue"));
		expect(queue.forget(AGENT)).toEqual([
			{ id: "intent-1", text: "implement the Issue", state: "pending-review" },
		]);
		expect(queue.confirm(AGENT, "intent-1", "too late")).toBe(false);
		expect(queue.cancel(AGENT, "intent-1")).toBe(false);
	});
});
