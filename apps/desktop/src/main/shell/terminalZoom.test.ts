/**
 * Which keystroke is a zoom, and on which surface.
 *
 * Two questions, and the second is half the feature: the same chord means the
 * window's zoom inside a VS Code workbench, so a rule that claimed it anywhere
 * but the Agents page would take it from every editor DevHub hosts.
 */

import { describe, expect, it } from "vitest";
import { terminalZoomFor } from "./terminalZoom.js";
import { SHELL_ORIGIN } from "./shellPageProtocol.js";
import type { KeyStroke } from "./chords.js";

const AGENTS = `${SHELL_ORIGIN}/agents.html`;

function stroke(
	code: string,
	key: string,
	overrides: Partial<KeyStroke> = {},
): KeyStroke {
	return {
		keys: [key],
		code,
		command: true,
		shift: false,
		option: false,
		control: false,
		isAutoRepeat: false,
		...overrides,
	};
}

/** What the two keyboards actually deliver for these keys. */
const US_MINUS = stroke("Minus", "-");
const US_SHIFT_MINUS = stroke("Minus", "_", { shift: true });
const JIS_MINUS = stroke("Minus", "-");
// On a JIS keyboard Shift and the key printed `-` produce `=`. Same key, same
// place, different character — which is why the character cannot be the
// identity here even though it is the identity of a chord's second stroke.
const JIS_SHIFT_MINUS = stroke("Minus", "=", { shift: true });
const SHIFT_ZERO = stroke("Digit0", ")", { shift: true });

describe("the Agent panes' zoom keys", () => {
	it("zooms in on Cmd+Shift+- and out on Cmd+-", () => {
		expect(terminalZoomFor(AGENTS, US_SHIFT_MINUS)).toBe("in");
		expect(terminalZoomFor(AGENTS, US_MINUS)).toBe("out");
	});

	it("is the same key on a JIS keyboard, which types a different character", () => {
		expect(terminalZoomFor(AGENTS, JIS_SHIFT_MINUS)).toBe("in");
		expect(terminalZoomFor(AGENTS, JIS_MINUS)).toBe("out");
	});

	it("forgets the zoom on Cmd+Shift+0", () => {
		expect(terminalZoomFor(AGENTS, SHIFT_ZERO)).toBe("reset");
	});

	it("leaves plain Cmd+0 to the terminal", () => {
		expect(terminalZoomFor(AGENTS, stroke("Digit0", "0"))).toBeUndefined();
	});

	/**
	 * Every other surface in the window, named rather than sampled: the one that
	 * has its own zoom is the workbench, and the one a question is asked on is
	 * the picker — which is where the keyboard is while a modal is up.
	 */
	it("means nothing on any other surface", () => {
		for (const url of [
			`${SHELL_ORIGIN}/index.html`,
			`${SHELL_ORIGIN}/sidebar.html`,
			`${SHELL_ORIGIN}/picker.html`,
			`${SHELL_ORIGIN}/toasts.html`,
			`${SHELL_ORIGIN}/settings.html`,
			"vscode-file://vscode-app/out/vs/code/x.html",
		]) {
			expect(terminalZoomFor(url, US_SHIFT_MINUS)).toBeUndefined();
			expect(terminalZoomFor(url, US_MINUS)).toBeUndefined();
			expect(terminalZoomFor(url, SHIFT_ZERO)).toBeUndefined();
		}
	});

	it("matches the modifiers exactly", () => {
		expect(
			terminalZoomFor(AGENTS, stroke("Minus", "-", { command: false })),
		).toBeUndefined();
		expect(
			terminalZoomFor(AGENTS, stroke("Minus", "-", { option: true })),
		).toBeUndefined();
		expect(
			terminalZoomFor(AGENTS, stroke("Minus", "-", { control: true })),
		).toBeUndefined();
	});

	it("means nothing for a key that is not one of the two", () => {
		expect(terminalZoomFor(AGENTS, stroke("Equal", "="))).toBeUndefined();
		expect(terminalZoomFor(AGENTS, stroke("Digit1", "1"))).toBeUndefined();
	});
});
