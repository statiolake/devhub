/**
 * Neovims in DevHub's terminals, drawn over their panes.
 *
 * With `[general] editor = "neovim"`, a Workspace's editor area is its
 * terminal (its `ws-` session), and every Neovim in a DevHub terminal is
 * drawn by DevHub over its pane: `nvim` typed in an Agent's terminal or the
 * Workspace's is DevHub's `nvim` (`terminalNeovimShim.ts`), the person's
 * Neovim running in that pane as its foreground program with DevHub as its
 * only UI; and the Workspace's own `devhub-nvim` window, where files DevHub
 * opens go (`managedNeovim.ts`), names its Neovim's socket the same way.
 * This is DevHub's half — which panes have one, where each pane is on the
 * screen, and whether the keys are its.
 *
 * # One reading of tmux, for all three
 *
 * While a terminal is on screen its session is read every so often
 * (150 ms here, slower on a host): every pane's place in its window, which
 * window and pane are active, zoom and modes, the socket a pane's `nvim` named
 * (`@devhub-nvim`), and the DevHub client's size, key table and prefix. tmux
 * pushes none of this — a window switch, a zoom, a pane moved by `swap-pane`
 * or a resize are events only of the client — and one `list-panes` plus one
 * `list-clients` per round is all of it. A terminal that is not on screen is
 * not read: its Neovims keep their pages, hidden, and come back where they
 * are when it does.
 *
 * # Where an overlay goes
 *
 * In the terminal's own page, over its pane: the page mounts each overlay's
 * Neovim (`shell/pane/PaneNeovims.tsx`) and draws it among the pane's own
 * layers. In control mode the page lays out the panes itself and puts the
 * Neovim in its pane, moving with it (`docs/pane-motion.md`); polled, it is
 * told the pane's cells and whether a status line on top pushes it down
 * (`neovims`), and places the Neovim over its emulator's screen. It is
 * hidden whenever the pane is not what tmux shows: another window, a zoomed
 * sibling, the pane in a mode (copy mode, a chooser), or no DevHub client.
 *
 * # The keyboard
 *
 * The overlay has the keys whenever the terminal would and its pane is the
 * active pane and shown. The tmux prefix typed in it is tmux's (DevHub puts
 * the client in its prefix table and the terminal takes the keys), and so is
 * the key after it; once that has been handled — a zoom, a pane switch — the
 * overlay takes the keys back if its pane is still the active one. A binding
 * that opens a prompt or a chooser keeps them in the terminal until it is
 * answered (Enter, Escape). A click outside the overlay gives them to the
 * terminal; a key typed there that tmux would only hand to the pane under the
 * overlay (whose Neovim does not read its tty) goes to the overlay instead.
 * DevHub's own chords are caught before any of this, on every page.
 *
 * # In tmux control mode
 *
 * A terminal in control mode (`docs/terminal-mode.md`) draws its panes
 * itself, from the layout tmux pushes, so its page knows each pane's
 * panes and says what they are (`controlPanes`): the shown window's panes,
 * which is active, every pane's mode and `@devhub-nvim`, the client and the
 * prefixes. Nothing is polled; the page moves the Neovim with its pane. The sockets the page
 * names are only a hint: each change of them is a reading of tmux here, and
 * only a socket that reading confirms is attached to. The prefix typed in
 * the overlay is handed to the terminal surface as the keystroke it was, since
 * that page's control client keeps its own place in tmux's key tables
 * (`ptyHost/control/keyGuard.ts`); a prompt or a chooser is DevHub's to draw
 * there (or refused), so every key after the prefix gives the keys back once
 * its binding has run.
 */

import type { RuntimeId } from "../runtime/runtime.js";
import type { WorkspaceTerminalTarget } from "../terminal/ports.js";

/** A pane of the terminal's session, as one reading has it. */
export interface TerminalNeovimPane {
	readonly paneId: string;
	readonly windowActive: boolean;
	readonly paneActive: boolean;
	readonly zoomed: boolean;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	readonly inMode: boolean;
	/** `@devhub-nvim`: the socket its `nvim` listens on, on its machine. */
	readonly socket: string;
}

/** DevHub's tmux client on the session. */
export interface TerminalNeovimClient {
	readonly name: string;
	readonly width: number;
	readonly height: number;
	readonly keyTable: string;
	/** Rows a status line takes above the window. */
	readonly statusTop: number;
	/** `prefix` and `prefix2`, as tmux names keys; `None` left out. */
	readonly prefixes: readonly string[];
}

export interface TerminalNeovimReading {
	readonly panes: readonly TerminalNeovimPane[];
	readonly client: TerminalNeovimClient | undefined;
}

