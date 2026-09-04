/**
 * Where the chord layer meets Electron.
 *
 * Every `WebContents` DevHub owns — the App Shell page, each workbench, the
 * Settings window — gets the same handler, because a chord is about the
 * application, not about whichever surface happens to be focused. One router,
 * so arming in a terminal and completing in an editor is the same chord rather
 * than two half ones; and a change of focus disarms, so the second stroke
 * cannot land somewhere the person did not arm it against.
 *
 * `before-input-event` is the only place this can work, and for two reasons.
 * A chord typed over a workbench or an xterm has to be caught before that
 * surface sees it, and only the main process sits in front of every surface at
 * once. And it is the only key event DevHub sees **before an input method gets
 * involved**: with a Japanese IME active the second stroke of a chord would
 * otherwise go into the preedit and never arrive at all. That is why the stroke
 * is built from `input.code` — the physical key, which Chromium fills in even
 * when composition has turned `input.key` into `Process` — and why a completed
 * chord is `preventDefault`ed rather than merely acted on.
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
import { keyNameForCode } from "../../model/chordKeys.js";
import { editingCommandFor, type EditingRole } from "./editingCommands.js";
import { resolveChord, type ChordEffect } from "./chords.js";
import { KeyRouter, type ChordLayout, type KeyStroke } from "./keyRouter.js";
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
	/** Only an Agent has two presentations; absent means the plain, full one. */
	selectContext(
		context: NavigationContext,
		presentation?: SurfacePresentationWire,
	): void;
	/** Side by side: move the keyboard between the editor and the Agent. */
	swapSplitFocus(): void;
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
	/** Stop this Agent, asking first exactly as the row's own close does. */
	closeAgent(agentId: string): void;
	/** Close it — and delete the worktree, if that is what it is. */
	closeWorkspace(workspaceId: string): void;
	/** Hand this workspace's folder to something outside DevHub. */
	openWorkspaceExternally(workspaceId: string): void;
	/** Look at every workspace's branch, pull request and Issue again, now. */
	refreshRepositories(): void;
	/** The list of chords, drawn from the registry they are run from. */
	openChordHelp(): void;
	openSettings(): void;
}

const router = new KeyRouter();
let installed = false;

/**
 * One Electron input event as a stroke.
 *
 * The key is derived from `input.code`, never from `input.key`. See
 * `model/chordKeys.ts`: the character is a function of the modifiers, the
 * layout and whether an input method is composing, and a binding compared
 * against it is a binding that stops working when any of those change.
 */
function strokeOf(input: Electron.Input): KeyStroke {
	return {
		key: keyNameForCode(input.code),
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
			host.selectContext(effect.context, effect.presentation);
			return;
		case "swap-split-focus":
			host.swapSplitFocus();
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
		case "close-agent":
			host.closeAgent(effect.agentId);
			return;
		case "close-workspace":
			host.closeWorkspace(effect.workspaceId);
			return;
		case "open-workspace-externally":
			host.openWorkspaceExternally(effect.workspaceId);
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
 * objects Electron delivers — including the ones an input method produces —
 * without an Electron window to attach to. `take` is what `preventDefault`
 * would do; `contents` is only consulted for the editing keys.
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
		const command = editingCommandFor(url, stroke);
		if (!command) return;
		take();
		editing(command.role);
		return;
	}
	// Everything else is the chord layer's: armed, cancelled, consumed or run.
	// Taken *before* the command is resolved, so a chord whose command has
	// nothing to act on is still swallowed — a half-eaten chord reaching a
	// surface would be worse than one that did nothing. This is also what keeps
	// the stroke away from an input method: a completed chord never becomes
	// preedit text.
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
	contents.on("focus", () => {
		router.focusChanged();
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

/** Install once, for every web contents this process will ever own. */
export function installKeyboard(host: ChordHost): void {
	if (installed) return;
	installed = true;
	electron.app.on("web-contents-created", (_event, contents) => {
		attach(contents, host);
	});
	for (const contents of electron.webContents.getAllWebContents()) {
		attach(contents, host);
	}
}

/** For tests only: forget the arming and the table between cases. */
export function resetChordRouterForTests(): void {
	router.focusChanged();
}
