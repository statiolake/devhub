/**
 * DevHub's default chord table.
 *
 * Command-Q is DevHub's prefix, the way Ctrl-Q is the prefix in the terminal
 * multiplexer this app is meant to replace. Every DevHub-level navigation
 * command is a two-stroke chord: Command-Q, then one ordinary key. Nothing is
 * a single shortcut, because DevHub's surfaces are whole applications — a VS
 * Code workbench, an xterm — and a single key taken from them is a key their
 * own users lose (see `menu.ts`, which deliberately has no accelerators).
 *
 * The bindings are modelled on the person's existing multiplexer environment
 * (`prefix = ctrl+q` there, `Command-Q` here) so the muscle memory carries
 * over unchanged.
 *
 * ## The default table
 *
 * | Chord                       | Does                                          | Origin                    |
 * | --------------------------- | --------------------------------------------- | ------------------------- |
 * | `Cmd+Q Cmd+Q`               | forward a real Command-Q to the active surface | DevHub (quit)             |
 * | `Cmd+Q Shift+P`             | previous sidebar entry (workspace cycle)       | `previous_workspace`      |
 * | `Cmd+Q Shift+N`             | next sidebar entry (workspace cycle)           | `next_workspace`          |
 * | `Cmd+Q {`                   | previous agent in the current workspace        | `previous_agent`          |
 * | `Cmd+Q }`                   | next agent in the current workspace            | `next_agent`              |
 * | `Cmd+Q T`                   | toggle the workbench's integrated terminal     | DevHub                    |
 * | `Cmd+Q Ctrl+J`              | the same toggle, under the multiplexer's key   | tmux `bind C-j`           |
 * | `Cmd+Q F`                   | Add Workspace (the picker)                     | `prefix+f` (`hp`)         |
 * | `Cmd+Q Shift+C`             | Add Workspace (the same picker)                | `new_workspace`           |
 * | `Cmd+Q C`                   | New Agent in the selected workspace            | `prefix+c` (new tab)      |
 * | `Cmd+Q ,`                   | rename the selected agent                      | `rename_tab`              |
 * | `Cmd+Q Shift+W`             | close the selected workspace                   | tmux `bind W` kill-session|
 * | `Cmd+Q Shift+,`             | DevHub Settings                                | `settings`                |
 * | `Cmd+Q 1`…`Cmd+Q 9`         | select the Nth sidebar entry (Scratch = 1)     | extension (tmux idiom)    |
 *
 * ## The decisions behind that table
 *
 * **Scratch is entry 1 and part of the workspace cycle.** It is a row of the
 * sidebar like any other, it is where the global terminal and the folderless
 * workbench live, and a cycle that skipped it would make `Cmd+Q Shift+N` and
 * `Cmd+Q 1` disagree about what the list is. One list, one order: Scratch,
 * then the workspaces in sidebar order, wrapping at both ends.
 *
 * **Lower case acts inside the selected workspace; upper case makes a new
 * one.** That is the multiplexer's own rule — `prefix+c` opens a tab in this
 * session, `prefix+Shift+C` opens a session — and DevHub keeps the shape with
 * the nouns it has: `Cmd+Q C` adds an Agent to the workspace that is selected,
 * `Cmd+Q Shift+C` adds a workspace. So the case of the key says how far the
 * command reaches, and that holds without having to remember it per row.
 *
 * **`Cmd+Q F` and `Cmd+Q Shift+C` are one command with two keys.** In the
 * multiplexer these were two things — a fuzzy finder over the project
 * directories, and "make me a session" — and DevHub's workspace picker is
 * already both: it searches the configured sources and offers to create what
 * it did not find. Two rows onto one command is not two implementations, and
 * dropping either would break muscle memory that really was two keys.
 *
 * **Rename means the selected Agent.** A workspace is named by the folder it
 * is open on, so there is nothing about it to rename; an Agent has a display
 * name a person chose, and it is the row `rename_tab` was reaching for. With a
 * workspace row or Scratch selected the chord is a no-op, like every other
 * chord with nothing to act on.
 *
 * **There is no activity ring left to cycle.** `Cmd+Q P` / `Cmd+Q N` and their
 * Control variants cycled Editor → Agent → Terminal. A context is now one
 * arrangement — a workbench, or a workbench with an Agent's pane beside it —
 * so there is nothing to step through and the four rows are gone rather than
 * given a new meaning. What is left of "show me the terminal" is `Cmd+Q T`,
 * which toggles the workbench's own integrated terminal: the terminal is
 * inside the workbench now, and the command that shows it is the workbench's.
 * `Cmd+Q Ctrl+J` is the same command under the key the multiplexer's
 * VS-Code-shaped binding used, because that is the finger that expects a
 * terminal to appear at the bottom of the window.
 *
 * **Not applicable, deliberately absent.** Panes (`focus_pane_*`,
 * `swap_pane_*`, `cycle_pane_next`, `zoom`), splits (`split_vertical`,
 * `split_horizontal`), the pane-moving commands (`hpe`, `hpm`, break-pane),
 * `previous_tab` / `next_tab`, `detach`, `reload_config` and the popup runners
 * (`hcmd`, `hrun`) have no DevHub concept behind them: DevHub's surfaces are
 * not tiled, a workspace's tabs belong to the VS Code workbench inside it and
 * answer its own keys, there is no session to detach from a client, and the
 * config file is re-read when it changes rather than on request. They are left
 * unbound rather than given invented meanings — an unbound chord key cancels,
 * so nothing surprising happens if one is typed out of habit.
 *
 * ## The rules
 *
 * - The prefix arms for exactly `PREFIX_TIMEOUT_MS`; after that the next
 *   Command-Q arms again rather than completing.
 * - **A second key that is not in this table cancels the chord and is *not*
 *   forwarded.** Once the prefix is armed the keyboard belongs to the chord
 *   layer, so a mistyped chord does nothing at all rather than firing whatever
 *   the surface would have done with that key. Only `Cmd+Q Cmd+Q` is ever
 *   forwarded, and that is a table entry.
 * - A chord whose command has nothing to act on (no agents, no other
 *   workspace) is a no-op, not an error.
 * - Changing focus disarms, so the second stroke cannot land somewhere else.
 *
 * ## These are defaults
 *
 * `DEFAULT_CHORDS` is data, and the router takes its table as a constructor
 * argument. A user-level override — reading the same keybindings file the
 * person's editor reads and producing another `ChordBinding[]` — is a matter
 * of building a different array and handing it to `KeyRouter`. That mechanism
 * is deliberately not built yet; this file is only the defaults.
 */