const PANE_FIELDS = [
	"pane_id",
	"window_active",
	"pane_active",
	"window_zoomed_flag",
	"pane_left",
	"pane_top",
	"pane_width",
	"pane_height",
	"pane_in_mode",
	"@devhub-nvim",
] as const;
const CLIENT_FIELDS = [
	"client_name",
	"client_width",
	"client_height",
	"client_key_table",
	"status",
	"status-position",
	"prefix",
	"prefix2",
] as const;

/** What a reading asks tmux for each pane, tab-separated. */
export const PANE_FORMAT = PANE_FIELDS.map((field) => `#{${field}}`).join("\t");
/** And for each client of the session. */
export const CLIENT_FORMAT = CLIENT_FIELDS.map((field) => `#{${field}}`).join(
	"\t",
);
/** Marks the client lines apart from the pane lines in one output. */
export const CLIENT_LINE_MARK = "client\t";

function statusRows(status: string): number {
	if (status === "on") return 1;
	const rows = Number(status);
	return Number.isInteger(rows) && rows > 0 ? rows : 0;
}

/** A reading's output: pane lines, then client lines marked `client\t`. */
export function parseTerminalNeovimReading(
	output: string,
): TerminalNeovimReading {
	const panes: TerminalNeovimPane[] = [];
	let client: TerminalNeovimClient | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith(CLIENT_LINE_MARK)) {
			if (client !== undefined) continue;
			const [name, width, height, keyTable, status, position, p1, p2] = line
				.slice(CLIENT_LINE_MARK.length)
				.split("\t");
			if (name === undefined || name === "") continue;
			client = {
				name,
				width: Number(width),
				height: Number(height),
				keyTable: keyTable ?? "root",
				statusTop: position === "top" ? statusRows(status ?? "") : 0,
				prefixes: [p1, p2].filter(
					(key): key is string =>
						key !== undefined && key !== "" && key !== "None",
				),
			};
			continue;
		}
		const fields = line.split("\t");
		if (fields.length < PANE_FIELDS.length || !/^%\d+$/.test(fields[0] ?? ""))
			continue;
		const [id, wa, pa, zoom, left, top, width, height, mode, socket] = fields;
		panes.push({
			paneId: id ?? "",
			windowActive: wa === "1",
			paneActive: pa === "1",
			zoomed: zoom === "1",
			left: Number(left),
			top: Number(top),
			width: Number(width),
			height: Number(height),
			inMode: mode === "1",
			socket: socket ?? "",
		});
	}
	return { panes, client };
}

/** Whether tmux is showing this pane to DevHub's client. */
export function paneShown(
	pane: TerminalNeovimPane,
	reading: TerminalNeovimReading,
): boolean {
	return (
		reading.client !== undefined &&
		pane.windowActive &&
		(!pane.zoomed || pane.paneActive) &&
		!pane.inMode
	);
}

/**
 * A control-mode terminal's panes, as its page has them (`controlPanes`,
 * `TerminalPanesWire`): what each is, not where it is drawn.
 */
export interface ControlPanes {
	readonly client: string;
	readonly prefixes: readonly string[];
	/** The shown window's panes (a zoomed pane alone). */
	readonly shown: readonly {
		readonly pane: number;
		readonly active: boolean;
	}[];
	/** Every pane of the session. */
	readonly panes: readonly {
		readonly pane: number;
		readonly inMode: boolean;
		readonly socket: string;
	}[];
	/**
	 * What DevHub draws over the panes is open (a popup, a prompt, a menu,
	 * the chooser): the terminal has the keys.
	 */
	readonly covered: boolean;
}

const MAX_PANES = 1024;

/**
 * A page's report of its panes, checked: numbers that are numbers, at most
 * `MAX_PANES` of each list; anything else is no report.
 */
export function parseControlPanes(value: unknown): ControlPanes | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	const cell = (n: unknown): n is number =>
		typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000;
	if (
		typeof v.client !== "string" ||
		!Array.isArray(v.prefixes) ||
		!v.prefixes.every((p) => typeof p === "string" && p.length < 64) ||
		!Array.isArray(v.shown) ||
		!Array.isArray(v.panes) ||
		typeof v.covered !== "boolean" ||
		v.shown.length > MAX_PANES ||
		v.panes.length > MAX_PANES
	)
		return undefined;
	const shown: ControlPanes["shown"][number][] = [];
	for (const item of v.shown as unknown[]) {
		const b = item as Record<string, unknown> | null;
		if (
			b === null ||
			typeof b !== "object" ||
			!cell(b.pane) ||
			typeof b.active !== "boolean"
		)
			return undefined;
		shown.push({ pane: b.pane, active: b.active });
	}
	const panes: ControlPanes["panes"][number][] = [];
	for (const item of v.panes as unknown[]) {
		const p = item as Record<string, unknown> | null;
		if (
			p === null ||
			typeof p !== "object" ||
			!cell(p.pane) ||
			typeof p.inMode !== "boolean" ||
			typeof p.socket !== "string"
		)
			return undefined;
		panes.push({ pane: p.pane, inMode: p.inMode, socket: p.socket });
	}
	return {
		client: v.client,
		prefixes: v.prefixes as string[],
		shown,
		panes,
		covered: v.covered,
	};
}

