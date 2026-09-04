/**
 * How a chord's second stroke is written down, in one grammar.
 *
 * DevHub's commands are two-stroke chords (see `model/commands.ts`), and the
 * second stroke has to be spelled three times over: in the defaults DevHub
 * ships, in the `[keybindings.chords]` table a person writes, and in the
 * Settings window that shows both. One parser, so those three cannot disagree.
 *
 * # The grammar
 *
 * `Modifier+Modifier+…+key`, and nothing else. The modifiers are `Cmd`, `Ctrl`,
 * `Alt` and `Shift`, in any order, each at most once. This is the notation the
 * person's multiplexer already uses (`prefix+shift+comma`), on purpose: the
 * bindings were carried over from it and so was the way of writing them.
 *
 * # The key is the *physical* key, not the character it produces
 *
 * `shift+n`, never `N`. `shift+bracketleft`, never `{`.
 *
 * This is the whole correctness argument of the file, and it is why the shifted
 * chords did not work before. A binding written as a character has to be
 * compared against the character the keyboard produced, and that character is a
 * function of three things DevHub does not control: which modifiers are down
 * (`n` becomes `N`), which layout is active (a JIS keyboard does not put `{`
 * where a US one does), and whether an input method is composing (during
 * Japanese composition the character that arrives is not a character at all —
 * Chromium reports `Process`). A physical key is none of those things. It is
 * the same key on every layout, with or without Shift, mid-composition or not.
 *
 * The name is Electron's `input.code` with the noise taken off: `KeyF` is `f`,
 * `Digit1` is `1`, and everything else is its code lower-cased — `comma`,
 * `bracketleft`, `slash`, `escape`, `f5`, `intlyen`. Stripping only the two
 * prefixes that are pure prefix keeps `a` and `1` readable without inventing a
 * dictionary that a new key could fall out of.
 *
 * # Matching is exact on the modifiers
 *
 * An absent modifier means the modifier must be **up**. `Cmd+Q p` and
 * `Cmd+Q Shift+p` are two different chords rather than one that ignores Shift —
 * otherwise a command would silently swallow every modified variant of its key,
 * including ones a surface underneath wanted.
 */

/** One stroke: a physical key, and exactly which modifiers were down. */
export interface ChordKey {
  /** The physical key's name — see `keyNameForCode`. Always lower case. */
  readonly key: string;
  readonly command: boolean;
  readonly control: boolean;
  readonly option: boolean;
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

/**
 * The modifiers, and the order a formatted key writes them in.
 *
 * Cmd first because that is the order every DevHub and multiplexer binding was
 * already written in, and a canonical form is only useful if it is the one
 * people were going to type anyway.
 */
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
 * Electron's `input.code`, as this file names it.
 *
 * `KeyF` → `f`, `Digit1` → `1`, anything else lower-cased. Two prefixes are
 * stripped and no others, because those two are pure prefix: `Key` and `Digit`
 * say what kind of key it is and nothing about which. `BracketLeft` keeps its
 * whole name because there is nothing in it that is not the key's identity.
 *
 * An empty code — Chromium reports one for a few synthesised events — has no
 * physical key behind it and therefore cannot complete a chord. It comes back
 * as the empty string, which no binding can name (see `isKeyName`).
 */
export function keyNameForCode(code: string): string {
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  return code.toLowerCase();
}

/**
 * Whether this stroke is a modifier and nothing else.
 *
 * It matters because of a bug this rule is the fix for. Chromium delivers a
 * `keyDown` for Shift itself before it delivers the shifted key, so an armed
 * prefix followed by `Shift+P` arrived as *two* strokes: `ShiftLeft`, then `p`
 * with Shift down. The first completed no chord, the chord layer abandoned the
 * chord on it, and the `p` then fell through to the terminal — which is exactly
 * what every shifted chord did, while every unshifted one worked.
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
 * Whether a token names a physical key.
 *
 * Letters, digits and code names, all lower case. Not checked against a list of
 * keys that exist: Chromium's set of codes grows with the platform, and a list
 * here would refuse a binding that would have worked perfectly well — a refusal
 * nobody could act on. What is refused is what could never be a code.
 */
function isKeyName(token: string): boolean {
  return /^[a-z0-9]+$/u.test(token);
}

/**
 * `"Shift+n"` → the stroke it names. Anything else throws.
 *
 * Throwing rather than returning `undefined` because both callers want the
 * reason: the config turns it into a diagnostic that names the offending key,
 * and the registry's own test wants the failure to say which default is wrong.
 */
export function parseChordKey(text: string): ChordKey {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new ChordKeyError("empty", text);
  const segments = trimmed.split("+");
  const keyToken = segments.pop();
  if (keyToken === undefined || keyToken.trim().length === 0) {
    throw new ChordKeyError("missing_key", text);
  }
  const flags = { command: false, control: false, option: false, shift: false };
  for (const segment of segments) {
    const name = modifierNamed(segment.trim());
    if (name === undefined) throw new ChordKeyError("unknown_modifier", text);
    const field = MODIFIER_FIELD[name];
    if (flags[field]) throw new ChordKeyError("duplicate_modifier", text);
    flags[field] = true;
  }
  // Written `Shift+N` by somebody who thinks in characters: the same physical
  // key, so it is accepted and normalised rather than refused. `{` is not,
  // because there is no way to know which key produces it on the layout the
  // person will actually be typing on.
  const key = keyToken.trim().toLowerCase();
  if (!isKeyName(key)) throw new ChordKeyError("invalid_key", text);
  return { key, ...flags };
}

/** The stroke, written back out canonically. `parse(format(k))` equals `k`. */
export function formatChordKey(chord: ChordKey): string {
  const written = MODIFIERS.filter((name) => chord[MODIFIER_FIELD[name]]);
  return [...written, chord.key].join("+");
}

/**
 * The identity two bindings are the same key under.
 *
 * Used for exactly one question: has this key already been bound? A duplicate
 * is a diagnostic rather than a silent last-one-wins, so the comparison has to
 * be the same one matching uses — which it is, because both are this string.
 */
export function chordKeyId(chord: ChordKey): string {
  return formatChordKey(chord);
}

/** Whether a stroke that arrived is the one a binding names. */
export function sameChordKey(binding: ChordKey, stroke: ChordKey): boolean {
  return chordKeyId(binding) === chordKeyId(stroke);
}

/**
 * How a chord reads on screen: `Shift+p`, but also `Shift+,` where that helps.
 *
 * Only for showing. The name is the key's identity and the character is a
 * property of one layout, so the character is offered *beside* the name where
 * DevHub can be sure of it on the keyboard the label was written for, and left
 * out entirely where it cannot. Nothing parses this back.
 */
const PRINTED: Readonly<Record<string, string>> = {
  comma: ",",
  period: ".",
  slash: "/",
  semicolon: ";",
  quote: "'",
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  backquote: "`",
  minus: "-",
  equal: "=",
  space: "Space",
};

export function describeChordKey(chord: ChordKey): string {
  const printed = PRINTED[chord.key];
  const written = MODIFIERS.filter((name) => chord[MODIFIER_FIELD[name]]);
  return [...written, printed ?? chord.key].join("+");
}
