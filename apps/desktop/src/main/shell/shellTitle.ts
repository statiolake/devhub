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
 * **The Editor's part comes from the Neovim on screen.** It is the name of
 * the buffer the Workspace's shown Neovim has in front
 * (`NeovimEditors.bufferName`), so the editor reports the element and DevHub
 * says the rest.
 *
 * **The Agent's part comes from the reconciler.** It is the same word the
 * sidebar row shows, read once in `main/agent/activity.ts` and read from the
 * model here, so a row and a title can never disagree about what an Agent is
 * doing. Which of that and its name leads is `agentLeadingText`, for the same
 * reason.
 *
 * **The Orchestrator's part comes from its page, by id.** The screen reports
 * which task or file its left pane shows (`reportOrchestratorView`) and
 * main reads the task's title and Workspace off its own store, so the
 * title is the time spent on the project the task is about:
 *
 *     {workspace} · {subject} — Orchestrator — DevHub
 *     {file name} — Orchestrator — DevHub
 *     Orchestrator — DevHub
 *
 * **Wherever a Workspace is named, its Issue is named with it.** A time
 * tracker that reads the title attributes the time to whatever it can see,
 * and the folder is not always enough — two worktrees of one repository can
 * be two Issues, and one folder moves between Issues as its branch does. So
 * the Workspace part is the Workspace's name and then what it is working on
 * (`workReference`), in that one place in every title that names one:
 *
 *     {element} — {workspace} #123 — DevHub
 *     {element} — {workspace} acme/plan#123 — DevHub     the Issue is elsewhere
 *     {element} — {workspace} PR #130 — DevHub           a pull request, no Issue
 *     {workspace} #123 · {subject} — Orchestrator — DevHub
 *
 * It is what the Sidebar's row knows (`WorkspaceRepositoryWire`, the branch's
 * Issue and pull request), read off the same projection, so a row and a title
 * can never disagree about which Issue a Workspace is on — and the title moves
 * when the branch does, because the projection does.
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
import type {
	OrchestratorViewWire,
	WorkspaceRepositoryWire,
} from "../../ipc/contract.js";

/** Everything the title is a function of. */
export interface ShellTitleFacts {
	readonly selection: NavigationSelection;
	readonly workspaces: readonly WorkspaceSnapshot[];
	/** The buffer the Neovim on screen has in front, if there is one. */
	readonly editorElement: string | undefined;
	/** The Orchestrator row's Workspace (`AppSnapshot.orchestratorWorkspaceId`). */
	readonly orchestratorWorkspaceId?: string | undefined;
	/**
	 * What the Orchestrator screen's left pane shows, resolved by main; absent
	 * is the board.
	 */
	readonly orchestratorView?: OrchestratorTitleView | undefined;
	/**
	 * What each Workspace is working on, as the Sidebar's rows have it
	 * (`RepositoryStatusWire.workspaces`). A Workspace with no row here is one
	 * with no Issue known, and is named as that.
	 */
	readonly repositories?: readonly WorkspaceRepositoryWire[] | undefined;
}

/** What the Orchestrator screen shows, as far as its title is concerned. */
export type OrchestratorTitleView =
	| { readonly kind: "board" }
	| {
			readonly kind: "task";
			/** The task's title — its subject, never its questions. */
			readonly subject: string;
			/** The agents bound to it, in order; the first one's Workspace counts. */
			readonly agentIds: readonly string[];
	  }
	| { readonly kind: "file"; readonly path: string };

/** How long a subject or a file name may run in the title, in characters. */
export const TITLE_TEXT_LIMIT = 80;

/** Between the Workspace a task is about and its subject. */
export const SUBJECT_SEPARATOR = " · ";

/**
 * What a pull request's number is written after, so that it can never be
 * read as an Issue's: GitHub numbers the two in one sequence and writes both
 * `#130`, and a tracker that files time under `#130` has to know which it was.
 */
export const PULL_REQUEST_PREFIX = "PR ";

/**
 * What the Workspace is working on, as a reference to put beside its name:
 * the Issue its branch names (`#123`), or — on a branch with a pull request
 * and no Issue — the pull request (`PR #130`). Nothing when neither is known,
 * including while the Issue is still being read: the title says only what
 * the Sidebar's row says.
 *
 * The number is bare in the Workspace's own repository, and written as
 * `owner/repo#123` when it is numbered in another — an upstream's, in a fork
 * — the case the Sidebar's tooltip says as _Issue in `owner/name`_.
 */
