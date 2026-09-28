import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ChordInputSource,
	type InputSourcePort,
	type InputSourceSwitch,
} from "./chordInputSource.js";

const JAPANESE = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese";
const ABC = "com.apple.keylayout.ABC";
const OTHER = "com.apple.keylayout.US";

/**
 * macOS's input source, as far as the port lets DevHub see it: one current
 * source, and the two check-and-select steps the helper does as one.
 */
class FakeInputSource implements InputSourcePort {
	readonly log: string[] = [];
	failure: Error | undefined;

	constructor(public current: string) {}

	selectAscii(): Promise<InputSourceSwitch | undefined> {
		this.log.push("ascii");
		if (this.failure) return Promise.reject(this.failure);
		if (this.current === ABC || this.current === OTHER) {
			return Promise.resolve(undefined);
		}
		const change = { previous: this.current, selected: ABC };
		this.current = ABC;
		return Promise.resolve(change);
	}

	restore(change: InputSourceSwitch): Promise<"restored" | "kept"> {
		this.log.push(`restore ${change.previous}`);
		if (this.failure) return Promise.reject(this.failure);
		if (this.current !== change.selected) return Promise.resolve("kept");
		this.current = change.previous;
		return Promise.resolve("restored");
	}
}

/** Let every request the state machine has queued run to the end. */
async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

describe("the input source while a chord is armed", () => {
	let port: FakeInputSource;
	let reported: unknown[];
	let source: ChordInputSource;

	beforeEach(() => {
		vi.useFakeTimers();
		port = new FakeInputSource(JAPANESE);
		reported = [];
		source = new ChordInputSource(port, (failure) => reported.push(failure));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("selects an ASCII-capable source when the chord arms", async () => {
		source.armed(Date.now() + 1_000);
		await settle();
		expect(port.current).toBe(ABC);
	});

	/**
	 * Every exit is the router's `disarmed` — a chord run, a key that
	 * completed nothing, the table changing, DevHub left — and they all come
	 * here the same way, so one case stands for them. The deadline is the one
	 * no key announces, so it has its own.
	 */
	it("puts the previous source back when the chord is over", async () => {
		source.armed(Date.now() + 1_000);
		await settle();
		source.disarmed();
		await settle();
		expect(port.current).toBe(JAPANESE);
		expect(reported).toEqual([]);
	});

	it("puts it back when the second passes with no second key", async () => {
		source.armed(Date.now() + 1_000);
		await settle();
		await vi.advanceTimersByTimeAsync(999);
		expect(port.current).toBe(ABC);
		await vi.advanceTimersByTimeAsync(1);
		expect(port.current).toBe(JAPANESE);
	});

	it("does not restore twice when the router reports the lapse later", async () => {
		source.armed(Date.now() + 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		// The router notices a lapsed deadline only on the next key.
		source.disarmed();
		await settle();
		expect(port.log).toEqual(["ascii", `restore ${JAPANESE}`]);
	});

	it("does not fight a source the person chose while the chord was armed", async () => {
		source.armed(Date.now() + 1_000);
		await settle();
		port.current = OTHER;
		source.disarmed();
		await settle();
		expect(port.current).toBe(OTHER);
	});

	it("touches nothing when the source was ASCII-capable already", async () => {
		port.current = ABC;
		source.armed(Date.now() + 1_000);
		await settle();
		source.disarmed();
		await settle();
		expect(port.log).toEqual(["ascii"]);
		expect(port.current).toBe(ABC);
	});

	it("restores after the switch, even when the chord ends before it is answered", async () => {
		// No settling between the two: the switch is still on its way.
		source.armed(Date.now() + 1_000);
		source.disarmed();
		await settle();
		expect(port.log).toEqual(["ascii", `restore ${JAPANESE}`]);
		expect(port.current).toBe(JAPANESE);
	});

	it("keeps one chord's restore ahead of the next chord's switch", async () => {
		source.armed(Date.now() + 1_000);
		source.disarmed();
		source.armed(Date.now() + 1_000);
		await settle();
		expect(port.log).toEqual(["ascii", `restore ${JAPANESE}`, "ascii"]);
		expect(port.current).toBe(ABC);
		source.disarmed();
		await settle();
		expect(port.current).toBe(JAPANESE);
	});

	it("says a failure once, and asks nothing more of the port", async () => {
		port.failure = new Error("the helper is not there");
		source.armed(Date.now() + 1_000);
		await settle();
		source.disarmed();
		source.armed(Date.now() + 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(reported).toEqual([port.failure]);
		expect(port.log).toEqual(["ascii"]);
	});

	it("says a failed restore", async () => {
		source.armed(Date.now() + 1_000);
		await settle();
		port.failure = new Error("the helper stopped");
		source.disarmed();
		await settle();
		expect(reported).toEqual([port.failure]);
	});
});
