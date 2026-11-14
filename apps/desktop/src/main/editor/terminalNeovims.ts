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
 * # Where an overlay goes
 *
 * In the terminal's own page, over its pane: the page draws the panes itself,
 * from the layout tmux pushes to its control client, so it knows each pane
 * and says what they are (`controlPanes`): the shown window's panes, which is
 * active, every pane's mode and `@devhub-nvim`, the client and the prefixes.
 * It mounts each overlay's Neovim (`shell/pane/PaneNeovims.tsx`) in its pane
 * and moves it with it (`docs/pane-motion.md`). Nothing is polled. An
 * overlay is hidden whenever the pane is not what tmux shows: another
 * window, the pane in a mode (copy mode, a chooser), or no DevHub client.
 *
 * The sockets the page names are only a hint: each change of them is a
 * reading of tmux here (`TerminalNeovimPorts.read`), and only a socket that
 * reading confirms is attached to; the control client in the pty host reads
 * a pane's socket from tmux itself and says so directly (`paneSocket`).
 *
 * # The keyboard
 *
 * The overlay has the keys whenever the terminal would and its pane is the
 * active pane and shown. The tmux prefix typed in it is handed to the
 * terminal surface as the keystroke it was, since that page's control client
 * keeps its own place in tmux's key tables (`ptyHost/control/keyGuard.ts`);
 * a prompt or a chooser is DevHub's to draw there (or refused), and covers
 * the panes while it is open (`covered`), so every key after the prefix gives
 * the keys back once its binding has run. A click outside the overlay gives
 * them to the terminal; a key typed there that tmux would only hand to the
 * pane under the overlay (whose Neovim does not read its tty) goes to the
 * overlay instead. DevHub's own chords are caught before any of this, on
 * every page.
 */

import { startupTrace } from "../diagnostics/startupTrace.js";
import type { RuntimeId } from "../runtime/runtime.js";
import type { WorkspaceTerminalTarget } from "../terminal/ports.js";

/** A pane of the terminal's session, as its page has it. */
export interface TerminalNeovimPane {
	readonly paneId: string;
	/** In the window the page shows (a zoomed pane alone). */
	readonly windowActive: boolean;
	readonly paneActive: boolean;
	readonly inMode: boolean;
	/** `@devhub-nvim`: the socket its `nvim` listens on, on its machine. */
	readonly socket: string;
}

/** DevHub's control client on the session. */
export interface TerminalNeovimClient {
	readonly name: string;
	/** `prefix` and `prefix2`, as tmux names keys; `None` left out. */
	readonly prefixes: readonly string[];
}

export interface TerminalNeovimReading {
	readonly panes: readonly TerminalNeovimPane[];
	readonly client: TerminalNeovimClient | undefined;
}

/** What a reading of tmux asks for each pane: its id and its socket. */
export const SOCKET_FORMAT = "#{pane_id}\t#{@devhub-nvim}";

/** A reading's output: each pane's id and `@devhub-nvim`, by pane id. */
export function parseSocketReading(output: string): Map<string, string> {
	const sockets = new Map<string, string>();
	for (const line of output.split("\n")) {
		const [id, socket] = line.split("\t");
		if (id === undefined || !/^%\d+$/.test(id)) continue;
		sockets.set(id, socket ?? "");
	}
	return sockets;
}

/** Whether tmux is showing this pane to DevHub's client. */
export function paneShown(
	pane: TerminalNeovimPane,
	reading: TerminalNeovimReading,
): boolean {
	return reading.client !== undefined && pane.windowActive && !pane.inMode;
}

/**
 * A terminal's panes, as its page has them (`controlPanes`,
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
 * A page's panes as a reading, with the sockets a reading of tmux confirmed
 * (`confirmed`, by pane id) in place of the page's hints. Where a pane is is
 * not in it: the page places its Neovim itself.
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
				inMode: pane.inMode,
				socket: confirmed.get(paneId) ?? "",
			};
		}),
		client:
			panes.client === ""
				? undefined
				: { name: panes.client, prefixes: panes.prefixes },
	};
}

/**
 * A tmux key name as the control-mode terminal names a keystroke
 * (`controlKeys.ts`): modifiers, then one character or a named key.
 */
export function isClientKeyName(key: string): boolean {
	return /^(?:[CMS]-)*(?:[A-Za-z][A-Za-z0-9]{1,15}|[!-~])$/u.test(key);
}

/**
 * At most this many keys a page reports untyped at once: the prefix, and
 * the keys typed while it waited.
 */
