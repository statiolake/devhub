/**
 * A chord's second stroke, resolved against the model.
 *
 * **The table and the reasoning behind it are in `model/commands.ts`.** That is
 * the one source of truth: every command's id, its label, what it needs and the
 * keys DevHub ships it under. This file has no table of its own — it turns a
 * command id into the one thing that command should do *now*, given what is
 * selected, and answers "nothing" when there is nothing to act on.
 *
 * Keeping the two apart is what lets the configuration file, the Settings
 * window and the help overlay read the same list the dispatcher runs from. It
 * used to be one file with the keys and the behaviour inlined together, which
 * had exactly one reader and could not have had a second.
 *
 * # The three lists
 *
 * The sidebar is a tree, and three of these commands step through it at
 * different levels. All three orders are computed here, from one projection, so
 * `Cmd+Q 3` and three presses of `Cmd+Q Cmd+N` cannot disagree about what the
 * list is:
 *
 * - `sidebarEntries` — Scratch, then the workspaces. What a digit names.
 * - `everyAgent` — every Agent there is, in sidebar order, across workspaces.
 * - `everyTab` — every row of the tree in order, of both kinds.
 */

import { chordKeyId, type ChordKey } from "../../model/chordKeys.js";
import {
	commandById,
	defaultBindings,
	isSelectEntryCommand,
	type CommandId,
	type KeyBinding,
} from "../../model/commands.js";
import type {
	AgentWire,
	AppSnapshotWire,
	NavigationContext,
	SurfacePresentationWire,
	WorkspaceWire,
} from "../../ipc/appShell.js";

/**
 * One row of the effective table: the key that completes the chord, and the
 * command it raises.
 *
 * Modifiers are matched exactly — an absent flag means the modifier must be
 * *up* — which is `chordKeys.ts`'s rule and not a second one.
 */
export type ChordBinding = KeyBinding;

/** The table DevHub ships, before any configuration is read. */
export function defaultChordTable(): readonly ChordBinding[] {
	return defaultBindings();
}

/**
 * One keystroke as the main process sees it.
 *
 * `key` is the physical key's name and `code` is what it was derived from. Both
 * travel because the code is what says whether this was a bare modifier — a
 * question the name cannot answer, and the one the shifted-chord bug turned on.
 */
export interface KeyStroke extends ChordKey {
	readonly code: string;
	readonly isAutoRepeat: boolean;
}

export function matchChord(
	table: readonly ChordBinding[],
	stroke: KeyStroke,
): ChordBinding | undefined {
	const wanted = chordKeyId(stroke);
	return table.find((binding) => chordKeyId(binding.key) === wanted);
}

/**
 * What running a chord comes to, once it has been resolved against the model.
 *
 * Every one of these is something DevHub can already be asked for by pointing
 * at it — a menu item, a sidebar button, a row's context menu — which is the
 * point: a chord is another way to raise a command DevHub has, never a second
 * implementation of one.
 */
export type ChordEffect =
	| {
			readonly kind: "select-context";
			readonly context: NavigationContext;
			/** Only an Agent has two; absent means the plain, full one. */
			readonly presentation?: SurfacePresentationWire;
	  }
	/** Side by side already: move the keyboard rather than the selection. */
	| { readonly kind: "swap-split-focus" }
	| { readonly kind: "open-workspace-picker" }
	| { readonly kind: "open-tab-picker" }
	| { readonly kind: "open-agent-picker"; readonly workspaceId: string }
	| { readonly kind: "open-issue-picker" }
	| { readonly kind: "open-agent-actions"; readonly agentId: string }
	| { readonly kind: "rename-agent"; readonly agentId: string }
	| { readonly kind: "close-agent"; readonly agentId: string }
	/** Close it, and delete the worktree if that is what it is. */
	| { readonly kind: "close-workspace"; readonly workspaceId: string }
	| { readonly kind: "open-workspace-externally"; readonly workspaceId: string }
	| { readonly kind: "refresh-repositories" }
	| { readonly kind: "open-chord-help" }
	| { readonly kind: "open-settings" };

const GLOBAL: NavigationContext = { kind: "global" };

/** Scratch, then the workspaces in their own order. What a digit names. */
function sidebarEntries(
	snapshot: AppSnapshotWire,
): readonly NavigationContext[] {
	return [
		GLOBAL,
		...snapshot.workspaces.map(
			(workspace): NavigationContext => ({
				kind: "workspace",
				workspaceId: workspace.id,
			}),
		),
	];
}

