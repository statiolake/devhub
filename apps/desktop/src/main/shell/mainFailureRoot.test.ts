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