export const MAX_UNTYPED_KEYS = 8;

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
	 * The sockets of the terminal's panes (`@devhub-nvim`, by pane id), or
	 * `undefined` when they cannot be read; `announce`: state the overlay's
	 * server option on the way.
	 */
	read(
		terminal: OverlayTerminal,
		announce: boolean,
	): Promise<ReadonlyMap<string, string> | undefined>;
	selectPane(terminal: OverlayTerminal, paneId: string): Promise<void>;
	/**
	 * Keys through DevHub's control client's key tables (`send-keys -K -c`),
	 * as its page's surface would send them: tmux's prefix, handed to the
	 * page, that the page could not type into its terminal surface.
	 */
	typeKeys?(
		terminal: OverlayTerminal,
		client: string,
		keys: readonly string[],
	): Promise<void>;
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
	| { readonly kind: "user" };

interface Watch {
	terminal: OverlayTerminal;
	onScreen: boolean;
	reading: TerminalNeovimReading | undefined;
	lend: Lend | undefined;
	/** The overlay's pane was active and shown at the last reading. */
	activeShown: boolean;
	/** `neovims` as the last change said it. */
	said: string;
	/**
	 * The page's panes, and the sockets the last reading of tmux confirmed.
	 * Absent until the terminal's page has said what its panes are.
	 */
	control:
		| {
				panes: ControlPanes;
				hints: string;
				confirmed: Map<string, string>;
				/**
				 * The sockets the pty host's control client read from tmux
				 * (`paneSocket`), by pane, with the reading they came at: a
				 * reading of main's that started before one stands for it.
				 */
				direct: Map<string, { socket: string; at: number }>;
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
	/** Pages that spoke before their terminal was known. */
	private readonly earlyControl = new Map<string, ControlPanes>();
	private serial = 1;
	/** Counts the readings of tmux, main's and the control clients'. */
	private readings = 0;
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
	 * screen. One that is gone takes its overlays with it.
	 */
	setTerminals(
		terminals: readonly OverlayTerminal[],
		onScreen: ReadonlySet<string>,
	): void {
		const known = new Set(terminals.map((terminal) => terminal.terminalId));
		let changed = false;
		for (const [terminalId, watch] of [...this.watches]) {
			if (known.has(terminalId)) continue;
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
		}
		if (changed) this.changed();
	}

	/**
	 * A terminal's page, saying what each of its panes is (see the file's
	 * comment); `undefined`: the page's surface went. The overlays stand as
	 * they are until a page speaks for the terminal again.
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
			watch.control = undefined;
			return;
		}
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
			direct: new Map(),
			confirmed: new Map(
				(watch.reading?.panes ?? [])
					.filter((pane) => pane.socket !== "")
					.map((pane) => [pane.paneId, pane.socket]),
			),
		});
		control.panes = panes;
		this.applyControl(watch);
		// A hint that says what is confirmed already (a control client read
		// it, `paneSocket`) needs no reading.
		const agrees = panes.panes.every(
			(pane) =>
				(control.confirmed.get(`%${String(pane.pane)}`) ?? "") === pane.socket,
		);
		if (first || control.hints === "" || (hints !== control.hints && !agrees)) {
			control.hints = hints;
			void this.confirm(watch);
		} else control.hints = hints;
	}

	/**
	 * A terminal's control client read, from tmux, that pane
	 * `paneId`'s `@devhub-nvim` is `socket` (`""`: none). It runs in the pty
	 * host, main's own process, and asked tmux itself — on the OSC the pane's
	 * `nvim` writes, at once — so this is confirmed as a reading of main's
	 * would be, without the page's report and a `list-panes` after it. The
	 * key of the overlay that is that pane's Neovim now, if there is one.
	 */
	paneSocket(
		terminalId: string,
		paneId: string,
		socket: string,
	): string | undefined {
		startupTrace(`overlay:pane-socket ${paneId}`);
		const watch = this.watches.get(terminalId);
		const control = watch?.control;
		if (watch === undefined || control === undefined || this.disposed)
			return undefined;
		this.readings += 1;
		control.direct.set(paneId, { socket, at: this.readings });
		if (socket === "") control.confirmed.delete(paneId);
		else control.confirmed.set(paneId, socket);
		this.applyControl(watch);
		const overlay = watch.overlays.get(paneId);
		return socket !== "" && overlay?.socket === socket
			? overlay.key
			: undefined;
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
			overlays.push({
				key: overlay.key,
				pane: Number(overlay.paneId.slice(1)),
				shown: this.shown(watch, overlay),
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
	}

	/**
	 * Where an overlay's page attaches: the socket, reached from here, and
	 * the pane whose Neovim it is to be (`NeovimUiTarget.pane`).
	 */
	async connection(key: string): Promise<{
		readonly socketPath: string;
		readonly server: number;
		readonly machine: RuntimeId;
		readonly pane?: string;
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
			pane: overlay.paneId,
		};
	}

	/**
	 * The page's UI is attached (the pane's `nvim` hears it from the attach
	 * itself, `neovimUi.ts`): the overlay can have the keys.
	 */
	attached(key: string): void {
		const overlay = this.byKey.get(key);
		if (overlay === undefined) return;
		overlay.attached = true;
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
		if (watch !== undefined) this.applyControl(watch);
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
				.catch(() => undefined);
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
	 * A key typed in the overlay: `hand` when it is tmux's prefix, and the
	 * terminal's page is to be given the keystroke itself (its control client
	 * keeps its own key tables).
	 */
	overlayKey(key: string, input: KeyInput): "hand" | "pass" {
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
		watch.lend = { kind: "prefix", armed: true };
		this.changed();
		return "hand";
	}

	/**
	 * Keys the terminal's page was handed (tmux's prefix, and the key after
	 * it) and could not type into its terminal surface: none there yet, or
	 * not attached (`PaneNeovims.typeKey`). Sent through DevHub's control
	 * client on the session instead, as the surface would have. With no
	 * client to send them through, or a send that fails, it is said, and
	 * the keys are not left handed to a terminal that never had them: they
	 * go back to the overlay.
	 */
	async untyped(terminalId: string, keys: readonly string[]): Promise<void> {
		const watch = this.watches.get(terminalId);
		if (watch === undefined || keys.length === 0) return;
		const client = watch.reading?.client?.name;
		const typeKeys = this.options.ports.typeKeys;
		let failure: string | undefined;
		if (client === undefined || client === "") failure = "no DevHub client";
		else if (typeKeys === undefined) failure = "nothing to send them with";
		else {
			try {
				await typeKeys(watch.terminal, client, keys);
			} catch (error: unknown) {
				failure = error instanceof Error ? error.message : String(error);
			}
		}
		if (failure === undefined) return;
		this.options.ports.log?.(
			`[devhub] tmux's prefix (${keys.join(" ")}) from a Neovim in terminal ${terminalId} did not reach tmux: ${failure}`,
		);
		if (watch.lend?.kind !== "prefix") return;
		watch.lend = undefined;
		this.changed();
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
			watch.lend = { kind: "prefix", armed: false };
			this.settle(watch);
			return "pass";
		}
		if (client.prefixes.some((prefix) => isTmuxKey(prefix, input))) {
			watch.lend = { kind: "prefix", armed: true };
			return "pass";
		}
		if (lend?.kind === "prefix") return "pass";
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

	/** After a prefix binding ran: the keys back, if its pane is the active one. */
	private settle(watch: Watch): void {
		setTimeout(() => {
			if (watch.lend === undefined || watch.lend.kind === "user") return;
			watch.lend = { kind: "user" };
			if (this.activeOverlay(watch) === undefined) return;
			watch.lend = undefined;
			this.changed();
		}, this.options.settleMs ?? 120);
	}

	/**
	 * Read tmux for a terminal's sockets (and state the overlay's server
	 * option on the way): what its page names is a hint.
	 */
	private async confirm(watch: Watch): Promise<void> {
		this.readings += 1;
		const started = this.readings;
		let sockets: ReadonlyMap<string, string> | undefined;
		startupTrace("overlay:confirm");
		try {
			sockets = await this.options.ports.read(watch.terminal, this.enabled);
		} catch {
			sockets = undefined;
		}
		startupTrace("overlay:confirmed");
		const control = watch.control;
		if (sockets === undefined || control === undefined || this.disposed) return;
		control.confirmed = new Map(
			[...sockets].filter(([, socket]) => socket !== ""),
		);
		// What a control client read after this reading started is newer.
		for (const [paneId, direct] of control.direct) {
			if (direct.at <= started) {
				control.direct.delete(paneId);
				continue;
			}
			if (direct.socket === "") control.confirmed.delete(paneId);
			else control.confirmed.set(paneId, direct.socket);
		}
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
			startupTrace(`overlay:new ${overlay.key}`);
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
