/**
 * How a chord's second stroke is written down, in one grammar.
 *
 * DevHub's commands are two-stroke chords (see `model/commands.ts`), and the
 * second stroke has to be spelled three times over: in the defaults DevHub
 * ships, in the `[keybindings.chords]` table a person writes, and in the
 * Settings window that shows both. One parser, so those three cannot disagree.
 *
 * # A stroke is the character it produces
 *
 * `{`, not `Shift+[` and not `Shift+bracketleft`. `N`, not `Shift+n`. `<`, not
 * `Shift+,`.
 *
 * This is the second answer to the same question, and the first one was wrong.
 * Matching the *character* went wrong because a character is a function of the
 * modifiers — `Shift+P` arrives as `P`, and a table written in lower case never
 * matched it. Matching the **physical key** from `input.code` fixed that and
 * broke something else: `code` names positions by the US layout, and a JIS
 * keyboard does not put punctuation where a US one does. The key printed `[` on
 * a JIS keyboard is `BracketRight`, the one printed `]` is `Backslash`, and
 * `BracketLeft` is where `@` lives — so `Shift+bracketleft` selected the key one
 * to the left of the one the person was looking at. Letters and digits happen
 * to coincide, which is exactly why it looked like it worked.
 *
 * The character does not have either problem. Chromium has already applied both
 * the modifiers and the layout by the time `input.key` arrives, so `{` is `{` on
 * every keyboard that can produce one, and it is also what is printed on the key
 * the person is pressing. There is nothing left to translate.
 *
 * # Shift is part of the character, where there is a character
 *
 * `Shift+n` and `N` are the same stroke, and the canonical spelling is `N` —
 * the config accepts either and normalises on parse. A stroke with no character
 * to fold Shift into (`Escape`, `Tab`, `ArrowLeft`) keeps Shift as a flag,
 * because there is nowhere else to put it. One rule, stated once: **Shift is in
 * the character where there is one, and a flag where there is not.**
 *
 * The `Shift+<base>` spelling has to be interpreted with *some* layout, and it
 * is interpreted with the US one: `Shift+[` is `{`, `Shift+,` is `<`. That is
 * safe because it is only ever a spelling of something the canonical form
 * already says outright, and what gets written back to the file is always the
 * character.
 *
 * Command, Control and Option stay as flags on all of them. They do not change
 * which character a key produces on a Mac, so there is nothing to fold.
 *
 * # Never the physical key
 *
 * `input.code` is not a fallback for a missing character either. It used to
 * be — read from two layouts at once, for a key an input method was composing
 * — but on macOS that key never reaches DevHub at all: the input method takes
 * it before Electron's `before-input-event` is raised. What a chord does about
 * an input method is take it out of the way while the chord is armed
 * (`main/shell/chordInputSource.ts`), after which the second stroke arrives
 * with its character like any other. A key that still arrives with no
 * character — a dead key half-way through an accent — is no stroke at all.
 */

/** One stroke: the character it produces, and the modifiers that are not in it. */
export interface ChordKey {
  /**
   * The character produced, or the lower-cased name of a key that produces
   * none (`escape`, `tab`, `arrowleft`).
   */
  readonly key: string;
  readonly command: boolean;
  readonly control: boolean;
  readonly option: boolean;
  /** Only meaningful for a named key: elsewhere it is in `key`. */
  readonly shift: boolean;
}

/** Why a key string is not one. Carried, so the config can say which. */
export type ChordKeyProblem =
  | "empty"
  | "unknown_modifier"
  | "duplicate_modifier"
  | "missing_key"
  | "invalid_key";

export class ChordKeyError extends Error {
  constructor(
    readonly problem: ChordKeyProblem,
    readonly text: string,
  ) {
    super(`${problem}: ${text}`);
    this.name = "ChordKeyError";
  }
}

const MODIFIERS = ["Cmd", "Ctrl", "Alt", "Shift"] as const;

type ModifierName = (typeof MODIFIERS)[number];

type ModifierField = "command" | "control" | "option" | "shift";

const MODIFIER_FIELD: Readonly<Record<ModifierName, ModifierField>> = {
  Cmd: "command",
  Ctrl: "control",
  Alt: "option",
  Shift: "shift",
};

function modifierNamed(word: string): ModifierName | undefined {
  const lowered = word.toLowerCase();
  return MODIFIERS.find((name) => name.toLowerCase() === lowered);
}

/**
 * What Shift makes of a character, on a US keyboard.
 *
 * Only for reading the `Shift+<base>` spelling a person may write in the config,
 * and never for deciding what a keypress was — a keypress arrives with its
 * character already worked out by the layout in use. A spelling has to be
 * interpreted with some layout or it means nothing at all, and the canonical
 * form it normalises to is the character itself, so nothing downstream depends
 * on the guess.
 */
const US_SHIFTED: Readonly<Record<string, string>> = {
  "`": "~",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
};

