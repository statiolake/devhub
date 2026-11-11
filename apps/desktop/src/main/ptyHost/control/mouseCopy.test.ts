import { describe, expect, it } from "vitest";
import { cursorSteps, mouseCommand } from "./mouseCopy.js";
import { parseCommands } from "./tmuxCommand.js";

const cells = (text: string, width: number) => {
	const out: string[] = [];
	for (const ch of text) {
		out.push(ch);
		if (/[\u3000-\u9fff]/.test(ch)) out.push("");
	}
	while (out.length < width) out.push(" ");
	return out;
};

describe("a mouse binding's commands", () => {
	it("tells the mouse handed on, a copy-mode command and a drag into copy mode apart", () => {
		// The person's root DoubleClick1Pane arm, and tmux's defaults.
		const [enter, word] = parseCommands(
			"copy-mode -H ; send-keys -X select-word",
		);
		expect(mouseCommand(enter)).toEqual({ kind: "other" });
		expect(mouseCommand(word)).toEqual({
			kind: "copy",
			command: "select-word",
		});
		expect(mouseCommand(["send", "-M"])).toEqual({ kind: "forward" });
		expect(mouseCommand(["send-keys", "-X", "-N", "1", "scroll-up"])).toEqual({
			kind: "copy",
			command: "scroll-up",
		});
		expect(mouseCommand(["copy-mode", "-M"])).toEqual({
			kind: "enter-drag",
			words: ["copy-mode"],
		});
		expect(mouseCommand(["copy-mode", "-eM", "-t", "="])).toEqual({
			kind: "enter-drag",
			words: ["copy-mode", "-e", "-t", "="],
		});
		expect(mouseCommand(["select-pane", "-t", "="])).toEqual({ kind: "other" });
	});
});

describe("cursorSteps", () => {
	it("moves along a plain row by columns", () => {
		const row = cells("hello world", 20);
		expect(cursorSteps(row, 0, 6, false)).toEqual({ left: 0, right: 6 });
		expect(cursorSteps(row, 8, 2, false)).toEqual({ left: 6, right: 0 });
	});

	it("clamps past the line's end to its last character (vi), or one past it (emacs)", () => {
		const row = cells("abc", 20);
		expect(cursorSteps(row, 0, 15, false)).toEqual({ left: 0, right: 2 });
		expect(cursorSteps(row, 0, 15, true)).toEqual({ left: 0, right: 3 });
	});

	it("lands on a wide character's left half, from either side", () => {
		// a 日(1,2) 本(3,4) b(5)
		const row = cells("a日本b", 10);
		// Right steps skip the right halves: to 本 is two steps.
		expect(cursorSteps(row, 0, 3, false)).toEqual({ left: 0, right: 2 });
		// On a right half: its character.
		expect(cursorSteps(row, 0, 4, false)).toEqual({ left: 0, right: 2 });
		// Left from b to 日: tmux's left lands on 本's right half, then 本's
		// left one... so it goes past to `a` and back onto 日.
		const back = cursorSteps(row, 5, 1, false);
		let at = 5;
		const pad = (x: number) => row[x] === "";
		for (let i = 0; i < back.left; i++) {
			while (at > 0 && pad(at)) at--;
			if (at > 0) at--;
		}
		for (let i = 0; i < back.right; i++) {
			at++;
			while (pad(at)) at++;
		}
		expect(at).toBe(1);
	});
});
