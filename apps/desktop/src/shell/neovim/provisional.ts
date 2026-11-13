/**
 * What the pointer did, shown before Neovim says so (`docs/neovim-editor.md`,
 * "The pointer"): a click moves the caret, a row's focus or a window border
 * at once, on the page, and Neovim's redraw then confirms it — or corrects
 * it, since Neovim owns that state and always wins.
 *
 * A guess is made against what Neovim showed when the pointer acted (its
 * `base`). It is shown for as long as Neovim still shows that base (or, in
 * a drag, the cells the pointer went over before), up to `ttl` ms; the
 * moment Neovim shows anything else — the guess itself, or whatever it
 * decided instead — Neovim's is shown and the guess is gone. So
 * a guess that was right is never seen to change (the caret is already
 * where Neovim puts it), a wrong one lasts one round trip, and a click
 * Neovim ignored (nothing moved) is taken back after `ttl`.
 *
 * Pure: the caller says what Neovim shows and when; `equal` compares.
 */
export class Provisional<T> {
  private guess:
    | {
        readonly value: T;
        /** What Neovim may show while it catches up: no answer yet. */
        readonly bases: readonly T[];
        readonly until: number;
      }
    | undefined;

  constructor(private readonly equal: (a: T, b: T) => boolean) {}

  /**
   * The pointer acted: show `value` while Neovim still shows `base`. A
   * guess made while one is pending (a drag's next cell) also waits through
   * the earlier ones: Neovim showing the cell before is on its way here, not
   * a different answer, and the caret is not taken back to it.
   */
  predict(value: T, base: T, now: number, ttl: number): void {
    const earlier = this.guess;
    const bases =
      earlier === undefined ? [base] : [...earlier.bases, earlier.value, base];
    this.guess = this.equal(value, base)
      ? undefined
      : { value, bases: bases.slice(-16), until: now + ttl };
  }

  /** What to show, Neovim showing `actual` at `now`. */
  shown(actual: T, now: number): T {
    const guess = this.guess;
    if (guess === undefined) return actual;
    if (
      now > guess.until ||
      this.equal(actual, guess.value) ||
      !guess.bases.some((b) => this.equal(actual, b))
    ) {
      this.guess = undefined;
      return actual;
    }
    return guess.value;
  }

  /** Whether a guess is being shown (until `shown` says otherwise). */
  get pending(): boolean {
    return this.guess !== undefined;
  }

  /** Forget the guess (the pointer went elsewhere, Neovim was restarted). */
  clear(): void {
    this.guess = undefined;
  }
}

/** How long a guess may stand without Neovim moving: a slow link's trip. */
export const PROVISIONAL_TTL_MS = 600;