import type { AppSnapshotWire, NavigationContext } from "../../ipc/appShell.js";

/** What a chord asks DevHub to do, before it is resolved against the model. */
export type ChordAction =
	/** Not a command: let this stroke through as an ordinary Command-Q. */
	| { readonly kind: "forward-prefix" }
	| { readonly kind: "cycle-workspace"; readonly step: 1 | -1 }
	| { readonly kind: "cycle-agent"; readonly step: 1 | -1 }
	| { readonly kind: "toggle-terminal" }
	/** One-based, as it is typed: 1 is Scratch. */
	| { readonly kind: "select-entry"; readonly ordinal: number }
	| { readonly kind: "add-workspace" }
	/** Add an Agent to whichever workspace is selected. */
	| { readonly kind: "add-agent" }
	/** Rename whichever Agent is selected. */
	| { readonly kind: "rename-agent" }
	/** Close whichever workspace is selected. */
	| { readonly kind: "close-workspace" }
	| { readonly kind: "open-settings" };

/**
 * One row of the table: the key that completes the chord, and what it does.
 *
 * Modifiers are matched exactly — an absent flag means the modifier must be
 * *up*, so `Cmd+Q P` and `Cmd+Q Ctrl+P` are different rows rather than one row
 * that ignores Control.
 */
