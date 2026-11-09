/**
 * One tmux control client (`tmux -C attach-session`) and the panes it shows:
 * the control-mode terminal's work in the pty host (`docs/terminal-mode.md`).
 *
 * The client is a child on plain pipes, not a PTY: a terminal would echo
 * every command back and cap a command line at the line discipline's 4 KiB.
 * Its output is the protocol (`tmuxControl.ts`). Each pane has an engine
 * (`vt/libghosttyVt.ts`) fed by its `%output`; what the page is told is the
 * session's windows, the shown window's pane rectangles, and each shown
 * pane's dirty rows, read from its engine at most once per `frameMs`.
 *
 * **Getting a pane's state.** A pane DevHub has not seen yet — at attach, a
 * new window or split, after a `%pause` — is read with `capture-pane` (its
 * history and screen, with attributes) and its cursor and modes with
 * `display-message`; the engine is reset and fed that. tmux answers commands
 * in order with the output it sends, so `%output` for that pane that comes
 * before the answer is already in it, and is dropped; what comes after is
 * applied. That is exact, with no guesswork about what overlapped.
 *
 * **Flow control.** The client asks for `pause-after`: a pane whose output
 * the client has not read for that long is paused (`%pause`) and its output
 * dropped by tmux; DevHub continues it and reads its state again. Towards
 * the page, at most `MAX_UNACKED` frames are in flight; a page that is behind
 * gets the rows that are dirty when it catches up, not every frame between.
 *
 * **Hidden panes.** A pane that is not shown (another window, a zoomed
 * sibling) keeps being fed, so it is current when it is shown, but none of
 * its rows are read or sent until then; nor are any while the page says it
 * is not on screen.
 */

import {
	NVIM_NAMED_OSC,
	type ControlToPage,
	type PageToControl,
	type PaneBox,
	type PaneModes,
	type SessionPane,
	type StatusLine,
	type WindowInfo,
	type WindowTab,
} from "../../../ipc/terminalControl.js";
import type { LibGhosttyVt, VtPane } from "../vt/libghosttyVt.js";
import { KeyRouter, parseBindings, waitingCommand } from "./keyGuard.js";
import { PopupJob, popupInput, type PopupPty } from "./popup.js";
import {
	STATUS_FORMAT,
	STATUS_SUBSCRIPTION,
	TAB_FIELD_COUNT,
	TAB_FORMAT,
	TABS_SUBSCRIPTION,
	parseStatus,
	parseTab,
} from "./statusLine.js";
import {
	ChooserSession,
	chooserOf,
	displayPanesOf,
	killConfirm,
	templateReplace,
	type ChooserArgs,
	type ChooserStep,
	type DisplayPanesArgs,
	type TreeNode,
} from "./chooser.js";
import {
	MenuSession,
	ifShellOf,
	keptItems,
	menuOf,
	plainText,
	menuPosition,
	type IfShellArgs,
	type MenuArgs,
	type MenuStep,
} from "./menu.js";
import {
	COPY_FORMAT,
	aimAt,
	copyCapture,
	copyScreen,
	copyState,
	matchSpans,
	plainLine,
	selectionSpans,
	type CopyState,
} from "./copyMode.js";
import {
	PromptSession,
	promptOf,
	untilControl,
	type PromptArgs,
	type PromptSessionInfo,
	type PromptStep,
} from "./prompt.js";
import {
	popupOf,
	popupPosition,
	popupSize,
	type PopupArgs,
} from "./tmuxCommand.js";
import {
	ControlParser,
	commandLine,
	layoutPanes,
	parseId,
	parseLayout,
	type ControlEvent,
	type LayoutNode,
	type TmuxId,
} from "./tmuxControl.js";

export type { ControlToPage, PageToControl, PaneBox, PaneModes, WindowInfo };

/** The child running `tmux -C attach-session`. */
export interface ControlProcess {
	write(text: string): void;
	onData(listener: (bytes: Uint8Array) => void): void;
	onExit(listener: (code?: number) => void): void;
	kill(): void;
}

export interface ControlClientOptions {
	readonly process: ControlProcess;
	readonly vt: LibGhosttyVt;
	readonly cols: number;
	readonly rows: number;
	readonly post: (message: ControlToPage) => void;
	/** The client ended: tmux exited, was detached, or the process died. */
	readonly ended: (reason: string) => void;
	readonly frameMs?: number;
	/** Lines of history read into a pane's engine, and kept there. */
	readonly scrollback?: number;
	/** Seconds behind before tmux pauses a pane (`pause-after`). */
	readonly pauseAfter?: number;
	readonly timers?: {
		set(fn: () => void, ms: number): unknown;
		clear(handle: unknown): void;
	};
	/** A pty for a popup's command (`popup.ts`); none: popups are refused. */
	readonly popup?: (cols: number, rows: number) => PopupPty;
}

const MAX_UNACKED = 4;
/** How long a binding that enters a mode has to leave it by itself. */
const MODE_SETTLE_MS = 250;
const NODE_TIMERS = {
	set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
	clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
};
const FIELD = "\u001f";
/** The subscription that says a pane's mode or `@devhub-nvim` changed. */
const PANE_FACTS = "devhub-pane";
const PANE_FACTS_FORMAT = `#{pane_in_mode}${FIELD}#{pane_mode}${FIELD}#{pane_synchronized}${FIELD}#{@devhub-nvim}`;
/** The modes DevHub draws on the pane (`copyMode.ts`): window-copy's two. */
const COPY_MODES = new Set(["copy-mode", "view-mode"]);
const NAMED = new TextEncoder().encode(NVIM_NAMED_OSC);

