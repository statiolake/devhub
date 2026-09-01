/**
 * Where the parts of an effect DevHub's shell does not own get filled in.
 *
 * The coordinator emits effects; something has to perform them. Three of them
 * belong to subsystems that live outside this directory — terminals and Agents
 * are both tmux sessions on DevHub's own socket (`main/terminal`,
 * `main/agent`) — so those register an adapter here and the effect runner
 * calls it.
 *
 * Every adapter is optional and the absence of one is a *stated* answer, not a
 * silent default:
 *
 * - **Agents.** Nothing else can launch, stop or observe one. With no adapter,
 *   an Agent effect fails loudly, because a build with no Agent runtime cannot
 *   pretend an Agent started.
 * - **Terminals.** A terminal exists only because a terminal adapter created
 *   it. With no adapter there are no terminals, so "close the workspace's
 *   terminals" is already true and the step completes — that is a fact about
 *   the build, not an assumption about the world.
 *
 * Editors are deliberately not one of these. The shell owns every workbench
 * view itself, and VS Code's renderer has already told main whether a view
 * holds unsaved work, so the App Controller answers that question directly
 * (`inspectEditors`) rather than through a seam. There was an `EditorInspector`
 * here that nothing ever registered; the branch for its absence was the whole
 * of the behaviour, and it said "could not verify" every time.
 */

import type {
	AgentId,
	AgentProfile,
	CloseInspectionInputs,
	ResourceInspection,
	WorkspaceId,
} from "../../model/domain.js";
import type {
	AgentLaunchResult,
	AgentStopResult,
	AgentReconciliationResult,
} from "./adapterTypes.js";

export interface AgentAdapter {
	launch(
		workspaceId: WorkspaceId,
		agentId: AgentId,
		profile: AgentProfile,
		workspaceRoot: string,
	): Promise<AgentLaunchResult>;
	stop(agentId: AgentId): Promise<AgentStopResult>;
	terminate(agentId: AgentId): Promise<AgentStopResult>;
	reconcile(agentId?: AgentId): Promise<AgentReconciliationResult>;
	/** Close every Agent belonging to a workspace. Resolves when they are gone. */
	closeWorkspaceAgents(workspaceId: WorkspaceId): Promise<void>;
	/**
	 * Hold text for an Agent, to be sent the next time its prompt is free.
	 *
	 * It does not go now. The Agent may be mid-turn, or stopped on a question
	 * that wants a keypress rather than a sentence, and the queue waits for a
	 * settled idle prompt before typing anything — see `agent/injection.ts`.
	 * Callers build the text; when it is delivered is not theirs to decide.
	 *
	 * Throws if the text is empty, which is a caller's bug rather than a state
	 * of the world: a bare Enter into an Agent's prompt is not a no-op.
	 */
	queueInjection(agentId: AgentId, text: string): void;
}

export interface TerminalAdapter {
	/** Close every terminal belonging to a workspace, scratch excluded. */
	closeWorkspaceTerminals(workspaceId: WorkspaceId): Promise<void>;
	/** What a close confirmation should say about this workspace's terminals. */
	inspect(workspaceId: WorkspaceId): Promise<{
		readonly processes: ResourceInspection;
		readonly panes: ResourceInspection;
		readonly windows: ResourceInspection;
	}>;
}

let agentAdapter: AgentAdapter | undefined;
let terminalAdapter: TerminalAdapter | undefined;

export function registerAgentAdapter(adapter: AgentAdapter): void {
	agentAdapter = adapter;
}

export function registerTerminalAdapter(adapter: TerminalAdapter): void {
	terminalAdapter = adapter;
}

export function agents(): AgentAdapter | undefined {
	return agentAdapter;
}

export function terminals(): TerminalAdapter | undefined {
	return terminalAdapter;
}

const CLEAN: ResourceInspection = { kind: "clean" };

/**
 * Collect what a close confirmation needs, asking whoever owns each answer.
 *
 * `agentCount` comes from the model, which is the only place that knows how
 * many Agents this Workspace has — the adapter knows about sessions, not about
 * DevHub's Agents.
 */
export async function inspectWorkspaceResources(
	workspaceId: WorkspaceId,
	agentCount: number,
	unsavedEditors: ResourceInspection,
): Promise<CloseInspectionInputs> {
	const terminal = terminals();
	const terminalInspection = terminal
		? await terminal.inspect(workspaceId)
		: { processes: CLEAN, panes: CLEAN, windows: CLEAN };
	return {
		agents: agentCount > 0 ? { kind: "busy", count: agentCount } : CLEAN,
		terminalProcesses: terminalInspection.processes,
		terminalPanes: terminalInspection.panes,
		terminalWindows: terminalInspection.windows,
		unsavedEditors,
	};
}
