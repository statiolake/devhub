/**
 * The bug this exists to stop: close a workspace whose workbench is still
 * starting, get refused, let the workbench come up and edit files in it, close
 * again — and the workbench was killed without ever being asked about the
 * unsaved work, because the refusal had left the "did not answer" mark behind.
 */

import { describe, expect, it } from "vitest";
import { type EditorCloseAsk, editorCloseStep } from "./editorCloseAsk.js";

describe("whether a workbench is asked before it is closed", () => {
	it("asks a running workbench that has never been asked", () => {
		expect(editorCloseStep({ runtime: "running", asked: "never-asked" })).toBe(
			"ask",
		);
	});

	it("asks again after an answer, because a veto is an answer", () => {
		expect(editorCloseStep({ runtime: "running", asked: "answered" })).toBe(
			"ask",
		);
	});

	it("stops asking a workbench that answered nothing", () => {
		expect(
			editorCloseStep({ runtime: "running", asked: "asked-and-silent" }),
		).toBe("close-without-asking");
	});

	it("has nothing to ask a workbench that is not there", () => {
		for (const asked of [
			"never-asked",
			"asked-and-silent",
			"answered",
		] as const) {
			expect(editorCloseStep({ runtime: "absent", asked })).toBe(
				"nothing-to-ask",
			);
			expect(editorCloseStep({ runtime: "gone", asked })).toBe(
				"nothing-to-ask",
			);
		}
	});

	it("refuses a workbench that is still coming up", () => {
		expect(editorCloseStep({ runtime: "starting", asked: "never-asked" })).toBe(
			"not-yet",
		);
	});

	it("starting → close → later close still asks", () => {
		// The sequence the tri-state exists for. A refusal writes nothing, so
		// the fact stays `never-asked` and the workbench gets its save prompt.
		let asked: EditorCloseAsk = "never-asked";
		const first = editorCloseStep({ runtime: "starting", asked });
		expect(first).toBe("not-yet");
		// `not-yet` is a refusal, and a refusal records no outcome.
		expect(asked).toBe("never-asked");

		const second = editorCloseStep({ runtime: "running", asked });
		expect(second).toBe("ask");

		// The ask marks silence, and the answer replaces it.
		asked = "asked-and-silent";
		asked = "answered";
		expect(editorCloseStep({ runtime: "running", asked })).toBe("ask");
	});
});
