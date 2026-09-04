/**
 * The Mac's editing keys reach DevHub's chrome, and nothing else.
 *
 * Two halves, and both matter. A text box in the Settings window has no way to
 * answer Cmd+A on its own, so DevHub has to answer it. A workbench answers it
 * perfectly well, and an answer given there would take Select All away from
 * Monaco — so the same key, one surface over, must come back as nothing.
 */

import { describe, expect, it, vi } from "vitest";
import type { KeyStroke } from "./chords.js";

// Only for the scheme constant `shellPageProtocol.ts` exports; nothing in this
// module reaches Electron.
vi.mock("../electron.js", () => ({ electron: { protocol: {} } }));

const { editingCommandFor, EDITING_COMMAND_GROUPS } = await import(
	"./editingCommands.js"
);

const SETTINGS = "devhub-app://shell/index.html?window=settings";
const APP_SHELL = "devhub-app://shell/index.html";
const WORKBENCH =
	"vscode-file://vscode-app/out/vs/code/electron-sandbox/x.html";

function stroke(key: string, modifiers: Partial<KeyStroke> = {}): KeyStroke {
	return {
		key,
		code: `Key${key.toUpperCase()}`,
		command: true,
		shift: false,
		option: false,
		control: false,
		isAutoRepeat: false,
		...modifiers,
	};
}

describe("the editing keys on DevHub's own chrome", () => {
	it("answer the chords a Mac text box is expected to know", () => {
		const roles = ["a", "c", "v", "x", "z"].map(
			(key) => editingCommandFor(SETTINGS, stroke(key))?.role,
		);
		expect(roles).toEqual(["selectAll", "copy", "paste", "cut", "undo"]);
	});

	it("tell Cmd+Z and Cmd+Shift+Z apart", () => {
		expect(editingCommandFor(SETTINGS, stroke("z"))?.role).toBe("undo");
		expect(
			editingCommandFor(SETTINGS, stroke("z", { shift: true }))?.role,
		).toBe("redo");
	});

	it("do not care which case the key arrives in", () => {
		// macOS reports the shifted character, so Cmd+Shift+Z arrives as "Z".
		expect(
			editingCommandFor(SETTINGS, stroke("Z", { shift: true }))?.role,
		).toBe("redo");
	});

	it("are answered on every page of the chrome bundle", () => {
		// The App Shell page, the Settings window and the modal overlay are one
		// bundle under three query strings; a rule that held for only one of
		// them would leave the picker's search box broken.
		expect(editingCommandFor(APP_SHELL, stroke("a"))?.role).toBe("selectAll");
		expect(
			editingCommandFor(`${APP_SHELL}?window=modal`, stroke("v"))?.role,
		).toBe("paste");
	});
});

describe("the keys DevHub does not claim", () => {
	it("leaves the workbench's own Select All alone", () => {
		expect(editingCommandFor(WORKBENCH, stroke("a"))).toBeUndefined();
		expect(editingCommandFor(WORKBENCH, stroke("z"))).toBeUndefined();
	});

	it("leaves a surface DevHub did not serve alone", () => {
		expect(
			editingCommandFor("devtools://devtools/bundled/x.html", stroke("a")),
		).toBeUndefined();
		// A web contents that has not loaded anything yet.
		expect(editingCommandFor("", stroke("a"))).toBeUndefined();
	});

	it("matches modifiers exactly", () => {
		// Ctrl+A is the beginning of the line to a terminal, and Cmd+Option+A is
		// not Select All anywhere. Swallowing either would take a key from a
		// surface that means something by it.
		expect(
			editingCommandFor(
				SETTINGS,
				stroke("a", { command: false, control: true }),
			),
		).toBeUndefined();
		expect(
			editingCommandFor(SETTINGS, stroke("a", { option: true })),
		).toBeUndefined();
		expect(
			editingCommandFor(SETTINGS, stroke("a", { command: false })),
		).toBeUndefined();
	});

	it("passes a plain key straight through", () => {
		expect(
			editingCommandFor(SETTINGS, stroke("ArrowLeft", { command: false })),
		).toBeUndefined();
		// Cmd+Left is the terminal pane's, and it is not on this list.
		expect(editingCommandFor(SETTINGS, stroke("ArrowLeft"))).toBeUndefined();
	});
});

describe("the list itself", () => {
	it("names each command once", () => {
		const roles = EDITING_COMMAND_GROUPS.flat().map((command) => command.role);
		expect(new Set(roles).size).toBe(roles.length);
	});

	it("gives each key one meaning", () => {
		const keys = EDITING_COMMAND_GROUPS.flat()
			.filter((command) => command.key !== undefined)
			.map((command) => `${command.shift ? "shift+" : ""}${command.key}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