/**
 * A control-mode page's panes as a reading, with the sockets a reading of
 * tmux confirmed (`confirmed`, by pane id) in place of the page's hints.
 * Where a pane is is not in it: the page places its Neovim itself.
 */
export function controlReading(
	panes: ControlPanes,
	confirmed: ReadonlyMap<string, string>,
): TerminalNeovimReading {
	const shown = new Map(panes.shown.map((box) => [box.pane, box]));
	return {
		panes: panes.panes.map((pane) => {
			const paneId = `%${String(pane.pane)}`;
			const box = shown.get(pane.pane);
			return {
				paneId,
				windowActive: box !== undefined,
				paneActive: box?.active ?? false,
				zoomed: false,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				inMode: pane.inMode,
				socket: confirmed.get(paneId) ?? "",
			};
		}),
		client:
			panes.client === ""
				? undefined
				: {
						name: panes.client,
						width: 0,
						height: 0,
						keyTable: "root",
						statusTop: 0,
						prefixes: panes.prefixes,
					},
	};
}

/** A key as Electron's `before-input-event` has it. */
export interface KeyInput {
	readonly type: string;
	readonly key: string;
	/** The physical key (`KeyX`, `AltLeft`). */
	readonly code?: string;
	readonly control: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	readonly meta: boolean;
}

/** Whether `input` is the tmux key `name` (`C-b`, `C-Space`, `M-a`, `F12`). */
export function isTmuxKey(name: string, input: KeyInput): boolean {
	let rest = name;
	let control = false;
	let alt = false;
	let shift = false;
	for (;;) {
		if (rest.startsWith("C-") && rest.length > 2) {
			control = true;
			rest = rest.slice(2);
		} else if (rest.startsWith("M-") && rest.length > 2) {
			alt = true;
			rest = rest.slice(2);
		} else if (rest.startsWith("S-") && rest.length > 2) {
			shift = true;
			rest = rest.slice(2);
		} else break;
	}
	if (input.meta || input.control !== control || input.alt !== alt) {
		return false;
	}
	const named: Record<string, string> = {
		Space: " ",
		Enter: "Enter",
		Escape: "Escape",
		Tab: "Tab",
		BSpace: "Backspace",
	};
	const want = named[rest] ?? rest;
	if (want.length === 1) {
		// `C-B` and `C-b` are one key to tmux; a capital names Shift otherwise.
		if (control) return input.key.toLowerCase() === want.toLowerCase();
		return input.key === want;
	}
	return input.key === want && (!shift || input.shift);
}

/**
 * Whether the left Option is down, followed from the key events of one web
 * contents (`code` `AltLeft`): a keystroke main hands on says so
 * (`TerminalNeovimKeyWire.leftOption`), since what it is typed into never
 * saw the Option go down.
 */
export class LeftOption {
	private down = false;

	note(input: KeyInput): boolean {
		if (input.code === "AltLeft") {
			this.down = input.type !== "keyUp";
		}
		if (!input.alt) this.down = false;
		return this.down;
	}
}

/**
 * Keys after the prefix that open something of tmux's that wants the keys
 * after it — a prompt, a chooser, a mode — in tmux's default table.
 */
const INTERACTIVE_AFTER_PREFIX = new Set([
	":",
	"[",
	"?",
	"w",
	"s",
	",",
	"$",
	".",
	"'",
	"f",
	"t",
	"q",
	"=",
	"/",
	"PageUp",
]);
/** What answers a prompt or leaves a chooser. */
const PROMPT_ENDS = new Set(["Enter", "Escape"]);

export interface OverlayTerminal {
	readonly terminalId: string;
	readonly machine: RuntimeId;
	/**
	 * A Workspace's terminal: its `ws-` session is the one read. Absent: an
	 * Agent's terminal, whose `tm-` session is named by `terminalId`.
	 */
	readonly workspace?: WorkspaceTerminalTarget;
}

