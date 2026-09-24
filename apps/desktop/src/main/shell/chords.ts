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
 * The workspaces arrive already in the order the sidebar draws them — the
 * projection puts them in it (`model/workspaceOrder.ts`) — so none of the
 * three sorts anything. They used to walk the order folders happened to be
 * opened in while the sidebar drew worktrees grouped under their repository,
 * which made every one of these cycles jump around the list on screen.
 *
 * - `sidebarEntries` — Scratch, then the workspaces. What a digit names.
 * - `everyAgent` — every Agent there is, in sidebar order, across workspaces.
 *   `Cmd+Q ]` stops at each of them and `Cmd+Q }` at the unread ones, both
 *   walking the tree below so that an editor has a place to step from, and so
 *   the filtered cycle cannot disagree with the whole one about the order.
 * - `everyTab` — every row of the tree in order, of both kinds.
 */

import { chordKeyId, type ChordKey } from "../../model/chordKeys.js";
import { pairedAgentId } from "../../model/appModel.js";
import { moveAgent, moveWorkspace } from "../../model/workspaceOrder.js";
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
import { sidebarWorkspaces } from "../../ipc/appShell.js";

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
 * `keys` is what the stroke could be, best first — one entry for anything that
 * produced a character, which is nearly everything, and up to two for a
 * punctuation key read from its position while an input method is composing
 * (see `charactersForCode`). `shift` is the raw flag, still needed by the
 * editing keys and by a named key; `code` is here for one question only, which
 * is whether this was a bare modifier.
 */
export interface KeyStroke {
	readonly keys: readonly string[];
	readonly code: string;
	readonly command: boolean;
	readonly control: boolean;
	readonly option: boolean;
	readonly shift: boolean;
	readonly isAutoRepeat: boolean;
}

/** One candidate identity of a stroke, as a binding would spell it. */
export function strokeAs(stroke: KeyStroke, key: string): ChordKey {
	return {
		key,
		command: stroke.command,
		control: stroke.control,
		option: stroke.option,
		// Shift is in the character already, unless there is no character to be
		// in — which is `chordKeys.ts`'s rule and not a second one.
		shift: key.length > 1 ? stroke.shift : false,
	};
}

/**
 * The binding this stroke completes, if any.
 *
 * Candidates in order, first bound one wins. Ordinarily there is one candidate
 * and the order says nothing; it matters only for a punctuation key read from
 * its position mid-composition, where two layouts disagree about what it
 * produces and only one of the two readings is usually bound to anything.
 */
export function matchChord(
	table: readonly ChordBinding[],
	stroke: KeyStroke,
): ChordBinding | undefined {
	for (const key of stroke.keys) {
		const wanted = chordKeyId(strokeAs(stroke, key));
		const found = table.find((binding) => chordKeyId(binding.key) === wanted);
		if (found) return found;
	}
	return undefined;
}

/**
 * Where the keyboard lands inside an editor a move arrives at.
 *
 * Every move a chord makes takes the keyboard to what it selected — that is
 * the host's rule, not something an effect can opt out of. Inside a workbench,
 * though, the keyboard is the workbench's own business, and an ordinary move
 * leaves it wherever that editor was last typed into, which is what coming
 * back to an editor is supposed to feel like.
 *
 * The toggles are the exception, and both of them, for one reason: `Cmd+Q
 * Cmd+J` and `Cmd+Q Shift+J` are how somebody goes *to the other place they
 * work*, and at an editor that place is its shell. So a toggle that lands on
 * an editor lands in its integrated terminal. Landing on an Agent, it means
 * nothing — an Agent is a terminal already.
 */
