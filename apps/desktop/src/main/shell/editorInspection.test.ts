import { describe, expect, it } from "vitest";

import {
	editorInspection,
	editorRuntimeState,
	type EditorInspectionFacts,
	type EditorWindowFacts,
} from "./editorInspection.js";

function window(
	overrides: Partial<{
		isReady: boolean;
		destroyed: boolean;
		crashed: boolean;
		contents: boolean;
	}> = {},
): EditorWindowFacts {
	const {
		isReady = true,
		destroyed = false,
		crashed = false,
		contents = true,
	} = overrides;
	return {
		isReady,
		win: contents
			? {
					webContents: {
						isDestroyed: () => destroyed,
						isCrashed: () => crashed,
					},
				}
			: null,
	};
}

describe("where a workbench is", () => {
	it("is absent when the folder has no window", () => {
		// The binding from folder to view id outlives the view. Reading the map
		// alone reported "the editor is not running" for a workspace whose
		// editor had already gone.
		expect(editorRuntimeState(undefined)).toBe("absent");
	});

	it("is running once the workbench has answered its handshake", () => {
		expect(editorRuntimeState(window())).toBe("running");
	});

	it("is starting before the handshake, not stopped", () => {
		expect(editorRuntimeState(window({ isReady: false }))).toBe("starting");
	});

	it("is gone when the contents crashed or were destroyed", () => {
		expect(editorRuntimeState(window({ crashed: true }))).toBe("gone");
		expect(editorRuntimeState(window({ destroyed: true }))).toBe("gone");
		expect(editorRuntimeState(window({ contents: false }))).toBe("gone");
	});
});

/** A running workbench with nothing unsaved: the ordinary case. */
const RUNNING: EditorInspectionFacts = {
	editorAgreedToClose: false,
	runtime: "running",
	documentEdited: false,
};

describe("the unsaved-editor inspection", () => {
	it("says clean for a workbench that reports no unsaved work", () => {
		// The reported bug: this answered "could not verify" for every live
		// view, so closing an untouched workspace always raised a confirmation.
		expect(editorInspection(RUNNING)).toEqual({ kind: "clean" });
	});

	it("says clean for a workspace whose editor was never opened", () => {
		expect(editorInspection({ ...RUNNING, runtime: "absent" })).toEqual({
			kind: "clean",
		});
	});

	it("says clean for a workbench whose contents are gone", () => {
		// Crashed or destroyed. There is nothing unsaved in a renderer that no
		// longer exists, so nothing stands in the way of the close — and a
		// workspace whose editor died must not become one nobody can close.
		expect(
			editorInspection({ ...RUNNING, runtime: "gone", documentEdited: true }),
		).toEqual({ kind: "clean" });
	});

	it("says clean once the workbench has agreed to close", () => {
		// Agreeing is what being clean means; whether a view object still
		// exists is not the question.
		expect(
			editorInspection({
				...RUNNING,
				editorAgreedToClose: true,
				documentEdited: true,
				runtime: "starting",
			}),
		).toEqual({ kind: "clean" });
	});

	it("names the unsaved work when the workbench reports it", () => {
		expect(editorInspection({ ...RUNNING, documentEdited: true })).toEqual({
			kind: "unknown",
			diagnostic: "close_editor_vetoed",
		});
	});

	it("could not verify only while the workbench is still starting", () => {
		// The one state where somebody exists to ask and cannot answer yet. It
		// no longer claims the editor is "not running", because a workbench
		// that is coming up is not the same thing as one that never did.
		expect(editorInspection({ ...RUNNING, runtime: "starting" })).toEqual({
			kind: "unknown",
			diagnostic: "close_editor_starting",
		});
	});
});
