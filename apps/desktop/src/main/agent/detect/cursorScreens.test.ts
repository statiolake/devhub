/**
 * The Cursor manifest, and the one property that makes it safe to ship
 * unverified.
 *
 * Read `cursorScreens.fixture.ts` first: unlike the Claude and Codex suites,
 * most of these screens are constructed from herdr's rule text rather than
 * captured from a running CLI, because `cursor-agent` needs a subscription this
 * project does not have. So the assertions below are deliberately of two kinds,
 * and the second kind is the point.
 *
 * The transcription tests say the rules survived the move from TOML to
 * TypeScript. They are worth having and they are not worth much: if Cursor's
 * screens have changed since herdr looked in 2026.08, every one of them can
 * pass while the manifest is wrong about the real thing.
 *
 * The never-idle tests do not depend on Cursor's screens at all. `idle` is the
 * only state the injection queue sends on, so a manifest with no idle rule
 * cannot make DevHub type into a Cursor pane no matter how far the screens have
 * drifted. That turns "we could not verify this" from a hazard into a `?`.
 */

import { describe, expect, it } from "vitest";
import {
	CURSOR_COMMAND_APPROVAL,
	CURSOR_LOGIN_SPLASH,
	CURSOR_LOOKS_FREE,
	CURSOR_WORKING_BACKGROUND,
	CURSOR_WORKING_SPINNER,
	CURSOR_WORKING_STOP_HINT,
	CURSOR_WRITE_APPROVAL,
	type CursorScreen,
} from "./cursorScreens.fixture.js";
import { CURSOR } from "./manifests.js";
import { read } from "./rules.js";

function reading(screen: CursorScreen) {
	return read(CURSOR, { ...screen, oscProgress: "" });
}

describe("the Cursor manifest, as ported from herdr", () => {
	it("knows a command waiting for approval is waiting on a person", () => {
		const result = reading(CURSOR_COMMAND_APPROVAL);
		expect(result.state).toBe("blocked");
		expect(result.visibleBlocker).toBe(true);
	});

	it("knows a file write waiting for approval is waiting on a person", () => {
		const result = reading(CURSOR_WRITE_APPROVAL);
		expect(result.state).toBe("blocked");
		expect(result.visibleBlocker).toBe(true);
	});

	it.each([
		["a spinner", CURSOR_WORKING_SPINNER],
		["an interrupt hint", CURSOR_WORKING_STOP_HINT],
		["a background task count", CURSOR_WORKING_BACKGROUND],
	])("says working from %s", (_label, screen) => {
		const result = reading(screen);
		expect(result.state).toBe("working");
		expect(result.visibleWorking).toBe(true);
	});

	/**
	 * A blocker outranks working, which is the ordering that matters most: a
	 * turn that has paused for an answer is not a turn that is running, and
	 * calling it `working` would hide a question behind a spinner.
	 */
	it("puts a question above a running turn when both are on screen", () => {
		const result = reading({
			oscTitle: "example-host",
			screen: `${CURSOR_WORKING_SPINNER.screen}\n${CURSOR_COMMAND_APPROVAL.screen}`,
		});
		expect(result.state).toBe("blocked");
	});
});

/**
 * The safety property, stated three ways.
 *
 * These are the tests that are allowed to be load-bearing while the manifest is
 * unverified, because none of them is a claim about what Cursor draws.
 */
describe("the Cursor manifest never claims idle", () => {
	/**
	 * The structural version: not "no screen we tried was idle" but "no rule in
	 * the manifest can produce the word". A future rule added from memory
	 * rather than from a capture fails here, which is the intent.
	 */
	it("has no idle rule at all", () => {
		expect(CURSOR.rules.filter((rule) => rule.state === "idle")).toEqual([]);
		expect(CURSOR.rules.some((rule) => rule.visibleIdle === true)).toBe(false);
	});

	/** A pane that looks like a free prompt is still `unknown`, not `idle`. */
	it("reads a free-looking prompt as unknown rather than idle", () => {
		const result = reading(CURSOR_LOOKS_FREE);
		expect(result.state).toBe("unknown");
		expect(result.matchedRuleId).toBeUndefined();
	});

	/**
	 * The startup splash — the one real capture here. A Cursor that has not
	 * confirmed who you are is not a Cursor waiting for an instruction.
	 */
	it("does not call a half-started Cursor idle", () => {
		expect(reading(CURSOR_LOGIN_SPLASH).state).toBe("unknown");
	});

	/**
	 * Where the title would have led. Cursor had not set one, so this is the
	 * shell's hostname — the exact trap that made Codex's old idle rule report
	 * a trust question as a free prompt. No rule here reads the title.
	 */
	it("keys nothing on a title the shell happened to set", () => {
		expect(CURSOR_LOGIN_SPLASH.oscTitle).toBe("example-host");
		expect(
			read(CURSOR, {
				screen: "",
				oscTitle: "example-host",
				oscProgress: "",
			}).state,
		).toBe("unknown");
	});

	/** An unfamiliar screen is unknown, which the queue refuses to send on. */
	it("says it cannot tell, rather than guessing", () => {
		expect(
			reading({
				oscTitle: "example-host",
				screen: "a screen no rule here describes",
			}).state,
		).toBe("unknown");
	});
});
