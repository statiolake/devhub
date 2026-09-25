/**
 * Main's root boundary, which is what makes `void somePromise()` honest.
 *
 * There are twenty-two of those in main. Before this, each one's rejection
 * ended at Node's `unhandledRejection` warning — stderr in a packaged app,
 * which is a file nobody opens — and the app carried on as though the thing
 * had been done. The alternative to a root is a `.catch(report)` at every one
 * of them: the same sentence twenty-two times, twenty-two places to write it
 * slightly differently.
 */

import { describe, expect, it, vi } from "vitest";
import { errorWireAt, TypedFailure } from "../../model/wire.js";
import { installMainFailureRoot } from "./mainFailureRoot.js";

function processWithListeners() {
	const listeners = new Map<string, Set<(reason: unknown) => void>>();
	return {
		emit(event: string, reason: unknown) {
			for (const listener of listeners.get(event) ?? []) listener(reason);
		},
		listenerCount(event: string) {
			return listeners.get(event)?.size ?? 0;
		},
		on: ((event: string, listener: (reason: unknown) => void) => {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
		}) as unknown as NodeJS.Process["on"],
		off: ((event: string, listener: (reason: unknown) => void) => {
			listeners.get(event)?.delete(listener);
		}) as unknown as NodeJS.Process["off"],
	};
}

describe("a rejection nothing caught", () => {
	it("is raised where every other app-scoped failure is raised", () => {
		const raiseUnhandled = vi.fn();
		const host = processWithListeners();
		installMainFailureRoot({ raiseUnhandled }, host.on, host.off);

		const reason = new Error("the state file could not be written");
		host.emit("unhandledRejection", reason);

		expect(raiseUnhandled).toHaveBeenCalledWith(reason);
	});

	it("is still raised the tenth time, because nothing here de-duplicates", () => {
		const raiseUnhandled = vi.fn();
		const host = processWithListeners();
		installMainFailureRoot({ raiseUnhandled }, host.on, host.off);

		for (let i = 0; i < 10; i += 1) {
			host.emit("unhandledRejection", new Error("boom"));
		}

		expect(raiseUnhandled).toHaveBeenCalledTimes(10);
	});
});

describe("a rejection main already drew", () => {
	// A refusal main drew and handed to the request marked as drawn, which
	// nobody then awaited. Raising it here would draw it a second time.
	it("is not raised again", () => {
		const raiseUnhandled = vi.fn();
		const host = processWithListeners();
		installMainFailureRoot({ raiseUnhandled }, host.on, host.off);

		host.emit(
			"unhandledRejection",
			new TypedFailure({
				...errorWireAt("agent_profile_unavailable"),
				reported: true,
			}),
		);

		expect(raiseUnhandled).not.toHaveBeenCalled();
	});
});

describe("an exception nothing caught", () => {
	it("is left alone, so the process still stops for it", () => {
		// Taking `uncaughtException` would mean carrying on after an assumption
		// failed, which is the thing this whole change exists to stop. A
		// rejection is different only because nothing stops for one today
		// either: reporting it adds what a person can see without changing what
		// the process does.
		const host = processWithListeners();
		installMainFailureRoot({ raiseUnhandled: vi.fn() }, host.on, host.off);

		expect(host.listenerCount("uncaughtException")).toBe(0);
	});
});

describe("taking the root off again", () => {
	it("leaves the process as it found it", () => {
		const host = processWithListeners();
		const remove = installMainFailureRoot(
			{ raiseUnhandled: vi.fn() },
			host.on,
			host.off,
		);

		remove();

		expect(host.listenerCount("unhandledRejection")).toBe(0);
	});
});

describe("a cancellation nothing caught", () => {
	it("is not raised: somebody asked for it", () => {
		// Measured at launch: VS Code's `RequestStore` cancels each pty-host
		// request's timeout token when the reply arrives, and the cancellation
		// reaches a promise that is already settled. Ten of those came up as
		// "the native app shell is unavailable" at every launch.
		const raiseUnhandled = vi.fn();
		const host = processWithListeners();
		installMainFailureRoot({ raiseUnhandled }, host.on, host.off);

		const canceled = new Error("Canceled");
		canceled.name = "Canceled";
		host.emit("unhandledRejection", canceled);

		const cancelError = new Error("");
		cancelError.name = "CanceledError";
		host.emit("unhandledRejection", cancelError);

		expect(raiseUnhandled).not.toHaveBeenCalled();
	});

	it("is not what an error that merely mentions cancelling is", () => {
		// The name is the test, not the words. A failure whose message happens
		// to say "cancelled" is still a failure, and it still has to be seen.
		const raiseUnhandled = vi.fn();
		const host = processWithListeners();
		installMainFailureRoot({ raiseUnhandled }, host.on, host.off);

		const failure = new Error("the clone was cancelled by the server");
		host.emit("unhandledRejection", failure);
		expect(raiseUnhandled).toHaveBeenCalledWith(failure);
	});
});
