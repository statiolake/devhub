/**
 * Where the parts of an effect DevHub's shell does not own get filled in.
 *
 * The coordinator emits effects; something has to perform them. Three of them
 * belong to subsystems that live outside this directory — terminals are PTYs in
 * `main/terminal`, Agents are Herdr sessions in `main/agent` — so those register
 * an adapter here and the effect runner calls it.
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
 * - **Close inspection.** Nobody can say whether an editor has unsaved work
 *   until something asks the workbench. With no inspector the shell answers
 *   from what it does know — whether a workbench view for that Workspace
 *   exists at all — which is what puts "Could not verify editor state" in
 *   front of the person instead of quietly reporting "clean".
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

export interface EditorInspector {
	/** Unsaved editors in this workspace's workbench view. */
	inspect(workspaceId: WorkspaceId): Promise<ResourceInspection>;
}

let agentAdapter: AgentAdapter | undefined;
let terminalAdapter: TerminalAdapter | undefined;
let editorInspector: EditorInspector | undefined;

export function registerAgentAdapter(adapter: AgentAdapter): void {
	agentAdapter = adapter;
}

export function registerTerminalAdapter(adapter: TerminalAdapter): void {
	terminalAdapter = adapter;
}

export function registerEditorInspector(inspector: EditorInspector): void {
	editorInspector = inspector;
}

export function agents(): AgentAdapter | undefined {
	return agentAdapter;
}

export function terminals(): TerminalAdapter | undefined {
	return terminalAdapter;
}

export function editors(): EditorInspector | undefined {
	return editorInspector;
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
	fallbackEditors: ResourceInspection,
): Promise<CloseInspectionInputs> {
	const terminal = terminals();
	const terminalInspection = terminal
		? await terminal.inspect(workspaceId)
		: { processes: CLEAN, panes: CLEAN, windows: CLEAN };
	const inspector = editors();
	return {
		agents: agentCount > 0 ? { kind: "busy", count: agentCount } : CLEAN,
		terminalProcesses: terminalInspection.processes,
		terminalPanes: terminalInspection.panes,
		terminalWindows: terminalInspection.windows,
		unsavedEditors: inspector
			? await inspector.inspect(workspaceId)
			: fallbackEditors,
	};
}
