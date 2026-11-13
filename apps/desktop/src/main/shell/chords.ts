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
 * `Cmd+Q 2` and two presses of `Cmd+Q Cmd+N` cannot disagree about what the
 * list is:
 *
 * The workspaces arrive already in the order the sidebar draws them — the
 * projection puts them in it (`model/workspaceOrder.ts`) — so none of the
 * three sorts anything. They used to walk the order folders happened to be
 * opened in while the sidebar drew worktrees grouped under their repository,
 * which made every one of these cycles jump around the list on screen.
 *
 * - `sidebarEntries` — Scratch, then the workspaces. What a digit names (0 is Scratch).
 * - `everyAgent` — every Agent there is, in sidebar order, across workspaces.
 *   `Cmd+Q ]` stops at each of them and `Cmd+Q }` at the unread ones, both
 *   walking the tree below from the selection's own row, so that an editor
 *   steps from where it is drawn, and so the filtered cycle cannot disagree
 *   with the whole one about the order.
 * - `everyTab` — every row of the tree in order, of both kinds.
 */

import { chordKeyId, type ChordKey } from "../../model/chordKeys.js";
import { pairedAgentId } from "../../model/appModel.js";
import type { TogglePlace } from "../../model/intents.js";
import { moveAgent, moveWorkspace } from "../../model/workspaceOrder.js";
import { formatDevhubLink } from "../../model/devhubLink.js";
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
import {
	sidebarOrder,
	sidebarWorkspaces,
	type TabOf,
	tabOrder,
	tabPosition,
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
 * `key` is the character it produced, or the name of a key that produces none
 * — and nothing at all for a key that arrived with neither, which completes no
 * chord (see `strokeKey`). `shift` is the raw flag, still needed by the editing
 * keys and by a named key; `code` is here for the few questions only the
 * physical key answers — whether this was a bare modifier, and the zoom keys.
 */
export interface KeyStroke {
	readonly key: string | undefined;
	readonly code: string;
	readonly command: boolean;
	readonly control: boolean;
	readonly option: boolean;
	readonly shift: boolean;
	readonly isAutoRepeat: boolean;
}

/** The stroke as a binding would spell it, when it has a key to spell. */
export function strokeAs(stroke: KeyStroke): ChordKey | undefined {
	if (stroke.key === undefined) return undefined;
	return {
		key: stroke.key,
		command: stroke.command,
		control: stroke.control,
		option: stroke.option,
		// Shift is in the character already, unless there is no character to be
		// in — which is `chordKeys.ts`'s rule and not a second one.
		shift: stroke.key.length > 1 ? stroke.shift : false,
	};
}

/** The binding this stroke completes, if any. */
export function matchChord(
	table: readonly ChordBinding[],
	stroke: KeyStroke,
): ChordBinding | undefined {
	const spelled = strokeAs(stroke);
	if (spelled === undefined) return undefined;
	const wanted = chordKeyId(spelled);
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
			/**
			 * `"explicit"`: a jump to a place named by the key — `Cmd+Q 0`–`9` —
			 * which is a place in Back and Forward at once, as a link is.
			 * Absent is stepping (`Cmd+Q N`/`P`): passing over places.
			 */
			readonly reason?: "explicit";
	  }
	/** Side by side already: move the keyboard rather than the selection. */
	| { readonly kind: "swap-split-focus" }
	/**
	 * The next pane on screen: the halves of a split, and the Agent's
	 * terminal with its Agent (`model/agentTerminal.ts`).
	 */
	| { readonly kind: "cycle-pane-focus" }
	/**
	 * Show or hide this Agent's own terminal beside it — started the first
	 * time, in its Workspace's folder.
	 */
	| { readonly kind: "toggle-terminal"; readonly agentId: string }
	/** `Cmd+Q V` where there is no Agent to own a terminal: said, not done. */
	| { readonly kind: "terminal-needs-agent"; readonly workspaceId: string }
	/**
	 * `Cmd+Q V` on the workbench alone: the Workspace has an Agent, but it is
	 * not on screen, and a terminal is only shown with its Agent. Said, not
	 * done — nothing about the terminal changes.
	 */
	| { readonly kind: "terminal-needs-agent-view"; readonly workspaceId: string }
	/** Close the terminal pane with the keyboard, and its session with it. */
	| { readonly kind: "close-terminal"; readonly terminalId: string }
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
	 * Out to Scratch or the Orchestrator, or back to wherever the jump out
	 * started.
	 *
	 * The one move that carries no target beyond the place: which selection
	 * to come back to is a thing only the model remembers, because it is
	 * written down by this command and by nothing else, and a snapshot of what
	 * is on screen cannot say where somebody was before it.
	 */
	| { readonly kind: "toggle-place"; readonly place: TogglePlace }
	| { readonly kind: "open-workspace-picker" }
	| { readonly kind: "open-tab-picker" }
	| { readonly kind: "open-agent-picker"; readonly workspaceId: string }
	| { readonly kind: "open-issue-picker" }
	| { readonly kind: "open-agent-actions"; readonly agentId: string }
	| { readonly kind: "rename-agent"; readonly agentId: string }
	| { readonly kind: "mark-agent-unread"; readonly agentId: string }
	/** Whichever failure is on screen in whichever window is in front. */
	| { readonly kind: "dismiss-alert" }
	/** The notice center, opened or closed by the page that draws it. */
	| { readonly kind: "show-notifications" }
	| { readonly kind: "close-agent"; readonly agentId: string }
	| { readonly kind: "restart-agent"; readonly agentId: string }
	/** Close it, and delete the worktree if that is what it is. */
	| { readonly kind: "close-workspace"; readonly workspaceId: string }
	/** Put it under the orchestrator's management, or take it out. */
	| {
			readonly kind: "set-workspace-managed";
			readonly workspaceId: string;
			readonly managed: boolean;
	  }
	/**
	 * Stop this Workspace's VS Code (`Cmd+Q Shift+E`): closed as a long frozen
	 * one is discarded, back to the placeholder Enter starts it from.
	 */
	/** The newest of what was closed, opened again (`model/recentlyClosed.ts`). */
	| { readonly kind: "reopen-closed" }
	/** What was closed lately, as a list to choose from. */
	| { readonly kind: "open-recently-closed" }
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
	| { readonly kind: "open-settings" }
	/** Main's log file (`diagnostics/mainLog.ts`), in the Mac's viewer. */
	| { readonly kind: "open-log" }
	| { readonly kind: "preview-color-theme" }
	| { readonly kind: "open-task-manager" }
	/** Put the `devhub` launcher on the PATH (`cli/install.ts`). */
	| { readonly kind: "install-cli" }
	| { readonly kind: "restart-terminals" }
	/** The Orchestrator screen, with its request composer open. */
	| { readonly kind: "orchestrator-request" }
	/** The Orchestrator's mode, as the person chooses it. */
	| {
			readonly kind: "orchestrator-mode";
			readonly mode: "full" | "saving" | "off";
	  }
	/** Every command, by name: the registry as a picker. */
	| { readonly kind: "open-command-palette" }
	/** Back or Forward through the places the window has shown. */
	| {
			readonly kind: "navigate-history";
			readonly direction: "back" | "forward";
	  }
	/**
	 * A `devhub:` link to what is selected, on the clipboard: canonical, or
	 * as Markdown with the place's name (`model/devhubLink.ts`).
	 */
	| {
			readonly kind: "copy-link";
			readonly link: string;
			readonly markdown: boolean;
	  };

/**
 * The Orchestrator row's Workspace, the Workspaces under it, Scratch, then
 * the workspaces in sidebar order. See `sidebarOrder`.
 */
function orderedWorkspaces(
	snapshot: AppSnapshotWire,
): readonly WorkspaceWire[] {
	return sidebarOrder(sidebarWorkspaces(snapshot));
}

function scratchContext(snapshot: AppSnapshotWire): NavigationContext {
	return { kind: "workspace", workspaceId: snapshot.scratchWorkspaceId };
}

/**
 * Scratch, then the workspaces in sidebar order. What a digit names (0 is
 * Scratch); the Orchestrator row has `Cmd+Q Shift+O` and no digit, and
 * neither have the Workspaces under it (`sidebarWorkspaces`' `managed`): the
 * digits are the person's own places, and the orchestrator's come and go.
 */
function sidebarEntries(
	snapshot: AppSnapshotWire,
): readonly TabOf<string, string>[] {
	const { scratch, rows } = sidebarWorkspaces(snapshot);
	return [scratch, ...rows].map(
		(workspace): TabOf<string, string> => ({
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

/**
 * Every row of the tree, of both kinds, in the order it is drawn. The
 * Orchestrator row is not one of them (it has `Cmd+Q Shift+O`); the agents
 * under it are.
 */
function everyTab(snapshot: AppSnapshotWire): readonly TabOf<string, string>[] {
	return tabOrder(orderedWorkspaces(snapshot)).filter((tab) =>
		tab.kind === "workspace"
			? tab.workspaceId !== snapshot.orchestratorWorkspaceId
			: tab.agentId !== snapshot.orchestratorAgentId,
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
			: context.kind === "agent" &&
				workspace.agents.some((agent) => agent.id === context.agentId),
	);
}

/**
 * The link `Cmd+Q Y` copies: the selected Agent, the selected Workspace, or
 * on the Orchestrator row the task open over its board, else the row. Not
 * Scratch: it is today's folder, and a link to it would name another one
 * tomorrow.
 */
export function copyLinkOf(snapshot: AppSnapshotWire): string | undefined {
	const context = snapshot.selection.context;
	switch (context.kind) {
		case "agent":
			return formatDevhubLink({ kind: "agent", agent: context.agentId });
		case "workspace":
			return context.workspaceId === snapshot.scratchWorkspaceId
				? undefined
				: formatDevhubLink({
						kind: "workspace",
						workspace: context.workspaceId,
					});
		case "orchestrator": {
			const view = snapshot.orchestratorView?.view;
			return formatDevhubLink(
				view?.kind === "task"
					? { kind: "task", id: view.id }
					: { kind: "orchestrator" },
			);
		}
	}
}

/** The terminal pane with the keyboard, when it is the one on screen. */
function focusedTerminal(snapshot: AppSnapshotWire): string | undefined {
	const id = snapshot.paneFocus;
	return id !== undefined && id === snapshot.visibleTerminal ? id : undefined;
}

/** The Agent the selection is on, or nothing when it is on a row. */
function selectedAgent(snapshot: AppSnapshotWire): AgentWire | undefined {
	const context = snapshot.selection.context;
	if (context.kind !== "agent") return undefined;
	return everyAgent(snapshot).find((agent) => agent.id === context.agentId);
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
	if (
		!workspace ||
		workspace.id === snapshot.scratchWorkspaceId ||
		workspace.id === snapshot.orchestratorWorkspaceId
	) {
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
 * its ring — the Agent cycle walks the whole tree, so that every tab, an
 * editor's row included, steps from its own place in it — so a starting point
 * the ring does not hold is a broken snapshot, not a case (`tabPosition`).
 *
 * `wanted` is what makes `}` a narrowing of `]` rather than a second cycle: the
 * same ring, from the same place, in the same direction, stopping at the first
 * entry that qualifies. Every entry is offered exactly once before it gives up,
 * so a ring with nothing wanted in it is a no-op rather than a loop.
 */
function step(
	ring: readonly TabOf<string, string>[],
	from: NavigationContext,
	direction: 1 | -1,
	wanted: (index: number) => boolean = () => true,
): ChordEffect | undefined {
	// From the Orchestrator row, which is in no ring: as if from just before
	// the first entry (forward) or just after the last (back).
	const current =
		from.kind === "orchestrator"
			? direction === 1
				? -1
				: ring.length
			: tabPosition(ring, from);
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
		// `ordinal` is the digit as typed: 0 is Scratch, 1 the first workspace.
		const entry = entries[definition.ordinal ?? 0];
		return entry
			? { kind: "select-context", context: entry, reason: "explicit" }
			: undefined;
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

		case "close_selection": {
			// The small thing if you are standing on one, the big thing if you are
			// not. `close_workspace` is the same second half, under its own key.
			// The terminal with the keyboard is the smallest thing there is.
			const terminal = focusedTerminal(snapshot);
			if (terminal !== undefined) {
				return { kind: "close-terminal", terminalId: terminal };
			}
			return agent
				? { kind: "close-agent", agentId: agent.id }
				: closeWorkspace(snapshot, workspace);
		}

		case "restart_agent":
			return agent ? { kind: "restart-agent", agentId: agent.id } : undefined;

		case "close_workspace":
			return closeWorkspace(snapshot, workspace);

		case "toggle_workspace_managed":
			// The rule the row menu reads (`workspaceMenuItems`): Scratch and
			// the Orchestrator row's own are rows of their own.
			if (
				!workspace ||
				workspace.id === snapshot.scratchWorkspaceId ||
				workspace.id === snapshot.orchestratorWorkspaceId
			)
				return undefined;
			return {
				kind: "set-workspace-managed",
				workspaceId: workspace.id,
				managed: workspace.managed !== true,
			};

		case "reopen_closed":
		case "open_recently_closed":
			// Main keeps the stack; a snapshot that does not say how long it is
			// offers the command and main decides, the way history does.
			if (snapshot.recentlyClosed === 0) return undefined;
			return commandId === "reopen_closed"
				? { kind: "reopen-closed" }
				: { kind: "open-recently-closed" };

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

		case "show_notifications":
			return { kind: "show-notifications" };

		case "open_settings":
			return { kind: "open-settings" };

		case "open_log":
			return { kind: "open-log" };

		case "preview_color_theme":
			return { kind: "preview-color-theme" };

		case "open_task_manager":
			return { kind: "open-task-manager" };

		case "install_cli":
			return { kind: "install-cli" };

		case "restart_terminals":
			return { kind: "restart-terminals" };
		case "orchestrator_request":
			return { kind: "orchestrator-request" };
		case "orchestrator_full":
			return { kind: "orchestrator-mode", mode: "full" };
		case "orchestrator_saving":
			return { kind: "orchestrator-mode", mode: "saving" };
		case "orchestrator_off":
			return { kind: "orchestrator-mode", mode: "off" };

		case "show_chord_help":
			return { kind: "open-chord-help" };

		case "open_command_palette":
			return { kind: "open-command-palette" };

		case "copy_link":
		case "copy_markdown_link": {
			const link = copyLinkOf(snapshot);
			return link === undefined
				? undefined
				: {
						kind: "copy-link",
						link,
						markdown: commandId === "copy_markdown_link",
					};
		}

		case "navigate_back":
		case "navigate_forward": {
			// A snapshot from before history existed says nothing, and then
			// the move is offered and the model decides.
			const forwards = commandId === "navigate_forward";
			const history = snapshot.history;
			if (history && !(forwards ? history.canGoForward : history.canGoBack))
				return undefined;
			return {
				kind: "navigate-history",
				direction: forwards ? "forward" : "back",
			};
		}

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

		case "swap_split_focus": {
			// Every pane on screen: the selection's own — one, or two side by
			// side — and the terminal on the right. With only the split, this
			// is the swap it always was.
			const beside = snapshot.selection.presentation === "beside";
			if (snapshot.visibleTerminal === undefined) {
				return beside ? { kind: "swap-split-focus" } : undefined;
			}
			return { kind: "cycle-pane-focus" };
		}

		case "toggle_terminal": {
			// The view's Agent: the selected one, or — on a Workspace's row
			// beside an Agent — the one the Workspace pairs with, which is
			// where `Cmd+Q Cmd+J` goes. No Agent, no terminal; the workbench
			// alone shows no Agent, so no terminal either. Both are said
			// rather than doing nothing.
			if (!workspace) return undefined;
			const owner = agent?.id ?? pairedAgentId(workspace);
			if (owner === undefined) {
				return { kind: "terminal-needs-agent", workspaceId: workspace.id };
			}
			if (!agent && snapshot.selection.presentation !== "beside") {
				return { kind: "terminal-needs-agent-view", workspaceId: workspace.id };
			}
			return { kind: "toggle-terminal", agentId: owner };
		}

		case "toggle_scratch":
			// Both directions, unconditionally: the model holds the memory this
			// turns on, so there is nothing here to decide and nothing to gate
			// on. On Scratch with nothing remembered it is a no-op there.
			return { kind: "toggle-place", place: "scratch" };

		case "toggle_orchestrator":
			// The same toggle to the Orchestrator screen, which is there with or
			// without an orchestrator assigned (without one it offers Start).
			return { kind: "toggle-place", place: "orchestrator" };

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
				return {
					kind: "select-context",
					context: { kind: "workspace", workspaceId: workspace.id },
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
			// The tree rather than the Agents alone, so that every tab steps from
			// its own row — an editor from its Workspace's, not from the Agent
			// `Cmd+Q Cmd+J` would toggle to; only the Agents are stops, and in
			// the same order `everyAgent` has them.
			const tabs = everyTab(snapshot);
			const unread = new Set(
				everyAgent(snapshot)
					.filter((one) => one.unread !== undefined)
					.map((one) => one.id),
			);
			return step(
				tabs,
				snapshot.selection.context,
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
				context.kind === "orchestrator" ||
				(context.kind === "workspace" &&
					(context.workspaceId === snapshot.scratchWorkspaceId ||
						context.workspaceId === snapshot.orchestratorWorkspaceId))
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