/**
 * Every Agent there is, in sidebar order.
 *
 * Across workspaces, deliberately: an Agent is the unit of work, and which
 * folder it happens to be rooted in is not what somebody stepping through them
 * is choosing between. Confining the cycle to one workspace made `}` stop dead
 * at a boundary that means nothing to the person pressing it.
 */
function everyAgent(snapshot: AppSnapshotWire): readonly AgentWire[] {
	return snapshot.workspaces.flatMap((workspace) => workspace.agents);
}

/** Every row of the tree, of both kinds, in the order it is drawn. */
function everyTab(snapshot: AppSnapshotWire): readonly NavigationContext[] {
	return [
		GLOBAL,
		...snapshot.workspaces.flatMap((workspace): NavigationContext[] => [
			{ kind: "workspace", workspaceId: workspace.id },
			...workspace.agents.map(
				(agent): NavigationContext => ({ kind: "agent", agentId: agent.id }),
			),
		]),
	];
}

/** The workspace the selection is in, whether a row or one of its agents. */
function selectedWorkspace(
	snapshot: AppSnapshotWire,
): WorkspaceWire | undefined {
	const context = snapshot.selection.context;
	if (context.kind === "global") return undefined;
	return snapshot.workspaces.find((workspace) =>
		context.kind === "workspace"
			? workspace.id === context.workspaceId
			: workspace.agents.some((agent) => agent.id === context.agentId),
	);
}

/** The Agent the selection is on, or nothing when it is on a row. */
function selectedAgent(snapshot: AppSnapshotWire): AgentWire | undefined {
	const context = snapshot.selection.context;
	if (context.kind !== "agent") return undefined;
	return everyAgent(snapshot).find((agent) => agent.id === context.agentId);
}

function sameContext(
	left: NavigationContext,
	right: NavigationContext,
): boolean {
	if (left.kind === "workspace" && right.kind === "workspace") {
		return left.workspaceId === right.workspaceId;
	}
	if (left.kind === "agent" && right.kind === "agent") {
		return left.agentId === right.agentId;
	}
	return left.kind === "global" && right.kind === "global";
}