/** What DevHub does to tmux and to the machine on the overlays' behalf. */
export interface TerminalNeovimPorts {
	/**
	 * The terminal's session read, or `undefined` when it cannot be;
	 * `announce`: state the overlay's server option on the way.
	 */
	read(
		terminal: OverlayTerminal,
		announce: boolean,
	): Promise<TerminalNeovimReading | undefined>;
	/** Tell the pane's `nvim` its UI is attached (`@devhub-nvim-ui`). */
	claim(terminal: OverlayTerminal, paneId: string): Promise<void>;
	selectPane(terminal: OverlayTerminal, paneId: string): Promise<void>;
	/** Put DevHub's client in tmux's prefix table. */
	enterPrefix(terminal: OverlayTerminal, client: string): Promise<void>;
	/** A socket on this Mac that reaches `socket` on the terminal's machine. */
	reach(terminal: OverlayTerminal, socket: string): Promise<string>;
	/** Told once a UI is attached: the theme, say. */
	attached?(localPath: string): void;
	log?(line: string): void;
}

export interface TerminalNeovimsOptions {
	readonly ports: TerminalNeovimPorts;
	/** Told when an overlay appears, moves, hides, ends, or the keys move. */
	readonly changed: () => void;
	/**
	 * An overlay went while its UI may be attached (its pane went, its
	 * `nvim` took its socket back): the UI is let go of. Its page draws
	 * every Neovim of its terminal and stays, so its going says nothing.
	 */
	readonly gone?: (key: string) => void;
	readonly pollMs?: (machine: RuntimeId) => number;
	readonly settleMs?: number;
}

/** One overlay, as the terminal's page draws it (`TerminalNeovimWire`). */
export interface OverlayView {
	/** The id its UI attaches as. */
	readonly key: string;
	/** Its tmux pane's number. */
	readonly pane: number;
	/** tmux shows its pane to DevHub's client. */
	readonly shown: boolean;
	/** Polled: the pane's cells in the client's screen (`TerminalNeovimWire`). */
	readonly cells?: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
		readonly cols: number;
		readonly rows: number;
	};
}

/** The Neovims over one terminal's panes, and which has the keys. */
export interface TerminalOverlays {
	readonly overlays: readonly OverlayView[];
	readonly keys?: string;
}

/** The ids the overlays' pages attach as, apart from Workspaces'. */
export const OVERLAY_KEY_PREFIX = "tnv:";

export function isOverlayKey(key: string): boolean {
	return key.startsWith(OVERLAY_KEY_PREFIX);
}

interface Overlay {
	readonly key: string;
	readonly serial: number;
	readonly terminal: OverlayTerminal;
	readonly paneId: string;
	readonly socket: string;
	localPath: Promise<string> | undefined;
	attached: boolean;
}

type Lend =
	| {
			readonly kind: "prefix";
			readonly armed: boolean;
	  }
	| { readonly kind: "interactive" }
	| { readonly kind: "user" };

interface Watch {
	terminal: OverlayTerminal;
	onScreen: boolean;
	reading: TerminalNeovimReading | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	reading$: boolean;
	lend: Lend | undefined;
	/** The overlay's pane was active and shown at the last reading. */
	activeShown: boolean;
	/** `neovims` as the last change said it. */
	said: string;
	/**
	 * In control mode: the page's panes, and the sockets the last reading of
	 * tmux confirmed. Absent: the page is xterm.js, and tmux is polled.
	 */
	control:
		| {
				panes: ControlPanes;
				hints: string;
				confirmed: Map<string, string>;
		  }
		| undefined;
	readonly overlays: Map<string, Overlay>;
}

function deadKey(paneId: string, socket: string): string {
	return `${paneId}\t${socket}`;
}

export class TerminalNeovims {
	private readonly watches = new Map<string, Watch>();
	private readonly byKey = new Map<string, Overlay>();
	/**
	 * Panes' sockets that could not be attached to, or whose Neovim ended: a
	 * stale option, not a Neovim. By pane and socket, as a managed Neovim
	 * started again in a new pane listens on the same socket path.
	 */
	private readonly dead = new Set<string>();
	/** Control-mode pages that spoke before their terminal was known. */
	private readonly earlyControl = new Map<string, ControlPanes>();
	private serial = 1;
	private disposed = false;
	/** `[general] editor = "neovim"`: off, no new overlay is made. */
	private enabled = false;

	constructor(private readonly options: TerminalNeovimsOptions) {}