export interface ChordBinding {
	/** Compared case-insensitively against Electron's `input.key`. */
	readonly key: string;
	readonly command?: boolean;
	readonly shift?: boolean;
	readonly control?: boolean;
	readonly option?: boolean;
	readonly action: ChordAction;
}

/**
 * `Cmd+Q 1` … `Cmd+Q 9`.
 *
 * Nine rows written by a loop rather than by hand: they differ only in the
 * digit, and nine hand-written rows are nine chances to mistype one.
 */
const DIGIT_CHORDS: readonly ChordBinding[] = Array.from(
	{ length: 9 },
	(_unused, index): ChordBinding => ({
		key: String(index + 1),
		action: { kind: "select-entry", ordinal: index + 1 },
	}),
);

export const DEFAULT_CHORDS: readonly ChordBinding[] = [
	// The chord DevHub started with: the second Command-Q is the real one.
	{ key: "q", command: true, action: { kind: "forward-prefix" } },

	{ key: "p", shift: true, action: { kind: "cycle-workspace", step: -1 } },
	{ key: "n", shift: true, action: { kind: "cycle-workspace", step: 1 } },

	// `{` and `}` are typed with Shift on a US layout, and Electron reports the
	// shifted character with `shift` set. Both facts are in the row.
	{ key: "{", shift: true, action: { kind: "cycle-agent", step: -1 } },
	{ key: "}", shift: true, action: { kind: "cycle-agent", step: 1 } },

	{ key: "t", action: { kind: "toggle-terminal" } },
	// The multiplexer's VS-Code-shaped binding for the same panel.
	{ key: "j", control: true, action: { kind: "toggle-terminal" } },

	{ key: "c", shift: true, action: { kind: "add-workspace" } },
	// The fuzzy project finder and "make me a session" are one command here,
	// because the picker both searches and creates.
	{ key: "f", action: { kind: "add-workspace" } },

	{ key: "c", action: { kind: "add-agent" } },
	{ key: ",", action: { kind: "rename-agent" } },
	{ key: "w", shift: true, action: { kind: "close-workspace" } },

	// Shift-comma. Layouts disagree about whether the key that arrives is the
	// shifted character or the unshifted one, so both spellings are rows.
	{ key: "<", shift: true, action: { kind: "open-settings" } },
	{ key: ",", shift: true, action: { kind: "open-settings" } },

	...DIGIT_CHORDS,
];

/** One keystroke as the main process sees it. */
export interface KeyStroke {
	/** Electron's `input.key`, compared case-insensitively. */
	readonly key: string;
	readonly command: boolean;
	readonly shift: boolean;
	readonly option: boolean;
	readonly control: boolean;
	readonly isAutoRepeat: boolean;
}

export function matchChord(
	table: readonly ChordBinding[],
	stroke: KeyStroke,
): ChordBinding | undefined {
	return table.find(
		(binding) =>
			binding.key.toLowerCase() === stroke.key.toLowerCase() &&
			(binding.command ?? false) === stroke.command &&
			(binding.shift ?? false) === stroke.shift &&
			(binding.control ?? false) === stroke.control &&
			(binding.option ?? false) === stroke.option,
	);
}

/**
 * What running a chord comes to, once it has been resolved against the model.
 *
 * Every one of these is something the menu bar can already ask for, which is
 * the point: a chord is another way to raise a command DevHub has, never a
 * second implementation of one.
 */
export type ChordEffect =
	| { readonly kind: "select-context"; readonly context: NavigationContext }
	| { readonly kind: "toggle-terminal" }
	| { readonly kind: "open-workspace-picker" }
	| { readonly kind: "open-agent-picker"; readonly workspaceId: string }
	| { readonly kind: "rename-agent"; readonly agentId: string }
	| { readonly kind: "close-workspace"; readonly workspaceId: string }
	| { readonly kind: "open-settings" };

