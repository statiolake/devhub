import { describe, expect, it } from "vitest";

import {
	closeEditor,
	editorInspection,
	editorRuntimeState,
	type EditorWindowFacts,
} from "./editorInspection.js";
import { errorWireAt, TypedFailure, withSummary } from "../../model/wire.js";

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

/** A reader that must not be called: the state alone decides. */
const notAsked = (): Promise<readonly string[]> => {
	throw new Error("a workbench in this state must not be asked");
};

const answers = (names: readonly string[]) => (): Promise<readonly string[]> =>
	Promise.resolve(names);

describe("the unsaved-editor inspection", () => {
	it("says clean for a running workbench with nothing modified", async () => {
		// The reported bug: this answered "could not verify" for every live
		// view, so closing an untouched workspace always raised a confirmation.
		expect(await editorInspection("running", answers([]))).toEqual({
			kind: "clean",
		});
	});

	it("names the unsaved tabs a running workbench holds", async () => {
		expect(
			await editorInspection("running", answers(["main.ts", "Untitled-1"])),
		).toEqual({ kind: "unsaved", tabs: ["main.ts", "Untitled-1"] });
	});

	it("says it could not tell, with the reason, when the workbench does not answer", async () => {
		// Never clean: a close would throw the work away without having said so.
		const refused = (): Promise<readonly string[]> =>
			Promise.reject(
				new TypedFailure(
					withSummary(
						errorWireAt("workspace_unavailable"),
						"The editor did not answer within 5 seconds.",
					),
				),
			);
		expect(await editorInspection("running", refused)).toEqual({
			kind: "unknown",
			diagnostic: "close_editor_unresponsive",
			reason: "The editor did not answer within 5 seconds.",
		});
	});

	it("lets a broken rule through rather than calling it unknown", async () => {
		const broken = (): Promise<readonly string[]> =>
			Promise.reject(new Error("the reply had no names"));
		await expect(editorInspection("running", broken)).rejects.toThrow(
			"the reply had no names",
		);
	});

	it("says clean for a workspace whose editor was never opened", async () => {
		expect(await editorInspection("absent", notAsked)).toEqual({
			kind: "clean",
		});
	});

	it("says clean for a workbench whose contents are gone", async () => {
		// Crashed or destroyed. There is nothing unsaved in a renderer that no
		// longer exists, so nothing stands in the way of the close — and a
		// workspace whose editor died must not become one nobody can close.
		expect(await editorInspection("gone", notAsked)).toEqual({
			kind: "clean",
		});
	});

	it("could not verify only while the workbench is still starting", async () => {
		// The one state where somebody exists to ask and cannot answer yet. It
		// no longer claims the editor is "not running", because a workbench
		// that is coming up is not the same thing as one that never did.
		expect(await editorInspection("starting", notAsked)).toEqual({
			kind: "unknown",
			diagnostic: "close_editor_starting",
		});
	});
});

/**
 * A workbench as the close sees it. `unload` behaves as VS Code's does: with
 * anything still modified it raises the save dialog and waits for somebody to
 * answer it — which, during a close, nobody does.
 */
function workbench(modified: readonly string[]) {
	const state = { modified: [...modified], unloaded: false };
	return {
		state,
		discardUnsaved: (): Promise<void> => {
			state.modified = [];
			return Promise.resolve();
		},
		unload: (): Promise<boolean> => {
			if (state.modified.length > 0) return new Promise<boolean>(() => {});
			state.unloaded = true;
			return Promise.resolve(false);
		},
	};
}

/** Whether a promise has settled after everything already queued has run. */
async function settledSoon<T>(promise: Promise<T>): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => (settled = true),
		() => (settled = true),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return settled;
}

describe("the close's editor step", () => {
	it("finishes on a workbench with unsaved editors instead of waiting on its save dialog", async () => {
		// The reported hang: the person confirmed the close, the step unloaded
		// the workbench, VS Code asked "do you want to save?" a second time,
		// and the close sat on that question until its deadline.
		const editor = workbench(["main.ts", "Untitled-1"]);
		const step = closeEditor("running", editor);
		expect(await settledSoon(step)).toBe(true);
		expect(await step).toBeUndefined();
		expect(editor.state).toEqual({ modified: [], unloaded: true });
	});

	it("stops the close, with nothing unloaded, when the discard fails", async () => {
		const editor = workbench(["main.ts"]);
		const failing = {
			...editor,
			discardUnsaved: () =>
				Promise.reject(
					new Error("Unsaved changes in main.ts could not be discarded."),
				),
		};
		await expect(closeEditor("running", failing)).rejects.toThrow(
			"main.ts could not be discarded",
		);
		expect(editor.state.unloaded).toBe(false);
	});

	it("reports a veto that comes after the discard", async () => {
		expect(
			await closeEditor("running", {
				discardUnsaved: () => Promise.resolve(),
				unload: () => Promise.resolve(true),
			}),
		).toBe("close_editor_vetoed");
	});

	it("asks nothing of a workbench that is not there, and refuses one still starting", async () => {
		const untouched = {
			discardUnsaved: () => Promise.reject(new Error("must not be asked")),
			unload: () => Promise.reject(new Error("must not be asked")),
		};
		expect(await closeEditor("absent", untouched)).toBeUndefined();
		expect(await closeEditor("gone", untouched)).toBeUndefined();
		expect(await closeEditor("starting", untouched)).toBe(
			"close_editor_starting",
		);
	});
});
