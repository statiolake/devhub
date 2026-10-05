/**
 * Where the chord layer meets Electron.
 *
 * Every `WebContents` DevHub owns — each of DevHub's own pages, each workbench,
 * the Settings window — gets the same handler, because a chord is about the
 * application, not about whichever surface happens to be focused. There is one
 * router for the whole process and therefore **one queue**: arming over a
 * terminal and completing over an editor is one chord, and no surface holds a
 * half-chord of its own that a switch away from it could strand.
 *
 * Moving the keyboard does **not** disarm it, and that is a decision rather
 * than an omission. It used to: every `focus` on every web contents cleared
 * the armed prefix. That was written for a window with two pages in it, where
 * the keyboard moving between contents was rare. DevHub's window is becoming a
 * tree of child views — sidebar, agents, editors, toasts, picker — and a focus
 * move between them is what using the app looks like, so the old rule would
 * have cancelled chords for going on with the work. The prefix belongs to the
 * application for one second; see `KeyRouter.disarm`.
 *
 * `before-input-event` is the only place this can work. A chord typed over a
 * workbench or an xterm has to be caught before that surface sees it, and only
 * the main process sits in front of every surface at once. A completed chord
 * is `preventDefault`ed rather than merely acted on, so its keys never reach
 * the surface underneath.
 *
 * It is **not** in front of an input method. On macOS Chromium lets the input
 * method see a key first, and a key the input method takes is never raised as
 * `before-input-event` at all — with Japanese input on, the second stroke of a
 * chord would simply become preedit text. The prefix is Command-modified,
 * which an input method leaves alone, so it always arrives; and while it is
 * armed the input source is an ASCII-capable one (`chordInputSource.ts`), so
 * the second stroke arrives too, as the character it is.
 *
 * Sitting in front of every surface is also what lets this module answer the
 * Mac's editing keys for the one surface that cannot answer them itself. See
 * `editingCommands.ts`: Cmd+A in a Settings text box is decided here, per web
 * contents, because a menu accelerator would decide it for the whole
 * application and take Select All away from the editor.
 *
 * There is no on-screen hint that the prefix is armed. The App Shell page has
 * no status bar to put one in, and the page is covered by a workbench view for
 * most of a session, so a hint drawn there would be invisible exactly when it
 * was wanted. Somewhere to show it is a real gap; inventing a floating badge
 * for it is not this module's call.
 */

import { electron } from "../electron.js";
import { strokeKey } from "../../model/chordKeys.js";
import { ChordInputSource, type InputSourcePort } from "./chordInputSource.js";
import { editingCommandFor, type EditingRole } from "./editingCommands.js";
import { terminalZoomFor } from "./terminalZoom.js";
import { historyDirectionFor } from "./historyKeys.js";
import type { NavigationDirection } from "../../model/navigationHistory.js";
import { resolveChord, type ChordEffect, type Landing } from "./chords.js";
import {
	defaultChordLayout,
	KeyRouter,
	type ChordLayout,
	type KeyStroke,
} from "./keyRouter.js";
import type { TerminalZoomDirection } from "../../model/terminalZoom.js";
import type {
	AppSnapshotWire,
	NavigationContext,
	SurfacePresentationWire,
} from "../../ipc/appShell.js";

/**
 * What a chord needs from the rest of the app.
 *
 * Deliberately the same handful of commands the rest of DevHub can already be
 * asked for by pointing at something: a chord is another way to raise a command
 * DevHub has, never a second implementation of one.
 */
