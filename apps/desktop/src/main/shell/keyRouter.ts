/**
 * Command-Q is a chord, not a shortcut.
 *
 * A port of the Tauri app's `src-tauri/src/keyboard.rs`. DevHub's surfaces are
 * whole applications in their own right — a VS Code workbench, a terminal —
 * and they want their own keys. Quitting on a single Command-Q, next to an
 * editor where Command-W closes a tab and Command-N makes a file, is a keypress
 * away from losing everything unsaved. So the first Command-Q only arms; the
 * second, within a second, is passed to whatever is focused as an ordinary
 * Command-Q, which is what actually quits.
 *
 * Everything else is untouched, by construction. This router's only power is
 * to swallow an exact Command-Q, and it never invents a key event: composition,
 * marked text, and every shortcut a surface defines travel as they always did.
 */

/** The product contract is an exact one-second prefix interval. */
export const PREFIX_TIMEOUT_MS = 1_000;

export interface KeyStroke {
	/** Electron's `input.key`, compared case-insensitively. */
	readonly key: string;
	readonly command: boolean;
	readonly shift: boolean;
	readonly option: boolean;
	readonly control: boolean;
	readonly isAutoRepeat: boolean;
}

export type RouteDecision =
	/** Swallow it: it must never reach a surface. */
	| { readonly kind: "consume" }
	/** Swallow it, and arm the prefix until `deadline`. */
	| { readonly kind: "armed"; readonly deadline: number }
	/** Let it through as an ordinary Command-Q. */
	| { readonly kind: "forward" }
	/** Leave it entirely alone. */
	| { readonly kind: "pass"; readonly clearedPrefix: boolean };

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
	 * A change of what is focused invalidates an armed prefix.
	 *
	 * Otherwise a second Command-Q lands on whatever happens to be focused a
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
			if (isExactCommandQ(stroke)) return { kind: "forward" };
			// Any other second key clears the prefix and carries on untouched,
			// which is what keeps Command-W, Command-M and IME working.
			return { kind: "pass", clearedPrefix: true };
		}

		if (isExactCommandQ(stroke)) {
			const armed = now + PREFIX_TIMEOUT_MS;
			this.armedUntil = armed;
			return { kind: "armed", deadline: armed };
		}
		return { kind: "pass", clearedPrefix: false };
	}
}
