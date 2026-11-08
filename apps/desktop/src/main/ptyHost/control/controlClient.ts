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

import type {
	ControlToPage,
	PageToControl,
	PaneBox,
	PaneModes,
	WindowInfo,
} from "../../../ipc/terminalControl.js";
import type { LibGhosttyVt, VtPane } from "../vt/libghosttyVt.js";
import { KeyRouter, parseBindings } from "./keyGuard.js";
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
}

const MAX_UNACKED = 4;
/** How long a binding that enters a mode has to leave it by itself. */
const MODE_SETTLE_MS = 250;
const NODE_TIMERS = {
	set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
	clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
};
const FIELD = "\u001f";

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
}

interface Window {
	readonly id: TmuxId;
	index: number;
	name: string;
	layout: LayoutNode | undefined;
	visible: LayoutNode | undefined;
	activePane: TmuxId | undefined;
	zoomed: boolean;
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
				const pane = message.pane ?? this.#activePane();
				if (pane === undefined || message.bytes.length === 0) return;
				this.#sendBytes(pane, message.bytes);
				return;
			}
			case "resize":
				this.#resize(message.cols, message.rows);
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
				return;
			case "output": {
				const pane = this.#panes.get(event.pane);
				if (pane === undefined || pane.syncing) return;
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
			case "pane-mode-changed": {
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
				]);
			send = [];
		};
		for (const key of keys) {
			const route = this.#router.route(key, Date.now());
			send.push(...route.send);
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
			["#{prefix}", "#{prefix2}", "#{repeat-time}"].join(FIELD),
		]);
		if (!keys.ok || !options.ok) return;
		const [prefix, prefix2, repeat] = (options.lines[0] ?? "").split(FIELD);
		const prefixes = [prefix, prefix2].filter(
			(p): p is string => p !== undefined && p !== "" && p !== "None",
		);
		this.#router.update(
			parseBindings(keys.lines),
			prefixes,
			Number(repeat) || 500,
		);
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
		if (!state.ok || inMode !== "1") return;
		await this.#command(["copy-mode", "-q", "-t", target]);
		this.#o.post({
			kind: "notice",
			text: `${mode !== undefined && mode !== "" ? mode : "This mode"} is not available in control mode yet.`,
		});
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
				"#{window_name}",
			].join(FIELD),
		]);
		const panes = await this.#command([
			"list-panes",
			"-s",
			"-F",
			["#{pane_id}", "#{window_id}", "#{pane_active}"].join(FIELD),
		]);
		if (!windows.ok || !panes.ok || this.#ended) return;
		const seenWindows = new Set<TmuxId>();
		for (const line of windows.lines) {
			const [session, idText, index, active, zoomed, layout, visible, ...name] =
				line.split(FIELD);
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
			};
			window.index = Number(index);
			window.name = name.join(FIELD);
			window.zoomed = zoomed === "1";
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
			const [paneText, windowText, active] = line.split(FIELD);
			const id = parseId(paneText);
			const windowId = parseId(windowText);
			if (id === undefined || windowId === undefined) continue;
			seenPanes.add(id);
			const window = this.#windows.get(windowId);
			if (window !== undefined && active === "1") window.activePane = id;
			const known = this.#panes.get(id);
			if (known !== undefined) {
				known.window = windowId;
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
			};
			this.#panes.set(id, pane);
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
		}));
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
			}));
		this.#o.post({
			kind: "layout",
			cols: this.#cols,
			rows: this.#rows,
			session: this.#session,
			windows,
			window: this.#activeWindow,
			panes: this.#shownPanes(),
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
		for (const box of this.#shownPanes()) {
			if (this.#seq - this.#acked >= MAX_UNACKED) return;
			const pane = this.#panes.get(box.pane);
			if (pane === undefined || pane.syncing || !(pane.dirty || pane.all))
				continue;
			const frame = pane.vt.read(pane.all);
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
		for (const check of this.#modeChecks.values()) {
			(this.#o.timers ?? NODE_TIMERS).clear(check);
		}
		this.#modeChecks.clear();
		for (const resolve of this.#replies.splice(0))
			resolve({ ok: false, lines: [] });
		for (const pane of this.#panes.values()) pane.vt.dispose();
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