export interface ChordHost {
	/** The model as the page sees it, or nothing before the first projection. */
	snapshot(): AppSnapshotWire | undefined;
	/**
	 * Go there, and take the keyboard along.
	 *
	 * Both moves below are a person going somewhere from the keyboard, so both
	 * end with the keyboard in what they selected — out of the Sidebar too, if
	 * that is where the chord was typed, because a chord is not the Sidebar's
	 * own Return. `focus` is where it lands inside an editor (see `Landing`);
	 * absent, the editor keeps whatever it was last typed into.
	 *
	 * Only an Agent has two presentations; absent means the plain, full one.
	 */
	selectContext(
		context: NavigationContext,
		presentation?: SurfacePresentationWire,
		focus?: Landing,
	): void;
	/** Side by side: move the keyboard between the editor and the Agent. */
	swapSplitFocus(): void;
	/** Put the keyboard on the Sidebar's selected row — the way into the tree. */
	focusSidebar(): void;
	/** Show the Sidebar as its icon rail, or give it its width back. */
	toggleSidebar(): void;
	/**
	 * Jump out to Scratch, or back to where the jump out started — a move like
	 * `selectContext`, landing the same way, to a place only the model knows.
	 */
	toggleScratch(focus: Landing): void;
	openWorkspacePicker(): void;
	/** Every workspace and Agent, as a list to choose from. */
	openTabPicker(): void;
	/** Ask which Agent to start in this workspace — the sidebar's `+`. */
	openAgentPicker(workspaceId: string): void;
	/** Take an Issue and start work on it — the sidebar's Issue button. */
	openIssuePicker(): void;
	/** Ask which of this Agent's configured actions to send it. */
	openAgentActions(agentId: string): void;
	/** Ask what this Agent should be called — the row's Rename. */
	renameAgent(agentId: string): void;
	/** Owe this Agent a look again — the row menu's Mark as Unread. */
	markAgentUnread(agentId: string): void;
	/** Put away whichever failure the window in front is showing. */
	dismissAlert(): void;
	/**
	 * Zoom every Agent pane's text one step, or forget the zoom.
	 *
	 * Answers whether it acted. It declines while a question is up — that is
	 * main's fact to know, not one to read off a URL — and a key it declined is
	 * left alone rather than swallowed, so it reaches the surface underneath
	 * exactly as an unbound key does.
	 */
	terminalZoom(direction: TerminalZoomDirection): boolean;
	/**
	 * Back or Forward through the places the window has shown — `Cmd+[` and
	 * `Cmd+]` on DevHub's own pages (`historyKeys.ts`).
	 *
	 * Answers whether it took the key, on the zoom's terms: it declines while
	 * a question is up, and a declined key travels on untouched.
	 */
	navigateHistory(direction: NavigationDirection): boolean;
	/** Stop this Agent, asking first exactly as the row's own close does. */
	closeAgent(agentId: string): void;
	/** Restart this Agent's session, asking first exactly as the row menu's Restart Session does. */
	restartAgent(agentId: string): void;
	/** Close it — and delete the worktree, if that is what it is. */
	closeWorkspace(workspaceId: string): void;
	/**
	 * Put the rows in this order — the Sidebar's own drag, under a key.
	 *
	 * `workspaceId` absent is the top-level rows; present is that workspace's
	 * Agents. Where a row may go was decided before this was raised, by the one
	 * rule the pointer obeys too.
	 */
	reorderEntries(order: readonly string[], workspaceId?: string): void;
	/** Look at every workspace's branch, pull request and Issue again, now. */
	refreshRepositories(): void;
	/** The list of chords, drawn from the registry they are run from. */
	openChordHelp(): void;
	openSettings(): void;
}

/**
 * The input source that follows the arming, once the keyboard is installed.
 *
 * Nothing routes a key before `installKeyboard` attaches the handler, so the
 * only arming it can miss is a test's driving `handleInput` directly.
 */
let inputSource: ChordInputSource | undefined;
const router = new KeyRouter(defaultChordLayout(), {
	armed: (deadline) => inputSource?.armed(deadline),
	disarmed: () => inputSource?.disarmed(),
});
let installed = false;

/**
 * One Electron input event as a stroke.
 *
 * The identity is the *character* the key produced, because Chromium has
 * already applied the modifiers and the layout to work it out — see
 * `model/chordKeys.ts`, which also says why the physical `code` cannot be that
 * identity.
 */
function strokeOf(input: Electron.Input): KeyStroke {
	return {
		key: strokeKey(input.key),
		code: input.code,
		command: input.meta,
		shift: input.shift,
		option: input.alt,
		control: input.control,
		isAutoRepeat: input.isAutoRepeat,
	};
}

function perform(host: ChordHost, effect: ChordEffect): void {
	switch (effect.kind) {
		case "select-context":
			host.selectContext(effect.context, effect.presentation, effect.focus);
			return;
		case "swap-split-focus":
			host.swapSplitFocus();
			return;
		case "focus-sidebar":
			host.focusSidebar();
			return;
		case "toggle-sidebar":
			host.toggleSidebar();
			return;
		case "toggle-scratch":
			host.toggleScratch(effect.focus);
			return;
		case "open-workspace-picker":
			host.openWorkspacePicker();
			return;
		case "open-tab-picker":
			host.openTabPicker();
			return;
		case "open-agent-picker":
			host.openAgentPicker(effect.workspaceId);
			return;
		case "open-issue-picker":
			host.openIssuePicker();
			return;
		case "open-agent-actions":
			host.openAgentActions(effect.agentId);
			return;
		case "rename-agent":
			host.renameAgent(effect.agentId);
			return;
		case "mark-agent-unread":
			host.markAgentUnread(effect.agentId);
			return;
		case "dismiss-alert":
			host.dismissAlert();
			return;
		case "close-agent":
			host.closeAgent(effect.agentId);
			return;
		case "restart-agent":
			host.restartAgent(effect.agentId);
			return;
		case "close-workspace":
			host.closeWorkspace(effect.workspaceId);
			return;
		case "reorder-entries":
			host.reorderEntries(effect.order, effect.workspaceId);
			return;
		case "refresh-repositories":
			host.refreshRepositories();
			return;
		case "open-chord-help":
			host.openChordHelp();
			return;
		case "open-settings":
			host.openSettings();
			return;
	}
}

