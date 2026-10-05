import { beforeEach, describe, expect, it } from "vitest";
import { parseChordKey, strokeKey } from "../../model/chordKeys.js";
import {
	defaultChordLayout,
	KeyRouter,
		type KeyStroke,
} from "./keyRouter.js";
import type { ArmingListener } from "./chordInputSource.js";

/**
 * A stroke, from the character and the physical key Electron reports.
 *
 * Built through the same function `keyboard.ts` builds one with, so a test
 * cannot pass on a pairing the real path would never produce.
 */
function press(
	key: string,
	code: string,
	modifiers: Partial<Omit<KeyStroke, "key" | "code">> = {},
): KeyStroke {
	const flags = {
		command: false,
		shift: false,
		option: false,
		control: false,
		isAutoRepeat: false,
		...modifiers,
	};
	return { key: strokeKey(key), code, ...flags };
}

/** A key whose character is its own lower-case letter or digit. */
function stroke(code: string, overrides: Partial<KeyStroke> = {}): KeyStroke {
	const character = /^Key([A-Z])$/u.exec(code)?.[1].toLowerCase();
	const digit = /^Digit([0-9])$/u.exec(code)?.[1];
	return press(character ?? digit ?? code, code, overrides);
}

const commandQ = stroke("KeyQ", { command: true });

/** For the cases that are not about what the router says of its arming. */
const IGNORED: ArmingListener = {
	armed: () => undefined,
	disarmed: () => undefined,
};

describe("the Command-Q chord", () => {
	let router: KeyRouter;

	beforeEach(() => {
		router = new KeyRouter(defaultChordLayout(), IGNORED);
	});

	it("swallows the first Command-Q and arms instead of quitting", () => {
		expect(router.route(commandQ)).toEqual({ kind: "armed" });
		expect(router.isArmed()).toBe(true);
	});

	it("forwards the second Command-Q", () => {
		router.route(commandQ);
		expect(router.route(commandQ)).toEqual({ kind: "forward" });
	});

	it("stays armed however long it waits for the next key", () => {
		router.route(commandQ);
		expect(router.isArmed()).toBe(true);
		expect(router.route(stroke("KeyF"))).toEqual({
			kind: "run",
			commandId: "add_workspace",
		});
	});

	it("leaves every other key alone while nothing is armed", () => {
		for (const key of [
			stroke("KeyW", { command: true }),
			stroke("KeyN", { command: true }),
			stroke("Digit1", { command: true }),
			stroke("KeyK", { control: true }),
			stroke("KeyA"),
			// The chord keys themselves: without the prefix they are ordinary.
			stroke("KeyZ"),
			stroke("Digit3"),
			stroke("KeyP", { shift: true }),
		]) {
			expect(router.route(key), key.code).toEqual({ kind: "pass" });
		}
	});

	it("runs a bound second stroke and swallows an unbound one", () => {
		router.route(commandQ);
		expect(router.route(stroke("KeyF"))).toEqual({
			kind: "run",
			commandId: "add_workspace",
		});
		router.route(commandQ);
		expect(router.route(stroke("KeyY"))).toEqual({ kind: "cancelled" });
	});

	it("does not arm and fire on one held-down prefix", () => {
		expect(router.route({ ...commandQ, isAutoRepeat: true })).toEqual({
			kind: "consume",
		});
		expect(router.isArmed()).toBe(false);
	});

	it("takes its layout as data, so an override is another table", () => {
		const overridden = new KeyRouter(
			{
				prefix: parseChordKey("Ctrl+q"),
				table: [{ key: parseChordKey("s"), commandId: "open_settings" }],
			},
			IGNORED,
		);
		expect(overridden.route(commandQ)).toEqual({ kind: "pass" });
		overridden.route(stroke("KeyQ", { control: true }));
		expect(overridden.route(stroke("KeyS"))).toEqual({
			kind: "run",
			commandId: "open_settings",
		});
	});

	it("drops an armed prefix when the table changes underneath it", () => {
		router.route(commandQ);
		router.setLayout(defaultChordLayout());
		expect(router.route(stroke("KeyF"))).toEqual({ kind: "pass" });
	});

	/**
	 * The table changing is the *only* thing that drops an armed prefix.
	 *
	 * The router has no other way to be told to forget one, and that is the
	 * whole of the "no disarm on focus change" rule: there is one queue for the
	 * application, so nothing about which child view holds the keyboard can
	 * reach it.
	 */
	it("has no way to be disarmed by anything but its own table", () => {
		const reachable = new Set<string>();
		for (
			let level: object | null = router;
			level && level !== Object.prototype;
			level = Object.getPrototypeOf(level) as object | null
		) {
			for (const name of Object.getOwnPropertyNames(level)) reachable.add(name);
		}
		expect([...reachable].filter((name) => /focus/iu.test(name))).toEqual([]);
	});
});

/**
 * The bug: every shifted chord fell through, and every unshifted one worked.
 *
 * Chromium delivers a `keyDown` for Shift itself before it delivers the shifted
 * key. That arrived as a second stroke, completed no chord, and abandoned the
 * chord — so the key the person actually meant then reached the terminal as a
 * literal `P`. These are the sequences the reporter typed.
 */