	/**
	 * The setting, as it is now. Turned off, the overlays there are stay
	 * until their Neovims exit (one is somebody's `git commit`), and a
	 * `nvim` started from then on is the TUI.
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/**
	 * The terminals there are — Agents' and Workspaces' — and which are on
	 * screen. Only those on screen are read; one that is gone takes its
	 * overlays with it.
	 */
	setTerminals(
		terminals: readonly OverlayTerminal[],
		onScreen: ReadonlySet<string>,
	): void {
		const known = new Set(terminals.map((terminal) => terminal.terminalId));
		let changed = false;
		for (const [terminalId, watch] of [...this.watches]) {
			if (known.has(terminalId)) continue;
			this.stop(watch);
			for (const overlay of watch.overlays.values()) {
				this.byKey.delete(overlay.key);
				this.options.gone?.(overlay.key);
			}
			changed ||= watch.overlays.size > 0;
			this.watches.delete(terminalId);
		}
		for (const terminal of terminals) {
			let watch = this.watches.get(terminal.terminalId);
			if (watch === undefined) {
				watch = {
					terminal,
					onScreen: false,
					reading: undefined,
					timer: undefined,
					reading$: false,
					lend: undefined,
					activeShown: false,
					said: "",
					control: undefined,
					overlays: new Map(),
				};
				this.watches.set(terminal.terminalId, watch);
				const early = this.earlyControl.get(terminal.terminalId);
				this.earlyControl.delete(terminal.terminalId);
				if (early !== undefined) this.controlPanes(terminal.terminalId, early);
			}
			watch.terminal = terminal;
			const shown = onScreen.has(terminal.terminalId);
			if (shown === watch.onScreen) continue;
			watch.onScreen = shown;
			changed ||= watch.overlays.size > 0;
			if (shown) this.schedule(watch, 0);
			else this.stop(watch);
		}
		if (changed) this.changed();
	}

	/**
	 * A control-mode terminal's page, saying where its panes are drawn and
	 * what each is (see the file's comment); `undefined`: it is not a
	 * control-mode page any more, and tmux is polled again.
	 */
	controlPanes(terminalId: string, panes: ControlPanes | undefined): void {
		const watch = this.watches.get(terminalId);
		if (watch === undefined) {
			// The page can say it before main has heard of the terminal.
			if (panes === undefined) this.earlyControl.delete(terminalId);
			else this.earlyControl.set(terminalId, panes);
			return;
		}
		if (panes === undefined) {
			if (watch.control === undefined) return;
			watch.control = undefined;
			if (watch.onScreen) this.schedule(watch, 0);
			return;
		}
		this.stop(watch);
		const hints = JSON.stringify(
			panes.panes.map((pane) => [pane.pane, pane.socket]),
		);
		const first = watch.control === undefined;
		// A control client attached again (an SSH host's connection came
		// back): a Neovim whose UI ended with the old connection is tried
		// again, as at a DevHub open (`reclaim`).
		if (
			panes.client !== "" &&
			watch.control !== undefined &&
			panes.client !== watch.control.panes.client
		) {
			for (const pane of watch.reading?.panes ?? []) {
				this.dead.delete(deadKey(pane.paneId, pane.socket));
			}
			watch.control.hints = "";
		}
		// Until tmux is read for it, the sockets the last reading found
		// stand: a pane's overlay is not ended and made again (a second page,
		// a second UI) for a page that started speaking for its terminal.
		const control = (watch.control ??= {
			panes,
			hints: "",
			confirmed: new Map(
				(watch.reading?.panes ?? [])
					.filter((pane) => pane.socket !== "")
					.map((pane) => [pane.paneId, pane.socket]),
			),
		});
		control.panes = panes;
		this.applyControl(watch);
		if (first || hints !== control.hints) {
			control.hints = hints;
			void this.confirm(watch);
		}
	}

	/** The terminals that have an overlay, or had one at the last change. */
	terminals(): readonly string[] {
		return [...this.watches.keys()];
	}

	/** The overlays of a terminal, for its page, and which has the keys. */
	neovims(terminalId: string): TerminalOverlays {
		const watch = this.watches.get(terminalId);
		if (watch === undefined) return { overlays: [] };
		const overlays: OverlayView[] = [];
		for (const overlay of watch.overlays.values()) {
			const cells = this.cellsOf(watch, overlay);
			overlays.push({
				key: overlay.key,
				pane: Number(overlay.paneId.slice(1)),
				shown: this.shown(watch, overlay),
				...(cells !== undefined ? { cells } : {}),
			});
		}
		const keys = this.keyboardOverlay(terminalId);
		return keys === undefined ? { overlays } : { overlays, keys };
	}

	/** The overlay the terminal's keys go to now, if any. */
	keyboardOverlay(terminalId: string): string | undefined {
		const watch = this.watches.get(terminalId);
		if (watch === undefined || watch.lend !== undefined) return undefined;
		// A prompt, a menu, a popup or the picker has them: tmux's.
		if (watch.control?.panes.covered === true) return undefined;
		const overlay = this.activeOverlay(watch);
		return overlay?.attached === true ? overlay.key : undefined;
	}

