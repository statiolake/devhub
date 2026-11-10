/**
 * What a tmux control client in the pty host (`main/ptyHost/control/`) and
 * the page that draws its panes say to each other (`docs/terminal-mode.md`):
 * the session's windows, the shown window's pane rectangles, each shown
 * pane's dirty rows as libghostty-vt read them, and the page's input.
 */

import { TerminalFailure, validateIdentity } from "./terminal.js";

/** A cell's look, apart from its text. Colours are 24-bit RGB; absent is the default. */
export interface VtStyle {
	readonly fg?: number;
	readonly bg?: number;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly faint?: boolean;
	readonly blink?: boolean;
	readonly inverse?: boolean;
	readonly invisible?: boolean;
	readonly strikethrough?: boolean;
	readonly overline?: boolean;
	/** `GhosttySgrUnderline`: 1 single, 2 double, 3 curly, 4 dotted, 5 dashed. */
	readonly underline?: number;
}

/** One row as the painter takes it. */
export interface VtRow {
	readonly y: number;
	/** Each cell's text: `""` for the right half of a wide character. */
	readonly cells: string[];
	/** Each cell's style id (`VtFrame.styles`); 0 is the default look. */
	readonly styles: Uint32Array;
}

export interface VtCursor {
	readonly x: number;
	readonly y: number;
	readonly visible: boolean;
	readonly blinking: boolean;
	/** `GhosttyCursorVisualStyle`: 0 bar, 1 block, 2 underline, 3 hollow block. */
	readonly shape: number;
	/**
	 * The colour the program set for the cursor (OSC 12, until OSC 112 resets
	 * it), as 24-bit RGB; absent: the theme's `cursor`.
	 */
	readonly color?: number;
}

/** What changed since the last read. */
export interface VtFrame {
	readonly cols: number;
	readonly rows: number;
	/** Every row is in `rows`: the screen was cleared, resized or switched. */
	readonly full: boolean;
	readonly dirty: readonly VtRow[];
	readonly cursor: VtCursor | undefined;
	/** Styles first used in this frame, by id. */
	readonly styles: readonly (readonly [number, VtStyle])[];
}

export interface WindowInfo {
	readonly id: number;
	readonly index: number;
	readonly name: string;
	readonly active: boolean;
	/** Its panes' rectangles, as shown (a zoomed pane alone), in cells. */
	readonly zoomed: boolean;
	/** Its tab, as the person's status line formats it; absent until read. */
	readonly tab?: WindowTab;
}

/** A colour tmux names: one of the 256 (the theme's 16 first), or 24-bit RGB. */
export type StatusColor = { readonly index: number } | { readonly rgb: number };

/** What a tmux style says that DevHub draws: its attributes and its ink. */
export interface StatusStyle {
	readonly bold?: boolean;
	readonly dim?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strikethrough?: boolean;
	readonly fg?: StatusColor;
}

/** Text tmux expanded, in the style its `#[...]` gave it. */
export interface StatusRun extends StatusStyle {
	readonly text: string;
}

/**
 * A window's tab (`ptyHost/control/statusLine.ts`): its
 * `window-status-format` (`-current-format` for the active one) expanded by
 * tmux, the leading `#I` cut out as the keycap and the padding trimmed.
 */
export interface WindowTab {
	/** The format led with `#I`: the index is drawn as a keycap. */
	readonly key: boolean;
	readonly label: readonly StatusRun[];
	/** `window-status-style`, or `window-status-current-style` for the active one. */
	readonly style: StatusStyle;
	readonly bell: boolean;
	readonly activity: boolean;
	/** The colour `window-status-bell-style` / `-activity-style` names, if any. */
	readonly alert?: StatusColor;
}

/** The session's status line as DevHub draws it: around the tabs. */
export interface StatusLine {
	/** `status` is not `off`. */
	readonly shown: boolean;
	readonly position: "top" | "bottom";
	readonly justify: "left" | "centre" | "right" | "absolute-centre";
	/** `status-left` / `status-right`, expanded by tmux and trimmed. */
	readonly left: readonly StatusRun[];
	readonly right: readonly StatusRun[];
	/**
	 * The colour `pane-active-border-style` gives the active pane's border,
	 * expanded there: tmux's default turns it yellow in a mode and red while
	 * the panes are synchronized. Left out at tmux's resting default (its
	 * green): the page outlines the active pane in the theme's accent.
	 */
	readonly activeBorder?: StatusColor;
}

export interface PaneBox {
	readonly pane: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly active: boolean;
	/** `synchronize-panes`: what is typed in the window's active pane goes to it too. */
	readonly synchronized: boolean;
}

/**
 * A pane of the session, shown or not: what a Neovim DevHub draws over a
 * pane (`main/editor/terminalNeovims.ts`) is shown and hidden by.
 */