/**
 * Decide one key event and, when the chord layer wants it, take it.
 *
 * Exported so the whole decision can be tested against the exact `Input`
 * objects Electron delivers without an Electron window to attach to. `take`
 * is what `preventDefault` would do; `contents` is only consulted for the
 * editing keys.
 */
export function handleInput(
	host: ChordHost,
	input: Electron.Input,
	url: string,
	take: () => void,
	editing: (role: EditingRole) => void,
	now: number = Date.now(),
): void {
	if (input.type !== "keyDown") return;
	const stroke = strokeOf(input);
	const decision = router.route(stroke, now);
	// `forward` and `pass` both mean the same thing to Electron: leave the
	// event alone and let the surface have it. They are separate decisions
	// because they mean different things to a reader.
	if (decision.kind === "forward") return;
	if (decision.kind === "pass") {
		// The chord layer wants nothing from this key. It may still be one of
		// the Mac's editing keys landing on a surface that has no way to
		// answer it — DevHub's own chrome — in which case this layer answers
		// it, and only for that surface. Anywhere else the key travels on
		// untouched, which is what leaves Cmd+A to Monaco.
		// The Agent panes' zoom is the same shape of answer — a key that means
		// something on one of DevHub's own pages and nothing anywhere else —
		// and it is asked first because it is the narrower claim: one page,
		// three chords, none of which the editing keys spell.
		// Back and Forward, on DevHub's own pages only: over a workbench the
		// brackets are VS Code's, and so is its own Back and Forward.
		const direction = historyDirectionFor(url, stroke);
		if (direction !== undefined && host.navigateHistory(direction)) {
			take();
			return;
		}
		const zoom = terminalZoomFor(url, stroke);
		if (zoom !== undefined && host.terminalZoom(zoom)) {
			take();
			return;
		}
		const command = editingCommandFor(url, stroke);
		if (!command) return;
		take();
		editing(command.role);
		return;
	}
	// Everything else is the chord layer's: armed, cancelled, consumed or run.
	// Taken *before* the command is resolved, so a chord whose command has
	// nothing to act on is still swallowed — a half-eaten chord reaching a
	// surface would be worse than one that did nothing.
	take();
	if (decision.kind !== "run") return;
	// Before the first projection there is no model to resolve against, and a
	// chord that arrives then has nothing to act on.
	const snapshot = host.snapshot();
	if (!snapshot) return;
	const effect = resolveChord(decision.commandId, snapshot);
	// A chord with nothing to act on — no agents, no seventh workspace — is a
	// no-op by design, not a failure.
	if (effect) perform(host, effect);
}

function attach(contents: Electron.WebContents, host: ChordHost): void {
	contents.on("before-input-event", (event, input) => {
		handleInput(
			host,
			input,
			contents.getURL(),
			() => {
				event.preventDefault();
			},
			(role) => {
				contents[role]();
			},
		);
	});
}

/**
 * Adopt a table the configuration produced.
 *
 * The router is one object for the whole process — one arming, one table — so
 * this is how `[keybindings]` reaches it, and it is called again every time the
 * file changes. See `main/shell/appController.ts`.
 */
export function setChordLayout(layout: ChordLayout): void {
	router.setLayout(layout);
}

/**
 * Install once, for every web contents this process will ever own.
 *
 * `port` is the input source the chords switch (see `chordInputSource.ts`), and
 * `report` is the root surface its failure is said on.
 */
export function installKeyboard(
	port: InputSourcePort,
	report: (failure: unknown) => void,
	host: ChordHost,
): void {
	if (installed) return;
	installed = true;
	inputSource = new ChordInputSource(port, report);
	// Leaving DevHub ends a chord. See `KeyRouter.leave`.
	electron.app.on("did-resign-active", () => {
		router.leave();
	});
	electron.app.on("web-contents-created", (_event, contents) => {
		attach(contents, host);
	});
	for (const contents of electron.webContents.getAllWebContents()) {
		attach(contents, host);
	}
}

/** For tests only: forget the arming between cases. */
export function resetChordRouterForTests(): void {
	router.forgetArmingForTests();
}
