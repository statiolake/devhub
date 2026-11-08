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
}

export interface PaneBox {
	readonly pane: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly active: boolean;
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
	  }
	| {
			readonly kind: "pane";
			readonly seq: number;
			readonly pane: number;
			readonly frame: VtFrame;
			readonly modes: PaneModes;
	  }
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
	| { readonly kind: "select-window"; readonly window: number }
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
		case "select-window":
			message = { kind: "select-window", window: count(m.window) };
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
