/**
 * The gate in front of an Agent's keyboard.
 *
 * Every case here is a way of typing into a pane at the wrong moment, which is
 * the only way this feature can do harm: the text itself is whatever a caller
 * built, and the queue's whole job is choosing the instant.
 */

import { describe, expect, it } from "vitest";
import { AgentInjectionQueue, IDLE_ROUNDS_BEFORE_SEND } from "./injection.js";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

/** Run `rounds` reconcile rounds at one status, returning what came due. */
function rounds(
	queue: AgentInjectionQueue,
	status: Parameters<AgentInjectionQueue["due"]>[1],
	count: number,
): (string | undefined)[] {
	return Array.from({ length: count }, () => queue.due(AGENT, status));
}

describe("the Agent injection queue", () => {
	it("sends nothing until the prompt has been idle for several rounds", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "do the thing");
		const seen = rounds(queue, "idle", IDLE_ROUNDS_BEFORE_SEND);
		expect(seen.slice(0, -1).every((one) => one === undefined)).toBe(true);
		expect(seen.at(-1)).toBe("do the thing");
	});

	it("never types into a turn that is running", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "do the thing");
		expect(rounds(queue, "working", 20).every((o) => o === undefined)).toBe(
			true,
		);
	});

	/**
	 * The sharpest case. That screen is a menu: free text does not answer it,
	 * and the first character may be taken as the answer.
	 */
	it("never types into an Agent that has stopped to ask a question", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "do the thing");
		expect(rounds(queue, "waiting", 20).every((o) => o === undefined)).toBe(
			true,
		);
	});

	it("never types into a screen it cannot read", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "do the thing");
		expect(rounds(queue, "unknown", 20).every((o) => o === undefined)).toBe(
			true,
		);
	});

	/** Idle has to be continuous. A flicker mid-turn is not a free prompt. */
	it("starts the count again when the Agent stops being idle", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "do the thing");
		rounds(queue, "idle", IDLE_ROUNDS_BEFORE_SEND - 1);
		expect(queue.due(AGENT, "working")).toBeUndefined();
		const seen = rounds(queue, "idle", IDLE_ROUNDS_BEFORE_SEND);
		expect(seen.slice(0, -1).every((one) => one === undefined)).toBe(true);
		expect(seen.at(-1)).toBe("do the thing");
	});

	it("sends one text once, and not again", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "do the thing");
		rounds(queue, "idle", IDLE_ROUNDS_BEFORE_SEND);
		queue.sent(AGENT);
		expect(rounds(queue, "idle", 20).every((o) => o === undefined)).toBe(true);
	});

	/** The Agent has just been given work; it must be seen idle again on its own. */
	it("makes a second text wait for its own settled prompt", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "first");
		queue.queue(AGENT, "second");
		rounds(queue, "idle", IDLE_ROUNDS_BEFORE_SEND);
		queue.sent(AGENT);
		const seen = rounds(queue, "idle", IDLE_ROUNDS_BEFORE_SEND);
		expect(seen.slice(0, -1).every((one) => one === undefined)).toBe(true);
		expect(seen.at(-1)).toBe("second");
	});

	it("keeps text that failed to send, with the reason, and tries again", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "do the thing");
		rounds(queue, "idle", IDLE_ROUNDS_BEFORE_SEND);
		queue.failed(AGENT, "the session went away");
		expect(queue.state(AGENT, "idle").lastFailure).toBe(
			"the session went away",
		);
		expect(queue.state(AGENT, "idle").queued).toBe(1);
		expect(rounds(queue, "idle", IDLE_ROUNDS_BEFORE_SEND).at(-1)).toBe(
			"do the thing",
		);
	});

	it("says why it is holding text, in the Agent's own terms", () => {
		const queue = new AgentInjectionQueue();
		expect(queue.state(AGENT, "idle").waitingFor.kind).toBe("nothing_queued");
		queue.queue(AGENT, "do the thing");
		expect(queue.state(AGENT, "working").waitingFor.kind).toBe("agent_busy");
		expect(queue.state(AGENT, "waiting").waitingFor.kind).toBe("agent_asking");
		expect(queue.state(AGENT, "unknown").waitingFor.kind).toBe(
			"agent_unreadable",
		);
		expect(queue.state(AGENT, "idle").waitingFor.kind).toBe("settling");
	});

	/** An ended Agent's undelivered text is handed back, never dropped quietly. */
	it("hands back what an Agent that ended was never told", () => {
		const queue = new AgentInjectionQueue();
		queue.queue(AGENT, "first");
		queue.queue(AGENT, "second");
		expect(queue.forget(AGENT)).toEqual(["first", "second"]);
		expect(queue.state(AGENT, "idle").queued).toBe(0);
	});

	it("refuses empty text rather than queueing a bare Enter", () => {
		const queue = new AgentInjectionQueue();
		expect(() => queue.queue(AGENT, "   \n ")).toThrow();
	});
});
