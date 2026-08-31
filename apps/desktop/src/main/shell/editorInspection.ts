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
 * This used to answer `unknown` for *every* live view, on the grounds that
 * nothing could ask one — which is why "Unsaved editors: Could not verify
 * editor state" appeared on every close of a workspace whose editor had never
 * been touched. There are now three answers and each one means what it says.
 */

import type { ResourceInspection } from "../../model/domain.js";

/** Everything the rule below looks at, and all it looks at. */
export interface EditorInspectionFacts {
	/** The workbench has already agreed to close, which is what clean means. */
	readonly editorAgreedToClose: boolean;
	/** A workbench view is bound to this Workspace's folder. */
	readonly hasView: boolean;
	/**
	 * The workbench finished loading and is still running: it is in a state to
	 * have reported its unsaved work. False while it is between loads, and
	 * false once its contents have crashed or gone.
	 */
	readonly workbenchIsRunning: boolean;
	/** What the running workbench last reported about its unsaved work. */
	readonly documentEdited: boolean;
}

export function editorInspection(
	facts: EditorInspectionFacts,
): ResourceInspection {
	// Agreeing to close *is* being clean, and it is a better answer than
	// looking at whether a view object still exists.
	if (facts.editorAgreedToClose) return { kind: "clean" };
	// A Workspace whose editor was never opened holds nothing.
	if (!facts.hasView) return { kind: "clean" };
	// There is a workbench, but nobody can be asked and nobody is guessing.
	if (!facts.workbenchIsRunning) {
		return { kind: "unknown", diagnostic: "close_editor_unknown" };
	}
	// `close_editor_vetoed` is the definite one: the workbench said so. It is
	// carried as `unknown` because the count of unsaved files is not something
	// main is told — only that there is unsaved work — and the confirmation
	// draws it as the sentence "The editor has unsaved changes".
	return facts.documentEdited
		? { kind: "unknown", diagnostic: "close_editor_vetoed" }
		: { kind: "clean" };
}
