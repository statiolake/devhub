/**
 * The character a physical key types *without* Option, for an Option chord
 * that is Meta (`optionKey.ts`).
 *
 * On a Mac, `KeyboardEvent.key` for an Option chord is what Option makes of
 * the key: Option+X is `≈`, Option+A `å`, Option+B `∫` on a US layout, and
 * Option+E, N, U, I and `` ` `` are dead keys (`key` is `"Dead"`; Chromium
 * may even report the keydown as `keyCode` 229 and start a composition). A
 * Meta chord wants the key itself — `M-x` for tmux, `<M-x>` for Neovim — and
 * that has to come from `code`, the physical key, read through the keyboard
 * layout: `code` names positions by the US layout, so `BracketLeft` is `[`
 * there but `@` on a JIS keyboard, and `KeyQ` is `a` on AZERTY.
 *
 * The layout is learned two ways, best first:
 *
 * 1. Every keydown without Option, Control or Cmd says what its key types,
 *    Shift included (`learn`). That is exact for the layout in use, and
 *    follows an input source switch as soon as the key is typed once.
 * 2. `navigator.keyboard.getLayoutMap()` (Chromium's Keyboard Map API: the
 *    unshifted character of every key under the current layout), asked
 *    when the surface mounts and whenever it takes focus (`loadLayout`).
 *
 * and only then the US layout, which is what `code` itself says.
 *
 * A letter's case is Shift's, whatever the layout or Caps Lock said. JIS's ¥
 * key (`IntlYen`) is `\` under Meta, as Option+¥ types `\` there and as
 * xterm.js (keyCode 220) and Terminal.app read it: a terminal has no `M-¥`.
 */

/** Just enough of a keydown to learn from, so the rule can be tested. */
export interface LearnableKey {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** `code` → [unshifted, shifted] on a US layout. */
const US: Readonly<Record<string, readonly [string, string]>> = {
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  IntlBackslash: ["§", "±"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Backquote: ["`", "~"],
  // JIS: ¥ (Shift: |) and ろ (_), where no US key is.
  IntlYen: ["\\", "|"],
  IntlRo: ["_", "_"],
};

/** A layout's `getLayoutMap()`, as far as this module reads it. */
export interface LayoutMapSource {
  getLayoutMap(): Promise<ReadonlyMap<string, string>>;
}

export class BaseKeys {
  /** `code` + Shift → what a keydown without Option said it types. */
  private readonly typed = new Map<string, string>();
  /** `code` → the unshifted character, from the Keyboard Map API. */
  private layout: ReadonlyMap<string, string> = new Map();
  /** The layout types what US does on every key US has: its Shift is US's. */
  private usLike = true;

  /** Note what a plain keydown types. Option chords teach nothing. */
  learn(event: LearnableKey): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.isComposing === true || event.keyCode === 229) return;
    if ([...event.key].length !== 1 || event.code === "") return;
    this.typed.set(slot(event.code, event.shiftKey), event.key);
  }

  /** Take the current layout's map (`navigator.keyboard.getLayoutMap()`). */
  adopt(layout: ReadonlyMap<string, string>): void {
    this.layout = layout;
    this.usLike = [...layout].every(
      ([code, character]) =>
        US[code] === undefined || US[code][0] === character,
    );
  }

  /**
   * Ask the Keyboard Map API for the layout, when there is one; a failure
   * (no API, a page without focus) leaves what was known.
   */
  async loadLayout(source: LayoutMapSource | undefined): Promise<void> {
    if (source === undefined) return;
    try {
      this.adopt(await source.getLayoutMap());
    } catch {
      // Keep what was learned.
    }
  }

  /**
   * The character `code` types without Option, Shift as given; `undefined`
   * when that is not known (a key no layout names, or a non-letter whose
   * Shift this layout has not shown yet — ask again without Shift).
   */
  base(code: string, shift: boolean): string | undefined {
    if (code === "Space") return " ";
    const layout = this.fromLayout(code, shift);
    // The layout has the key but not its Shift: nothing to guess with.
    if (layout === null) return undefined;
    const found =
      this.typed.get(slot(code, shift)) ??
      layout ??
      US[code]?.[shift ? 1 : 0] ??
      usLetterOrDigit(code, shift);
    if (found === undefined) return undefined;
    if (found === "¥" || found === "￥") return "\\";
    return caseOf(found, shift);
  }

  /**
   * From the layout: `undefined` when it does not know the key, `null` when
   * it knows the key but not what Shift makes of it.
   */
  private fromLayout(code: string, shift: boolean): string | null | undefined {
    if (this.typed.has(slot(code, shift))) return undefined;
    const unshifted =
      this.typed.get(slot(code, false)) ?? this.layout.get(code);
    if (unshifted === undefined) return undefined;
    if (!shift) return unshifted;
    // Shift of a letter is its capital. Shift of anything else is only known
    // where the layout agrees with US there.
    if (unshifted.toUpperCase() !== unshifted.toLowerCase()) {
      return unshifted.toUpperCase();
    }
    // JIS's ¥ key: Shift+¥ is `|` on every layout that has it.
    if (code === "IntlYen") return "|";
    const us = US[code];
    return this.usLike && us !== undefined && us[0] === unshifted
      ? us[1]
      : null;
  }
}

function slot(code: string, shift: boolean): string {
  return `${code}${shift ? "+S" : ""}`;
}

function usLetterOrDigit(code: string, shift: boolean): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return shift ? letter[1] : letter[1].toLowerCase();
  const digit = /^Numpad([0-9])$/.exec(code);
  if (digit !== null) return digit[1];
  return undefined;
}

/** A letter's case is Shift's: Caps Lock or a learned capital aside. */
function caseOf(character: string, shift: boolean): string {
  if ([...character].length !== 1) return character;
  const lower = character.toLowerCase();
  const upper = character.toUpperCase();
  if (lower === upper || [...upper].length !== 1) return character;
  return shift ? upper : lower;
}

/** The page's Keyboard Map API, when Chromium offers it. */
export function layoutMapSource(): LayoutMapSource | undefined {
  const keyboard = (
    globalThis.navigator as { keyboard?: Partial<LayoutMapSource> } | undefined
  )?.keyboard;
  return typeof keyboard?.getLayoutMap === "function"
    ? (keyboard as LayoutMapSource)
    : undefined;
}
