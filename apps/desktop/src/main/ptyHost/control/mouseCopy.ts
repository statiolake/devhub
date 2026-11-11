/**
 * The left button on a control client (`docs/terminal-mode.md`, "The
 * mouse"). tmux runs a mouse binding with the mouse event's position: a
 * copy-mode command run from one first puts the copy cursor under the
 * mouse (`window_copy_move_mouse`), `begin-selection` and `copy-mode -M`
 * start a drag that follows the mouse (`window_copy_start_drag`), and a
 * drag at the pane's top or bottom row scrolls. A command a control client
 * sends has no mouse event, so DevHub does the same with copy-mode commands
 * of its own: the cursor moved to the mouse's row (`cursor-up`/`-down`,
 * which scroll past the edge as tmux's drag does) and then along it
 * (`cursor-left`/`-right`, counted on the row's cells as tmux's grid reader
 * steps over a wide character's halves).
 *
 * Pure: `controlClient.ts` asks and sends.
 */

import { readFlags } from "./tmuxCommand.js";

/** The left button's keys tmux binds, with what each is. */
export const LEFT_MOUSE_KEYS: readonly string[] = [
	"MouseDown1Pane",
	"MouseDrag1Pane",
	"MouseDragEnd1Pane",
	"DoubleClick1Pane",
	"TripleClick1Pane",
];

/** What one command of a mouse binding is, for running it with the mouse. */
export type MouseCommand =
	/** `send-keys -M`: the mouse handed on to the pane's mode (or program). */
	| { readonly kind: "forward" }
	/** `send-keys -X <command>`: a copy-mode command, run at the mouse. */
	| { readonly kind: "copy"; readonly command: string }
	/** `copy-mode -M`: into copy mode, and a drag from the mouse. */
	| { readonly kind: "enter-drag"; readonly words: readonly string[] }
	| { readonly kind: "other" };

export function mouseCommand(words: readonly string[]): MouseCommand {
	const [name, ...rest] = words;
	if (name === "send-keys" || name === "send") {
		const read = readFlags(rest, "cNt", "FHKlMRX");
		if (read === undefined) return { kind: "other" };
		if (read.count.has("M")) return { kind: "forward" };
		if (read.count.has("X") && read.rest[0] !== undefined)
			return { kind: "copy", command: read.rest[0] };
		return { kind: "other" };
	}
	if (name === "copy-mode") {
		const read = readFlags(rest, "st", "deHMqSu");
		if (read?.count.has("M") === true) {
			const flags = rest.slice(0, rest.length - read.rest.length);
			const kept = flags
				.map((w) => (w.startsWith("-") && w !== "--" ? w.replace(/M/g, "") : w))
				.filter((w) => w !== "-");
			return { kind: "enter-drag", words: [name, ...kept, ...read.rest] };
		}
	}
	return { kind: "other" };
}

/**
 * The steps that move the copy cursor from column `from` to the character
 * at `to` on a row whose cells are `cells` (`""` the right half of a wide
 * character): tmux's `cursor-left` lands on the half it reaches and its
 * `cursor-right` steps over halves, so the cursor goes left until it is at
 * or before the character, then right onto it. `onemore`: emacs keys,
 * where the cursor may stand past the line's last character (vi's may
 * not). A column past the end of the line is its last character, as tmux
 * clamps it.
 */
export function cursorSteps(
	cells: readonly string[],
	from: number,
	to: number,
	onemore: boolean,
): { left: number; right: number } {
	let length = cells.length;
	while (length > 0 && cells[length - 1] === " ") length--;
	const limit = onemore ? length : Math.max(0, length - 1);
	const pad = (x: number) => cells[x] === "";
	let target = Math.max(0, Math.min(limit, to));
	while (target > 0 && pad(target)) target--;
	const left = (x: number) => {
		while (x > 0 && pad(x)) x--;
		return x > 0 ? x - 1 : x;
	};
	const right = (x: number) => {
		if (x >= limit) return x;
		x++;
		while (x < limit && pad(x)) x++;
		return x;
	};
	let at = Math.min(from, Math.max(limit, 0));
	let l = 0;
	while (at > target && at > 0) {
		at = left(at);
		l++;
	}
	let r = 0;
	while (at < target) {
		const n = right(at);
		if (n === at) break;
		at = n;
		r++;
	}
	return { left: l, right: r };
}
