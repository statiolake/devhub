/**
 * The Codex manifest, against screens a real Codex drew.
 *
 * The stakes here are higher than a wrong word in the sidebar. `idle` is what
 * the injection queue waits for, so a screen wrongly called idle is a screen
 * DevHub will type an instruction into — and two of the five below are menus
 * where the first option runs an installer or answers a trust question.
 */

import { describe, expect, it } from "vitest";
import {
	CODEX_IDLE,
	CODEX_STARTUP,
	CODEX_TRUST_PROMPT,
	CODEX_UPDATE_PROMPT,
	CODEX_WORKING,
	type CodexScreen,
} from "./codexScreens.fixture.js";
import { CODEX } from "./manifests.js";
import { read } from "./rules.js";

function reading(screen: CodexScreen) {
	return read(CODEX, { ...screen, oscProgress: "" });
}

describe("the Codex manifest, on real screens", () => {
	it("says working while a turn is running", () => {
		const result = reading(CODEX_WORKING);
		expect(result.state).toBe("working");
		expect(result.visibleWorking).toBe(true);
	});

	it("says idle only once Codex is actually ready", () => {
		expect(reading(CODEX_IDLE).state).toBe("idle");
	});

	/**
	 * The composer is drawn and inviting from the first frame, long before
	 * anything can act on what is typed into it. The model still says loading.
	 */
	it("does not call a half-started Codex idle", () => {
		expect(reading(CODEX_STARTUP).state).not.toBe("idle");
	});

	/**
	 * The sharpest case in the whole detector. This screen's first option is
	 * `curl … | sh`; an instruction typed into it is a keystroke in a menu.
	 */
	it("never calls a numbered menu idle, and knows a person is needed", () => {
		const result = reading(CODEX_UPDATE_PROMPT);
		expect(result.state).toBe("blocked");
		expect(result.visibleBlocker).toBe(true);
	});

	it("knows the trust question is waiting on a person", () => {
		const result = reading(CODEX_TRUST_PROMPT);
		expect(result.state).toBe("blocked");
		expect(result.visibleBlocker).toBe(true);
	});

	/**
	 * Why none of this can be read off the title.
	 *
	 * Codex only sets a title once it is running, so every screen it draws
	 * before that carries whatever the person's shell left there. The old rule
	 * read any non-empty title as idle, which is how a question about trust
	 * came to look like a free prompt.
	 */
	it("cannot tell a question from a free prompt by the title", () => {
		expect(CODEX_STARTUP.oscTitle).toBe(CODEX_UPDATE_PROMPT.oscTitle);
		expect(CODEX_UPDATE_PROMPT.oscTitle).toBe(CODEX_TRUST_PROMPT.oscTitle);
		// Non-empty, and nothing to do with Codex.
		expect(CODEX_TRUST_PROMPT.oscTitle.trim().length).toBeGreaterThan(0);
	});

	/** An unfamiliar screen is unknown, which the queue refuses to send on. */
	it("says it cannot tell, rather than guessing idle", () => {
		const result = read(CODEX, {
			screen: "a screen no rule here describes",
			oscTitle: CODEX_IDLE.oscTitle,
			oscProgress: "",
		});
		expect(result.state).toBe("unknown");
	});
});
