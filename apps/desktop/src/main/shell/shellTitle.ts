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
 * Agent says it is doing — or its name, if somebody gave it one. `shellWindowTitle` in `ipc/windowTitles.ts` is that
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
 * doing. Which of that and its name leads is `agentLeadingText`, for the same
 * reason.
 *
 * **The Orchestrator's part comes from its page, by id.** The screen reports
 * which escalation or file its left pane shows (`reportOrchestratorView`) and
 * main reads the escalation's subject and Workspace off its own store, so the
 * title is the time spent on the project the escalation is about:
 *
 *     {workspace} · {subject} — Orchestrator — DevHub
 *     {file name} — Orchestrator — DevHub
 *     Orchestrator — DevHub
 *
 * Only titles and names: never what anyone wrote in a thread.
 */

import type {
	AgentSnapshot,
	NavigationSelection,
	WorkspaceSnapshot,
} from "../../model/appModel.js";
import {
	ORCHESTRATOR_NAME,
	shellWindowTitle,
	type ShellTitleParts,
} from "../../ipc/windowTitles.js";
import { agentLeadingText } from "../../model/domain.js";
import type { OrchestratorViewWire } from "../../ipc/contract.js";

/** Everything the title is a function of. */
export interface ShellTitleFacts {
	readonly selection: NavigationSelection;
	readonly workspaces: readonly WorkspaceSnapshot[];
	/**
	 * What the workbench on screen calls itself, already reduced to an element.
	 * `editorElement` is what reduces it.
	 */
	readonly editorElement: string | undefined;
	/** The Orchestrator row's Workspace (`AppSnapshot.orchestratorWorkspaceId`). */
	readonly orchestratorWorkspaceId?: string | undefined;
	/**
	 * What the Orchestrator screen's left pane shows, resolved by main; absent
	 * is the board.
	 */
	readonly orchestratorView?: OrchestratorTitleView | undefined;
}

/** What the Orchestrator screen shows, as far as its title is concerned. */
export type OrchestratorTitleView =
	| { readonly kind: "board" }
	| {
			readonly kind: "escalation";
			/** The escalation's title — its subject, never its thread. */
			readonly subject: string;
			readonly workspaceId?: string | undefined;
			/** The agents it is about, in order; the first one's Workspace counts. */
			readonly agentIds: readonly string[];
	  }
	| { readonly kind: "file"; readonly path: string };

/** How long a subject or a file name may run in the title, in characters. */
export const TITLE_TEXT_LIMIT = 80;

/** Between the Workspace an escalation is about and its subject. */
export const SUBJECT_SEPARATOR = " · ";

/**
 * Text from elsewhere made fit for one line of a title: control characters
 * and line breaks become spaces, runs of space one, and anything past
 * `limit` characters is cut at a word where one is near, with an ellipsis.
 */
export function titleText(text: string, limit = TITLE_TEXT_LIMIT): string {
	// eslint-disable-next-line no-control-regex
	const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ");
	const one = flat.replace(/\s+/gu, " ").trim();
	const characters = Array.from(one);
	if (characters.length <= limit) return one;
	const cut = characters.slice(0, limit - 1).join("");
	const space = cut.lastIndexOf(" ");
	const head = space >= limit * 0.6 ? cut.slice(0, space) : cut;
	return `${head.trimEnd()}…`;
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
		case "workspace":
			return {
				element: facts.editorElement,
				workspace: requireWorkspace(facts, context.workspaceId).label,
			};
		case "agent": {
			const found = findAgent(facts, context.agentId);
			return {
				// What the row leads with (`agentLeadingText`): what it is
				// doing, or the name a person gave it. An Agent that has said
				// nothing is still an Agent you are looking at, and its name is
				// the most specific true thing there is to say about the window.
				element: agentLeadingText(found.agent),
				workspace: found.workspace.label,
			};
		}
		case "orchestrator":
			return {
				element: orchestratorElement(facts),
				workspace:
					facts.workspaces.find(
						(one) => one.id === facts.orchestratorWorkspaceId,
					)?.label ?? ORCHESTRATOR_NAME,
			};
	}
}

/**
 * The Orchestrator screen's element: the escalation being read — after the
 * Workspace it is about, so the time lands on that project — or the file
 * open in the Files tab. The board has none.
 */
function orchestratorElement(facts: ShellTitleFacts): string | undefined {
	const view = facts.orchestratorView;
	switch (view?.kind) {
		case undefined:
		case "board":
			return undefined;
		case "file": {
			const name = titleText(view.path.split("/").at(-1) ?? "");
			return name === "" ? undefined : name;
		}
		case "escalation": {
			const subject = titleText(view.subject);
			const workspace = escalationWorkspace(facts, view)?.label;
			const parts = [workspace, subject].filter(
				(part): part is string => part !== undefined && part !== "",
			);
			return parts.length === 0 ? undefined : parts.join(SUBJECT_SEPARATOR);
		}
	}
}

/**
 * The one Workspace an escalation is about: its own, else its first agent's.
 * The Orchestrator's own is not one — the title already names it.
 */
function escalationWorkspace(
	facts: ShellTitleFacts,
	view: Extract<OrchestratorTitleView, { kind: "escalation" }>,
): WorkspaceSnapshot | undefined {
	const own =
		view.workspaceId === undefined
			? undefined
			: facts.workspaces.find((one) => one.id === view.workspaceId);
	const first = view.agentIds[0];
	const found =
		own ??
		(first === undefined
			? undefined
			: facts.workspaces.find((one) =>
					one.agents.some((agent) => agent.id === first),
				));
	return found === undefined || found.id === facts.orchestratorWorkspaceId
		? undefined
		: found;
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

/** A page's `reportOrchestratorView`, checked; anything else is nothing. */
export function orchestratorViewWire(
	value: unknown,
): OrchestratorViewWire | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const view = value as Record<string, unknown>;
	switch (view["kind"]) {
		case "board":
			return { kind: "board" };
		case "escalation":
			return typeof view["id"] === "number" && Number.isInteger(view["id"])
				? { kind: "escalation", id: view["id"] }
				: undefined;
		case "file":
			return typeof view["path"] === "string" && view["path"] !== ""
				? { kind: "file", path: view["path"] }
				: undefined;
		default:
			return undefined;
	}
}