export type Landing = "terminal";

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
			/** Where the keyboard lands in an editor. See `Landing`. */
			readonly focus?: Landing;
	  }
	/** Side by side already: move the keyboard rather than the selection. */
	| { readonly kind: "swap-split-focus" }
	/**
	 * Put the keyboard on the Sidebar's selected row.
	 *
	 * The one effect that moves focus into DevHub's own chrome rather than
	 * acting on the model. Everything the Sidebar can do with a keyboard was
	 * already written and none of it could be reached; this is the door.
	 */
	| { readonly kind: "focus-sidebar" }
	/** The Sidebar as its icon rail, or back to its width. */
	| { readonly kind: "toggle-sidebar" }
	/**
	 * Out to Scratch, or back to wherever the jump out started.
	 *
	 * The one move that carries no target: which selection to come back to is
	 * a thing only the model remembers, because it is written down by this
	 * command and by nothing else, and a snapshot of what is on screen cannot
	 * say where somebody was before it. It is a toggle all the same, so it
	 * lands the way the other toggle does.
	 */
	| { readonly kind: "toggle-scratch"; readonly focus: Landing }
	| { readonly kind: "open-workspace-picker" }
	| { readonly kind: "open-tab-picker" }
	| { readonly kind: "open-agent-picker"; readonly workspaceId: string }
	| { readonly kind: "open-issue-picker" }
	| { readonly kind: "open-agent-actions"; readonly agentId: string }
	| { readonly kind: "rename-agent"; readonly agentId: string }
	| { readonly kind: "mark-agent-unread"; readonly agentId: string }
	/** Whichever failure is on screen in whichever window is in front. */
	| { readonly kind: "dismiss-alert" }
	| { readonly kind: "close-agent"; readonly agentId: string }
	/** Close it, and delete the worktree if that is what it is. */
	| { readonly kind: "close-workspace"; readonly workspaceId: string }
	/**
	 * The rows, in the order the person has just put them.
	 *
	 * The whole list and not "this one moved there", because that is what the
	 * intent carries and what the model stores — and because the rule that
	 * produced it (`model/workspaceOrder.ts`) has already been applied here,
	 * against the same projection the Sidebar drew. `workspaceId` says which
	 * list: absent for the top-level rows, present for that workspace's Agents.
	 */
	| {
			readonly kind: "reorder-entries";
			readonly workspaceId?: string;
			readonly order: readonly string[];
	  }
	| { readonly kind: "refresh-repositories" }
	| { readonly kind: "open-chord-help" }
	| { readonly kind: "open-settings" };

/** Scratch, then the workspaces in sidebar order. See `sidebarWorkspaces`. */
function orderedWorkspaces(
	snapshot: AppSnapshotWire,
): readonly WorkspaceWire[] {
	const { scratch, rows } = sidebarWorkspaces(snapshot);
	return [scratch, ...rows];
}

function scratchContext(snapshot: AppSnapshotWire): NavigationContext {
	return { kind: "workspace", workspaceId: snapshot.scratchWorkspaceId };
}

/** Scratch, then the workspaces in sidebar order. What a digit names. */
function sidebarEntries(
	snapshot: AppSnapshotWire,
): readonly NavigationContext[] {
	return orderedWorkspaces(snapshot).map(
		(workspace): NavigationContext => ({
			kind: "workspace",
			workspaceId: workspace.id,
		}),
	);
}

/**
 * Every Agent there is, in sidebar order.
 *
 * Across workspaces, deliberately: an Agent is the unit of work, and which
 * folder it happens to be rooted in is not what somebody stepping through them
 * is choosing between. Confining the cycle to one workspace made `]` stop dead
 * at a boundary that means nothing to the person pressing it.
 */
function everyAgent(snapshot: AppSnapshotWire): readonly AgentWire[] {
	return orderedWorkspaces(snapshot).flatMap((workspace) => workspace.agents);
}

/** Every row of the tree, of both kinds, in the order it is drawn. */
function everyTab(snapshot: AppSnapshotWire): readonly NavigationContext[] {
	return orderedWorkspaces(snapshot).flatMap(
		(workspace): NavigationContext[] => [
			{ kind: "workspace", workspaceId: workspace.id },
			...workspace.agents.map(
				(agent): NavigationContext => ({ kind: "agent", agentId: agent.id }),
			),
		],
	);
}