describe("a modifier pressed after the prefix", () => {
	let router: KeyRouter;

	beforeEach(() => {
		router = new KeyRouter(defaultChordLayout(), IGNORED);
	});

	function chord(modifierCode: string, second: KeyStroke) {
		router.route(commandQ);
		// The modifier goes down first. It must neither complete nor cancel.
		const held = router.route(press("Shift", modifierCode, { shift: true }));
		return { held, then: router.route(second) };
	}

	it("keeps the chord armed for Shift+P and Shift+N", () => {
		expect(chord("ShiftLeft", press("P", "KeyP", { shift: true }))).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "previous_workspace" },
		});
		expect(chord("ShiftRight", press("N", "KeyN", { shift: true }))).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "next_workspace" },
		});
	});

	it("keeps it armed for Shift+, which is Settings", () => {
		expect(chord("ShiftLeft", press("<", "Comma", { shift: true }))).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "open_settings" },
		});
	});

	it("keeps it armed for the Command chords", () => {
		expect(chord("MetaLeft", press("n", "KeyN", { command: true }))).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "next_tab" },
		});
		expect(chord("MetaLeft", press("j", "KeyJ", { command: true }))).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "toggle_workspace_agent" },
		});
	});

	it("still works for the unshifted chords that never broke", () => {
		router.route(commandQ);
		expect(router.route(stroke("KeyF"))).toEqual({
			kind: "run",
			commandId: "add_workspace",
		});
		router.route(commandQ);
		expect(router.route(press(",", "Comma"))).toEqual({
			kind: "run",
			commandId: "rename_agent",
		});
		router.route(commandQ);
		expect(router.route(stroke("Digit1"))).toEqual({
			kind: "run",
			commandId: "select_entry_1",
		});
	});

	it("leaves a bare modifier alone when nothing is armed", () => {
		expect(
			router.route(press("Shift", "ShiftLeft", { shift: true })),
		).toEqual({
			kind: "pass",
		});
	});
});

/**
 * The same chord on two keyboards.
 *
 * A JIS keyboard does not put punctuation where a US one does: the key printed
 * `[` is `BracketRight` there, the one printed `]` is `Backslash`, and
 * `BracketLeft` is where `@` lives. Matching the physical key selected the key
 * one to the left of the one the person was looking at. The character does not
 * move, so one binding is right on both.
 */
describe("a chord on a US and a JIS keyboard", () => {
	let router: KeyRouter;

	beforeEach(() => {
		router = new KeyRouter(defaultChordLayout(), IGNORED);
	});

	function second(key: string, code: string, shift = true) {
		router.route(commandQ);
		router.route(press("Shift", "ShiftLeft", { shift }));
		return router.route(press(key, code, { shift }));
	}

	const layouts: readonly {
		readonly name: string;
		readonly rows: readonly [string, string, string | undefined, boolean?][];
	}[] = [
		{
			name: "US",
			rows: [
				["[", "BracketLeft", "previous_agent", false],
				["]", "BracketRight", "next_agent", false],
				["{", "BracketLeft", "previous_unread_agent"],
				["}", "BracketRight", "next_unread_agent"],
				["<", "Comma", "open_settings"],
				["?", "Slash", "show_chord_help"],
				["N", "KeyN", "next_workspace"],
			],
		},
		{
			name: "JIS",
			rows: [
				["[", "BracketRight", "previous_agent", false],
				["]", "Backslash", "next_agent", false],
				["{", "BracketRight", "previous_unread_agent"],
				["}", "Backslash", "next_unread_agent"],
				// The key a US keyboard reads as `{` is `@` here, and `@` is not a
				// chord: it cancels rather than firing the wrong command, which is
				// exactly what the physical-key model got wrong.
				["@", "BracketLeft", undefined],
				["<", "Comma", "open_settings"],
				["?", "Slash", "show_chord_help"],
				["N", "KeyN", "next_workspace"],
			],
		},
	];

	for (const layout of layouts) {
		for (const [key, code, commandId, shift = true] of layout.rows) {
			it(`${layout.name}: ${key} (${code}) → ${commandId ?? "nothing"}`, () => {
				expect(second(key, code, shift)).toEqual(
					commandId === undefined
						? { kind: "cancelled" }
						: { kind: "run", commandId },
				);
			});
		}
	}
});

/**
 * What the router says about its arming, which the input source follows.
 *
 * Every way a chord ends is a `disarmed`, whatever ended it, so the input
 * source put in place for the chord is given back on each of them.
 */
describe("the arming, as the router reports it", () => {
	let heard: string[];
	let router: KeyRouter;

	beforeEach(() => {
		heard = [];
		router = new KeyRouter(defaultChordLayout(), {
			armed: () => heard.push("armed"),
			disarmed: () => heard.push("disarmed"),
		});
	});

	it("reports the prefix", () => {
		router.route(commandQ);
		expect(heard).toEqual(["armed"]);
	});

	it.each([
		["a chord that runs", stroke("KeyF")],
		["a key that completes nothing", stroke("KeyY")],
		["the prefix again, which is passed on", commandQ],
	])("reports the end of the chord on %s", (_name, second) => {
		router.route(commandQ);
		router.route(second);
		expect(heard).toEqual(["armed", "disarmed"]);
	});

	it("does not end the chord on a bare modifier", () => {
		router.route(commandQ);
		router.route(press("Shift", "ShiftLeft", { shift: true }));
		expect(heard).toEqual(["armed"]);
	});

	it("reports the end when the table changes", () => {
		router.route(commandQ);
		router.setLayout(defaultChordLayout());
		expect(heard).toEqual(["armed", "disarmed"]);
	});

	it("reports the end when DevHub is left, and ends the chord", () => {
		router.route(commandQ);
		router.leave();
		expect(heard).toEqual(["armed", "disarmed"]);
		expect(router.route(stroke("KeyF"))).toEqual({ kind: "pass" });
	});

	it("says nothing when nothing was armed", () => {
		router.leave();
		router.setLayout(defaultChordLayout());
		router.route(stroke("KeyF"));
		expect(heard).toEqual([]);
	});

	it("reports a held-down prefix as over", () => {
		router.route(commandQ);
		router.route({ ...commandQ, isAutoRepeat: true });
		expect(heard).toEqual(["armed", "disarmed"]);
	});
});
