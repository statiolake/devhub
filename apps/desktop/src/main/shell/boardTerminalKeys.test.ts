import { describe, expect, it } from "vitest";
import {
	BoardTerminalKeys,
	orchestratorFocusMove,
} from "./boardTerminalKeys.js";

describe("the Orchestrator Terminal tab's keys", () => {
	it("are the terminal's when the tab is first shown, and not off it", () => {
		const keys = new BoardTerminalKeys();
		expect(keys.inTerminal).toBe(false);
		keys.shown(true);
		expect(keys.inTerminal).toBe(true);
		keys.shown(false);
		expect(keys.inTerminal).toBe(false);
		// Off the tab, a click anywhere changes nothing to say.
		expect(keys.focused("agents")).toBe(false);
		keys.shown(true);
		expect(keys.inTerminal).toBe(true);
	});

	it("follow a click: out into the board, back into the terminal", () => {
		const keys = new BoardTerminalKeys();
		keys.shown(true);
		expect(keys.focused("agents")).toBe(true);
		expect(keys.inTerminal).toBe(false);
		keys.shown(true);
		expect(keys.inTerminal).toBe(false);
		expect(keys.focused("editor")).toBe(true);
		expect(keys.inTerminal).toBe(true);
		expect(keys.focused("editor")).toBe(false);
		// An Agent terminal's page says nothing about the tab.
		expect(keys.focused("terminal")).toBe(false);
		expect(keys.inTerminal).toBe(true);
	});

	// The press on the tab lands in the board's header, the board's page
	// taking the keyboard, before the choice arrives. Only a first show used
	// to give the keys back: the tab already shown, clicked, left them in
	// the board, and nothing typed reached the terminal or tmux.
	it("are the terminal's again when the tab shown is chosen after a press in the header", () => {
		const keys = new BoardTerminalKeys();
		keys.shown(true);
		keys.focused("agents");
		keys.shown(true);
		expect(keys.inTerminal).toBe(false);
		keys.chosen();
		keys.shown(true);
		expect(keys.inTerminal).toBe(true);
	});
});

describe("Cmd+Q O on the Orchestrator row", () => {
	const at = (where: Partial<Parameters<typeof orchestratorFocusMove>[0]>) =>
		orchestratorFocusMove({
			inBoardTerminal: false,
			boardTerminalShown: false,
			gui: true,
			keysOnBoard: false,
			...where,
		});

	it("swaps a GUI orchestrator's conversation and its board", () => {
		expect(at({})).toBe("board");
		expect(at({ keysOnBoard: true })).toBe("conversation");
	});

	it("goes from the conversation into the Terminal tab shown, and out of it to the conversation", () => {
		expect(at({ boardTerminalShown: true })).toBe("board-terminal");
		expect(at({ boardTerminalShown: true, inBoardTerminal: true })).toBe(
			"conversation",
		);
		// The tab shown, the keys clicked out into the board's page.
		expect(at({ boardTerminalShown: true, keysOnBoard: true })).toBe(
			"conversation",
		);
	});

	it("leaves a TUI orchestrator's page to say which of its two has the keys, but for the tab's terminal", () => {
		expect(at({ gui: false })).toBe("toggle");
		expect(at({ gui: false, boardTerminalShown: true })).toBe("toggle");
		expect(
			at({ gui: false, boardTerminalShown: true, inBoardTerminal: true }),
		).toBe("conversation");
	});

	it("takes the keys out of the Terminal tab's terminal, the BoardTerminalKeys way", () => {
		// What `swapOrchestratorFocus` does with the rule: out, then back in.
		const keys = new BoardTerminalKeys();
		keys.shown(true);
		expect(keys.inTerminal).toBe(true);
		keys.focused("agents");
		expect(keys.inTerminal).toBe(false);
		keys.chosen();
		// The press's own focus landing afterwards does not undo the choice.
		keys.focused("editor");
		expect(keys.inTerminal).toBe(true);
	});
});
