/**
 * What a close confirmation says about a Workspace's unsaved editors.
 *
 * The facts come from three places — the model's Workspace state, DevHub's
 * folder-to-view binding, and the workbench's own `CodeWindow` — and the rule
 * that turns them into one answer is here, on its own, because it is the part
 * that has to be right and the part that can be read.
 *
 * A workbench that is up is asked which working copies it holds modified, by
 * name (`workbenchUnsaved.ts`). What it pushes on its own —
 * `setDocumentEdited`, a boolean — could say "there are unsaved changes" but
 * not which, and the confirmation names them.
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

import {
	unsavedEditors,
	type UnsavedEditorsInspection,
} from "../../model/domain.js";
import { TypedFailure } from "../../model/wire.js";
import type { CloseDiagnosticWire } from "../../ipc/appShell.js";

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

/**
 * What the close confirmation says about a workbench's unsaved editors.
 *
 * A running workbench is asked for the names (`readUnsavedEditors`), and only
 * a running one: every other state either cannot hold unsaved work or cannot
 * answer. A workbench that was asked and did not answer is `unknown` with
 * the reason it gave — the confirmation says it could not tell, and the close
 * that follows discards whatever there is. It is never read as clean.
 */
export async function editorInspection(
	runtime: EditorRuntimeState,
	readUnsaved: () => Promise<readonly string[]>,
): Promise<UnsavedEditorsInspection> {
	switch (runtime) {
		case "absent":
		case "gone":
			// There is no process. Nothing is unsaved in it, so nothing stands in
			// the way of the close.
			return { kind: "clean" };
		case "starting":
			return { kind: "unknown", diagnostic: "close_editor_starting" };
		case "running": {
			let tabs: readonly string[];
			try {
				tabs = await readUnsaved();
			} catch (error) {
				// Recovered by asking: the sheet shows this, with the workbench's
				// own reason, in place of the names.
				if (!(error instanceof TypedFailure)) throw error;
				return {
					kind: "unknown",
					diagnostic: "close_editor_unresponsive",
					reason: error.wire.summary,
				};
			}
			return unsavedEditors(tabs);
		}
	}
}

/**
 * The close's `editor` step: carry out the answer about unsaved work, then
 * let the workbench go.
 *
 * The question was asked once, before anything happened — in the close
 * confirmation, from `editorInspection` — so this step asks nothing. What is
 * unsaved is discarded *first*, because `unload` is where VS Code raises its
 * own "do you want to save?" when anything is still modified, and that dialog,
 * raised here, was a second question in the middle of an answered close: the
 * close waited on it, ran out its deadline, and left the dialog standing.
 *
 * A veto after the discard is still an answer — an extension, a running task
 * — and stops the close with nothing destroyed. Answers with the diagnostic
 * that stopped the close, or nothing when the workbench has gone.
 */
export async function closeEditor(
	runtime: EditorRuntimeState,
	workbench: {
		readonly discardUnsaved: () => Promise<void>;
		readonly unload: () => Promise<boolean>;
	},
): Promise<CloseDiagnosticWire | undefined> {
	switch (runtime) {
		case "absent":
		case "gone":
			// No process holds work anybody could save, so there is nothing to
			// discard and nothing in the way.
			return undefined;
		case "starting":
			// It cannot answer, and DevHub does not guess about a workbench a
			// person may be watching load. Said now rather than waited out,
			// because the answer would not change.
			return "close_editor_starting";
		case "running":
			await workbench.discardUnsaved();
			return (await workbench.unload()) ? "close_editor_vetoed" : undefined;
	}
}
