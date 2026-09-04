/**
 * What a close confirmation says about a Workspace's unsaved editors.
 *
 * The facts come from three places — the model's Workspace state, DevHub's
 * folder-to-view binding, and the workbench's own `CodeWindow` — and the rule
 * that turns them into one answer is here, on its own, because it is the part
 * that has to be right and the part that can be read.
 *
 * The answer main can read is the one VS Code's renderer pushes: every time a
 * working copy changes dirty, `workbench/electron-browser/window.ts` calls
 * `nativeHostService.setDocumentEdited`, which lands on the view's
 * `CodeWindow`, which is `WorkbenchView.setDocumentEdited`. A workbench that
 * is up has therefore already said whether it holds unsaved work, and there is
 * nothing left to ask it.
 *
 * The state below is the whole of the question. It used to be a pair of
 * booleans — "there is a view" and "the workbench is running" — and every way
 * of not being running collapsed into one answer, `close_editor_unknown`,
 * whose sentence is "the editor is not running". So a workspace whose view had
 * been destroyed but whose binding was still in the map, and a workbench that
 * was still coming up, both blocked the close with a sentence that was false
 * in front of a visible editor. There is no such thing as "not running" here
 * any more: there are four states and each one decides for itself.
 */

import type { ResourceInspection } from "../../model/domain.js";

/**
 * Where this Workspace's workbench actually is.
 *
 * The distinction the close policy turns on is not "running or not" but
 * "could this hold unsaved work a person would want back".
 */
export type EditorRuntimeState =
	/**
	 * No workbench: never started, or its view is gone from the window. A
	 * process that does not exist holds nothing, so there is nothing to lose.
	 */
	| "absent"
	/**
	 * A workbench whose contents crashed or were destroyed. Whatever it held
	 * went with the renderer; nothing here can save it and nothing can ask it.
	 */
	| "gone"
	/**
	 * A workbench that exists but has not finished its ready handshake — first
	 * load, or a navigation. It has not opened anything yet, so it cannot have
	 * unsaved work, but it also cannot answer, and DevHub does not guess about
	 * a workbench a person may be watching come up.
	 */
	| "starting"
	/** Up, answering, and has already said what it holds. */
	| "running";

/**
 * As much of a `CodeWindow` as deciding its state needs.
 *
 * Structural on purpose: the rule is about a handshake and a `WebContents`,
 * not about VS Code's window class, and stating only what it reads is what
 * lets the rule be tested without a window.
 */
export interface EditorWindowFacts {
	readonly isReady: boolean;
	readonly win: {
		readonly webContents: {
			isDestroyed(): boolean;
			isCrashed(): boolean;
		};
	} | null;
}

/**
 * Where a workbench is, read from the one window that would know.
 *
 * The single place the four states are decided, so the close inspection and
 * the close itself cannot disagree about what a workbench is doing.
 *
 * `isReady` is the workbench's own handshake: true from the moment the
 * workbench signalled it had come up, false again while it navigates. Contents
 * that crashed or were destroyed cannot answer whatever the handshake said,
 * and that is a different thing from still coming up — one has lost whatever
 * it held, the other has not opened anything yet.
 */
export function editorRuntimeState(
	codeWindow: EditorWindowFacts | undefined,
): EditorRuntimeState {
	if (!codeWindow) return "absent";
	const contents = codeWindow.win?.webContents;
	if (!contents || contents.isDestroyed() || contents.isCrashed()) {
		return "gone";
	}
	return codeWindow.isReady ? "running" : "starting";
}

/** Everything the rule below looks at, and all it looks at. */
export interface EditorInspectionFacts {
	/** The workbench has already agreed to close, which is what clean means. */
	readonly editorAgreedToClose: boolean;
	/** Where the workbench is. */
	readonly runtime: EditorRuntimeState;
	/** What the running workbench last reported about its unsaved work. */
	readonly documentEdited: boolean;
}

export function editorInspection(
	facts: EditorInspectionFacts,
): ResourceInspection {
	// Agreeing to close *is* being clean, and it is a better answer than
	// looking at whether a view object still exists.
	if (facts.editorAgreedToClose) return { kind: "clean" };
	switch (facts.runtime) {
		case "absent":
		case "gone":
			// There is no process. Nothing is unsaved in it, so nothing stands in
			// the way of the close.
			return { kind: "clean" };
		case "starting":
			return { kind: "unknown", diagnostic: "close_editor_starting" };
		case "running":
			// `close_editor_vetoed` is the definite one: the workbench said so. It
			// is carried as `unknown` because the count of unsaved files is not
			// something main is told — only that there is unsaved work — and the
			// confirmation draws it as "The editor has unsaved changes".
			return facts.documentEdited
				? { kind: "unknown", diagnostic: "close_editor_vetoed" }
				: { kind: "clean" };
	}
}