const GLOBAL: NavigationContext = { kind: "global" };

/**
 * The sidebar, as a list: Scratch, then the workspaces in their own order.
 *
 * This is the one place that order is written down for the chords, so
 * `Cmd+Q 3` and three presses of `Cmd+Q Shift+N` cannot mean different rows.
 */
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

/** The workspace the selection is in, whether a row or one of its agents. */
function selectedWorkspace(snapshot: AppSnapshotWire) {
	const context = snapshot.selection.context;
	if (context.kind === "global") return undefined;
	return snapshot.workspaces.find((workspace) =>
		context.kind === "workspace"
			? workspace.id === context.workspaceId
			: workspace.agents.some((agent) => agent.id === context.agentId),
	);
}

/** The Agent the selection is on, or nothing when it is on a row. */
function selectedAgent(snapshot: AppSnapshotWire) {
	const context = snapshot.selection.context;
	if (context.kind !== "agent") return undefined;
	return snapshot.workspaces
		.flatMap((workspace) => workspace.agents)
		.find((agent) => agent.id === context.agentId);
}

function wrap(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/**
 * Turn a chord into the one thing it should do now, or nothing.
 *
 * Nothing is a real answer: `Cmd+Q }` in a workspace with no agents, or
 * `Cmd+Q 7` with three workspaces open, is a no-op. Raising an error for it
 * would put a red sentence on screen for a keystroke that simply had nowhere
 * to go.
 */
export function resolveChord(
	action: ChordAction,
	snapshot: AppSnapshotWire,
): ChordEffect | undefined {
	switch (action.kind) {
		case "forward-prefix":
			// Handled by the router before anything is resolved.
			return undefined;

		case "add-workspace":
			return { kind: "open-workspace-picker" };

		case "add-agent": {
			const workspace = selectedWorkspace(snapshot);
			// Scratch has no workspace to add one to, and a workspace that says
			// it cannot start an Agent — it is closing, or unavailable — is not
			// asked to. Either way the chord is a no-op.
			if (!workspace?.canCreateAgent) return undefined;
			return { kind: "open-agent-picker", workspaceId: workspace.id };
		}

		case "rename-agent": {
			const agent = selectedAgent(snapshot);
			return agent ? { kind: "rename-agent", agentId: agent.id } : undefined;
		}

		case "close-workspace": {
			const workspace = selectedWorkspace(snapshot);
			return workspace
				? { kind: "close-workspace", workspaceId: workspace.id }
				: undefined;
		}

		case "open-settings":
			return { kind: "open-settings" };

		case "toggle-terminal":
			return { kind: "toggle-terminal" };

		case "select-entry": {
			const entries = sidebarEntries(snapshot);
			const entry = entries[action.ordinal - 1];
			return entry ? { kind: "select-context", context: entry } : undefined;
		}

		case "cycle-workspace": {
			const entries = sidebarEntries(snapshot);
			if (entries.length < 2) return undefined;
			const workspace = selectedWorkspace(snapshot);
			const current = workspace
				? entries.findIndex(
						(entry) =>
							entry.kind === "workspace" && entry.workspaceId === workspace.id,
					)
				: 0;
			return {
				kind: "select-context",
				context: entries[wrap(current + action.step, entries.length)],
			};
		}

		case "cycle-agent": {
			const workspace = selectedWorkspace(snapshot);
			if (!workspace || workspace.agents.length === 0) return undefined;
			const context = snapshot.selection.context;
			const current =
				context.kind === "agent"
					? workspace.agents.findIndex((agent) => agent.id === context.agentId)
					: // With the workspace row itself selected there is no "current"
						// agent, so stepping forward lands on the first and stepping
						// back on the last.
						action.step === 1
						? -1
						: 0;
			const next =
				workspace.agents[wrap(current + action.step, workspace.agents.length)];
			return {
				kind: "select-context",
				context: { kind: "agent", agentId: next.id },
			};
		}
	}
}
