/**
 * `devhub --tell agent stop`, `agent restart` and `workspace close`: the
 * window's Stop Agent, Restart Session and Close Workspace, by the same
 * intents.
 *
 * The window asks first when the Agent is busy (`interruptsNothing`): the
 * coordinator answers `confirmation_required` and the window draws the sheet
 * for the person. A command line has already decided, so the confirmation is
 * given at once with the sheet's first choice, and nothing is drawn. What the
 * window does not offer (Stop on an Agent that is stopping, Restart on one
 * that is not running) is refused here, as the row and its menu leave it out;
 * the rest of the refusals are the coordinator's own (`agentRestart` and the
 * like), which reach the caller in its words.
 */

import {
	interruptsNothing,
	type AgentControlState,
	type AgentFailureCode,
	type AgentId,
	type AgentStatus,
	type CloseInspectionInputs,
	type ResourceInspection,
	type WorkspaceId,
} from "../../../model/domain.js";
import type {
	IntentOutcome,
	UserIntent,
	WorktreeDisposition,
} from "../../../model/intents.js";
import type {
	TellCloseAnswers,
	TellCloseQuestion,
	TellClosed,
	TellStopped,
} from "./service.js";

export interface ActedAgent {
	readonly id: AgentId;
	readonly displayName: string;
	readonly status: AgentStatus;
	readonly controlState: AgentControlState;
	readonly failure?: { readonly code: AgentFailureCode } | undefined;
}

export type Dispatch = (intent: UserIntent) => Promise<IntentOutcome>;

/** Stop Agent, or the row's Retry Stop after a Stop that failed. */
export async function stopAsTheRowDoes(
	agent: ActedAgent,
	dispatch: Dispatch,
): Promise<TellStopped> {
	if (agent.controlState.kind === "stopping")
		throw new Error(`${agent.displayName} is already stopping.`);
	const busy = !interruptsNothing(agent);
	if (agent.controlState.kind === "stop-failed") {
		await dispatch({ type: "retry_stop_agent", agentId: agent.id });
		return { busy, movedTerminal: false, retried: true };
	}
	const outcome = await dispatch({ type: "stop_agent", agentId: agent.id });
	if (outcome.kind !== "confirmation_required")
		return { busy, movedTerminal: false, retried: false };
	// The sheet's first choice for an open terminal keeps what runs in it.
	const terminal =
		outcome.purpose.kind === "agent_stop" && outcome.purpose.terminal;
	await dispatch({
		type: "confirm_stop_agent",
		confirmationId: outcome.confirmationId,
		...(terminal ? { moveTerminal: true } : {}),
	});
	return { busy, movedTerminal: terminal, retried: false };
}

/** Restart Session, which the row menu offers a running Agent only. */
export async function restartAsTheMenuDoes(
	agent: ActedAgent,
	dispatch: Dispatch,
): Promise<{ readonly busy: boolean }> {
	if (agent.controlState.kind !== "running")
		throw new Error(
			`${agent.displayName} is ${agent.controlState.kind === "stopping" ? "stopping" : "not running: its Stop failed"}, and only a running agent's session can be restarted.`,
		);
	const busy = !interruptsNothing(agent);
	const outcome = await dispatch({ type: "restart_agent", agentId: agent.id });
	if (outcome.kind === "confirmation_required")
		await dispatch({
			type: "confirm_restart_agent",
			confirmationId: outcome.confirmationId,
		});
	return { busy };
}

/** Why `workspace close` refuses the Orchestrator row's Workspace. */
export const ORCHESTRATOR_CANNOT_CLOSE =
	"The orchestrator's workspace cannot be closed: it is the Orchestrator row, and the window has no close for it. Set orchestrator.root to another folder (once the orchestrator has stopped) to make it an ordinary workspace.";

/** What `workspace close` needs to know about the Workspace before it asks. */
export interface ClosedWorkspace {
	readonly id: WorkspaceId;
	readonly label: string;
	readonly scratch: boolean;
	/** It is the Orchestrator row's Workspace, which has no close either. */
	readonly orchestrator?: boolean;
	/** A close of it is already running (the window refuses a second). */
	readonly closing: boolean;
	/**
	 * The folder a close deletes (`closingDeletesWorktree`), when it is a
	 * worktree; undefined for every other Workspace, whose folder stays.
	 */
	readonly worktree:
		| {
				readonly root: string;
				readonly branch: string | undefined;
				/** As of DevHub's last look; undefined: it could not tell. */
				readonly dirty: boolean | undefined;
		  }
		| undefined;
}

export interface CloseWindow {
	readonly dispatch: Dispatch;
	/** What the window's close would ask about now (`inspect`, the same reading). */
	inspect(): Promise<CloseInspectionInputs>;
	/** Once the close has settled: why the Workspace is still open, if it is. */
	failure(): string | undefined;
}

function inspected(resource: ResourceInspection): string | undefined {
	switch (resource.kind) {
		case "clean":
			return undefined;
		case "busy":
			return String(resource.count);
		case "unknown":
			return `could not tell (${resource.diagnostic}${resource.reason === undefined ? "" : `: ${resource.reason}`})`;
	}
}

/**
 * The window's questions for this close that the answers leave open, in the
 * order the window asks them: the folder first, then the close sheet's rows.
 */