export interface SessionPane {
	readonly pane: number;
	readonly window: number;
	/** In a mode (copy mode, a chooser): tmux shows the mode, not the program. */
	readonly inMode: boolean;
	/** `@devhub-nvim`: the socket its `nvim` named, or `""`. */
	readonly socket: string;
}

/**
 * What DevHub's `nvim` (`main/editor/terminalNeovimShim.ts`) writes to its
 * pane once it has named its socket: tmux drops an OSC it does not know, and
 * a control client sees the pane's bytes as they are, so the pane is read at
 * once rather than at tmux's next once-a-second subscription check.
 */
export const NVIM_NAMED_OSC = "\u001b]6973;devhub-nvim\u0007";

/** Cells `x0`…`x1` (inclusive) of row `y` of a pane. */
export interface CopySpan {
	readonly y: number;
	readonly x0: number;
	readonly x1: number;
}

/**
 * The rows of a chooser's frame above its tree and the chosen item's pane:
 * the quick pick's header band (what is asked), one row tall as every
 * floating surface's title band is, and its search field (the filter), two
 * rows, so the pane's grid, which the painter draws on cells, starts on a
 * row of its own under them (`docs/native-picker.md`).
 */
export const CHOOSER_HEAD_ROWS = 3;

/** A row of the picker's tree. */
export interface ChooserRow {
	readonly depth: number;
	readonly text: string;
	readonly kind: "session" | "window" | "pane";
	/** Absent: nothing under it. */
	readonly expanded?: boolean;
	/** The client's own session, window or pane. */
	readonly current: boolean;
}

/** A menu's item as the page draws it; no name is a separator. */
export interface MenuItem {
	readonly name?: string;
	/** tmux's name of the key that chooses it. */
	readonly key?: string;
	/** Shown, not chosen (a name tmux was given beginning `-`). */
	readonly disabled?: boolean;
}

/** The modes of a pane the page encodes input by. */
export interface PaneModes {
	/** 0 off, else the tracking mode: 9, 1000, 1002 or 1003. */
	readonly mouse: number;
	readonly sgrMouse: boolean;
	readonly bracketedPaste: boolean;
	readonly focusEvents: boolean;
	readonly alternateScreen: boolean;
}

