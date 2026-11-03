/**
 * Which key, button or swipe is Back or Forward, and on which surface.
 *
 * The surface is half the rule: over a workbench every one of these belongs
 * to VS Code, whose own Back and Forward are the editor's.
 */

import { describe, expect, it } from "vitest";
import {
	appCommandDirection,
	historyDirectionFor,
	isAppHistorySurface,
	isDestinationSurface,
	swipeDirection,
} from "./historyKeys.js";
import { SHELL_ORIGIN } from "./shellPageProtocol.js";
import type { KeyStroke } from "./chords.js";

const WORKBENCH = "vscode-file://vscode-app/out/vs/code/x.html";

function stroke(key: string, overrides: Partial<KeyStroke> = {}): KeyStroke {
	return {
		key,
		code: key === "[" ? "BracketLeft" : "BracketRight",
		command: true,
		shift: false,
		option: false,
		control: false,
		isAutoRepeat: false,
		...overrides,
	};
}

describe("Back and Forward's keys", () => {
	it("are Cmd+[ and Cmd+] on the window, the Sidebar and the Agents", () => {
		for (const page of ["index.html", "sidebar.html", "agents.html"]) {
			const url = `${SHELL_ORIGIN}/${page}`;
			expect(historyDirectionFor(url, stroke("["))).toBe("back");
			expect(historyDirectionFor(url, stroke("]"))).toBe("forward");
		}
	});

	it("are nothing in a workbench, where the editor's own history wins", () => {
		expect(historyDirectionFor(WORKBENCH, stroke("["))).toBeUndefined();
		expect(isAppHistorySurface(WORKBENCH)).toBe(false);
	});

	it("are nothing on the modals' page, where a question holds the keyboard", () => {
		const url = `${SHELL_ORIGIN}/picker.html`;
		expect(historyDirectionFor(url, stroke("["))).toBeUndefined();
	});

	it("match the modifiers exactly", () => {
		const url = `${SHELL_ORIGIN}/agents.html`;
		expect(
			historyDirectionFor(url, stroke("[", { shift: true })),
		).toBeUndefined();
		expect(
			historyDirectionFor(url, stroke("[", { option: true })),
		).toBeUndefined();
		expect(
			historyDirectionFor(url, stroke("[", { command: false })),
		).toBeUndefined();
	});
});

describe("Back and Forward's other gestures", () => {
	it("reads the mouse's side buttons from app-command", () => {
		expect(appCommandDirection("browser-backward")).toBe("back");
		expect(appCommandDirection("browser-forward")).toBe("forward");
		expect(appCommandDirection("media-play-pause")).toBeUndefined();
	});

	it("reads only a horizontal swipe", () => {
		expect(swipeDirection("left")).toBe("back");
		expect(swipeDirection("right")).toBe("forward");
		expect(swipeDirection("up")).toBeUndefined();
	});
});

describe("where input makes a place for Back and Forward", () => {
	it("is a workbench, the Agents and a terminal pane", () => {
		expect(isDestinationSurface(WORKBENCH)).toBe(true);
		expect(isDestinationSurface(`${SHELL_ORIGIN}/agents.html`)).toBe(true);
		expect(isDestinationSurface(`${SHELL_ORIGIN}/pane.html#t1`)).toBe(true);
		expect(isDestinationSurface(`${SHELL_ORIGIN}/pane.html#workspace:w1`)).toBe(
			true,
		);
	});

	it("is not the Sidebar (choosing where to go), the window's own page, the modals or the notices", () => {
		for (const page of [
			"sidebar.html",
			"index.html",
			"picker.html",
			"toasts.html",
			"settings.html",
			"task-manager.html",
		]) {
			expect(isDestinationSurface(`${SHELL_ORIGIN}/${page}`)).toBe(false);
		}
	});

	it("is not a Web Inspector or a blank page", () => {
		expect(isDestinationSurface("devtools://devtools/bundled/x.html")).toBe(
			false,
		);
		expect(isDestinationSurface("")).toBe(false);
		expect(isDestinationSurface("about:blank")).toBe(false);
	});
});