/**
 * Whether this stroke is a modifier and nothing else.
 *
 * It matters because of a bug this rule is the fix for. Chromium delivers a
 * `keyDown` for Shift itself before it delivers the shifted key, so an armed
 * prefix followed by `Shift+P` arrived as *two* strokes: `ShiftLeft`, then `P`.
 * The first completed no chord, the chord layer abandoned the chord on it, and
 * the `P` then fell through to the terminal — which is exactly what every
 * shifted chord did while every unshifted one worked.
 *
 * So a bare modifier is not a stroke that can complete or cancel anything. It
 * is not a key a person can bind either, which is the same fact: there is no
 * chord whose second stroke is "Shift".
 */
export function isModifierKey(code: string): boolean {
  return /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^CapsLock$|^Fn$/u.test(
    code,
  );
}

/** The names Chromium gives a key that produced no character. */
const NO_CHARACTER = new Set(["Process", "Dead", "Unidentified", ""]);

/**
 * What a key event is, as a chord identity — or nothing, for a key that
 * produced no character and has no name of its own.
 *
 * One character is a character. Anything longer is a key with a name, and
 * names are compared without regard to case.
 */
export function strokeKey(key: string): string | undefined {
  if (NO_CHARACTER.has(key)) return undefined;
  return key.length === 1 ? key : key.toLowerCase();
}

/** Whether this identity is a key with a name rather than a character. */
function isNamedKey(key: string): boolean {
  return key.length > 1;
}

function isKeyToken(token: string): boolean {
  if (token.length === 0) return false;
  if (token.length === 1) return !/\s/u.test(token);
  return /^[A-Za-z][A-Za-z0-9]*$/u.test(token);
}

/**
 * `"{"` — or `"Shift+["`, which is the same stroke — as the stroke it names.
 *
 * Throwing rather than returning `undefined` because both callers want the
 * reason: the config turns it into a diagnostic that names the offending key,
 * and the registry's own test wants the failure to say which default is wrong.
 */
export function parseChordKey(text: string): ChordKey {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new ChordKeyError("empty", text);
  const segments = trimmed.split("+");
  let keyToken = segments.pop() ?? "";
  if (keyToken.length === 0) {
    // The key *is* the plus sign: `+` splits to two empty segments and
    // `Shift++` to three, so the empty tail and the empty segment before it
    // are together one `+` key.
    if (segments.pop() !== "") throw new ChordKeyError("missing_key", text);
    keyToken = "+";
  }
  const flags = { command: false, control: false, option: false, shift: false };
  for (const segment of segments) {
    const name = modifierNamed(segment.trim());
    if (name === undefined) throw new ChordKeyError("unknown_modifier", text);
    const field = MODIFIER_FIELD[name];
    if (flags[field]) throw new ChordKeyError("duplicate_modifier", text);
    flags[field] = true;
  }
  const written = keyToken.trim();
  if (!isKeyToken(written)) throw new ChordKeyError("invalid_key", text);
  if (isNamedKey(written)) {
    // No character to fold Shift into, so it stays a flag.
    return { ...flags, key: written.toLowerCase() };
  }
  if (!flags.shift) return { ...flags, key: written };
  // `Shift+n` is `N`, `Shift+[` is `{`, and `Shift+{` is already `{`: a
  // character with no shifted form of its own is one that has been written
  // shifted already, so it is taken as it stands.
  const shifted = /^[a-z]$/u.test(written)
    ? written.toUpperCase()
    : US_SHIFTED[written];
  return { ...flags, shift: false, key: shifted ?? written };
}

/** The stroke, written back out canonically. `parse(format(k))` equals `k`. */
export function formatChordKey(chord: ChordKey): string {
  const written = MODIFIERS.filter((name) => {
    // Shift is only ever written for a named key. Anywhere else it is in the
    // character, and writing it as well would be saying it twice.
    if (name === "Shift") return chord.shift && isNamedKey(chord.key);
    return chord[MODIFIER_FIELD[name]];
  });
  return [...written, chord.key].join("+");
}

/**
 * The identity two bindings are the same key under.
 *
 * Case matters, and that is the model rather than an oversight: `N` and `n` are
 * different characters produced by the same key with and without Shift, and
 * folding them would make `Shift+N` and `n` one binding.
 */
export function chordKeyId(chord: ChordKey): string {
  return formatChordKey(chord);
}

/** Whether a stroke that arrived is the one a binding names. */
export function sameChordKey(binding: ChordKey, stroke: ChordKey): boolean {
  return chordKeyId(binding) === chordKeyId(stroke);
}

/**
 * How a chord reads on screen.
 *
 * The character, which is what is printed on the key the person presses — so
 * this is the canonical form and nothing more. It has a name of its own only
 * because a named key reads better with a capital.
 */
const SHOWN: Readonly<Record<string, string>> = {
  " ": "Space",
  // The arrows are drawn, not spelled. They are what is printed on the keys —
  // this is a Mac, and every menu on it says ↑ — and "Arrowup" is a name only
  // the canonical lower-cased spelling of a named key ever produces.
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

export function describeChordKey(chord: ChordKey): string {
  const shown =
    SHOWN[chord.key] ??
    (isNamedKey(chord.key)
      ? chord.key.charAt(0).toUpperCase() + chord.key.slice(1)
      : chord.key);
  const written = MODIFIERS.filter((name) => {
    if (name === "Shift") return chord.shift && isNamedKey(chord.key);
    return chord[MODIFIER_FIELD[name]];
  });
  return [...written, shown].join("+");
}