function wrap(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/**
 * Step through a ring, from wherever the selection is in it.
 *
 * One function for all three cycles, because they differ only in what the ring
 * holds. A selection that is not in the ring at all — a workspace row while the
 * Agent ring is being stepped — steps forward onto the first entry and back
 * onto the last, which is the answer with no arbitrary choice in it.
 */
function step(
	ring: readonly NavigationContext[],
	from: NavigationContext | undefined,
	direction: 1 | -1,
): ChordEffect | undefined {
	if (ring.length === 0) return undefined;
	const found = from ? ring.findIndex((entry) => sameContext(entry, from)) : -1;
	const current = found === -1 ? (direction === 1 ? -1 : 0) : found;
	return {
		kind: "select-context",
		context: ring[wrap(current + direction, ring.length)],
	};
}

/**
 * Turn a command into the one thing it should do now, or nothing.
 *
 * Nothing is a real answer: `Cmd+Q }` with no Agents running, or `Cmd+Q 7` with
 * three workspaces open, is a no-op. Raising an error for it would put a red
 * sentence on screen for a keystroke that simply had nowhere to go.
 *
 * What a command needs is asked once, from the registry, before the switch — so
 * no case restates it and no command added later can forget to.
 */
export function resolveChord(
	commandId: CommandId,
	snapshot: AppSnapshotWire,
): ChordEffect | undefined {
	const definition = commandById(commandId);
	if (!definition) return undefined;

	const workspace = selectedWorkspace(snapshot);
	const agent = selectedAgent(snapshot);
	if (definition.needs === "workspace" && !workspace) return undefined;
	if (definition.needs === "agent" && !agent) return undefined;

	if (isSelectEntryCommand(commandId)) {
		const entries = sidebarEntries(snapshot);
		// `ordinal` is one-based, as it is typed: 1 is Scratch.
		const entry = entries[(definition.ordinal ?? 1) - 1];
		return entry ? { kind: "select-context", context: entry } : undefined;
	}

	switch (commandId) {
		case "forward_prefix":
			// Handled by the router before anything is resolved.
			return undefined;

		case "add_workspace":
			return { kind: "open-workspace-picker" };

		case "open_tab_picker":
			return { kind: "open-tab-picker" };

		case "add_agent":
			// A workspace that says it cannot start an Agent — it is closing, or
			// unavailable — is not asked to. The chord is a no-op.
			return workspace?.canCreateAgent
				? { kind: "open-agent-picker", workspaceId: workspace.id }
				: undefined;

		case "open_issue_picker":
			return { kind: "open-issue-picker" };

		case "send_agent_action":
			return agent
				? { kind: "open-agent-actions", agentId: agent.id }
				: undefined;

		case "rename_agent":
			return agent ? { kind: "rename-agent", agentId: agent.id } : undefined;

		case "close_selection":
			// The small thing if you are standing on one, the big thing if you are
			// not. `close_workspace` is the same second half, under its own key.
			return agent
				? { kind: "close-agent", agentId: agent.id }
				: workspace
					? { kind: "close-workspace", workspaceId: workspace.id }
					: undefined;

		case "close_workspace":
			return workspace
				? { kind: "close-workspace", workspaceId: workspace.id }
				: undefined;

		case "open_workspace_externally":
			return workspace
				? { kind: "open-workspace-externally", workspaceId: workspace.id }
				: undefined;

		case "refresh_repositories":
			return { kind: "refresh-repositories" };

		case "open_settings":
			return { kind: "open-settings" };

		case "show_chord_help":
			return { kind: "open-chord-help" };

		case "focus_editor":
			// What "focused" means for DevHub's content area is what is selected:
			// the selection decides the layout, and `ShellWindow.focusSurface` puts
			// the keyboard wherever the layout put the surface. So this selects the
			// workbench rather than reaching for a second notion of focus that the
			// window would then have to reconcile with the first.
			return {
				kind: "select-context",
				context: workspace
					? { kind: "workspace", workspaceId: workspace.id }
					: GLOBAL,
			};

		case "toggle_split":
			// The two arrangements DevHub already has for an Agent: beside its
			// workbench, or alone over the content area. Moving the *selection's*
			// presentation rather than adding a "maximised" flag is what keeps
			// there being one answer to how much room the Agent takes.
			return agent
				? {
						kind: "select-context",
						context: { kind: "agent", agentId: agent.id },
						presentation:
							snapshot.selection.presentation === "beside" ? "full" : "beside",
					}
				: undefined;

		case "toggle_workspace_agent": {
			if (!workspace) return undefined;
			// Side by side, both halves are already on screen: there is nothing to
			// select, so the same chord moves the keyboard between them instead.
			if (snapshot.selection.presentation === "beside") {
				return { kind: "swap-split-focus" };
			}
			if (agent) {
				return {
					kind: "select-context",
					context: { kind: "workspace", workspaceId: workspace.id },
				};
			}
			// Back to the Agent this workspace was last in, and only that: with
			// none remembered there is no "other half" to go to, and picking the
			// first Agent instead would make one chord mean two things.
			const last = workspace.lastAgentId;
			return last === undefined
				? undefined
				: {
						kind: "select-context",
						context: { kind: "agent", agentId: last },
						presentation: "full",
					};
		}

		case "next_workspace":
		case "previous_workspace": {
			const direction = commandId === "next_workspace" ? 1 : -1;
			const entries = sidebarEntries(snapshot);
			if (entries.length < 2) return undefined;
			// From wherever the selection is, the workspace it belongs to — an
			// Agent is somewhere in this ring even though it is not a row of it.
			return step(
				entries,
				workspace ? { kind: "workspace", workspaceId: workspace.id } : GLOBAL,
				direction,
			);
		}

		case "next_agent":
		case "previous_agent": {
			const direction = commandId === "next_agent" ? 1 : -1;
			const agents = everyAgent(snapshot);
			if (agents.length === 0) return undefined;
			return step(
				agents.map(
					(one): NavigationContext => ({ kind: "agent", agentId: one.id }),
				),
				agent ? { kind: "agent", agentId: agent.id } : undefined,
				direction,
			);
		}

		case "next_tab":
		case "previous_tab": {
			const direction = commandId === "next_tab" ? 1 : -1;
			const tabs = everyTab(snapshot);
			if (tabs.length < 2) return undefined;
			return step(tabs, snapshot.selection.context, direction);
		}
	}
}