/** The workspace the selection is in, whether a row or one of its agents. */
function selectedWorkspace(
	snapshot: AppSnapshotWire,
): WorkspaceWire | undefined {
	const context = snapshot.selection.context;
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

/**
 * Where the selection stands in the tree, for a cycle that steps between
 * Agents.
 *
 * An Agent stands where it is. An editor stands where its `Cmd+Q Cmd+J`
 * partner stands (`pairedAgentId`): the two are one place, toggled between, so
 * `]` from the editor goes to the Agent after the one `Cmd+J` would have gone
 * to, and never somewhere unrelated. A workspace with no Agents has no partner
 * and stands on its own row, which is between the Agents before it and the
 * ones after.
 */
function standing(
	snapshot: AppSnapshotWire,
	workspace: WorkspaceWire | undefined,
	agent: AgentWire | undefined,
): NavigationContext {
	if (agent) return { kind: "agent", agentId: agent.id };
	if (!workspace) {
		// `resolveChord` has the selection's workspace for every selection the
		// model can hold; one that names nothing is a broken snapshot.
		throw new Error("the selection is in no workspace of the snapshot");
	}
	const partner = pairedAgentId(workspace);
	return partner === undefined
		? { kind: "workspace", workspaceId: workspace.id }
		: { kind: "agent", agentId: partner };
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
	return false;
}

/**
 * Close the workspace the selection is in — nothing, when that is Scratch,
 * which does not close (it stops being Scratch at midnight instead). The same
 * rule File ▸ Close Workspace reads in `menu.ts`.
 */
function closeWorkspace(
	snapshot: AppSnapshotWire,
	workspace: WorkspaceWire | undefined,
): ChordEffect | undefined {
	if (!workspace || workspace.id === snapshot.scratchWorkspaceId) {
		return undefined;
	}
	return { kind: "close-workspace", workspaceId: workspace.id };
}

function wrap(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/**
 * Step through a ring, from wherever the selection is in it.
 *
 * One function for every cycle, because they differ only in what the ring holds
 * and which of its entries count. Every caller steps from somewhere that is in
 * its ring — the Agent cycle walks the whole tree so that an editor, which is
 * not an Agent, still has a place to step from (`standing`) — so a starting
 * point the ring does not hold is a broken snapshot, not a case.
 *
 * `wanted` is what makes `}` a narrowing of `]` rather than a second cycle: the
 * same ring, from the same place, in the same direction, stopping at the first
 * entry that qualifies. Every entry is offered exactly once before it gives up,
 * so a ring with nothing wanted in it is a no-op rather than a loop.
 */
function step(
	ring: readonly NavigationContext[],
	from: NavigationContext,
	direction: 1 | -1,
	wanted: (index: number) => boolean = () => true,
): ChordEffect | undefined {
	const current = ring.findIndex((entry) => sameContext(entry, from));
	if (current === -1) {
		throw new Error(
			`a cycle was asked to step from ${JSON.stringify(from)}, which is not in it`,
		);
	}
	for (let offset = 1; offset <= ring.length; offset += 1) {
		const index = wrap(current + direction * offset, ring.length);
		if (wanted(index)) {
			return { kind: "select-context", context: ring[index] };
		}
	}
	return undefined;
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
	if (
		definition.needs === "split" &&
		snapshot.selection.presentation !== "beside"
	)
		return undefined;

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

		case "mark_agent_unread":
			// `needs: "agent"` has already answered "is there one".
			return agent
				? { kind: "mark-agent-unread", agentId: agent.id }
				: undefined;

		case "close_selection":
			// The small thing if you are standing on one, the big thing if you are
			// not. `close_workspace` is the same second half, under its own key.
			return agent
				? { kind: "close-agent", agentId: agent.id }
				: closeWorkspace(snapshot, workspace);

		case "close_workspace":
			return closeWorkspace(snapshot, workspace);

		case "refresh_repositories":
			return { kind: "refresh-repositories" };

		case "focus_sidebar":
			return { kind: "focus-sidebar" };

		case "toggle_sidebar":
			return { kind: "toggle-sidebar" };

		case "dismiss_alert":
			// Whether anything is showing is a fact about a page, not about the
			// model, so it is not decidable here. The page answers with nothing
			// when it has nothing to put away.
			return { kind: "dismiss-alert" };

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
					: scratchContext(snapshot),
			};

		case "swap_split_focus":
			// `needs: "split"` has already answered "is there another pane".
			return { kind: "swap-split-focus" };

		case "toggle_scratch":
			// Both directions, unconditionally: the model holds the memory this
			// turns on, so there is nothing here to decide and nothing to gate
			// on. On Scratch with nothing remembered it is a no-op there.
			return { kind: "toggle-scratch", focus: "terminal" };

		case "toggle_split": {
			// Both halves of one pair, side by side — the twin of
			// `toggle_workspace_agent`, which shows one of the same two.
			if (!workspace) return undefined;
			if (snapshot.selection.presentation === "beside") {
				// Leaving: the half in front is what is selected, and it is what
				// the single view lands on. Entered from the editor, left to the
				// editor; entered from the Agent, left to the Agent; moved with
				// `Cmd+J` in between, left to wherever that moved it.
				return {
					kind: "select-context",
					context: snapshot.selection.context,
					presentation: "full",
				};
			}
			// Entering: the pair as two panes, with the keyboard staying in the
			// half it was already in. A workspace with no Agents has no pair and
			// nothing to put beside it.
			if (agent) {
				return {
					kind: "select-context",
					context: { kind: "agent", agentId: agent.id },
					presentation: "beside",
				};
			}
			return pairedAgentId(workspace) === undefined
				? undefined
				: {
						kind: "select-context",
						context: { kind: "workspace", workspaceId: workspace.id },
						presentation: "beside",
					};
		}

		case "toggle_workspace_agent": {
			if (!workspace) return undefined;
			// Side by side, both halves are already on screen: there is nothing to
			// select, so the same chord moves the keyboard between them instead —
			// which is what `Cmd+Q O` does with nothing else attached.
			if (snapshot.selection.presentation === "beside") {
				return { kind: "swap-split-focus" };
			}
			if (agent) {
				// A toggle landing on an editor: see `Landing`. Every other way
				// of choosing this workbench — the sidebar, the pickers, `Cmd+Q
				// N/P`, a digit — leaves the keyboard where that editor had it.
				return {
					kind: "select-context",
					context: { kind: "workspace", workspaceId: workspace.id },
					focus: "terminal",
				};
			}
			// Back to the Agent you were last in, or the first one if you have
			// not been in any. A workspace with Agents always has an "other
			// half"; refusing to open it until one had been opened by hand made
			// the chord dead exactly when it was most useful — on a workspace
			// just restored, or just given its first Agent. Only a workspace
			// with no Agents at all has nowhere to go.
			const last = pairedAgentId(workspace);
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
				workspace
					? { kind: "workspace", workspaceId: workspace.id }
					: scratchContext(snapshot),
				direction,
			);
		}

		case "next_agent":
		case "previous_agent":
		case "next_unread_agent":
		case "previous_unread_agent": {
			const forwards =
				commandId === "next_agent" || commandId === "next_unread_agent";
			const onlyUnread =
				commandId === "next_unread_agent" ||
				commandId === "previous_unread_agent";
			// The tree rather than the Agents alone, so that where the person
			// stands is always somewhere in it (`standing`); only the Agents are
			// stops, and in the same order `everyAgent` has them.
			const tabs = everyTab(snapshot);
			const unread = new Set(
				everyAgent(snapshot)
					.filter((one) => one.unread !== undefined)
					.map((one) => one.id),
			);
			return step(
				tabs,
				standing(snapshot, workspace, agent),
				forwards ? 1 : -1,
				(index) => {
					const entry = tabs[index];
					return (
						entry.kind === "agent" && (!onlyUnread || unread.has(entry.agentId))
					);
				},
			);
		}

		case "move_entry_up":
		case "move_entry_down": {
			// The one command that changes where the rows *are* rather than which
			// of them is selected, and it acts on whatever is selected — which is
			// why it needs nothing: Scratch is not a row that moves (it is entry
			// 1, always), and a chord with nothing to act on is a no-op like
			// every other. Its Agents move like any Workspace's.
			const direction = commandId === "move_entry_up" ? -1 : 1;
			const context = snapshot.selection.context;
			if (
				context.kind === "workspace" &&
				context.workspaceId === snapshot.scratchWorkspaceId
			) {
				return undefined;
			}
			if (context.kind === "agent") {
				if (!workspace) return undefined;
				const order = moveAgent(
					workspace.agents.map((one) => one.id),
					context.agentId,
					direction,
				);
				return order === undefined
					? undefined
					: { kind: "reorder-entries", workspaceId: workspace.id, order };
			}
			const order = moveWorkspace(
				sidebarWorkspaces(snapshot).rows,
				(one) => one.groupKey,
				context.workspaceId,
				direction,
			);
			return order === undefined
				? undefined
				: { kind: "reorder-entries", order };
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
