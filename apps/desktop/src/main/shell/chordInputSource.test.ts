import { describe, expect, it } from "vitest";

import { ChordInputSource, type InputSourcePort } from "./chordInputSource.js";

const JAPANESE = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese";
const ABC = "com.apple.keylayout.ABC";

/** macOS's input source, as far as the port lets DevHub see it. */
class FakeInputSource implements InputSourcePort {
	readonly log: string[] = [];
	failure: Error | undefined;

	constructor(public current: string) {}

	selectAscii(): Promise<void> {
		this.log.push("ascii");
		if (this.failure) return Promise.reject(this.failure);
		this.current = ABC;
		return Promise.resolve();
	}
}

/** Let the requests made so far be answered. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("the input source when a chord arms", () => {
	function world() {
		const port = new FakeInputSource(JAPANESE);
		const reported: unknown[] = [];
		const source = new ChordInputSource(port, (failure) =>
			reported.push(failure),
		);
		return { port, reported, source };
	}

	it("selects an ASCII-capable source when the chord arms", async () => {
		const { port, source, reported } = world();
		source.armed();
		await settle();
		expect(port.current).toBe(ABC);
		expect(reported).toEqual([]);
	});

	it("puts nothing back afterwards: there is no restore to ask for", async () => {
		const { port, source } = world();
		source.armed();
		await settle();
		source.armed();
		await settle();
		// Only selects, never a request for the source it switched from.
		expect(port.log).toEqual(["ascii", "ascii"]);
		expect(port.current).toBe(ABC);
	});

	it("says a failure once, and asks nothing more of the port", async () => {
		const { port, source, reported } = world();
		port.failure = new Error("the helper is not there");
		source.armed();
		await settle();
		source.armed();
		await settle();
		expect(reported).toEqual([port.failure]);
		expect(port.log).toEqual(["ascii"]);
	});
});