export type ControlToPage =
	| {
			readonly kind: "layout";
			readonly cols: number;
			readonly rows: number;
			readonly session: string;
			readonly windows: readonly WindowInfo[];
			/** The shown window, and its panes as shown. */
			readonly window: number | undefined;
			readonly panes: readonly PaneBox[];
			/** Every pane of the session, every window's. */
			readonly sessionPanes: readonly SessionPane[];
			/** The control client's name, as tmux has it. */
			readonly client: string;
			/** `prefix` and `prefix2` as tmux names keys, `None` left out. */
			readonly prefixes: readonly string[];
			/** The status line around the tabs; absent until read. */
			readonly status?: StatusLine;
	  }
	| {
			readonly kind: "pane";
			readonly seq: number;
			readonly pane: number;
			readonly frame: VtFrame;
			readonly modes: PaneModes;
	  }
	/**
	 * A `display-popup` DevHub runs (`ptyHost/control/popup.ts`): where it
	 * is in cells of the window, its border included, and its rows since the
	 * last. While one is open the keys are its.
	 */
	| {
			readonly kind: "popup";
			readonly id: number;
			readonly x: number;
			readonly y: number;
			readonly width: number;
			readonly height: number;
			readonly border: boolean;
			readonly title: string;
			readonly frame: VtFrame;
			/** Its program's modes: the mouse is reported to it as a pane's. */
			readonly modes: PaneModes;
	  }
	| { readonly kind: "popup-closed"; readonly id: number }
	/**
	 * A `command-prompt` or `confirm-before` DevHub asks
	 * (`ptyHost/control/prompt.ts`), drawn as one line at the terminal's
	 * foot, where tmux draws its prompt. While one is open the keys are its.
	 */
	| {
			readonly kind: "prompt";
			/** Expanded by tmux. */
			readonly prompt: string;
			readonly input: string;
			/** In characters of `input`. */
			readonly cursor: number;
			/** `status-keys vi`, and in command (normal) mode. */
			readonly vi: boolean;
			readonly command: boolean;
			readonly confirm: boolean;
			/** A `-T search` prompt: asked at its pane's foot in copy mode. */
			readonly search: boolean;
			/** Tab's menu of completions, while open (`PromptCompletion`). */
			readonly completion?: {
				readonly items: readonly {
					readonly word: string;
					readonly kind: "command" | "option" | "layout" | "session" | "window";
					readonly extra?: string;
				}[];
				readonly choice: number;
				/** Where the completed word starts, in characters of `input`. */
				readonly column: number;
			};
	  }
	| { readonly kind: "prompt-closed" }
	/**
	 * A `display-menu` DevHub asks (`ptyHost/control/menu.ts`): its items
	 * expanded by tmux, and where tmux would put it, in cells of the window
	 * (`x` `"W"`: over `window`'s tab, or the shown window's). While one is
	 * open the keys are its.
	 */
	| {
			readonly kind: "menu";
			readonly id: number;
			readonly title: string;
			readonly items: readonly MenuItem[];
			/** The item the keys are on; -1 none. */
			readonly choice: number;
			readonly x: number | "W";
			readonly y: number;
			/** In cells, as tmux sizes it: its widest line, and four. */
			readonly width: number;
			readonly height: number;
			readonly window?: number;
	  }
	| { readonly kind: "menu-closed"; readonly id: number }
	/**
	 * A `choose-tree` or `find-window` DevHub draws
	 * (`ptyHost/control/chooser.ts`): its frame in cells of the window, the
	 * tree's rows as shown, and where the chosen item's pane is drawn
	 * (`chooser-preview` frames). While one is open the keys are its.
	 */
	| {
			readonly kind: "chooser";
			readonly id: number;
			readonly x: number;
			readonly y: number;
			readonly width: number;
			readonly height: number;
			readonly preview: {
				readonly x: number;
				readonly y: number;
				readonly width: number;
				readonly height: number;
			};
			readonly filter: string;
			readonly rows: readonly ChooserRow[];
			readonly choice: number;
	  }
	| {
			readonly kind: "chooser-preview";
			readonly id: number;
			readonly frame: VtFrame;
	  }
	| { readonly kind: "chooser-closed"; readonly id: number }
	/** `display-panes`: each shown pane's index, drawn over it. */
	| {
			readonly kind: "display-panes";
			readonly id: number;
			readonly panes: readonly {
				readonly pane: number;
				readonly index: number;
			}[];
	  }
	| { readonly kind: "display-panes-closed"; readonly id: number }
	/**
	 * A pane in copy mode (`ptyHost/control/copyMode.ts`): its rows come as
	 * its frames; this is what is drawn over them.
	 */
	| {
			readonly kind: "copy-mode";
			readonly pane: number;
			/** tmux's position indicator (`copy-mode-position-format`). */
			readonly badge: string;
			/** Lines back from the bottom, of `history`. */
			readonly scroll: number;
			readonly history: number;
			readonly selection: readonly CopySpan[];
			readonly matches: readonly CopySpan[];
	  }
	| { readonly kind: "copy-mode-closed"; readonly pane: number }
	/** Text for the system clipboard: a copy tmux made (`set-clipboard`). */
	| { readonly kind: "clipboard"; readonly text: string }
	/**
	 * Something DevHub did not do and says so quietly: a binding whose
	 * command tmux does not draw for a control client (`keyGuard.ts`).
	 */
	| { readonly kind: "notice"; readonly text: string }
	| { readonly kind: "ended"; readonly reason: string };

export type PageToControl =
	/** tmux key names, through the client's key tables (prefix, bindings). */
	| { readonly kind: "keys"; readonly keys: readonly string[] }
	/** Bytes straight to a pane (text, a paste, a mouse report); the active pane if none. */
	| {
			readonly kind: "bytes";
			readonly pane?: number;
			readonly bytes: Uint8Array;
	  }
	| { readonly kind: "resize"; readonly cols: number; readonly rows: number }
	| { readonly kind: "select-pane"; readonly pane: number }
	/** A boundary dragged: the pane before it, to this many cells across or down. */
	| {
			readonly kind: "resize-pane";
			readonly pane: number;
			readonly vertical: boolean;
			readonly cells: number;
	  }
	/** The open menu: an item clicked, or a click outside it. */
	| {
			readonly kind: "menu";
			readonly action: "choose" | "close";
			readonly index?: number;
	  }
	/** The open picker: a row clicked, or a click outside it. */
	| {
			readonly kind: "chooser";
			readonly action: "choose" | "close";
			readonly index?: number;
	  }
	/**
	 * A mouse event the pane's program did not take (a right-click, the
	 * wheel), or one on a window's tab: tmux's binding for it runs.
	 */
	| {
			readonly kind: "mouse";
			/** tmux's name: `MouseDown3Pane`, `WheelUpPane`, `MouseDown3Status`… */
			readonly key: string;
			readonly pane?: number;
			readonly window?: number;
			/** The cell, in the window. */
			readonly x: number;
			readonly y: number;
	  }
	| { readonly kind: "select-window"; readonly window: number }
	/** An item of the prompt's completion menu, clicked. */
	| { readonly kind: "prompt-complete"; readonly index: number }
	| { readonly kind: "visible"; readonly visible: boolean }
	| { readonly kind: "ack"; readonly seq: number }
	| {
			readonly kind: "colors";
			readonly foreground: number;
			readonly background: number;
			readonly palette?: readonly number[];
	  };

