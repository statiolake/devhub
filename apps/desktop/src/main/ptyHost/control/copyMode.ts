/**
 * Copy mode (and view mode) on a control client (phase 3,
 * `docs/terminal-mode.md`). Copy mode is tmux's: a key in it goes through
 * the mode's key table (the person's `copy-mode-vi`), and tmux moves the
 * cursor, selects, searches and copies. What tmux does not do for a control
 * client is draw it, so DevHub reads the mode's state from tmux's own
 * formats (`window_copy_formats`) and paints it in place on the pane: the
 * lines the mode shows (`capture-pane -M`, the mode's frozen copy, from
 * `-scroll_position`), the copy cursor, the selection in the selection
 * colour, the search's matches, and tmux's position indicator
 * (`copy-mode-position-format`, expanded by tmux) as a badge.
 *
 * Pure: `controlClient.ts` asks and sends.
 */

import type { CopySpan } from "../../../ipc/terminalControl.js";

const FIELD = "\u001f";

/** The formats read, in order: what `copyState` takes apart. */
export const COPY_FORMAT = [
	"#{pane_mode}",
	"#{scroll_position}",
	"#{copy_position}",
	"#{copy_position_limit}",
	"#{copy-mode-line-numbers}",
	"#{copy_cursor_x}",
	"#{copy_cursor_y}",
	"#{selection_present}",
	"#{selection_start_x}",
	"#{selection_start_y}",
	"#{selection_end_x}",
	"#{selection_end_y}",
	"#{rectangle_toggle}",
	"#{selection_mode}",
	"#{search_present}",
	"#{pane_search_string}",
	"#{pane_width}",
	"#{pane_height}",
	"#{E:copy-mode-position-format}",
].join(FIELD);

export interface CopyState {
	readonly mode: string;
	/** Lines scrolled back from the bottom (`scroll_position`, tmux's `oy`). */
	readonly scroll: number;
	/** The mode's history size: its absolute line `hsize + y` is row `y`. */
	readonly history: number;
	readonly cursor: { readonly x: number; readonly y: number };
	readonly selection?: {
		readonly start: { readonly x: number; readonly y: number };
		readonly end: { readonly x: number; readonly y: number };
		readonly rectangle: boolean;
		readonly line: boolean;
	};
	/** The search's string, while a search is shown. */
	readonly search?: string;
	readonly width: number;
	readonly height: number;
	/** tmux's position indicator, styles dropped. */
	readonly badge: string;
}

/** A pane's mode state from `display-message -p COPY_FORMAT`. */
export function copyState(line: string): CopyState | undefined {
	const f = line.split(FIELD);
	if (f.length < 19) return undefined;
	const n = (i: number) => Number(f[i]) || 0;
	const scroll = n(1);
	// `copy_position` is `oy` and its limit `hsize`, unless the line numbers
	// are absolute (`window_copy_line_number_is_absolute`): then hsize - oy + 1.
	const absolute = !["", "off", "default"].includes(f[4]);
	const history = absolute ? n(2) + scroll - 1 : n(3);
	return {
		mode: f[0],
		scroll,
		history,
		cursor: { x: n(5), y: n(6) },
		...(f[7] === "1"
			? {
					selection: {
						start: { x: n(8), y: n(9) },
						end: { x: n(10), y: n(11) },
						rectangle: f[12] === "1",
						line: f[13] === "line",
					},
				}
			: {}),
		...(f[14] === "1" && f[15] !== "" ? { search: f[15] } : {}),
		width: n(16),
		height: n(17),
		badge: f
			.slice(18)
			.join(FIELD)
			.replace(/#\[[^\]]*\]/g, "")
			.replace(/##/g, "#")
			.trim(),
	};
}

/** `capture-pane -M` for the rows the mode shows. */
export function copyCapture(state: CopyState, target: string): string[] {
	return [
		"capture-pane",
		"-M",
		"-p",
		"-e",
		"-N",
		"-t",
		target,
		"-S",
		String(-state.scroll),
		"-E",
		String(state.height - 1 - state.scroll),
	];
}

/**
 * The selection as spans of the rows shown, as tmux's
 * `screen_check_selection` takes it: inclusive at both ends, whole rows
 * between; a rectangle the same columns on every row; a line selection
 * whole lines.
 */
export function selectionSpans(state: CopyState): CopySpan[] {
	const sel = state.selection;
	if (sel === undefined) return [];
	const top = state.history - state.scroll;
	let [a, b] = [sel.start, sel.end];
	if (b.y < a.y || (b.y === a.y && b.x < a.x)) [a, b] = [b, a];
	const spans: CopySpan[] = [];
	const last = state.width - 1;
	for (let abs = a.y; abs <= b.y; abs++) {
		const y = abs - top;
		if (y < 0 || y >= state.height) continue;
		let x0: number;
		let x1: number;
		if (sel.line) {
			x0 = 0;
			x1 = last;
		} else if (sel.rectangle) {
			x0 = Math.min(sel.start.x, sel.end.x);
			x1 = Math.max(sel.start.x, sel.end.x);
		} else {
			x0 = abs === a.y ? a.x : 0;
			x1 = abs === b.y ? b.x : last;
		}
		if (x1 >= x0)
			spans.push({ y, x0: Math.max(0, x0), x1: Math.min(last, x1) });
	}
	return spans;
}

/** Where the search's string is on the rows shown, as plain text. */
export function matchSpans(
	rows: readonly string[],
	search: string | undefined,
): CopySpan[] {
	if (search === undefined || search === "") return [];
	const spans: CopySpan[] = [];
	rows.forEach((text, y) => {
		const chars = [...text];
		const needle = [...search];
		for (let x = 0; x + needle.length <= chars.length; x++) {
			if (needle.every((c, i) => chars[x + i] === c)) {
				spans.push({ y, x0: x, x1: x + needle.length - 1 });
				x += needle.length - 1;
			}
		}
	});
	return spans;
}

/**
 * The bytes that put the mode's rows into an engine of the pane's size:
 * no wrapping (each captured line is one row), the copy cursor a block.
 */
export function copyScreen(
	lines: readonly string[],
	state: CopyState,
): Uint8Array {
	const rows = lines.slice(0, state.height);
	const body = rows
		.map((line, y) => `\u001b[${String(y + 1)};1H${line}\u001b[0m`)
		.join("");
	return new TextEncoder().encode(
		`\u001b[0m\u001b[H\u001b[2J\u001b[?7l${body}\u001b[2 q\u001b[?25h\u001b[${String(state.cursor.y + 1)};${String(state.cursor.x + 1)}H`,
	);
}

/** The text of a captured line: its escape sequences dropped. */
export function plainLine(line: string): string {
	return line.replace(
		// eslint-disable-next-line no-control-regex
		/\u001b\[[0-9;:]*[A-Za-z]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g,
		"",
	);
}

/**
 * A mouse binding's command aimed at the pane the mouse is over, as tmux
 * aims it (the mouse's pane is the current one): `-t =` is that pane, and
 * the commands that act on a pane and name none are given it.
 */
export function aimAt(command: string, pane: string): string {
	return command
		.replace(
			/(^|\s)-([A-Za-z]*)t\s*=(?=\s|$|;)/g,
			(_, lead: string, flags: string) =>
				`${lead}${flags === "" ? "" : `-${flags} `}-t ${pane}`,
		)
		.replace(
			/(^|;\s*|\\;\s*)(send-keys|send|copy-mode)(?![^;]*\s-t\s)/g,
			`$1$2 -t ${pane}`,
		);
}
