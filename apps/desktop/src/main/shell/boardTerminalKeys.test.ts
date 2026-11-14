import { describe, expect, it } from "vitest";
import { BoardTerminalKeys } from "./boardTerminalKeys.js";

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