/** A page's request about a control client, checked like every other request. */
export interface ControlRequest {
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
	readonly message: PageToControl;
}

const MAX_KEYS = 256;
const MAX_KEY_LENGTH = 64;
const MAX_BYTES = 1 << 20;

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TerminalFailure("invalid_request");
	}
	return value as Record<string, unknown>;
}

function count(value: unknown, max = 100_000): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > max
	) {
		throw new TerminalFailure("invalid_request");
	}
	return value;
}

function rgb(value: unknown): number {
	return count(value, 0xffffff);
}

/** A page's control request, whole: its identity and a message of a known shape. */
export function validateControlRequest(value: unknown): ControlRequest {
	const request = record(value);
	const identity = validateIdentity({
		schemaVersion: 1,
		...request,
		message: undefined,
	});
	const m = record(request.message);
	let message: PageToControl;
	switch (m.kind) {
		case "keys": {
			const keys = m.keys;
			if (
				!Array.isArray(keys) ||
				keys.length > MAX_KEYS ||
				!keys.every(
					(k) =>
						typeof k === "string" &&
						k.length > 0 &&
						k.length <= MAX_KEY_LENGTH &&
						!/[\r\n]/.test(k),
				)
			) {
				throw new TerminalFailure("invalid_request");
			}
			message = { kind: "keys", keys: keys as string[] };
			break;
		}
		case "bytes": {
			if (!(m.bytes instanceof Uint8Array) || m.bytes.length > MAX_BYTES)
				throw new TerminalFailure("invalid_request");
			message = {
				kind: "bytes",
				bytes: m.bytes,
				...(m.pane === undefined ? {} : { pane: count(m.pane) }),
			};
			break;
		}
		case "resize":
			message = {
				kind: "resize",
				cols: count(m.cols, 10_000),
				rows: count(m.rows, 10_000),
			};
			break;
		case "select-pane":
			message = { kind: "select-pane", pane: count(m.pane) };
			break;
		case "resize-pane":
			if (typeof m.vertical !== "boolean")
				throw new TerminalFailure("invalid_request");
			message = {
				kind: "resize-pane",
				pane: count(m.pane),
				vertical: m.vertical,
				cells: Math.max(1, count(m.cells, 10_000)),
			};
			break;
		case "menu":
			if (m.action !== "choose" && m.action !== "close")
				throw new TerminalFailure("invalid_request");
			message = {
				kind: "menu",
				action: m.action,
				...(m.index === undefined ? {} : { index: count(m.index, 10_000) }),
			};
			break;
		case "chooser":
			if (m.action !== "choose" && m.action !== "close")
				throw new TerminalFailure("invalid_request");
			message = {
				kind: "chooser",
				action: m.action,
				...(m.index === undefined ? {} : { index: count(m.index) }),
			};
			break;
		case "mouse":
			if (
				typeof m.key !== "string" ||
				!/^(M-)?(MouseDown3Pane|MouseDown3Status|WheelUpPane|WheelDownPane)$/.test(
					m.key,
				) ||
				(m.pane === undefined) === (m.window === undefined)
			)
				throw new TerminalFailure("invalid_request");
			message = {
				kind: "mouse",
				key: m.key,
				x: count(m.x, 10_000),
				y: count(m.y, 10_000),
				...(m.pane === undefined ? {} : { pane: count(m.pane) }),
				...(m.window === undefined ? {} : { window: count(m.window) }),
			};
			break;
		case "select-window":
			message = { kind: "select-window", window: count(m.window) };
			break;
		case "prompt-complete":
			message = { kind: "prompt-complete", index: count(m.index, 100) };
			break;
		case "visible":
			if (typeof m.visible !== "boolean")
				throw new TerminalFailure("invalid_request");
			message = { kind: "visible", visible: m.visible };
			break;
		case "ack":
			message = { kind: "ack", seq: count(m.seq, Number.MAX_SAFE_INTEGER) };
			break;
		case "colors": {
			const palette = m.palette;
			if (
				palette !== undefined &&
				(!Array.isArray(palette) || palette.length !== 256)
			) {
				throw new TerminalFailure("invalid_request");
			}
			message = {
				kind: "colors",
				foreground: rgb(m.foreground),
				background: rgb(m.background),
				...(palette === undefined
					? {}
					: { palette: (palette as unknown[]).map(rgb) }),
			};
			break;
		}
		default:
			throw new TerminalFailure("invalid_request");
	}
	return {
		surfaceKey: identity.surfaceKey,
		attachmentId: identity.attachmentId,
		targetGeneration: identity.targetGeneration,
		message,
	};
}
