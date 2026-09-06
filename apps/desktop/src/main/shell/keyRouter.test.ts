import { beforeEach, describe, expect, it } from "vitest";
import { parseChordKey, strokeKeys } from "../../model/chordKeys.js";
import {
	defaultChordLayout,
	KeyRouter,
	PREFIX_TIMEOUT_MS,
	type KeyStroke,
} from "./keyRouter.js";

/**
 * A stroke, from the character and the physical key Electron reports.
 *
 * Built through the same function `keyboard.ts` builds one with, so a test
 * cannot pass on a pairing the real path would never produce.
 */
function press(
	key: string,
	code: string,
	modifiers: Partial<Omit<KeyStroke, "keys" | "code">> = {},
): KeyStroke {
	const flags = {
		command: false,
		shift: false,
		option: false,
		control: false,
		isAutoRepeat: false,
		...modifiers,
	};
	return { keys: strokeKeys(key, code, flags.shift), code, ...flags };
}

/** A key whose character is its own lower-case letter or digit. */
function stroke(code: string, overrides: Partial<KeyStroke> = {}): KeyStroke {
	const character = /^Key([A-Z])$/u.exec(code)?.[1].toLowerCase();
	const digit = /^Digit([0-9])$/u.exec(code)?.[1];
	return press(character ?? digit ?? code, code, overrides);
}

const commandQ = stroke("KeyQ", { command: true });

describe("the Command-Q chord", () => {
	let router: KeyRouter;

	beforeEach(() => {
		router = new KeyRouter();
	});

	it("swallows the first Command-Q and arms instead of quitting", () => {
		expect(router.route(commandQ, 0)).toEqual({
			kind: "armed",
			deadline: PREFIX_TIMEOUT_MS,
		});
		expect(router.isArmed(0)).toBe(true);
	});

	it("forwards the second Command-Q within the second", () => {
		router.route(commandQ, 0);
		expect(router.route(commandQ, PREFIX_TIMEOUT_MS)).toEqual({
			kind: "forward",
		});
	});

	it("arms again rather than forwarding after the second has passed", () => {
		router.route(commandQ, 0);
		expect(router.route(commandQ, PREFIX_TIMEOUT_MS + 1)).toEqual({
			kind: "armed",
			deadline: PREFIX_TIMEOUT_MS * 2 + 1,
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
			expect(router.route(key, 0), key.code).toEqual({ kind: "pass" });
		}
	});

	it("runs a bound second stroke and swallows an unbound one", () => {
		router.route(commandQ, 0);
		expect(router.route(stroke("KeyF"), 10)).toEqual({
			kind: "run",
			commandId: "add_workspace",
		});
		router.route(commandQ, 20);
		expect(router.route(stroke("KeyY"), 30)).toEqual({ kind: "cancelled" });
	});

	it("is over once the second has passed", () => {
		router.route(commandQ, 0);
		expect(router.route(stroke("KeyZ"), PREFIX_TIMEOUT_MS + 1)).toEqual({
			kind: "pass",
		});
	});

	it("does not arm and fire on one held-down prefix", () => {
		expect(router.route({ ...commandQ, isAutoRepeat: true }, 0)).toEqual({
			kind: "consume",
		});
		expect(router.isArmed(0)).toBe(false);
	});

	it("takes its layout as data, so an override is another table", () => {
		const overridden = new KeyRouter({
			prefix: parseChordKey("Ctrl+q"),
			table: [{ key: parseChordKey("s"), commandId: "open_settings" }],
		});
		expect(overridden.route(commandQ, 0)).toEqual({ kind: "pass" });
		overridden.route(stroke("KeyQ", { control: true }), 10);
		expect(overridden.route(stroke("KeyS"), 20)).toEqual({
			kind: "run",
			commandId: "open_settings",
		});
	});

	it("drops an armed prefix when the table changes underneath it", () => {
		router.route(commandQ, 0);
		router.setLayout(defaultChordLayout());
		expect(router.route(stroke("KeyF"), 10)).toEqual({ kind: "pass" });
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
		router = new KeyRouter();
	});

	function chord(modifierCode: string, second: KeyStroke) {
		router.route(commandQ, 0);
		// The modifier goes down first. It must neither complete nor cancel.
		const held = router.route(press("Shift", modifierCode, { shift: true }), 5);
		return { held, then: router.route(second, 10) };
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
		router.route(commandQ, 0);
		expect(router.route(stroke("KeyF"), 10)).toEqual({
			kind: "run",
			commandId: "add_workspace",
		});
		router.route(commandQ, 20);
		expect(router.route(press(",", "Comma"), 30)).toEqual({
			kind: "run",
			commandId: "rename_agent",
		});
		router.route(commandQ, 40);
		expect(router.route(stroke("Digit1"), 50)).toEqual({
			kind: "run",
			commandId: "select_entry_1",
		});
	});

	it("leaves a bare modifier alone when nothing is armed", () => {
		expect(
			router.route(press("Shift", "ShiftLeft", { shift: true }), 0),
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
		router = new KeyRouter();
	});

	function second(key: string, code: string, shift = true) {
		router.route(commandQ, 0);
		router.route(press("Shift", "ShiftLeft", { shift }), 5);
		return router.route(press(key, code, { shift }), 10);
	}

	const layouts: readonly {
		readonly name: string;
		readonly rows: readonly [string, string, string | undefined][];
	}[] = [
		{
			name: "US",
			rows: [
				["{", "BracketLeft", "previous_agent"],
				["}", "BracketRight", "next_agent"],
				["<", "Comma", "open_settings"],
				["?", "Slash", "show_chord_help"],
				["N", "KeyN", "next_workspace"],
			],
		},
		{
			name: "JIS",
			rows: [
				["{", "BracketRight", "previous_agent"],
				["}", "Backslash", "next_agent"],
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
		for (const [key, code, commandId] of layout.rows) {
			it(`${layout.name}: ${key} (${code}) → ${commandId ?? "nothing"}`, () => {
				expect(second(key, code)).toEqual(
					commandId === undefined
						? { kind: "cancelled" }
						: { kind: "run", commandId },
				);
			});
		}
	}
});