/** A rectangle in cells of the window. */
interface Box {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Where a click that opened something was: its target, and its cell. */
interface MouseAt {
	/** `%pane` or `@window`: what `-t =` names. */
	readonly target: string;
	/** tmux's name for it: `MouseDown3Pane`, `WheelUpPane`. */
	readonly key: string;
	/** Already handed on to the pane's mode (`send-keys -M`). */
	readonly viaMode?: boolean;
	readonly x: number;
	readonly y: number;
	readonly window?: number;
}

/**
 * A format for `display-message -p` expanded as `format_single` would,
 * without `strftime`: `display-message` runs it first, and `%%` is `%`.
 */
function noTime(format: string): string {
	return format.replace(/%/g, "%%");
}

/** A menu title as the page draws it: centred by the page, styles dropped. */
function plainTitle(title: string): string {
	return plainText(title);
}

interface Pane {
	readonly id: TmuxId;
	readonly vt: VtPane;
	window: TmuxId;
	/** Waiting for its `capture-pane`: its `%output` until then is in the capture. */
	syncing: boolean;
	/** Changed since it was last sent. */
	dirty: boolean;
	/** Send every row next time: it was hidden, resynchronised or resized. */
	all: boolean;
	lastCursor: string;
	/** In a mode (copy mode, a chooser). */
	inMode: boolean;
	/** Which (`#{pane_mode}`). */
	mode: string;
	/** `synchronize-panes` is on for it. */
	synchronized: boolean;
	/**
	 * Copy mode as DevHub draws it (`copyMode.ts`): the mode's rows in an
	 * engine of their own, shown in place of the pane's.
	 */
	copy:
		| {
				readonly vt: VtPane;
				reading: boolean;
				again: boolean;
				state?: CopyState;
		  }
		| undefined;
	/** `@devhub-nvim`: the socket a DevHub `nvim` in it named. */
	socket: string;
}

interface Window {
	readonly id: TmuxId;
	index: number;
	name: string;
	layout: LayoutNode | undefined;
	visible: LayoutNode | undefined;
	activePane: TmuxId | undefined;
	zoomed: boolean;
	/** Its tab as the status line formats it (`statusLine.ts`). */
	tab: WindowTab | undefined;
}

export class ControlClient {
	readonly #o: ControlClientOptions;
	readonly #parser = new ControlParser();
	readonly #replies: ((reply: {
		ok: boolean;
		lines: readonly string[];
	}) => void)[] = [];
	readonly #panes = new Map<TmuxId, Pane>();
	readonly #windows = new Map<TmuxId, Window>();
	#session = "";
	#activeWindow: TmuxId | undefined;
	#clientName = "";
	#prefixes: readonly string[] = [];
	#status: StatusLine | undefined;
	#cols: number;
	#rows: number;
	#visible = true;
	#seq = 0;
	#acked = 0;
	#flushTimer: unknown;
	#refreshing = false;
	#refreshAgain = false;
	#ended = false;
	#colors:
		| { foreground: number; background: number; palette?: readonly number[] }
		| undefined;
	readonly #router = new KeyRouter(new Map(), [], 500);
	#bindingsAt = 0;
	/** A pane's pending mode check (`pane-mode-changed`), by pane. */
	readonly #modeChecks = new Map<TmuxId, unknown>();
	/**
	 * Keys typed before the bindings were first read: they wait, since a key
	 * routed with no bindings known is a popup sent unseen.
	 */
	#keysBeforeBindings: string[] | undefined = [];
	/** The popup open now: the keys are its. */
	#popup: PopupJob | undefined;
	#popupSerial = 0;
	/** Keys typed while a popup was being opened: its, once it is. */
	#popupOpening: string[] | undefined;
	/** The prompt open now (`prompt.ts`): the keys are its. */
	#prompt: PromptSession | undefined;
	/**
	 * Keys and text typed while DevHub works out a binding it does itself (a
	 * prompt, a menu, an `if-shell -F`): the prompt's or menu's once it is
	 * open, else the panes'.
	 */
	#opening: (string | { text: string })[] | undefined;
	/** The menu open now (`menu.ts`): the keys are its. */
	#menu:
		| {
				readonly id: number;
				readonly session: MenuSession;
				readonly select?: readonly string[];
				readonly at: { readonly x: number | "W"; readonly y: number };
				/** A window's tab it was opened on (`-x W` is over it). */
				readonly window?: number;
		  }
		| undefined;
	#menuSerial = 0;
	/** The picker open now (`chooser.ts`): the keys are its. */
	#chooser:
		| {
				readonly id: number;
				readonly session: ChooserSession;
				readonly box: Box;
				readonly preview: Box;
				readonly vt: VtPane;
				timer: unknown;
				shown: string;
		  }
		| undefined;
	#chooserSerial = 0;
	/** `display-panes` showing now: the next key is its. */
	#numbers:
		| {
				readonly id: number;
				readonly args: DisplayPanesArgs;
				readonly panes: readonly { pane: number; index: number }[];
				timer: unknown;
		  }
		| undefined;
	/** What Tab completes to, read once: commands and aliases, options. */
	#completions: Promise<{ commands: string[]; options: string[] }> | undefined;

	constructor(options: ControlClientOptions) {
		this.#o = options;
		this.#cols = options.cols;
		this.#rows = options.rows;
		options.process.onData((bytes) => {
			this.#parser.feed(bytes, (event) => this.#event(event));
		});
		options.process.onExit(() => this.#end("exited"));
		void this.#start();
	}

	get clientName(): string {
		return this.#clientName;
	}

	/** What the page sent. */
	receive(message: PageToControl): void {
		if (this.#ended) return;
		switch (message.kind) {
			case "keys":
				this.#keys(message.keys);
				return;
			case "bytes": {
				if (message.pane === undefined && this.#promptText(message.bytes))
					return;
				if (this.#popup !== undefined && message.pane === undefined) {
					this.#popup.bytes(message.bytes);
					return;
				}
				const pane = message.pane ?? this.#activePane();
				if (pane === undefined || message.bytes.length === 0) return;
				this.#sendBytes(pane, message.bytes);
				return;
			}
			case "resize":
				this.#resize(message.cols, message.rows);
				return;
			case "menu":
				if (message.action === "close") this.#menuStep({ kind: "close" });
				else if (this.#menu !== undefined)
					this.#menuStep(this.#menu.session.choose(message.index ?? -1));
				return;
			case "mouse":
				this.#mouse(message);
				return;
			case "prompt-complete":
				if (this.#prompt !== undefined)
					this.#promptStep(this.#prompt, this.#prompt.choose(message.index));
				return;
			case "chooser":
				if (message.action === "close") this.#chooserStep({ kind: "close" });
				else if (this.#chooser !== undefined)
					this.#chooserStep(this.#chooser.session.choose(message.index ?? -1));
				return;
			case "select-pane":
				void this.#command(["select-pane", "-t", `%${String(message.pane)}`]);
				return;
			case "select-window":
				void this.#command([
					"select-window",
					"-t",
					`@${String(message.window)}`,
				]);
				return;
			case "visible":
				this.#visible = message.visible;
				if (message.visible) {
					this.#popup?.redraw();
					this.#postPrompt();
					this.#postMenu();
					for (const pane of this.#panes.values()) pane.all = true;
					this.#postLayout();
					this.#schedule();
				}
				return;
			case "ack":
				this.#acked = Math.max(this.#acked, message.seq);
				this.#schedule();
				return;
			case "colors":
				this.#colors = message;
				for (const pane of this.#panes.values()) {
					pane.vt.setColors(message);
					pane.all = true;
				}
				this.#schedule();
				return;
		}
	}

	/** Detach and end. */
	stop(): void {
		if (this.#ended) return;
		try {
			this.#o.process.write("detach-client\n");
		} catch {
			// The process is already gone.
		}
		this.#end("detached");
		this.#o.process.kill();
	}

	async #start(): Promise<void> {
		await this.#command([
			"refresh-client",
			"-C",
			`${String(this.#cols)}x${String(this.#rows)}`,
		]);
		await this.#command([
			"refresh-client",
			"-f",
			`pause-after=${String(this.#o.pauseAfter ?? 2)}`,
		]);
		// Where a Neovim DevHub draws over a pane is shown: tmux says a mode
		// change at once, and checks a subscription once a second; DevHub's
		// `nvim` also says it named its socket in the pane's output.
		await this.#command([
			"refresh-client",
			"-B",
			`${PANE_FACTS}:%*:${PANE_FACTS_FORMAT}`,
		]);
		// The status line DevHub draws (`statusLine.ts`): read now, then kept.
		const status = await this.#command([
			"display-message",
			"-p",
			STATUS_FORMAT,
		]);
		if (status.ok) this.#status = parseStatus(status.lines.join("\n"));
		await this.#command([
			"refresh-client",
			"-B",
			`${STATUS_SUBSCRIPTION}::${STATUS_FORMAT}`,
		]);
		await this.#command([
			"refresh-client",
			"-B",
			`${TABS_SUBSCRIPTION}:@*:#{window_active}${FIELD}${TAB_FORMAT}`,
		]);
		const name = await this.#command([
			"display-message",
			"-p",
			"#{client_name}",
		]);
		this.#clientName = name.lines[0] ?? "";
		await this.#readBindings();
		const waiting = this.#keysBeforeBindings ?? [];
		this.#keysBeforeBindings = undefined;
		this.#keys(waiting);
		await this.#refresh();
	}

	#event(event: ControlEvent): void {
		switch (event.type) {
			case "reply":
				if (event.own)
					this.#replies.shift()?.({ ok: event.ok, lines: event.lines });
				// A command tmux ran for this client (a prompt's template, a
				// menu's item) failed, or said something: tmux would say so in
				// the status line.
				else {
					const said = event.lines.filter((line) =>
						line.startsWith("%message "),
					);
					for (const line of said)
						this.#o.post({
							kind: "notice",
							text: line.slice("%message ".length),
						});
					if (!event.ok && event.lines.length > said.length)
						this.#o.post({
							kind: "notice",
							text: event.lines.filter((l) => !said.includes(l)).join(" "),
						});
				}
				return;
			case "output": {
				const pane = this.#panes.get(event.pane);
				if (pane === undefined) return;
				if (includes(event.data, NAMED)) void this.#readFacts(pane.id);
				if (pane.syncing) return;
				pane.vt.write(event.data);
				pane.dirty = true;
				this.#schedule();
				return;
			}
			case "layout-change": {
				const window = this.#windows.get(event.window);
				const known = layoutPanes(event.layout).every((p) =>
					this.#panes.has(p.pane),
				);
				if (window !== undefined && known) {
					window.layout = event.layout;
					window.visible = event.visible;
					window.zoomed = event.flags.includes("Z");
					this.#sizePanes(window);
					this.#postLayout();
					this.#schedule();
				} else {
					void this.#refresh();
				}
				return;
			}
			case "window-pane-changed": {
				const window = this.#windows.get(event.window);
				if (window !== undefined) window.activePane = event.pane;
				this.#postLayout();
				return;
			}
			case "session-window-changed":
				this.#activeWindow = event.window;
				for (const pane of this.#panes.values())
					if (pane.window === event.window) pane.all = true;
				this.#postLayout();
				this.#schedule();
				return;
			case "window-renamed": {
				const window = this.#windows.get(event.window);
				if (window !== undefined) window.name = event.name;
				this.#postLayout();
				return;
			}
			case "session-changed":
				this.#session = event.name;
				void this.#refresh();
				return;
			case "window-add":
			case "window-close":
			case "unlinked-window-close":
			case "session-renamed":
				void this.#refresh();
				return;
			case "pause":
				void this.#continue(event.pane);
				return;
			case "subscription-changed": {
				if (event.name === TABS_SUBSCRIPTION) {
					const window =
						event.window === undefined
							? undefined
							: this.#windows.get(event.window);
					if (window !== undefined) this.#setTab(window, event.value);
					return;
				}
				if (event.name === STATUS_SUBSCRIPTION) {
					const status = parseStatus(event.value);
					if (JSON.stringify(status) === JSON.stringify(this.#status)) return;
					this.#status = status;
					this.#postLayout();
					return;
				}
				if (event.name !== PANE_FACTS || event.pane === undefined) return;
				this.#facts(event.pane, event.value);
				return;
			}
			case "pane-mode-changed": {
				void this.#readFacts(event.pane);
				// tmux says so while the binding that entered the mode is still
				// running (prefix+y: copy-mode, select, copy-pipe-and-cancel), so
				// the pane is asked once that has had time to finish.
				// One check per pane, from its last change.
				const timers = this.#o.timers ?? NODE_TIMERS;
				const previous = this.#modeChecks.get(event.pane);
				if (previous !== undefined) timers.clear(previous);
				this.#modeChecks.set(
					event.pane,
					timers.set(() => {
						this.#modeChecks.delete(event.pane);
						void this.#leaveMode(event.pane);
					}, MODE_SETTLE_MS),
				);
				return;
			}
			case "exit":
				this.#end(event.reason.length > 0 ? event.reason : "detached");
				return;
			// What tmux would show in the client's status line: a
			// `display-message`, an error from a command a prompt ran.
			case "message":
				if (event.text !== "")
					this.#o.post({ kind: "notice", text: event.text });
				return;
			case "other":
				if (event.line.startsWith("%paste-buffer-changed ")) {
					void this.#clipboard(
						event.line.slice("%paste-buffer-changed ".length),
					);
					return;
				}
				if (event.line.trim() !== "" && !event.line.startsWith("%"))
					this.#o.post({ kind: "notice", text: event.line });
				return;
			default:
				return;
		}
	}

	/**
	 * Keys through the client's key tables, each looked up first
	 * (`keyGuard.ts`): a binding that would wait on the client is not sent.
	 */
	#keys(keys: readonly string[]): void {
		if (this.#keysBeforeBindings !== undefined) {
			this.#keysBeforeBindings.push(...keys);
			return;
		}
		if (this.#popupOpening !== undefined) {
			this.#popupOpening.push(...keys);
			return;
		}
		if (this.#opening !== undefined) {
			this.#opening.push(...keys);
			return;
		}
		if (this.#numbers !== undefined) {
			const [key, ...after] = keys;
			if (key === undefined) return;
			this.#numbersKey(key);
			this.#keys(after);
			return;
		}
		if (this.#chooser !== undefined) {
			for (const [index, key] of keys.entries()) {
				this.#chooserStep(this.#chooser.session.key(key));
				if (this.#chooser === undefined) {
					this.#keys(keys.slice(index + 1));
					return;
				}
			}
			return;
		}
		if (this.#menu !== undefined) {
			for (const [index, key] of keys.entries()) {
				this.#menuStep(this.#menu.session.key(key));
				if (this.#menu === undefined) {
					this.#keys(keys.slice(index + 1));
					return;
				}
			}
			return;
		}
		if (this.#prompt !== undefined) {
			for (const [index, key] of keys.entries()) {
				this.#promptKey(key);
				// A key that closed it: the rest are the panes' again.
				if (this.#prompt === undefined) {
					this.#keys(keys.slice(index + 1));
					return;
				}
			}
			return;
		}
		if (this.#popup !== undefined) {
			// A popup has the keys, the prefix too, as in tmux.
			for (const key of keys) this.#popup?.key(key);
			return;
		}
		let send: string[] = [];
		const flush = () => {
			if (send.length > 0)
				void this.#command([
					"send-keys",
					"-K",
					"-c",
					this.#clientName,
					"--",
					...send,
				]).then(() => this.#copyMoved());
			send = [];
		};
		for (const [index, key] of keys.entries()) {
			const route = this.#router.route(key, Date.now(), this.#rootTable());
			send.push(...route.send);
			if (route.own !== undefined) {
				flush();
				if (route.resetTable === true) {
					void this.#command([
						"switch-client",
						"-c",
						this.#clientName,
						"-T",
						"root",
					]);
				}
				void this.#hold(keys.slice(index + 1), this.#dispatch(route.own));
				return;
			}
			if (route.refused !== undefined) {
				flush();
				if (route.resetTable === true) {
					void this.#command([
						"switch-client",
						"-c",
						this.#clientName,
						"-T",
						"root",
					]);
				}
				this.#o.post({
					kind: "notice",
					text: `${route.refused.keys}: ${route.refused.command} is not available in control mode yet.`,
				});
			}
		}
		flush();
		// The bindings can change (a source-file, a bind typed at a prompt):
		// they are read again while the prefix waits for its key.
		if (this.#router.holdingPrefix && Date.now() - this.#bindingsAt > 5000)
			void this.#readBindings();
	}

	async #readBindings(): Promise<void> {
		this.#bindingsAt = Date.now();
		const keys = await this.#command(["list-keys"]);
		const options = await this.#command([
			"display-message",
			"-p",
			["#{prefix}", "#{prefix2}", "#{repeat-time}", "#{mode-keys}"].join(FIELD),
		]);
		if (!keys.ok || !options.ok) return;
		const [prefix, prefix2, repeat, modeKeys] = (options.lines[0] ?? "").split(
			FIELD,
		);
		this.#modeKeys = modeKeys ?? "emacs";
		const prefixes = [prefix, prefix2].filter(
			(p): p is string => p !== undefined && p !== "" && p !== "None",
		);
		this.#router.update(
			parseBindings(keys.lines),
			prefixes,
			Number(repeat) || 500,
		);
		if (prefixes.join(" ") !== this.#prefixes.join(" ")) {
			this.#prefixes = prefixes;
			this.#postLayout();
		}
	}

	/**
	 * A pane left in a mode tmux does not draw for this client (copy mode, a
	 * chooser) takes every key there unseen: once the command that entered it
	 * has finished, it is taken out of it, and that is said. A binding that
	 * enters copy mode and leaves it in one go (prefix+y's copy of the last
	 * command's output) is done by the time this asks, and is untouched.
	 */
	async #leaveMode(paneId: TmuxId): Promise<void> {
		if (this.#ended || !this.#panes.has(paneId)) return;
		const target = `%${String(paneId)}`;
		const state = await this.#command([
			"display-message",
			"-p",
			"-t",
			target,
			"#{pane_in_mode}" + FIELD + "#{pane_mode}",
		]);
		const [inMode, mode] = (state.lines[0] ?? "").split(FIELD);
		if (!state.ok || inMode !== "1" || COPY_MODES.has(mode ?? "")) return;
		await this.#command(["copy-mode", "-q", "-t", target]);
		this.#o.post({
			kind: "notice",
			text: `${mode !== undefined && mode !== "" ? mode : "This mode"} is not available in control mode yet.`,
		});
	}

	/**
	 * Run a `display-popup` binding as tmux would (`popup.ts`): its
	 * target pane's `TMUX`, `TMUX_PANE`, directory and the server's
	 * `default-shell` are read from tmux, `-d` and `-T` expanded by it, and
	 * its size and place worked out against the client's size as tmux does.
	 * `rest`: keys typed after the binding's, which are the popup's.
	 */
	async #openPopup(args: PopupArgs, rest: readonly string[]): Promise<void> {
		const spawn = this.#o.popup;
		if (spawn === undefined) {
			this.#o.post({
				kind: "notice",
				text: "display-popup is not available here.",
			});
			this.#keys(rest);
			return;
		}
		this.#popupOpening = [...rest];
		const active = this.#activePane();
		const target =
			args.target ?? (active === undefined ? undefined : `%${String(active)}`);
		const facts = await this.#command([
			"display-message",
			"-p",
			...(target === undefined ? [] : ["-t", target]),
			[
				"#{pane_id}",
				"#{socket_path},#{pid},#{session_id}",
				args.directory ?? "#{pane_current_path}",
				"#{default-shell}",
				args.title ?? "",
			].join(FIELD),
		]);
		// The PATH tmux gives a popup's job: its session's, else the server's.
		const paths = await Promise.all(
			[[...(target === undefined ? [] : ["-t", target])], ["-g"]].map((scope) =>
				this.#command(["show-environment", ...scope, "PATH"]),
			),
		);
		const path =
			paths
				.flatMap((answer) => (answer.ok ? answer.lines : []))
				.find((line) => line.startsWith("PATH="))
				?.slice("PATH=".length) ?? "";
		const waiting = this.#popupOpening;
		this.#popupOpening = undefined;
		const [pane, tmux, directory, shell, title] = facts.lines
			.join("\n")
			.split(FIELD);
		if (!facts.ok || pane === undefined || this.#ended) {
			this.#keys(waiting);
			return;
		}
		const cols = this.#cols;
		const rows = this.#rows;
		const width = popupSize(args.width, cols, Math.floor(cols / 2));
		const height = popupSize(args.height, rows, Math.floor(rows / 2));
		const box = {
			x: popupPosition(args.x, cols, width),
			y: popupPosition(args.y, rows, height, true),
			width,
			height,
		};
		const border = !args.noBorder && width > 2 && height > 2;
		const inner = {
			cols: border ? width - 2 : width,
			rows: border ? height - 2 : height,
		};
		this.#popup?.close();
		let pty: PopupPty;
		try {
			pty = spawn(inner.cols, inner.rows);
		} catch (failure: unknown) {
			this.#o.post({
				kind: "notice",
				text: `display-popup could not start: ${failure instanceof Error ? failure.message : String(failure)}`,
			});
			return;
		}
		const vt = this.#o.vt.open(inner.cols, inner.rows, 0);
		if (this.#colors !== undefined) vt.setColors(this.#colors);
		const id = ++this.#popupSerial;
		const job = new PopupJob({
			id,
			pty,
			vt,
			box,
			border,
			title: title ?? "",
			closeOnExit: args.closeOnExit,
			// tmux's `TMUX` names the session by its number, without the `$`.
			input: popupInput({
				directory: directory ?? "",
				tmux: (tmux ?? "").replace(/,$(\d+)$/, ",$1"),
				pane,
				shell: shell ?? "",
				command: args.command ?? "",
				path,
				environment: args.environment,
			}),
			changed: () => this.#schedule(),
			closed: () => {
				if (this.#popup === job) this.#popup = undefined;
				if (!this.#ended) this.#o.post({ kind: "popup-closed", id });
			},
		});
		this.#popup = job;
		for (const key of waiting) job.key(key);
		this.#schedule();
	}

	/**
	 * Ask a `command-prompt` or `confirm-before` binding (`prompt.ts`): its
	 * prompts and inputs expanded by tmux against the active pane, as tmux
	 * expands them; tmux's history of its type, `status-keys`,
	 * `word-separators` and the top buffer for its keys. `rest`: keys typed
	 * after the binding's, which are the prompt's.
	 */
	#openPrompt(args: PromptArgs, rest: readonly string[]): Promise<void> {
		return this.#hold(rest, this.#preparePrompt(args));
	}

	async #preparePrompt(args: PromptArgs): Promise<void> {
		const active = this.#activePane();
		const target = active === undefined ? [] : ["-t", `%${String(active)}`];
		const texts = args.prompts.flatMap((p) => [p.prompt, p.input]);
		const [facts, history, paste, completions, windows] = await Promise.all([
			this.#command([
				"display-message",
				"-p",
				...target,
				"--",
				["#{status-keys}", "#{word-separators}", ...texts].join(FIELD),
			]),
			this.#command(["show-prompt-history", "-T", args.type]),
			this.#command(["show-buffer"]),
			this.#readCompletions(),
			// Every session's windows, for Tab on a `-t` or a target prompt.
			this.#command([
				"list-windows",
				"-a",
				"-F",
				[
					"#{session_id}",
					"#{session_name}",
					"#{window_index}",
					"#{window_name}",
				].join(FIELD),
			]),
		]);
		if (this.#ended) return;
		const [keys, separators, ...expanded] = facts.lines.join("\n").split(FIELD);
		if (!facts.ok) {
			this.#o.post({ kind: "notice", text: facts.lines.join(" ") });
			return;
		}
		const session = new PromptSession(
			args,
			args.prompts.map((_, i) => ({
				prompt: expanded[2 * i] ?? "",
				input: expanded[2 * i + 1] ?? "",
			})),
			{
				vi: keys === "vi",
				separators: separators ?? "",
				history: history.ok
					? history.lines.flatMap((line) => {
							const entry = /^\d+: (.*)$/.exec(line);
							return entry === null ? [] : [entry[1]];
						})
					: [],
				paste: paste.ok ? paste.lines.join("\n") : undefined,
				...completions,
				sessions: windows.ok ? sessionsOf(windows.lines) : [],
				session: this.#session,
			},
		);
		this.#prompt = session;
		// An incremental prompt is tmux's from the start: it runs its
		// template as the answer changes.
		if (args.mode === "incremental") void this.#run([args.replay]);
		this.#postPrompt();
	}

	/** Keys and text typed while a binding was worked out, in order. */
	#replayOpening(waiting: readonly (string | { text: string })[]): void {
		for (const item of waiting) {
			if (typeof item === "string") this.#keys([item]);
			else {
				const bytes = new TextEncoder().encode(item.text);
				if (this.#promptText(bytes)) continue;
				const pane = this.#activePane();
				if (pane !== undefined) this.#sendBytes(pane, bytes);
			}
		}
	}

	/** Hold the keys typed while `work` runs; then they go where they now go. */
	async #hold(rest: readonly string[], work: Promise<void>): Promise<void> {
		if (this.#opening !== undefined) {
			// Held already: the outer hold replays them all.
			this.#opening.push(...rest);
			await work;
			return;
		}
		this.#opening = [...rest];
		await work;
		const waiting = this.#opening;
		this.#opening = undefined;
		this.#replayOpening(waiting);
	}

	/**
	 * A command DevHub does itself if tmux would wait on the client for it:
	 * a popup, a prompt or a menu is opened, an `if-shell -F` decided, any
	 * other waiting command refused; the rest is tmux's to run.
	 * `mouse`: where a click opened it, for `-t =` and `-x M`.
	 */
	async #dispatch(command: string, mouse?: MouseAt): Promise<void> {
		const popup = popupOf(command);
		if (popup !== undefined) return this.#openPopup(popup, []);
		const prompt = promptOf(command);
		if (prompt !== undefined) return this.#openPrompt(prompt, []);
		const menu = menuOf(command);
		if (menu !== undefined) return this.#openMenu(menu, [], mouse);
		const chooser = chooserOf(command);
		if (chooser !== undefined) return this.#openChooser(chooser);
		const numbers = displayPanesOf(command);
		if (numbers !== undefined) return this.#openNumbers(numbers);
		const conditional = ifShellOf(command);
		if (conditional !== undefined && waitingCommand(command) !== undefined)
			return this.#conditional(conditional, mouse);
		const waiting = waitingCommand(command);
		if (waiting !== undefined) {
			this.#o.post({
				kind: "notice",
				text: `${waiting} is not available in control mode yet.`,
			});
			return;
		}
		if (mouse !== undefined) {
			// `send-keys -M` hands the mouse on: to the pane's mode, whose
			// table's binding for it runs; to a program, which the page
			// reports it to itself.
			if (/^\s*send(-keys)?\s+-M\s*$/.test(command)) {
				const paneId = Number(mouse.target.slice(1));
				const pane = mouse.target.startsWith("%")
					? this.#panes.get(paneId)
					: undefined;
				if (pane !== undefined && COPY_MODES.has(pane.mode)) {
					const table = this.#modeKeys === "vi" ? "copy-mode-vi" : "copy-mode";
					const bound = this.#router.binding(table, mouse.key);
					if (bound !== undefined)
						await this.#dispatch(bound, { ...mouse, viaMode: true });
				}
				return;
			}
			if (mouse.target.startsWith("%"))
				await this.#runText(aimAt(command, mouse.target));
			return;
		}
		await this.#runText(command);
	}

	/** tmux decides an `if-shell -F`'s format at its target; the arm is run. */
	async #conditional(args: IfShellArgs, mouse?: MouseAt): Promise<void> {
		const target = this.#resolveTarget(args.target, mouse);
		const answer = await this.#command([
			"display-message",
			"-p",
			...(target === undefined ? [] : ["-t", target]),
			"--",
			noTime(args.condition),
		]);
		if (!answer.ok || this.#ended) return;
		const value = answer.lines.join("\n");
		const arm = value !== "" && value !== "0" ? args.then : args.otherwise;
		if (arm !== undefined) await this.#dispatch(arm, mouse);
	}

	/** `-t =` is the mouse's pane (or window); other targets are tmux's. */
	#resolveTarget(
		target: string | undefined,
		mouse?: MouseAt,
	): string | undefined {
		if (target === "=" && mouse !== undefined) return mouse.target;
		return target;
	}

	/**
	 * A command list as text, run by tmux as a binding's is, with one answer
	 * whatever it holds: `confirm-before -b` parses it (expanding formats, so
	 * a `#` is doubled) and runs it once `y` is typed into its prompt, on the
	 * client's queue with no state of its own.
	 */
	async #runText(command: string): Promise<void> {
		let line: string;
		try {
			line = commandLine([
				"confirm-before",
				"-b",
				"-c",
				"y",
				command.replace(/#/g, "##"),
			]);
		} catch (failure: unknown) {
			this.#o.post({
				kind: "notice",
				text: failure instanceof Error ? failure.message : String(failure),
			});
			return;
		}
		await this.#run([line, this.#typeInto(["y"])]);
		this.#copyMoved();
	}

	/**
	 * Ask a `display-menu` (`menu.ts`): its title, item names and commands
	 * expanded by tmux against its target pane, placed by tmux's rules.
	 */
	async #openMenu(
		args: MenuArgs,
		rest: readonly string[],
		mouse?: MouseAt,
	): Promise<void> {
		const work = (async () => {
			const active = this.#activePane();
			const target =
				this.#resolveTarget(args.target, mouse) ??
				(active === undefined ? undefined : `%${String(active)}`);
			const texts = [
				args.title,
				...args.items.flatMap((item) => [item.name, item.command]),
			];
			const facts = await this.#command([
				"display-message",
				"-p",
				...(target === undefined ? [] : ["-t", target]),
				"--",
				["#{pane_id}", "#{window_id}", ...texts.map(noTime)].join(FIELD),
			]);
			if (!facts.ok || this.#ended) {
				if (!facts.ok)
					this.#o.post({ kind: "notice", text: facts.lines.join(" ") });
				return;
			}
			const [paneText, windowText, title, ...expanded] = facts.lines
				.join("\n")
				.split(FIELD);
			const items = keptItems(
				args,
				args.items.map((_, i) => ({
					name: expanded[2 * i] ?? "",
					command: expanded[2 * i + 1] ?? "",
				})),
			);
			if (items.length === 0) return;
			const session = new MenuSession(title ?? "", items, args.startingChoice);
			const paneId = Number((paneText ?? "").slice(1));
			const box = this.#shownPanes().find((p) => p.pane === paneId) ?? {
				x: 0,
				y: 0,
				width: this.#cols,
				height: this.#rows,
			};
			const at = menuPosition(args.x, args.y, session.width, session.height, {
				cols: this.#cols,
				rows: this.#rows,
				pane: box,
				...(mouse === undefined ? {} : { mouse }),
			});
			// tmux runs the item with the menu's target as the current pane;
			// a control client's commands have its active pane: the target is
			// selected first when it is not that (a right-click elsewhere).
			const window = Number((windowText ?? "").slice(1));
			const select =
				paneId === active
					? undefined
					: window === this.#activeWindow || mouse?.window === undefined
						? ["select-pane", "-t", `%${String(paneId)}`]
						: ["select-window", "-t", `@${String(window)}`];
			this.#menu = {
				id: ++this.#menuSerial,
				session,
				at,
				...(select === undefined ? {} : { select }),
				...(mouse?.window === undefined ? {} : { window: mouse.window }),
			};
			this.#postMenu();
		})();
		await this.#hold(rest, work);
	}

	#postMenu(): void {
		const menu = this.#menu;
		if (menu === undefined || this.#ended) return;
		const place = menu.at;
		this.#o.post({
			kind: "menu",
			id: menu.id,
			title: plainTitle(menu.session.title),
			items: menu.session.items,
			choice: menu.session.choice,
			x: place.x,
			y: place.y,
			width: menu.session.width,
			height: menu.session.height,
			...(menu.window === undefined ? {} : { window: menu.window }),
		});
	}

	#menuStep(step: MenuStep): void {
		const menu = this.#menu;
		if (menu === undefined) return;
		switch (step.kind) {
			case "unchanged":
				return;
			case "changed":
				this.#postMenu();
				return;
			case "close":
				this.#closeMenu();
				return;
			case "run":
				this.#closeMenu();
				void (async () => {
					if (menu.select !== undefined) await this.#command(menu.select);
					if (step.command !== "") await this.#dispatch(step.command);
				})();
				return;
		}
	}

	#closeMenu(): void {
		const menu = this.#menu;
		if (menu === undefined) return;
		this.#menu = undefined;
		if (!this.#ended) this.#o.post({ kind: "menu-closed", id: menu.id });
	}

	/**
	 * A picker over tmux's tree (`chooser.ts`): sessions, windows and panes
	 * as tmux lists them, each line in tmux's choose-tree format, `-f` by
	 * tmux; the chosen item's pane shown beside it, read again while it is.
	 */
	async #openChooser(args: ChooserArgs): Promise<void> {
		const F = FIELD;
		const filter = args.filter === undefined ? [] : ["-f", args.filter];
		const [here, sessions, windows, panes] = await Promise.all([
			this.#command([
				"display-message",
				"-p",
				`#{session_id}${F}#{window_id}${F}#{pane_id}`,
			]),
			this.#command([
				"list-sessions",
				"-F",
				`#{session_id}${F}#{session_name}${F}#{session_name}: #{session_windows} windows#{?session_grouped, (group #{session_group}: #{session_group_list}),}#{?session_attached, (attached),}`,
			]),
			this.#command([
				"list-windows",
				"-a",
				"-F",
				`#{session_id}${F}#{window_id}${F}#{window_index}${F}#{window_index}: #{window_name}#{window_flags}#{?#{&&:#{==:#{window_panes},1},#{&&:#{pane_title},#{!=:#{pane_title},#{host_short}}}},: "#{pane_title}",}`,
			]),
			this.#command([
				"list-panes",
				"-a",
				...filter,
				"-F",
				`#{session_id}${F}#{window_id}${F}#{pane_id}${F}#{pane_index}: #{pane_current_command}#{?pane_active,*,}#{?pane_marked,M,}#{?#{&&:#{pane_title},#{!=:#{pane_title},#{host_short}}},: "#{pane_title}",}`,
			]),
		]);
		if (this.#ended || !sessions.ok || !windows.ok || !panes.ok) return;
		const [curSession, curWindow, curPane] = (here.lines[0] ?? "").split(F);
		const roots: TreeNode[] = [];
		const byId = new Map<
			string,
			{ node: TreeNode; name: string; index?: string }
		>();
		for (const line of sessions.lines) {
			const [id, name, ...text] = line.split(F);
			const node: TreeNode = {
				kind: "session",
				id,
				target: `=${name}:`,
				text: text.join(F),
				children: [],
				current: id === curSession,
			};
			byId.set(id, { node, name });
			roots.push(node);
		}
		for (const line of windows.lines) {
			const [sessionId, id, index, ...text] = line.split(F);
			const parent = byId.get(sessionId);
			if (parent === undefined) continue;
			const node: TreeNode = {
				kind: "window",
				id: `${sessionId}${id}`,
				target: `=${parent.name}:${index}.`,
				text: text.join(F),
				children: [],
				current: id === curWindow && sessionId === curSession,
			};
			parent.node.children.push(node);
			byId.set(`${sessionId}${id}`, { node, name: parent.name, index });
		}
		for (const line of panes.lines) {
			const [sessionId, windowId, id, ...text] = line.split(F);
			const parent = byId.get(`${sessionId}${windowId}`);
			if (parent === undefined) continue;
			parent.node.children.push({
				kind: "pane",
				id: `${sessionId}${id}`,
				target: `=${parent.name}:${parent.index ?? ""}.${id}`,
				text: text.join(F),
				children: [],
				current: id === curPane && sessionId === curSession,
			});
		}
		// `-f` filters the panes: a window or session left with none goes too.
		const kept =
			args.filter === undefined
				? roots
				: roots
						.map((session) => ({
							...session,
							children: session.children.filter((w) => w.children.length > 0),
						}))
						.filter((session) => session.children.length > 0);
		const session = new ChooserSession(args, kept);
		// The picker's frame: most of the terminal; the tree on its left, the
		// chosen item's pane on the right, a line for the filter at its top.
		const cols = this.#cols;
		const rows = this.#rows;
		const width = Math.max(20, Math.min(cols, Math.floor(cols * 0.9)));
		const height = Math.max(6, Math.min(rows, Math.floor(rows * 0.85)));
		const box = {
			x: Math.floor((cols - width) / 2),
			y: Math.floor((rows - height) / 2),
			width,
			height,
		};
		const treeWidth = Math.max(16, Math.floor(width * 0.4));
		const preview = {
			x: box.x + treeWidth + 1,
			y: box.y + 2,
			width: Math.max(1, width - treeWidth - 2),
			height: Math.max(1, height - 3),
		};
		this.#chooser?.vt.dispose();
		const vt = this.#o.vt.open(preview.width, preview.height, 0);
		if (this.#colors !== undefined) vt.setColors(this.#colors);
		this.#chooser = {
			id: ++this.#chooserSerial,
			session,
			box,
			preview,
			vt,
			timer: undefined,
			shown: "",
		};
		this.#postChooser();
		void this.#readPreview();
	}

	/** The chosen item's pane, read with `capture-pane`, again every 500 ms. */
	async #readPreview(): Promise<void> {
		const chooser = this.#chooser;
		if (chooser === undefined || this.#ended) return;
		const timers = this.#o.timers ?? NODE_TIMERS;
		if (chooser.timer !== undefined) timers.clear(chooser.timer);
		chooser.timer = timers.set(() => {
			chooser.timer = undefined;
			void this.#readPreview();
		}, 500);
		const node = chooser.session.chosen;
		if (node === undefined) return;
		const target = node.id.slice(
			node.id.search(/[@%]/) >= 0 ? node.id.search(/[@%]/) : 0,
		);
		const capture = await this.#command([
			"capture-pane",
			"-p",
			"-e",
			"-N",
			"-t",
			target,
		]);
		if (this.#chooser !== chooser || !capture.ok) return;
		chooser.vt.reset();
		chooser.vt.write(
			new TextEncoder().encode(
				`\u001b[?7l\u001b[H${capture.lines.slice(0, chooser.preview.height).join("\r\n")}`,
			),
		);
		chooser.shown = node.id;
		this.#schedule();
	}

	#postChooser(): void {
		const chooser = this.#chooser;
		if (chooser === undefined || this.#ended) return;
		this.#o.post({
			kind: "chooser",
			id: chooser.id,
			...chooser.box,
			preview: chooser.preview,
			filter: chooser.session.filter,
			rows: chooser.session.rows(),
			choice: chooser.session.choice,
		});
	}

	#chooserStep(step: ChooserStep): void {
		const chooser = this.#chooser;
		if (chooser === undefined) return;
		switch (step.kind) {
			case "unchanged":
				return;
			case "changed":
				this.#postChooser();
				if (chooser.session.chosen?.id !== chooser.shown)
					void this.#readPreview();
				return;
			case "close":
				this.#closeChooser();
				return;
			case "choose":
				this.#closeChooser();
				void this.#hold([], this.#dispatch(step.command));
				return;
			case "kill":
				// tmux asks first, on its prompt line: so does DevHub.
				this.#closeChooser();
				void this.#hold([], this.#dispatch(killConfirm(step.node)));
				return;
		}
	}

	#closeChooser(): void {
		const chooser = this.#chooser;
		if (chooser === undefined) return;
		this.#chooser = undefined;
		if (chooser.timer !== undefined)
			(this.#o.timers ?? NODE_TIMERS).clear(chooser.timer);
		chooser.vt.dispose();
		if (!this.#ended) this.#o.post({ kind: "chooser-closed", id: chooser.id });
	}

	/**
	 * `display-panes`: each shown pane's index over it, until a key or
	 * `display-panes-time`; a digit runs the template with that index.
	 */
	async #openNumbers(args: DisplayPanesArgs): Promise<void> {
		const [listing, time] = await Promise.all([
			this.#command(["list-panes", "-F", `#{pane_id}${FIELD}#{pane_index}`]),
			this.#command(["display-message", "-p", "#{display-panes-time}"]),
		]);
		if (!listing.ok || this.#ended) return;
		const panes = listing.lines.map((line) => {
			const [id, index] = line.split(FIELD);
			return { pane: Number(id.slice(1)), index: Number(index) };
		});
		const ms = args.duration ?? (Number(time.lines[0]) || 1000);
		const timers = this.#o.timers ?? NODE_TIMERS;
		const id = ++this.#chooserSerial;
		this.#numbers = {
			id,
			args,
			panes,
			timer: ms > 0 ? timers.set(() => this.#closeNumbers(), ms) : undefined,
		};
		this.#o.post({ kind: "display-panes", id, panes });
	}

	#numbersKey(key: string): void {
		const numbers = this.#numbers;
		if (numbers === undefined) return;
		this.#closeNumbers();
		if (numbers.args.noKeys || !/^[0-9]$/.test(key)) return;
		if (!numbers.panes.some((p) => p.index === Number(key))) return;
		void this.#hold(
			[],
			this.#dispatch(templateReplace(numbers.args.template, key)),
		);
	}

	#closeNumbers(): void {
		const numbers = this.#numbers;
		if (numbers === undefined) return;
		this.#numbers = undefined;
		if (numbers.timer !== undefined)
			(this.#o.timers ?? NODE_TIMERS).clear(numbers.timer);
		if (!this.#ended)
			this.#o.post({ kind: "display-panes-closed", id: numbers.id });
	}

	/**
	 * A mouse event the page did not give the pane's program — a right-click,
	 * the wheel — or one on a window's tab: tmux's binding for it
	 * (`MouseDown3Pane`, `WheelUpPane`, `MouseDown3Status`) runs with it as
	 * its mouse, in the mode's table while the pane is in copy mode.
	 */
	#mouse(at: {
		key: string;
		pane?: number;
		window?: number;
		x: number;
		y: number;
	}): void {
		if (
			this.#menu !== undefined ||
			this.#prompt !== undefined ||
			this.#popup !== undefined ||
			this.#chooser !== undefined
		)
			return;
		const pane = at.pane === undefined ? undefined : this.#panes.get(at.pane);
		const inCopy = pane !== undefined && COPY_MODES.has(pane.mode);
		const table = inCopy
			? this.#modeKeys === "vi"
				? "copy-mode-vi"
				: "copy-mode"
			: "root";
		const command = this.#router.binding(table, at.key);
		if (command === undefined) return;
		const target =
			at.window !== undefined ? `@${String(at.window)}` : `%${String(at.pane)}`;
		void this.#hold(
			[],
			this.#dispatch(command, {
				target,
				key: at.key,
				x: at.x,
				y: at.y,
				...(inCopy ? { viaMode: true } : {}),
				...(at.window === undefined ? {} : { window: at.window }),
			}),
		);
	}

	async #readCompletions(): Promise<{ commands: string[]; options: string[] }> {
		this.#completions ??= (async () => {
			const [commands, aliases, ...options] = await Promise.all([
				this.#command([
					"list-commands",
					"-F",
					`#{command_list_name}${FIELD}#{command_list_alias}`,
				]),
				this.#command(["show-options", "-s", "command-alias"]),
				...[["-s"], ["-g"], ["-wg"]].map((scope) =>
					this.#command(["show-options", ...scope]),
				),
			]);
			const names = (line: string) => /^([a-z][a-z0-9-]*)/.exec(line)?.[1];
			return {
				commands: [
					...commands.lines.flatMap((line) => line.split(FIELD)),
					...aliases.lines.flatMap(
						(line) => /^\S+\s+"?([^=\s"]+)=/.exec(line)?.[1] ?? [],
					),
				].filter((word) => word !== ""),
				options: options.flatMap((answer) =>
					answer.lines.flatMap((line) => names(line) ?? []),
				),
			};
		})();
		return this.#completions;
	}

	/** Text for the prompt (an IME's, a paste), if one is open or opening. */
	#promptText(bytes: Uint8Array): boolean {
		const text = new TextDecoder().decode(bytes);
		if (this.#opening !== undefined) {
			this.#opening.push({ text });
			return true;
		}
		if (this.#chooser !== undefined) {
			this.#chooserStep(this.#chooser.session.text(untilControl(text)));
			return true;
		}
		const prompt = this.#prompt;
		if (prompt === undefined) return false;
		const step = prompt.text(text);
		if (prompt.args.mode === "incremental" && step.kind === "changed") {
			const typed = untilControl(text);
			void this.#run([this.#typeInto(["-l", typed])]);
		}
		this.#promptStep(prompt, step);
		return true;
	}

	#promptKey(key: string): void {
		const prompt = this.#prompt;
		if (prompt === undefined) return;
		const step = prompt.key(key);
		if (prompt.args.mode === "incremental") {
			// tmux's prompt has every key too, and closes itself as this does.
			void this.#run([this.#typeInto([key])]);
			if (step.kind === "done" || step.kind === "cancel") this.#closePrompt();
			else this.#postPrompt();
			return;
		}
		this.#promptStep(prompt, step);
	}

	#promptStep(prompt: PromptSession, step: PromptStep): void {
		switch (step.kind) {
			case "unchanged":
				return;
			case "changed":
				this.#postPrompt();
				return;
			case "cancel":
				this.#closePrompt();
				return;
			case "done":
				this.#closePrompt();
				this.#answer(prompt.args, step.keys);
				return;
		}
	}

	/**
	 * The answer typed into tmux's own prompt, opened by the binding run with
	 * `-b`, in one command line: tmux fills the template, keeps the history
	 * and runs it. What is typed at the bare `:` prompt is the command itself,
	 * and is looked at first as a key's binding is (`keyGuard.ts`).
	 */
	#answer(args: PromptArgs, keys: readonly (readonly string[])[]): void {
		if (args.bare) {
			// What is typed at `:` is a command: one that would wait on the
			// client is DevHub's, as a key's binding is.
			const typed = keys.find((k) => k[0] === "-l")?.[1] ?? "";
			if (waitingCommand(typed) !== undefined) {
				void this.#hold([], this.#dispatch(typed));
				return;
			}
		}
		let lines: string[];
		try {
			lines = [args.replay, ...keys.map((k) => this.#typeInto(k))];
		} catch (failure: unknown) {
			this.#o.post({
				kind: "notice",
				text: failure instanceof Error ? failure.message : String(failure),
			});
			return;
		}
		void this.#run(lines).then(() => this.#copyMoved());
	}

	/** `send-keys -K` into this client's prompt: keys, or `-l` and text. */
	#typeInto(keys: readonly string[]): string {
		const literal = keys[0] === "-l";
		return commandLine([
			"send-keys",
			"-K",
			"-c",
			this.#clientName,
			...(literal ? ["-l"] : []),
			"--",
			...(literal ? keys.slice(1) : keys),
		]);
	}

	#postPrompt(): void {
		const prompt = this.#prompt;
		if (prompt === undefined || this.#ended) return;
		this.#o.post({ kind: "prompt", ...prompt.view() });
	}

	#closePrompt(): void {
		if (this.#prompt === undefined) return;
		this.#prompt = undefined;
		if (!this.#ended) this.#o.post({ kind: "prompt-closed" });
	}

	/**
	 * Commands, already written as tmux reads them, on one line: tmux runs
	 * them in order with nothing between, and answers each, up to the first
	 * that fails: tmux skips the rest of the line, which get no answer.
	 */
	#run(
		commands: readonly string[],
	): Promise<{ ok: boolean; lines: readonly string[] }[]> {
		if (this.#ended) return Promise.resolve([]);
		return Promise.all(
			commands.map(
				(_, i) =>
					new Promise<{ ok: boolean; lines: readonly string[] }>((resolve) => {
						this.#replies.push((reply) => {
							resolve(reply);
							if (!reply.ok) {
								if (reply.lines.length > 0)
									this.#o.post({ kind: "notice", text: reply.lines.join(" ") });
								// The line's later commands, next in the queue, never run.
								for (const skipped of this.#replies.splice(
									0,
									commands.length - 1 - i,
								))
									skipped({ ok: false, lines: [] });
							}
						});
						if (i === commands.length - 1) {
							try {
								this.#o.process.write(`${commands.join(" ; ")}\n`);
							} catch {
								for (const reply of this.#replies.splice(-commands.length))
									reply({ ok: false, lines: [] });
							}
						}
					}),
			),
		);
	}

	/** Write a command; its answer is the next reply of this client's. */
	#command(
		words: readonly string[],
	): Promise<{ ok: boolean; lines: readonly string[] }> {
		if (this.#ended) return Promise.resolve({ ok: false, lines: [] });
		return new Promise((resolve) => {
			this.#replies.push(resolve);
			try {
				this.#o.process.write(`${commandLine(words)}\n`);
			} catch {
				this.#replies.pop();
				resolve({ ok: false, lines: [] });
			}
		});
	}

	/**
	 * Read the session's windows and panes again and reconcile: panes that
	 * are new are created and read, panes that are gone are dropped. Runs one
	 * at a time; a request while one runs runs once more after it.
	 */
	async #refresh(): Promise<void> {
		if (this.#refreshing) {
			this.#refreshAgain = true;
			return;
		}
		this.#refreshing = true;
		try {
			do {
				this.#refreshAgain = false;
				await this.#readStructure();
			} while (this.#refreshAgain && !this.#ended);
		} finally {
			this.#refreshing = false;
		}
	}

	async #readStructure(): Promise<void> {
		const windows = await this.#command([
			"list-windows",
			"-F",
			[
				"#{session_name}",
				"#{window_id}",
				"#{window_index}",
				"#{window_active}",
				"#{window_zoomed_flag}",
				"#{window_layout}",
				"#{window_visible_layout}",
				TAB_FORMAT,
				"#{window_name}",
			].join(FIELD),
		]);
		const panes = await this.#command([
			"list-panes",
			"-s",
			"-F",
			["#{pane_id}", "#{window_id}", "#{pane_active}", PANE_FACTS_FORMAT].join(
				FIELD,
			),
		]);
		if (!windows.ok || !panes.ok || this.#ended) return;
		const seenWindows = new Set<TmuxId>();
		for (const line of windows.lines) {
			const [session, idText, index, active, zoomed, layout, visible, ...rest] =
				line.split(FIELD);
			const tab = rest.slice(0, TAB_FIELD_COUNT).join(FIELD);
			const name = rest.slice(TAB_FIELD_COUNT);
			const id = parseId(idText);
			if (id === undefined || layout === undefined) continue;
			this.#session = session;
			seenWindows.add(id);
			const window = this.#windows.get(id) ?? {
				id,
				index: 0,
				name: "",
				layout: undefined,
				visible: undefined,
				activePane: undefined,
				zoomed: false,
				tab: undefined,
			};
			window.index = Number(index);
			window.name = name.join(FIELD);
			window.zoomed = zoomed === "1";
			window.tab = parseTab(tab);
			try {
				window.layout = parseLayout(layout);
				window.visible =
					visible !== undefined ? parseLayout(visible) : window.layout;
			} catch {
				continue;
			}
			this.#windows.set(id, window);
			if (active === "1") this.#activeWindow = id;
		}
		for (const id of [...this.#windows.keys()])
			if (!seenWindows.has(id)) this.#windows.delete(id);
		const seenPanes = new Set<TmuxId>();
		const fresh: Pane[] = [];
		for (const line of panes.lines) {
			const [paneText, windowText, active, inMode, mode, sync, ...socket] =
				line.split(FIELD);
			const id = parseId(paneText);
			const windowId = parseId(windowText);
			if (id === undefined || windowId === undefined) continue;
			seenPanes.add(id);
			const window = this.#windows.get(windowId);
			if (window !== undefined && active === "1") window.activePane = id;
			const known = this.#panes.get(id);
			if (known !== undefined) {
				known.window = windowId;
				known.inMode = inMode === "1";
				known.synchronized = sync === "1";
				known.socket = socket.join(FIELD);
				this.#modeOf(known, mode ?? "");
				continue;
			}
			const box =
				window?.layout !== undefined
					? layoutPanes(window.layout).find((p) => p.pane === id)
					: undefined;
			const vt = this.#o.vt.open(
				box?.width ?? this.#cols,
				box?.height ?? this.#rows,
				this.#o.scrollback ?? 2000,
			);
			if (this.#colors !== undefined) vt.setColors(this.#colors);
			const pane: Pane = {
				id,
				vt,
				window: windowId,
				syncing: true,
				dirty: false,
				all: true,
				lastCursor: "",
				inMode: inMode === "1",
				mode: "",
				synchronized: sync === "1",
				copy: undefined,
				socket: socket.join(FIELD),
			};
			this.#panes.set(id, pane);
			this.#modeOf(pane, mode ?? "");
			fresh.push(pane);
		}
		for (const [id, pane] of [...this.#panes]) {
			if (!seenPanes.has(id)) {
				pane.vt.dispose();
				this.#panes.delete(id);
			}
		}
		for (const window of this.#windows.values()) this.#sizePanes(window);
		this.#postLayout();
		await Promise.all(fresh.map((pane) => this.#sync(pane)));
		this.#schedule();
	}

	/** Read a pane's state from tmux into its engine (see the file's comment). */
	async #sync(pane: Pane): Promise<void> {
		pane.syncing = true;
		const target = `%${String(pane.id)}`;
		const state = await this.#command([
			"display-message",
			"-p",
			"-t",
			target,
			[
				"#{cursor_x}",
				"#{cursor_y}",
				"#{cursor_flag}",
				"#{alternate_on}",
				"#{mouse_standard_flag}",
				"#{mouse_button_flag}",
				"#{mouse_any_flag}",
				"#{mouse_sgr_flag}",
				"#{scroll_region_upper}",
				"#{scroll_region_lower}",
				"#{pane_width}",
				"#{pane_height}",
			].join(FIELD),
		]);
		const fields = (state.lines[0] ?? "").split(FIELD);
		const alternate = fields[3] === "1";
		const history = alternate ? 0 : (this.#o.scrollback ?? 2000);
		const capture = await this.#command([
			"capture-pane",
			"-p",
			"-e",
			"-N",
			"-t",
			target,
			"-S",
			String(-history),
		]);
		if (this.#ended || this.#panes.get(pane.id) !== pane) return;
		const width = Number(fields[10]);
		const height = Number(fields[11]);
		if (width > 0 && height > 0) pane.vt.resize(width, height);
		pane.vt.reset();
		pane.vt.write(
			new TextEncoder().encode(restoreSequence(capture.lines, fields)),
		);
		pane.syncing = false;
		pane.dirty = true;
		pane.all = true;
	}

	/**
	 * A buffer tmux made or changed: with `set-clipboard` on, tmux would
	 * have set the outside terminal's clipboard (a copy in copy mode, a
	 * `load-buffer -w`, a program's OSC 52), so DevHub sets the system's.
	 */
	async #clipboard(name: string): Promise<void> {
		const [setting, buffer] = await Promise.all([
			this.#command(["display-message", "-p", "#{set-clipboard}"]),
			this.#command(["show-buffer", "-b", name]),
		]);
		if (!setting.ok || !buffer.ok || this.#ended) return;
		if ((setting.lines[0] ?? "off") === "off") return;
		this.#o.post({ kind: "clipboard", text: buffer.lines.join("\n") });
	}

	/** A pane entered or left copy mode: DevHub draws it, or stops. */
	#modeOf(pane: Pane, mode: string): void {
		if (pane.mode === mode) return;
		pane.mode = mode;
		if (COPY_MODES.has(mode)) {
			if (pane.copy === undefined) {
				const vt = this.#o.vt.open(pane.vt.cols, pane.vt.rows, 0);
				if (this.#colors !== undefined) vt.setColors(this.#colors);
				pane.copy = { vt, reading: false, again: false };
			}
			void this.#readCopy(pane);
			return;
		}
		if (pane.copy !== undefined) {
			pane.copy.vt.dispose();
			pane.copy = undefined;
			pane.all = true;
			pane.dirty = true;
			this.#o.post({ kind: "copy-mode-closed", pane: pane.id });
			this.#schedule();
		}
	}

	/** Every pane in copy mode read again: a key or a command may have moved it. */
	#copyMoved(): void {
		for (const pane of this.#panes.values())
			if (pane.copy !== undefined) void this.#readCopy(pane);
	}

	/**
	 * A pane's copy mode, read from tmux (`copyMode.ts`): its state, then the
	 * rows it shows; one read at a time, once more if asked meanwhile.
	 */
	async #readCopy(pane: Pane): Promise<void> {
		const copy = pane.copy;
		if (copy === undefined || this.#ended) return;
		if (copy.reading) {
			copy.again = true;
			return;
		}
		copy.reading = true;
		try {
			do {
				copy.again = false;
				const target = `%${String(pane.id)}`;
				const answer = await this.#command([
					"display-message",
					"-p",
					"-t",
					target,
					COPY_FORMAT,
				]);
				const state = answer.ok
					? copyState(answer.lines.join("\n"))
					: undefined;
				if (state === undefined || !COPY_MODES.has(state.mode)) return;
				const capture = await this.#command(copyCapture(state, target));
				if (pane.copy !== copy || !capture.ok) return;
				if (copy.vt.cols !== state.width || copy.vt.rows !== state.height)
					copy.vt.resize(state.width, state.height);
				copy.vt.reset();
				copy.vt.write(copyScreen(capture.lines, state));
				copy.state = state;
				pane.all = true;
				pane.dirty = true;
				this.#o.post({
					kind: "copy-mode",
					pane: pane.id,
					badge: state.badge,
					scroll: state.scroll,
					history: state.history,
					selection: selectionSpans(state),
					matches: matchSpans(capture.lines.map(plainLine), state.search),
				});
				this.#schedule();
			} while (copy.again && pane.copy === copy && !this.#ended);
		} finally {
			copy.reading = false;
		}
	}

	/** A pane's mode and socket, as `PANE_FACTS_FORMAT` gives them. */
	#facts(paneId: TmuxId, value: string): void {
		const pane = this.#panes.get(paneId);
		if (pane === undefined) return;
		const [inMode, mode, sync, ...socket] = value.split(FIELD);
		this.#modeOf(pane, mode ?? "");
		const next = {
			inMode: inMode === "1",
			synchronized: sync === "1",
			socket: socket.join(FIELD),
		};
		if (
			next.inMode === pane.inMode &&
			next.synchronized === pane.synchronized &&
			next.socket === pane.socket
		)
			return;
		pane.inMode = next.inMode;
		pane.synchronized = next.synchronized;
		pane.socket = next.socket;
		this.#postLayout();
	}

	async #readFacts(paneId: TmuxId): Promise<void> {
		const state = await this.#command([
			"display-message",
			"-p",
			"-t",
			`%${String(paneId)}`,
			PANE_FACTS_FORMAT,
		]);
		if (state.ok) this.#facts(paneId, state.lines.join("\n"));
	}

	async #continue(paneId: TmuxId): Promise<void> {
		await this.#command([
			"refresh-client",
			"-A",
			`%${String(paneId)}:continue`,
		]);
		const pane = this.#panes.get(paneId);
		if (pane !== undefined) await this.#sync(pane);
		this.#schedule();
	}

	#resize(cols: number, rows: number): void {
		if (cols <= 0 || rows <= 0 || (cols === this.#cols && rows === this.#rows))
			return;
		this.#cols = cols;
		this.#rows = rows;
		void this.#command([
			"refresh-client",
			"-C",
			`${String(cols)}x${String(rows)}`,
		]);
	}

	/** Each pane's engine at its rectangle's size. */
	#sizePanes(window: Window): void {
		if (window.layout === undefined) return;
		for (const box of layoutPanes(window.layout)) {
			const pane = this.#panes.get(box.pane);
			if (pane === undefined) continue;
			if (pane.vt.cols !== box.width || pane.vt.rows !== box.height) {
				// tmux reflowed its own grid; the engine's rows from a capture carry
				// no wraps to reflow by, so the pane is read again at its new size.
				pane.vt.resize(box.width, box.height);
				pane.all = true;
				pane.dirty = true;
				if (!pane.syncing) void this.#sync(pane).then(() => this.#schedule());
			}
		}
	}

	/**
	 * The table a key is looked up in with no prefix: the copy mode's while
	 * the active pane is in it (`mode-keys`), as tmux does; else root.
	 */
	#rootTable(): string {
		const active = this.#activePane();
		const pane = active === undefined ? undefined : this.#panes.get(active);
		if (pane === undefined || !COPY_MODES.has(pane.mode)) return "root";
		return this.#modeKeys === "vi" ? "copy-mode-vi" : "copy-mode";
	}

	#modeKeys = "emacs";

	#activePane(): TmuxId | undefined {
		const window =
			this.#activeWindow !== undefined
				? this.#windows.get(this.#activeWindow)
				: undefined;
		return window?.activePane;
	}

	#sendBytes(pane: TmuxId, bytes: Uint8Array): void {
		// Hex, so no byte is a quoting question; one command per 1 KiB keeps the
		// lines short whatever is pasted.
		for (let i = 0; i < bytes.length; i += 1024) {
			const hex = Array.from(bytes.subarray(i, i + 1024), (b) =>
				b.toString(16).padStart(2, "0"),
			);
			void this.#command(["send-keys", "-t", `%${String(pane)}`, "-H", ...hex]);
		}
	}

	#shownPanes(): PaneBox[] {
		const window =
			this.#activeWindow !== undefined
				? this.#windows.get(this.#activeWindow)
				: undefined;
		if (window?.visible === undefined) return [];
		return layoutPanes(window.visible).map((box) => ({
			pane: box.pane,
			x: box.x,
			y: box.y,
			width: box.width,
			height: box.height,
			active: box.pane === window.activePane,
			synchronized: this.#panes.get(box.pane)?.synchronized === true,
		}));
	}

	/**
	 * A window's tab changed (`TABS_SUBSCRIPTION`), or whether it is the
	 * session's current one: a switch whose notification was overtaken by an
	 * older listing is put right within tmux's next check.
	 */
	#setTab(window: Window, value: string): void {
		const at = value.indexOf(FIELD);
		const active = value.slice(0, at) === "1";
		const tab = parseTab(value.slice(at + 1));
		const switched = active && this.#activeWindow !== window.id;
		if (!switched && JSON.stringify(tab) === JSON.stringify(window.tab)) return;
		window.tab = tab;
		if (switched) {
			this.#activeWindow = window.id;
			for (const pane of this.#panes.values())
				if (pane.window === window.id) pane.all = true;
			this.#schedule();
		}
		this.#postLayout();
	}

	#postLayout(): void {
		if (this.#ended) return;
		const windows = [...this.#windows.values()]
			.sort((a, b) => a.index - b.index)
			.map((w) => ({
				id: w.id,
				index: w.index,
				name: w.name,
				active: w.id === this.#activeWindow,
				zoomed: w.zoomed,
				...(w.tab === undefined ? {} : { tab: w.tab }),
			}));
		this.#o.post({
			kind: "layout",
			cols: this.#cols,
			rows: this.#rows,
			session: this.#session,
			windows,
			window: this.#activeWindow,
			panes: this.#shownPanes(),
			sessionPanes: [...this.#panes.values()].map(
				(pane): SessionPane => ({
					pane: pane.id,
					window: pane.window,
					inMode: pane.inMode,
					socket: pane.socket,
				}),
			),
			client: this.#clientName,
			prefixes: this.#prefixes,
			...(this.#status === undefined ? {} : { status: this.#status }),
		});
	}

	#schedule(): void {
		if (this.#flushTimer !== undefined || this.#ended) return;
		const timers = this.#o.timers ?? {
			set: (fn: () => void, ms: number) => setTimeout(fn, ms),
			clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
		};
		this.#flushTimer = timers.set(() => {
			this.#flushTimer = undefined;
			this.#flush();
		}, this.#o.frameMs ?? 4);
	}

	#flush(): void {
		if (!this.#visible || this.#ended) return;
		const popup = this.#popup;
		const popupFrame = popup?.frame();
		if (popup !== undefined && popupFrame !== undefined) {
			this.#o.post({
				kind: "popup",
				id: popup.id,
				...popup.box,
				border: popup.border,
				title: popup.title,
				frame: popupFrame,
				modes: modesOf(popup.vt),
			});
		}
		const chooser = this.#chooser;
		if (chooser !== undefined) {
			const frame = chooser.vt.read(false);
			if (frame.dirty.length > 0 || frame.styles.length > 0)
				this.#o.post({ kind: "chooser-preview", id: chooser.id, frame });
		}
		for (const box of this.#shownPanes()) {
			if (this.#seq - this.#acked >= MAX_UNACKED) return;
			const pane = this.#panes.get(box.pane);
			if (pane === undefined || pane.syncing || !(pane.dirty || pane.all))
				continue;
			const frame = (pane.copy?.vt ?? pane.vt).read(pane.all);
			pane.dirty = false;
			pane.all = false;
			const cursor = JSON.stringify(frame.cursor);
			if (
				frame.dirty.length === 0 &&
				frame.styles.length === 0 &&
				cursor === pane.lastCursor
			)
				continue;
			pane.lastCursor = cursor;
			this.#o.post({
				kind: "pane",
				seq: ++this.#seq,
				pane: pane.id,
				frame,
				modes: modesOf(pane.vt),
			});
		}
	}

	#end(reason: string): void {
		if (this.#ended) return;
		this.#ended = true;
		if (this.#flushTimer !== undefined) {
			const timers = this.#o.timers ?? {
				set: () => undefined,
				clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
			};
			timers.clear(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		this.#popup?.close();
		this.#prompt = undefined;
		this.#menu = undefined;
		this.#closeChooser();
		this.#closeNumbers();
		for (const check of this.#modeChecks.values()) {
			(this.#o.timers ?? NODE_TIMERS).clear(check);
		}
		this.#modeChecks.clear();
		for (const resolve of this.#replies.splice(0))
			resolve({ ok: false, lines: [] });
		for (const pane of this.#panes.values()) {
			pane.vt.dispose();
			pane.copy?.vt.dispose();
		}
		this.#panes.clear();
		this.#o.post({ kind: "ended", reason });
		this.#o.ended(reason);
	}
}

function modesOf(vt: VtPane): PaneModes {
	const mouse = vt.mode(1003)
		? 1003
		: vt.mode(1002)
			? 1002
			: vt.mode(1000)
				? 1000
				: vt.mode(9)
					? 9
					: 0;
	return {
		mouse,
		sgrMouse: vt.mode(1006),
		bracketedPaste: vt.mode(2004),
		focusEvents: vt.mode(1004),
		alternateScreen: vt.alternateScreen,
	};
}

/**
 * The bytes that put an engine where tmux's pane is: the captured lines (the
 * history, then the screen), the screen's modes and the cursor. Each line
 * ends with its attributes reset, so a line's colour does not run into the
 * next one's blank cells.
 */
export function restoreSequence(
	lines: readonly string[],
	fields: readonly string[],
): string {
	const [
		cursorX,
		cursorY,
		cursorFlag,
		alternate,
		standard,
		button,
		any,
		sgr,
		upper,
		lower,
		,
		heightText,
	] = fields;
	const height = Number(heightText) || lines.length;
	let out = alternate === "1" ? "\x1b[?1049h\x1b[H" : "";
	out += lines.map((line) => `${line}\x1b[0m`).join("\r\n");
	// The captured screen is the last `height` lines: the cursor is placed in it.
	const regionTop = Number(upper);
	const regionBottom = Number(lower);
	if (
		Number.isInteger(regionTop) &&
		Number.isInteger(regionBottom) &&
		(regionTop > 0 || regionBottom < height - 1)
	) {
		out += `\x1b[${String(regionTop + 1)};${String(regionBottom + 1)}r`;
	}
	if (any === "1") out += "\x1b[?1003h";
	else if (button === "1") out += "\x1b[?1002h";
	else if (standard === "1") out += "\x1b[?1000h";
	if (sgr === "1") out += "\x1b[?1006h";
	if (cursorFlag === "0") out += "\x1b[?25l";
	out += `\x1b[${String(Number(cursorY) + 1)};${String(Number(cursorX) + 1)}H`;
	return out;
}

/** Whether `needle` is somewhere in `bytes`. */
function includes(bytes: Uint8Array, needle: Uint8Array): boolean {
	const first = needle[0];
	for (let i = bytes.indexOf(first); i >= 0; i = bytes.indexOf(first, i + 1)) {
		if (i + needle.length > bytes.length) return false;
		let j = 1;
		while (j < needle.length && bytes[i + j] === needle[j]) j++;
		if (j === needle.length) return true;
	}
	return false;
}

/** `list-windows -a`'s lines, as the prompt's sessions and their windows. */
function sessionsOf(lines: readonly string[]): PromptSessionInfo[] {
	const sessions = new Map<
		string,
		PromptSessionInfo & { windows: { index: number; name: string }[] }
	>();
	for (const line of lines) {
		const [id, name, index, ...windowName] = line.split(FIELD);
		if (id === undefined || name === undefined || index === undefined) continue;
		const session = sessions.get(name) ?? {
			name,
			id: Number(id.replace(/^\$/, "")),
			windows: [],
		};
		session.windows.push({
			index: Number(index),
			name: windowName.join(FIELD),
		});
		sessions.set(name, session);
	}
	return [...sessions.values()];
}
