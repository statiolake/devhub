import { describe, expect, it } from "vitest";
import {
	aimAt,
	copyCapture,
	copyState,
	matchSpans,
	plainLine,
	scaledWheel,
	selectionSpans,
} from "./copyMode.js";

const F = "\u001f";
// tmux 3.7c in copy mode: 100 lines of `seq`, the cursor 7 up, a selection
// begun 5 up, scrolled 3 back (the formats as `display-message -p` gave them).
const LINE = [
	"copy-mode",
	"3",
	"3",
	"77",
	"off",
	"1",
	"16",
	"1",
	"1",
	"95",
	"1",
	"90",
	"0",
	"char",
	"1",
	"15",
	"80",
	"24",
	"#[align=right]20:46 [3/77]",
].join(F);

describe("copy mode as tmux's formats say it", () => {
	it("reads the state, the history and the badge", () => {
		const state = copyState(LINE);
		expect(state).toMatchObject({
			mode: "copy-mode",
			scroll: 3,
			history: 77,
			cursor: { x: 1, y: 16 },
			search: "15",
			width: 80,
			height: 24,
			badge: "20:46 [3/77]",
		});
		// Absolute line numbers: copy_position is hsize - oy + 1.
		expect(
			copyState(
				LINE.replace(`${F}off${F}`, `${F}absolute${F}`).replace(
					`${F}3${F}77${F}`,
					`${F}75${F}101${F}`,
				),
			)?.history,
		).toBe(77);
	});

	it("captures the rows the mode shows, from its own copy", () => {
		const state = copyState(LINE);
		if (state === undefined) throw new Error("no state");
		expect(copyCapture(state, "%1")).toEqual([
			"capture-pane",
			"-M",
			"-p",
			"-e",
			"-N",
			"-t",
			"%1",
			"-S",
			"-3",
			"-E",
			"20",
		]);
	});

	it("draws the selection as tmux checks it, inclusive, rows between whole", () => {
		const state = copyState(LINE);
		if (state === undefined) throw new Error("no state");
		// Rows shown start at line 74: the selection runs from row 16 (the
		// cursor's end) to row 21.
		const spans = selectionSpans(state);
		expect(spans[0]).toEqual({ y: 16, x0: 1, x1: 79 });
		expect(spans.at(-1)).toEqual({ y: 21, x0: 0, x1: 1 });
		expect(spans).toHaveLength(6);
	});

	it("finds the search's matches in the rows, as text", () => {
		expect(matchSpans([plainLine("\u001b[1m115\u001b[0m"), "x"], "15")).toEqual(
			[{ y: 0, x0: 1, x1: 2 }],
		);
	});

	it("aims a mouse binding at the mouse's pane", () => {
		expect(aimAt("send-keys -X -N 1 scroll-up", "%3")).toBe(
			"send-keys -t %3 -X -N 1 scroll-up",
		);
		expect(aimAt("copy-mode -et=", "%3")).toBe("copy-mode -e -t %3");
		expect(aimAt("select-pane -t = ; send -M", "%3")).toBe(
			"select-pane -t %3 ; send -t %3 -M",
		);
	});
});

describe("a wheel binding for several lines at once", () => {
	it("scales a plain scroll", () => {
		expect(scaledWheel("send-keys -X -N 1 scroll-up", 4)).toBe(
			"send-keys -X -N 4 scroll-up",
		);
		expect(scaledWheel("send -X -N 5 scroll-down", 3)).toBe(
			"send-keys -X -N 15 scroll-down",
		);
		expect(scaledWheel("send-keys -X scroll-up", 2)).toBe(
			"send-keys -X -N 2 scroll-up",
		);
		// tmux's own copy-mode-vi WheelUpPane.
		expect(scaledWheel("select-pane \\; send-keys -X -N 5 scroll-up", 2)).toBe(
			"select-pane \\; send-keys -X -N 10 scroll-up",
		);
	});
	it("leaves anything else to be run line by line", () => {
		expect(scaledWheel("send-keys -X -N 1 scroll-up \\; select-pane", 2)).toBe(
			undefined,
		);
		expect(scaledWheel("send-keys -X halfpage-up", 2)).toBe(undefined);
	});
});
