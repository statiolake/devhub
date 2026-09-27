import { afterEach, describe, expect, it, vi } from "vitest";
import { InvariantViolation } from "../../model/invariant.js";
import { StaleCompletion, operationId } from "../../model/intents.js";
import { namedFailureAt } from "../../model/wire.js";
import { crash, isInvariantViolation } from "./invariant.js";

describe("what counts as DevHub's own bug", () => {
	it("is a stated invariant and nothing else", () => {
		expect(isInvariantViolation(new InvariantViolation("wiring"))).toBe(true);
		// A fact about the world is news for the person, not a crash: it has a
		// subject, a surface and something to do about it.
		expect(isInvariantViolation(new Error("tmux would not answer"))).toBe(
			false,
		);
		// Nor is a refusal DevHub names for the person, or a completion that
		// something newer settled first.
		expect(isInvariantViolation(namedFailureAt("workspace_closing"))).toBe(
			false,
		);
		expect(
			isInvariantViolation(
				new StaleCompletion(
					operationId("00000000-0000-4000-8000-000000000001"),
				),
			),
		).toBe(false);
		expect(isInvariantViolation(undefined)).toBe(false);
	});
});

describe("crashing on one", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("throws where nothing in DevHub can catch it", () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const violation = new InvariantViolation("the adapter was not wired");

		// The call itself returns: every caller is inside a `catch` that was
		// about to keep going, so handing the error back would be handing it to
		// the code that swallows it.
		expect(() => {
			crash(violation);
		}).not.toThrow();

		// It comes back out of a timer, which is an `uncaughtException`.
		expect(() => {
			vi.runAllTimers();
		}).toThrow(violation);
	});

	it("says what broke, with the stack, before it goes", () => {
		vi.useFakeTimers();
		const logged = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		crash(new InvariantViolation("an operation nobody started was completed"));

		expect(logged).toHaveBeenCalledTimes(1);
		expect(String(logged.mock.calls[0]?.[1])).toContain(
			"an operation nobody started was completed",
		);
		expect(() => {
			vi.runAllTimers();
		}).toThrow();
	});
});