export function workReference(
	row: WorkspaceRepositoryWire | undefined,
): string | undefined {
	if (row === undefined) return undefined;
	if (row.issue !== undefined) {
		return `${repositoryElsewhere(row, row.issue.url)}#${String(row.issue.number)}`;
	}
	if (row.pullRequest !== undefined) {
		return `${PULL_REQUEST_PREFIX}${repositoryElsewhere(row, row.pullRequest.url)}#${String(row.pullRequest.number)}`;
	}
	return undefined;
}

/**
 * `owner/repo` for a number not numbered in the checkout's own repository,
 * and the empty string for one that is. Where it lives is what its own URL
 * says — an upstream's in a fork, the new repository of one that was
 * transferred — and `issueRepository` when the URL is not a github.com one;
 * what is "own" is `origin`'s page. With either unknown there is nothing to
 * tell it apart from, and the number is left bare.
 */
function repositoryElsewhere(
	row: WorkspaceRepositoryWire,
	url: string,
): string {
	const named = row.issueRepository;
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//u.exec(url);
	const where =
		match === null
			? named === undefined
				? undefined
				: `${named.owner}/${named.repository}`
			: `${match[1] ?? ""}/${match[2] ?? ""}`;
	const own = row.repositoryUrl?.replace(/^https:\/\//u, "");
	if (where === undefined || own === undefined) return "";
	return own.toLowerCase() === `github.com/${where}`.toLowerCase() ? "" : where;
}

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
 * The title's parts for one moment of the model.
 *
 * The selection decides which of the two elements is the one being looked at.
 * An Agent is selected *as an Agent* whether it takes the whole content area or
 * sits beside the editor, so the split arrangement is not a third case: the
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
				workspace: workspaceName(
					facts,
					requireWorkspace(facts, context.workspaceId),
				),
			};
		case "agent": {
			const found = findAgent(facts, context.agentId);
			return {
				// What the row leads with (`agentLeadingText`): what it is
				// doing, or the name a person gave it. An Agent that has said
				// nothing is still an Agent you are looking at, and its name is
				// the most specific true thing there is to say about the window.
				element: agentLeadingText(found.agent),
				workspace: workspaceName(facts, found.workspace),
			};
		}
		case "orchestrator": {
			const own = facts.workspaces.find(
				(one) => one.id === facts.orchestratorWorkspaceId,
			);
			return {
				element: orchestratorElement(facts),
				workspace:
					own === undefined ? ORCHESTRATOR_NAME : workspaceName(facts, own),
			};
		}
	}
}

/**
 * A Workspace as a title names it: its label, then what it is working on
 * (`workReference`) when that is known — the one placement for every title.
 */
function workspaceName(
	facts: ShellTitleFacts,
	workspace: WorkspaceSnapshot,
): string {
	const reference = workReference(
		facts.repositories?.find((row) => row.workspaceId === workspace.id),
	);
	return reference === undefined
		? workspace.label
		: `${workspace.label} ${reference}`;
}

/**
 * The Orchestrator screen's element: the task being read — after the
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
		case "task": {
			const subject = titleText(view.subject);
			const found = taskWorkspace(facts, view);
			const workspace =
				found === undefined ? undefined : workspaceName(facts, found);
			const parts = [workspace, subject].filter(
				(part): part is string => part !== undefined && part !== "",
			);
			return parts.length === 0 ? undefined : parts.join(SUBJECT_SEPARATOR);
		}
	}
}

/**
 * The one Workspace a task is about: the first of its agents' that is open.
 * The Orchestrator's own is not one — the title already names it.
 */
function taskWorkspace(
	facts: ShellTitleFacts,
	view: Extract<OrchestratorTitleView, { kind: "task" }>,
): WorkspaceSnapshot | undefined {
	const found = view.agentIds
		.map((id) =>
			facts.workspaces.find((one) =>
				one.agents.some((agent) => agent.id === id),
			),
		)
		.find((one) => one !== undefined);
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
		case "task":
			return typeof view["id"] === "number" && Number.isInteger(view["id"])
				? { kind: "task", id: view["id"] }
				: undefined;
		case "file":
			return typeof view["path"] === "string" && view["path"] !== ""
				? { kind: "file", path: view["path"] }
				: undefined;
		default:
			return undefined;
	}
}