	/**
	 * The overlay tmux shows on the terminal's active pane, whether or not it
	 * has the keys: the Neovim the terminal is in, for the window's title.
	 */
	shownOverlay(terminalId: string): string | undefined {
		const watch = this.watches.get(terminalId);
		return watch === undefined ? undefined : this.activeOverlay(watch)?.key;
	}

	/**
	 * DevHub just made one of the terminal's panes the active one (a file
	 * opened in its `devhub-nvim` window): the keys go to the overlay there
	 * as soon as a reading shows it, whoever had them before. A pane whose UI
	 * ended while its Neovim ran on (an SSH host's connection dropped) is
	 * tried again: the open just reached that Neovim.
	 */
	reclaim(terminalId: string): void {
		const watch = this.watches.get(terminalId);
		if (watch === undefined) return;
		for (const pane of watch.reading?.panes ?? []) {
			this.dead.delete(deadKey(pane.paneId, pane.socket));
		}
		watch.lend = undefined;
		this.changed();
		if (watch.control !== undefined) void this.confirm(watch);
		else if (watch.onScreen) this.schedule(watch, 0);
	}

	/** Where an overlay's page attaches: the socket, reached from here. */
	async connection(key: string): Promise<{
		readonly socketPath: string;
		readonly server: number;
		readonly machine: RuntimeId;
	}> {
		const overlay = this.byKey.get(key);
		if (overlay === undefined) throw new Error("That Neovim has exited.");
		overlay.localPath ??= this.options.ports.reach(
			overlay.terminal,
			overlay.socket,
		);
		return {
			socketPath: await overlay.localPath,
			server: overlay.serial,
			machine: overlay.terminal.machine,
		};
	}

	/** The page's UI is attached: the `nvim` stops waiting for one. */
	attached(key: string): void {
		const overlay = this.byKey.get(key);
		if (overlay === undefined) return;
		overlay.attached = true;
		void this.options.ports
			.claim(overlay.terminal, overlay.paneId)
			.catch((error: unknown) => {
				this.options.ports.log?.(
					`[devhub] could not tell ${overlay.paneId}'s nvim its UI is attached: ${String(error)}`,
				);
			});
		void overlay.localPath?.then((path) => this.options.ports.attached?.(path));
		this.changed();
	}

	/** Its UI ended (Neovim exited) or never attached: the overlay goes. */
	ended(key: string): void {
		const overlay = this.byKey.get(key);
		if (overlay === undefined) return;
		this.dead.add(deadKey(overlay.paneId, overlay.socket));
		this.byKey.delete(key);
		const watch = this.watches.get(overlay.terminal.terminalId);
		watch?.overlays.delete(overlay.paneId);
		if (watch !== undefined && watch.overlays.size === 0) {
			watch.lend = undefined;
		}
		this.changed();
		if (watch?.control !== undefined) this.applyControl(watch);
		else if (watch?.onScreen === true) this.schedule(watch, 0);
	}

	/** The overlay's page took the keyboard (a click into it). */
	overlayFocused(key: string): void {
		const overlay = this.byKey.get(key);
		if (overlay === undefined) return;
		const watch = this.watches.get(overlay.terminal.terminalId);
		if (watch === undefined) return;
		const pane = watch.reading?.panes.find(
			(candidate) => candidate.paneId === overlay.paneId,
		);
		const lent = watch.lend !== undefined;
		watch.lend = undefined;
		if (pane !== undefined && !pane.paneActive) {
			void this.options.ports
				.selectPane(watch.terminal, overlay.paneId)
				.catch(() => undefined)
				.then(() => {
					if (watch.control === undefined) this.schedule(watch, 0);
				});
		} else if (lent) {
			this.changed();
		}
	}

	/** The terminal's page took the keyboard by itself: a click beside the overlay. */
	terminalFocused(terminalId: string): void {
		const watch = this.watches.get(terminalId);
		if (watch === undefined || watch.lend !== undefined) return;
		if (this.keyboardOverlay(terminalId) === undefined) return;
		watch.lend = { kind: "user" };
		this.changed();
	}

