/**
 * Command-Q is a prefix, not a shortcut.
 *
 * A port of the Tauri app's `src-tauri/src/keyboard.rs`, grown into DevHub's
 * chord layer. DevHub's surfaces are whole applications in their own right — a
 * VS Code workbench, a terminal — and they want their own keys. Quitting on a
 * single Command-Q, next to an editor where Command-W closes a tab and
 * Command-N makes a file, is a keypress away from losing everything unsaved.
 * So the first Command-Q only arms; the second stroke is looked up in the
 * chord table (`model/commands.ts` holds the commands and the reasoning,
 * `chords.ts` resolves one against the model), and `forward_prefix` is the
 * command that passes a real Command-Q through to whatever is focused, which is
 * what actually quits.
 *
 * The prefix is a constructor argument for the same reason the table is: both
 * are settings now (`[keybindings]`), and a router with either of them baked in
 * would be a second answer to what the configuration already decides.
 *
 * Outside an armed prefix this router has no power at all: it never invents a
 * key event, and composition, marked text and every shortcut a surface defines
 * travel as they always did.
 */

import {
	isModifierKey,
	parseChordKey,
	sameChordKey,
	type ChordKey,
} from "../../model/chordKeys.js";
import { DEFAULT_CHORD_PREFIX, type CommandId } from "../../model/commands.js";
import {
	defaultChordTable,
	matchChord,
	strokeAs,
	type ChordBinding,
	type KeyStroke,
} from "./chords.js";

export type { KeyStroke } from "./chords.js";

/** The product contract is an exact one-second prefix interval. */
export const PREFIX_TIMEOUT_MS = 1_000;

export type RouteDecision =
	/** Swallow it: it must never reach a surface. */
	| { readonly kind: "consume" }
	/** Swallow it, and arm the prefix until `deadline`. */
	| { readonly kind: "armed"; readonly deadline: number }
	/** Let it through as an ordinary prefix keystroke. */
	| { readonly kind: "forward" }
	/** Swallow it, and run this command. */
	| { readonly kind: "run"; readonly commandId: CommandId }
	/** Swallow it: it completed no chord, so the chord is abandoned. */
	| { readonly kind: "cancelled" }
	/** Leave it entirely alone. */
	| { readonly kind: "pass" };

/** The whole of what the configuration decides about the keyboard. */
export interface ChordLayout {
	readonly prefix: ChordKey;
	readonly table: readonly ChordBinding[];
}

export function defaultChordLayout(): ChordLayout {
	return {
		prefix: parseChordKey(DEFAULT_CHORD_PREFIX),
		table: defaultChordTable(),
	};
}

export class KeyRouter {
	private armedUntil: number | undefined;
	private layout: ChordLayout;

	constructor(layout: ChordLayout = defaultChordLayout()) {
		this.layout = layout;
	}

	/**
	 * Adopt a new table, because the configuration file changed.
	 *
	 * An armed prefix is dropped with it: the person armed against the table
	 * that was in effect a moment ago, and completing their chord against a
	 * different one is not what they asked for.
	 */
	setLayout(layout: ChordLayout): void {
		this.layout = layout;
		this.armedUntil = undefined;
	}

	/**
	 * A change of what is focused invalidates an armed prefix.
	 *
	 * Otherwise a second stroke lands on whatever happens to be focused a
	 * moment later, which is not what the person armed it against.
	 */
	focusChanged(): void {
		this.armedUntil = undefined;
	}

	isArmed(now: number): boolean {
		return this.armedUntil !== undefined && now <= this.armedUntil;
	}

	private isPrefix(stroke: KeyStroke): boolean {
		return stroke.keys.some((key) =>
			sameChordKey(this.layout.prefix, strokeAs(stroke, key)),
		);
	}

	route(stroke: KeyStroke, now: number): RouteDecision {
		// **A bare modifier is not a stroke.** Chromium delivers a `keyDown` for
		// Shift itself before it delivers the shifted key, so `Cmd+Q Shift+P`
		// arrived here as two strokes: `ShiftLeft`, and then `p` with Shift down.
		// The first completed no chord, the chord was abandoned on it, and the `p`
		// then fell straight through to whatever was focused — which is exactly
		// what every shifted chord did while every unshifted one worked.
		//
		// So it neither completes nor cancels, and it is not swallowed either: a
		// surface underneath is entitled to know that Shift went down.
		if (isModifierKey(stroke.code)) return { kind: "pass" };

		// A held-down prefix is one intention, not many. Holding it must not arm
		// and fire in the same press.
		if (stroke.isAutoRepeat && this.isPrefix(stroke)) {
			this.armedUntil = undefined;
			return { kind: "consume" };
		}

		const deadline = this.armedUntil;
		this.armedUntil = undefined;
		if (deadline !== undefined && now <= deadline) {
			const binding = matchChord(this.layout.table, stroke);
			if (!binding) {
				// Once the prefix is armed the keyboard belongs to the chord layer.
				// A key that completes nothing abandons the chord and goes nowhere:
				// a mistyped chord must do nothing at all rather than fire whatever
				// the focused surface would have done with that key.
				return { kind: "cancelled" };
			}
			if (binding.commandId === "forward_prefix") return { kind: "forward" };
			return { kind: "run", commandId: binding.commandId };
		}

		if (this.isPrefix(stroke)) {
			const armed = now + PREFIX_TIMEOUT_MS;
			this.armedUntil = armed;
			return { kind: "armed", deadline: armed };
		}
		return { kind: "pass" };
	}
}
