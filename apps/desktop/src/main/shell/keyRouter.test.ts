import { beforeEach, describe, expect, it } from "vitest";
import { keyNameForCode, parseChordKey } from "../../model/chordKeys.js";
import {
	defaultChordLayout,
	KeyRouter,
	PREFIX_TIMEOUT_MS,
	type KeyStroke,
} from "./keyRouter.js";

/**
 * A stroke, named by the physical key the way Electron reports it.
 *
 * The tests say `code` because that is what the router reads; the key name is
 * derived from it here exactly as `keyboard.ts` derives it, so a test cannot
 * pass with a pairing the real path would never produce.
 */
function stroke(code: string, overrides: Partial<KeyStroke> = {}): KeyStroke {
	return {
		key: keyNameForCode(code),
		code,
		command: false,
		shift: false,
		option: false,
		control: false,
		isAutoRepeat: false,
		...overrides,
	};
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

	function chord(
		modifierCode: string,
		code: string,
		flags: Partial<KeyStroke>,
	) {
		router.route(commandQ, 0);
		// The modifier goes down first. It must neither complete nor cancel.
		const held = router.route(stroke(modifierCode, flags), 5);
		return { held, then: router.route(stroke(code, flags), 10) };
	}

	it("keeps the chord armed for Shift+P and Shift+N", () => {
		expect(chord("ShiftLeft", "KeyP", { shift: true })).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "previous_workspace" },
		});
		expect(chord("ShiftRight", "KeyN", { shift: true })).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "next_workspace" },
		});
	});

	it("keeps it armed for the bracket chords, on US and on JIS alike", () => {
		// `{` and `}` are Shift and the bracket keys, and they are the *same*
		// physical keys on a JIS keyboard even though the characters printed on
		// them differ. Naming the key rather than the character is what makes
		// one binding right on both.
		expect(chord("ShiftLeft", "BracketLeft", { shift: true })).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "previous_agent" },
		});
		expect(chord("ShiftLeft", "BracketRight", { shift: true })).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "next_agent" },
		});
	});

	it("keeps it armed for Shift+, which is Settings", () => {
		expect(chord("ShiftLeft", "Comma", { shift: true })).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "open_settings" },
		});
	});

	it("keeps it armed for the Command chords", () => {
		expect(chord("MetaLeft", "KeyN", { command: true })).toEqual({
			held: { kind: "pass" },
			then: { kind: "run", commandId: "next_tab" },
		});
		expect(chord("MetaLeft", "KeyJ", { command: true })).toEqual({
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
		expect(router.route(stroke("Comma"), 30)).toEqual({
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
		expect(router.route(stroke("ShiftLeft", { shift: true }), 0)).toEqual({
			kind: "pass",
		});
	});
});