	/**
	 * A key typed in the overlay: `prefix` when it is tmux's prefix, which
	 * the terminal is to take (the client is put in the prefix table here);
	 * `hand`, in control mode, when the terminal's page is to be given the
	 * keystroke itself (its control client keeps its own key tables).
	 */
	overlayKey(key: string, input: KeyInput): "prefix" | "hand" | "pass" {
		if (input.type !== "keyDown") return "pass";
		const overlay = this.byKey.get(key);
		const watch =
			overlay === undefined
				? undefined
				: this.watches.get(overlay.terminal.terminalId);
		const client = watch?.reading?.client;
		if (watch === undefined || client === undefined) return "pass";
		if (!client.prefixes.some((prefix) => isTmuxKey(prefix, input))) {
			return "pass";
		}
		if (watch.control !== undefined) {
			watch.lend = { kind: "prefix", armed: true };
			this.changed();
			return "hand";
		}
		watch.lend = { kind: "prefix", armed: true };
		void this.options.ports
			.enterPrefix(watch.terminal, client.name)
			.catch(() => undefined);
		this.changed();
		return "prefix";
	}

	/**
	 * A key typed in the terminal's page. `redirect`: tmux would only hand it
	 * to the pane under the overlay, so the overlay takes the keys (and this
	 * one) instead.
	 */
	terminalKey(terminalId: string, input: KeyInput): "pass" | "redirect" {
		if (input.type !== "keyDown") return "pass";
		if (["Shift", "Control", "Alt", "Meta"].includes(input.key)) return "pass";
		const watch = this.watches.get(terminalId);
		if (watch === undefined) return "pass";
		// What is drawn over the panes takes every key while it is open.
		if (watch.control?.panes.covered === true) return "pass";
		const overlay = this.activeOverlay(watch);
		const client = watch.reading?.client;
		if (overlay?.attached !== true || client === undefined) return "pass";
		const lend = watch.lend;
		// The key after the prefix, the prefix again (`send-prefix`) included.
		if (lend?.kind === "prefix" && lend.armed) {
			if (
				watch.control === undefined &&
				INTERACTIVE_AFTER_PREFIX.has(input.key)
			) {
				watch.lend = { kind: "interactive" };
			} else {
				watch.lend = { kind: "prefix", armed: false };
				this.settle(watch);
			}
			return "pass";
		}
		if (client.prefixes.some((prefix) => isTmuxKey(prefix, input))) {
			watch.lend = { kind: "prefix", armed: true };
			return "pass";
		}
		if (lend?.kind === "interactive") {
			if (PROMPT_ENDS.has(input.key) || (input.control && input.key === "c")) {
				this.settle(watch);
			}
			return "pass";
		}
		if (lend?.kind === "prefix") return "pass";
		if (client.keyTable !== "root") return "pass";
		watch.lend = undefined;
		this.changed();
		return "redirect";
	}

	/** Told to the window: each terminal's `neovims` as it is now. */
	private changed(): void {
		for (const [terminalId, watch] of this.watches)
			watch.said = JSON.stringify(this.neovims(terminalId));
		this.options.changed();
	}

	/** DevHub is quitting: the Neovims run on, and the next DevHub adopts them. */
	dispose(): void {
		this.disposed = true;
		for (const watch of this.watches.values()) this.stop(watch);
	}

	/** The overlay on the pane tmux has active in the window it shows. */
	private activeOverlay(watch: Watch): Overlay | undefined {
		const reading = watch.reading;
		if (reading === undefined || !watch.onScreen) return undefined;
		const pane = reading.panes.find(
			(candidate) =>
				candidate.windowActive &&
				candidate.paneActive &&
				paneShown(candidate, reading),
		);
		return pane === undefined ? undefined : watch.overlays.get(pane.paneId);
	}

	/** Whether tmux shows the overlay's pane to DevHub's client. */
	private shown(watch: Watch, overlay: Overlay): boolean {
		const reading = watch.reading;
		if (!watch.onScreen || reading?.client === undefined) return false;
		const pane = reading.panes.find(
			(candidate) => candidate.paneId === overlay.paneId,
		);
		return pane !== undefined && paneShown(pane, reading);
	}

	/** Polled: the overlay's pane in the client's cells, while it is shown. */
	private cellsOf(watch: Watch, overlay: Overlay): OverlayView["cells"] {
		const client = watch.reading?.client;
		if (watch.control !== undefined || client === undefined) return undefined;
		if (!this.shown(watch, overlay)) return undefined;
		const pane = watch.reading?.panes.find(
			(candidate) => candidate.paneId === overlay.paneId,
		);
		if (pane === undefined || !(client.width > 0 && client.height > 0))
			return undefined;
		return {
			x: pane.left,
			y: pane.top + client.statusTop,
			width: pane.width,
			height: pane.height,
			cols: client.width,
			rows: client.height,
		};
	}

