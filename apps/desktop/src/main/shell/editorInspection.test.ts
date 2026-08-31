import { describe, expect, it } from "vitest";

import {
	editorInspection,
	type EditorInspectionFacts,
} from "./editorInspection.js";

/** A running workbench with nothing unsaved: the ordinary case. */
const RUNNING: EditorInspectionFacts = {
	editorAgreedToClose: false,
	hasView: true,
	workbenchIsRunning: true,
	documentEdited: false,
};

describe("the unsaved-editor inspection", () => {
	it("says clean for a workbench that reports no unsaved work", () => {
		// The reported bug: this answered "could not verify" for every live
		// view, so closing an untouched workspace always raised a confirmation.
		expect(editorInspection(RUNNING)).toEqual({ kind: "clean" });
	});

	it("says clean for a workspace whose editor was never opened", () => {
		expect(editorInspection({ ...RUNNING, hasView: false })).toEqual({
			kind: "clean",
		});
	});

	it("says clean once the workbench has agreed to close", () => {
		// Agreeing is what being clean means; whether a view object still
		// exists is not the question.
		expect(
			editorInspection({
				...RUNNING,
				editorAgreedToClose: true,
				documentEdited: true,
				workbenchIsRunning: false,
			}),
		).toEqual({ kind: "clean" });
	});

	it("names the unsaved work when the workbench reports it", () => {
		expect(editorInspection({ ...RUNNING, documentEdited: true })).toEqual({
			kind: "unknown",
			diagnostic: "close_editor_vetoed",
		});
	});

	it("could not verify only when the workbench is not running", () => {
		// Crashed, or between loads. This is the one case where nobody can be
		// asked — and the only one that may say so.
		expect(editorInspection({ ...RUNNING, workbenchIsRunning: false })).toEqual(
			{ kind: "unknown", diagnostic: "close_editor_unknown" },
		);
		expect(
			editorInspection({
				...RUNNING,
				workbenchIsRunning: false,
				documentEdited: true,
			}),
		).toEqual({ kind: "unknown", diagnostic: "close_editor_unknown" });
	});
});
