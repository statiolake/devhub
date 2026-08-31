/**
 * Command-Q is a prefix, not a shortcut.
 *
 * A port of the Tauri app's `src-tauri/src/keyboard.rs`, grown into DevHub's
 * chord layer. DevHub's surfaces are whole applications in their own right — a
 * VS Code workbench, a terminal — and they want their own keys. Quitting on a
 * single Command-Q, next to an editor where Command-W closes a tab and
 * Command-N makes a file, is a keypress away from losing everything unsaved.
 * So the first Command-Q only arms; the second stroke is looked up in the
 * chord table (`chords.ts`, which is also where the bindings and the reasoning
 * behind them are written down), and `Cmd+Q Cmd+Q` is the row that passes a
 * real Command-Q through to whatever is focused, which is what actually quits.
 *
 * Outside an armed prefix this router has no power at all: it never invents a
 * key event, and composition, marked text and every shortcut a surface defines
 * travel as they always did.
 */

import {
	DEFAULT_CHORDS,
	matchChord,
	type ChordAction,
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
	/** Let it through as an ordinary Command-Q. */
	| { readonly kind: "forward" }
	/** Swallow it, and run this chord. */
	| { readonly kind: "run"; readonly action: ChordAction }
	/** Swallow it: it completed no chord, so the chord is abandoned. */
	| { readonly kind: "cancelled" }
	/** Leave it entirely alone. */
	| { readonly kind: "pass" };

function isExactCommandQ(stroke: KeyStroke): boolean {
	return (
		stroke.key.toLowerCase() === "q" &&
		stroke.command &&
		!stroke.shift &&
		!stroke.option &&
		!stroke.control
	);
}

export class KeyRouter {
	private armedUntil: number | undefined;

	/**
	 * The table is an argument so that a user override is a different array
	 * rather than a different router. Nothing builds one yet; see `chords.ts`.
	 */
	constructor(
		private readonly table: readonly ChordBinding[] = DEFAULT_CHORDS,
	) {}

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

	route(stroke: KeyStroke, now: number): RouteDecision {
		// A held-down Command-Q is one intention, not many. Holding it must not
		// arm and fire in the same press.
		if (stroke.isAutoRepeat && isExactCommandQ(stroke)) {
			this.armedUntil = undefined;
			return { kind: "consume" };
		}

		const deadline = this.armedUntil;
		this.armedUntil = undefined;
		if (deadline !== undefined && now <= deadline) {
			const binding = matchChord(this.table, stroke);
			if (!binding) {
				// Once the prefix is armed the keyboard belongs to the chord layer.
				// A key that completes nothing abandons the chord and goes nowhere:
				// a mistyped chord must do nothing at all rather than fire whatever
				// the focused surface would have done with that key.
				return { kind: "cancelled" };
			}
			if (binding.action.kind === "forward-prefix") return { kind: "forward" };
			return { kind: "run", action: binding.action };
		}

		if (isExactCommandQ(stroke)) {
			const armed = now + PREFIX_TIMEOUT_MS;
			this.armedUntil = armed;
			return { kind: "armed", deadline: armed };
		}
		return { kind: "pass" };
	}
}