	/** After a prefix binding ran: read again, and take the keys back if it is ours. */
	private settle(watch: Watch): void {
		setTimeout(() => {
			if (watch.lend === undefined || watch.lend.kind === "user") return;
			watch.lend = { kind: "user" };
			const read =
				watch.control === undefined ? this.poll(watch) : Promise.resolve();
			void read.then(() => {
				if (watch.lend?.kind !== "user") return;
				if (watch.reading?.client?.keyTable !== "root") return;
				if (this.activeOverlay(watch) === undefined) return;
				watch.lend = undefined;
				this.changed();
			});
		}, this.options.settleMs ?? 120);
	}

	private stop(watch: Watch): void {
		if (watch.timer !== undefined) clearTimeout(watch.timer);
		watch.timer = undefined;
	}

	private schedule(watch: Watch, delayMs: number): void {
		if (this.disposed || !watch.onScreen || watch.control !== undefined) return;
		this.stop(watch);
		watch.timer = setTimeout(() => {
			watch.timer = undefined;
			void this.poll(watch).finally(() => {
				if (watch.timer === undefined && watch.onScreen) {
					this.schedule(
						watch,
						this.options.pollMs?.(watch.terminal.machine) ??
							(watch.terminal.machine === "local" ? 150 : 400),
					);
				}
			});
		}, delayMs);
	}

	private async poll(watch: Watch): Promise<void> {
		if (watch.reading$) return;
		watch.reading$ = true;
		let reading: TerminalNeovimReading | undefined;
		try {
			reading = await this.options.ports.read(watch.terminal, this.enabled);
		} catch {
			reading = undefined;
		} finally {
			watch.reading$ = false;
		}
		if (reading === undefined || this.disposed) return;
		this.apply(watch, reading);
	}

	/**
	 * Read tmux for a control-mode terminal's sockets (and state the
	 * overlay's server option on the way): what its page names is a hint.
	 */
	private async confirm(watch: Watch): Promise<void> {
		let reading: TerminalNeovimReading | undefined;
		try {
			reading = await this.options.ports.read(watch.terminal, this.enabled);
		} catch {
			reading = undefined;
		}
		const control = watch.control;
		if (reading === undefined || control === undefined || this.disposed) return;
		control.confirmed = new Map(
			reading.panes
				.filter((pane) => pane.socket !== "")
				.map((pane) => [pane.paneId, pane.socket]),
		);
		this.applyControl(watch);
	}

	private applyControl(watch: Watch): void {
		const control = watch.control;
		if (control === undefined || this.disposed) return;
		this.apply(watch, controlReading(control.panes, control.confirmed));
	}

	private apply(watch: Watch, reading: TerminalNeovimReading): void {
		watch.reading = reading;
		let changed = false;
		const live = new Map(reading.panes.map((pane) => [pane.paneId, pane]));
		for (const [paneId, overlay] of [...watch.overlays]) {
			// The pane went, or its `nvim` took its socket back on the way out.
			if (live.get(paneId)?.socket === overlay.socket) continue;
			watch.overlays.delete(paneId);
			this.byKey.delete(overlay.key);
			this.options.gone?.(overlay.key);
			changed = true;
		}
		for (const pane of reading.panes) {
			if (!this.enabled) break;
			if (
				pane.socket === "" ||
				this.dead.has(deadKey(pane.paneId, pane.socket))
			)
				continue;
			if (watch.overlays.has(pane.paneId)) continue;
			const overlay: Overlay = {
				key: `${OVERLAY_KEY_PREFIX}${String(this.serial)}`,
				serial: this.serial,
				terminal: watch.terminal,
				paneId: pane.paneId,
				socket: pane.socket,
				localPath: undefined,
				attached: false,
			};
			this.serial += 1;
			watch.overlays.set(pane.paneId, overlay);
			this.byKey.set(overlay.key, overlay);
			changed = true;
		}
		// The keys come back to an overlay whose pane becomes the active one
		// (a pane switch into it, its window selected again, a zoom undone).
		const activeShown = this.activeOverlay(watch) !== undefined;
		if (activeShown && !watch.activeShown && watch.lend?.kind === "user") {
			watch.lend = undefined;
		}
		watch.activeShown = activeShown;
		const after = JSON.stringify(this.neovims(watch.terminal.terminalId));
		if (changed || after !== watch.said) this.changed();
	}
}

/**
 * The terminal a terminal page's URL is for (`pane.html#<terminal id>`), or
 * nothing for any other page.
 */
export function terminalIdOfPaneUrl(surfaceUrl: string): string | undefined {
	const at = surfaceUrl.indexOf("/pane.html#");
	if (at < 0) return undefined;
	try {
		return decodeURIComponent(surfaceUrl.slice(at + "/pane.html#".length));
	} catch {
		return undefined;
	}
}
