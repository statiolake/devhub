/**
 * What the one window is called, at every moment.
 *
 * People watch window titles. Some do it by hand and some have a tool doing it
 * for them, and either way a title is the only handle anything outside DevHub
 * has on what is being worked on inside it. A window called "DevHub" for eight
 * hours says a day was spent, and nothing about on what.
 *
 * So the title always carries two things — the word "DevHub" and the name of
 * the Workspace — and puts in front of them whatever is more specific than the
 * Workspace right now: the file the Editor is showing, or what the selected
 * Agent says it is doing. `shellWindowTitle` in `ipc/windowTitles.ts` is that
 * rule; this file is where the facts it needs are collected.
 *
 * **The Editor's part comes from the workbench itself.** VS Code writes its
 * window title into its page's `document.title`
 * (`browser/parts/titlebar/windowTitle.ts`), which for a `WebContentsView`
 * reaches main as `page-title-updated` and reaches nothing else — a view has no
 * window of its own to rename. DevHub narrows what that string says by
 * contributing `window.title` as `${dirty}${activeEditorShort}` from the Bridge
 * extension, so the workbench reports the element and DevHub says the rest;
 * without that the Workspace's name would appear twice in one title.
 *
 * **The Agent's part comes from the reconciler.** It is the same word the
 * sidebar row shows, read once in `main/agent/activity.ts` and read from the
 * model here, so a row and a title can never disagree about what an Agent is
 * doing.
 */

import type {
	AgentSnapshot,
	NavigationSelection,
	WorkspaceSnapshot,
} from "../../model/appModel.js";
import {
	SCRATCH_NAME,
	shellWindowTitle,
	type ShellTitleParts,
} from "../../ipc/windowTitles.js";

/** Everything the title is a function of. */
export interface ShellTitleFacts {
	readonly selection: NavigationSelection;
	readonly workspaces: readonly WorkspaceSnapshot[];
	/**
	 * What the workbench on screen calls itself, already reduced to an element.
	 * `editorElement` is what reduces it.
	 */
	readonly editorElement: string | undefined;
}

/**
 * The workbench's own title, as an element — or nothing, when it has none.
 *
 * With `window.title` contributed as `${dirty}${activeEditorShort}`, a
 * workbench with an editor open reports that editor and a workbench with none
 * reports an empty string. Upstream does not leave the empty string alone: it
 * substitutes the product's own long name, so that a window with nothing open
 * is still called something by the OS. That substitution is the one case here,
 * and the product name is passed in rather than spelled out — it is the same
 * value the workbench read out of the same `product.json`, so the two cannot
 * drift.
 *
 * A workbench naming the product is a workbench saying it has nothing to show,
 * and DevHub already has a name for the window; repeating the application's
 * name inside its own title would say nothing twice.
 */
export function editorElement(
	reported: string | undefined,
	productName: string,
): string | undefined {
	const title = reported?.trim();
	if (title === undefined || title === "") return undefined;
	return title === productName.trim() ? undefined : title;
}

/**
 * The title's parts for one moment of the model.
 *
 * The selection decides which of the two elements is the one being looked at.
 * An Agent is selected *as an Agent* whether it takes the whole content area or
 * sits beside the workbench, so the split arrangement is not a third case: the
 * thing you selected is the thing you are working in.
 */
export function shellTitleFor(facts: ShellTitleFacts): string {
	return shellWindowTitle(titleParts(facts));
}

function titleParts(facts: ShellTitleFacts): ShellTitleParts {
	const context = facts.selection.context;
	switch (context.kind) {
		case "global":
			// Scratch is a Workspace as far as a title is concerned: it is where
			// the work is happening, and it has a name.
			return { element: facts.editorElement, workspace: SCRATCH_NAME };
		case "workspace":
			return {
				element: facts.editorElement,
				workspace: requireWorkspace(facts, context.workspaceId).label,
			};
		case "agent": {
			const found = findAgent(facts, context.agentId);
			return {
				// An Agent that has said nothing is still an Agent you are
				// looking at, and its name is the most specific true thing
				// there is to say about the window.
				element: found.agent.activity ?? found.agent.displayName,
				workspace: found.workspace.label,
			};
		}
	}
}

function requireWorkspace(
	facts: ShellTitleFacts,
	workspaceId: string,
): WorkspaceSnapshot {
	const workspace = facts.workspaces.find((one) => one.id === workspaceId);
	// The selection is the model's own, and the model does not allow a
	// selection of something it does not have. A title that guessed here would
	// hide a broken selection behind a plausible window name.
	if (!workspace) {
		throw new Error("the selected workspace is not in the model");
	}
	return workspace;
}

function findAgent(
	facts: ShellTitleFacts,
	agentId: string,
): { readonly workspace: WorkspaceSnapshot; readonly agent: AgentSnapshot } {
	for (const workspace of facts.workspaces) {
		for (const agent of workspace.agents) {
			if (agent.id === agentId) return { workspace, agent };
		}
	}
	throw new Error("the selected agent is not in the model");
}
