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
 * # `input.code`, only where there is no character
 *
 * An input method that is composing reports `Process` for the key — that is the
 * whole of what `code` is still needed for, and it is why a chord works
 * mid-composition at all. See `charactersForCode`, and the layout ambiguity it
 * cannot resolve.
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
 * What each physical key produces, when only the physical key is known.
 *
 * **Two layouts, written down, because there is no way to ask.** macOS knows
 * which keyboard layout is active, and neither Electron nor Node exposes it: the
 * answer lives behind Carbon's `TISCopyCurrentKeyboardLayoutInputSource`, which
 * needs a native binding this app does not have. Reading
 * `AppleCurrentKeyboardLayoutInputSourceID` out of the HIToolbox preferences
 * would be a guess wearing an API's clothes — it names the *input source*, and a
 * Japanese input source says nothing about whether the hardware under it is JIS
 * or ANSI, which is the only thing in question here.
 *
 * So both readings are candidates and the first one that is actually bound wins.
 * That resolves every case except one: a punctuation key whose two readings are
 * *both* bound to something. `BracketRight` shifted is `}` on a US keyboard and
 * `{` on a JIS one, and DevHub binds both — so under composition, and only
 * under composition, that pair is genuinely ambiguous and the US reading is
 * taken. The practical cost is small and worth stating plainly: this table is
 * consulted **only** while an input method is composing, letters and digits are
 * unambiguous on both layouts, and every chord whose second stroke is
 * punctuation can still be typed by finishing or cancelling the composition
 * first.
 *
 * The rows are `[unshifted, shifted]` per layout. Keys that produce nothing on a
 * layout are left out of that layout's row.
 */
const LAYOUT_CHARACTERS: Readonly<
  Record<
    string,
    {
      readonly us?: readonly [string, string];
      readonly jis?: readonly [string, string];
    }
  >
> = {
  Backquote: { us: ["`", "~"] },
  Minus: { us: ["-", "_"], jis: ["-", "="] },
  Equal: { us: ["=", "+"], jis: ["^", "~"] },
  BracketLeft: { us: ["[", "{"], jis: ["@", "`"] },
  BracketRight: { us: ["]", "}"], jis: ["[", "{"] },
  Backslash: { us: ["\\", "|"], jis: ["]", "}"] },
  Semicolon: { us: [";", ":"], jis: [";", "+"] },
  Quote: { us: ["'", '"'], jis: [":", "*"] },
  Comma: { us: [",", "<"], jis: [",", "<"] },
  Period: { us: [".", ">"], jis: [".", ">"] },
  Slash: { us: ["/", "?"], jis: ["/", "?"] },
  IntlYen: { jis: ["\\", "|"] },
  IntlRo: { jis: ["\\", "_"] },
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

/**
 * The characters a physical key could have produced, best guess first.
 *
 * Only for a key event that carries no character of its own. Letters and digits
 * are one answer, because every layout DevHub can meet puts them in the same
 * places; punctuation is up to two, for the reason in `LAYOUT_CHARACTERS`.
 */
export function charactersForCode(
  code: string,
  shift: boolean,
): readonly string[] {
  const letter = /^Key([A-Z])$/u.exec(code);
  if (letter) {
    const lower = letter[1].toLowerCase();
    return [shift ? letter[1] : lower];
  }
  const digit = /^Digit([0-9])$/u.exec(code);
  if (digit) {
    return [shift ? (US_SHIFTED[digit[1]] ?? digit[1]) : digit[1]];
  }
  const layouts = LAYOUT_CHARACTERS[code];
  if (layouts) {
    const at = shift ? 1 : 0;
    // Deduplicated: the two layouts agree about `,` `.` and `/`, and one
    // candidate offered twice is a candidate that looks ambiguous and is not.
    return [...new Set([layouts.us?.[at], layouts.jis?.[at]])].filter(
      (character): character is string => character !== undefined,
    );
  }
  return [];
}

/** The names Chromium gives a key whose character it cannot report yet. */
const NO_CHARACTER = new Set(["Process", "Dead", "Unidentified", ""]);

/**
 * What a key event could be, as chord identities, best first.
 *
 * The character it produced, when it produced one — which is almost always, and
 * is the whole model. Otherwise the physical key's readings, which is the
 * composing case and the only reason `code` is here at all.
 */
export function strokeKeys(
  key: string,
  code: string,
  shift: boolean,
): readonly string[] {
  if (NO_CHARACTER.has(key)) return charactersForCode(code, shift);
  // One character is a character. Anything longer is a key with a name, and
  // names are compared without regard to case.
  return [key.length === 1 ? key : key.toLowerCase()];
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
