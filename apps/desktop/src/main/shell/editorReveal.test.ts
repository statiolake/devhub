/**
 * The three states a requested workbench can be in, and the one that is a bug.
 *
 * The launch failure this exists to stop: the page restores its selection and
 * asks for the Editor while the eager open for that folder is still running.
 * That is an ordinary start, and it was reported as a broken invariant on the
 * failure surface. Reading "not built yet" as "gone" is the whole mistake, so
 * the two are asserted apart here.
 */

import { describe, expect, it } from "vitest";
import { editorReveal } from "./editorReveal.js";

describe("what to do when the page asks for the native surface", () => {
	it("does nothing more once the workbench is on screen", () => {
		expect(editorReveal({ revealed: true, opening: false })).toBe("on-screen");
		expect(editorReveal({ revealed: true, opening: true })).toBe("on-screen");
	});

	it("waits for a workbench that is still being built", () => {
		expect(editorReveal({ revealed: false, opening: true })).toBe("coming");
	});

	it("calls a workbench that is neither here nor coming what it is", () => {
		// The invariant stays loud: a view that died leaves nothing opening, and
		// that has to reach the page rather than become a blank pane.
		expect(editorReveal({ revealed: false, opening: false })).toBe("absent");
	});
});