export function openCloseQuestions(
	workspace: ClosedWorkspace,
	inspection: CloseInspectionInputs,
	answers: TellCloseAnswers,
): readonly TellCloseQuestion[] {
	const open: TellCloseQuestion[] = [];
	const tree = workspace.worktree;
	if (tree !== undefined && answers.worktree === undefined)
		open.push({
			flag: "--worktree",
			values: ["keep", "remove"],
			why: `${workspace.label} is a worktree: closing it removes ${tree.root}${tree.branch === undefined ? "" : ` (${tree.branch})`} unless kept; ${tree.dirty === true ? "it has uncommitted changes, and remove deletes them" : tree.dirty === false ? "it was clean at DevHub's last look" : "DevHub could not tell whether it has uncommitted changes, and remove deletes any"}`,
		});
	const agents = inspected(inspection.agents);
	if (agents !== undefined && answers.agents !== "stop")
		open.push({
			flag: "--agents",
			values: ["stop"],
			why: `agents that stopping would interrupt (working, waiting or in the background): ${agents}; closing stops them`,
		});
	const terminals = (
		[
			["processes", inspection.terminalProcesses],
			["panes", inspection.terminalPanes],
			["windows", inspection.terminalWindows],
		] as const
	).flatMap(([name, resource]) => {
		const said = inspected(resource);
		return said === undefined ? [] : [`${name} ${said}`];
	});
	if (terminals.length > 0 && answers.terminals !== "close")
		open.push({
			flag: "--terminals",
			values: ["close"],
			why: `the workspace's terminals are running something (${terminals.join(", ")}); closing ends them`,
		});
	const unsaved = inspection.unsavedEditors;
	if (unsaved.kind !== "clean" && !answers.discardUnsaved)
		open.push({
			flag: "--discard-unsaved",
			values: [],
			why:
				unsaved.kind === "unsaved"
					? `unsaved editors: ${unsaved.tabs.join(", ")}; closing discards their changes`
					: `DevHub could not read whether the editor has unsaved files (${unsaved.diagnostic}${unsaved.reason === undefined ? "" : `: ${unsaved.reason}`}); closing discards any`,
		});
	return open;
}

/** What the window's answer about the folder is, for the CLI's. */
function disposition(
	workspace: ClosedWorkspace,
	answer: TellCloseAnswers["worktree"],
): WorktreeDisposition {
	if (workspace.worktree === undefined || answer !== "remove") return "keep";
	// A clean one is what the window removes without asking (git still
	// refuses if that was a stale poll); otherwise it is the sheet's Delete the
	// worktree, which is the one answer that means --force.
	return workspace.worktree.dirty === false ? "remove" : "remove-anyway";
}

/**
 * Close Workspace, as the window does (`closeWorkspaceOrWorktree`, then the
 * close sheet): the same two intents, `request_close_workspace` with the
 * folder's answer and `confirm_close_workspace` for the sheet's. Every
 * question the window would ask is a flag; one left open refuses before
 * anything is sent, and the coordinator's own reading is checked again
 * before its confirmation is given — a question that came up in between is
 * refused, its confirmation left unanswered (as the sheet's Cancel leaves
 * it), and nothing has been closed.
 */
export async function closeAsTheWindowDoes(
	workspace: ClosedWorkspace,
	answers: TellCloseAnswers,
	window: CloseWindow,
): Promise<TellClosed> {
	if (workspace.scratch)
		throw new Error(
			"Scratch cannot be closed: it is today's folder, and the window has no close for it.",
		);
	if (workspace.orchestrator === true)
		throw new Error(ORCHESTRATOR_CANNOT_CLOSE);
	if (workspace.closing)
		throw new Error(`${workspace.label} is already closing.`);
	if (workspace.worktree === undefined && answers.worktree === "remove")
		throw new Error(
			`${workspace.label} is not a worktree DevHub removes on close, so there is no folder to remove (--worktree keep, or leave it out).`,
		);
	const before = await window.inspect();
	const open = openCloseQuestions(workspace, before, answers);
	if (open.length > 0) return { kind: "questions", questions: open };
	const worktree = disposition(workspace, answers.worktree);
	const outcome = await window.dispatch({
		type: "request_close_workspace",
		workspaceId: workspace.id,
		worktree,
	});
	let asked: CloseInspectionInputs = before;
	if (
		outcome.kind === "confirmation_required" &&
		outcome.purpose.kind === "workspace_close"
	) {
		asked = outcome.purpose.inspection;
		const now = openCloseQuestions(workspace, asked, answers);
		if (now.length > 0) return { kind: "questions", questions: now };
		await window.dispatch({
			type: "confirm_close_workspace",
			confirmationId: outcome.confirmationId,
		});
	}
	const failure = window.failure();
	if (failure !== undefined) throw new Error(failure);
	const count = (resource: ResourceInspection): number =>
		resource.kind === "busy" ? resource.count : 0;
	return {
		kind: "closed",
		worktree:
			workspace.worktree === undefined
				? "none"
				: worktree === "keep"
					? "kept"
					: "removed",
		busyTerminalProcesses: count(asked.terminalProcesses),
		discarded:
			asked.unsavedEditors.kind === "unsaved" ? asked.unsavedEditors.tabs : [],
	};
}
