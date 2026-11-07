/**
 * A key the person pressed, as Neovim's key notation (`:help key-notation`)
 * for `nvim_input`.
 *
 * Pure: it is handed what a `keydown` says and whether Option is Meta for
 * this key (`surfaces/optionKey.ts` decides that from `[terminal]
 * mac_option_is_meta`, as for DevHub's terminals), and answers the string to
 * send, or `undefined` for a key that is not Neovim's — a lone modifier, a
 * key the IME is composing, or a printable key that will arrive as text
 * through the input element instead (`ime.ts`).
 *
 * What DevHub and macOS own never gets here: `Cmd+Q` and the chords after it
 * are taken by main's key router before the page sees them
 * (`main/shell/keyboard.ts`), as for every other surface.
 */

export interface KeyInput {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** `KeyboardEvent.isComposing`, or the IME's own word for it. */
  readonly isComposing?: boolean;
}

/** The keys whose `KeyboardEvent.key` has a name in Neovim. */
const NAMED: Readonly<Record<string, string>> = {
  Escape: "Esc",
  Enter: "CR",
  Tab: "Tab",
  Backspace: "BS",
  Delete: "Del",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Help: "Help",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};

/** Characters that must be spelled by name inside `<…>` or as text. */
const SPECIAL_CHARS: Readonly<Record<string, string>> = {
  "<": "lt",
  "\\": "Bslash",
  "|": "Bar",
  " ": "Space",
};

const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "OS",
  "NumLock",
  "ScrollLock",
]);

/** Text as `nvim_input` reads it: only `<` is special, and is `<lt>`. */
export function escapeInputText(text: string): string {
  return text.replaceAll("<", "<lt>");
}

/**
 * The character a key produces with Option *not* applied, for a Meta key:
 * Option+X on a US layout reports `≈`, and Neovim's `<M-x>` wants the `x`.
 * Read from the physical key, so it is the US-layout letter or digit.
 */
function baseOfCode(code: string, shift: boolean): string | undefined {
  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    return shift ? letter : letter.toLowerCase();
  }
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const punct: Record<string, string> = {
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Backquote: "`",
    Space: " ",
  };
  return punct[code];
}

function wrap(mods: string, key: string): string {
  return mods.length === 0 && key.length === 1
    ? key
    : `<${mods}${SPECIAL_CHARS[key] ?? key}>`;
}

/**
 * What to send for this `keydown`. `optionIsMeta` says whether Option is
 * Meta for it; a printable key with no Ctrl, Meta or Cmd answers
 * `undefined`, because its character arrives as text (`input` events), which
 * is what an IME and a dead key need.
 */
export function keyToNeovim(
  event: KeyInput,
  optionIsMeta: boolean,
): string | undefined {
  if (event.isComposing === true || event.key === "Process") return undefined;
  if (MODIFIER_KEYS.has(event.key) || event.key === "Dead") return undefined;
  const meta = event.altKey && optionIsMeta;
  const named = NAMED[event.key];
  if (named !== undefined) {
    const mods =
      (event.ctrlKey ? "C-" : "") +
      (event.shiftKey ? "S-" : "") +
      (meta ? "M-" : "") +
      (event.metaKey ? "D-" : "");
    return `<${mods}${named}>`;
  }
  // One character from here on (`key` is the produced character).
  if ([...event.key].length !== 1) return undefined;
  if (!event.ctrlKey && !meta && !event.metaKey) {
    // Plain text, Shift and the layout's Option characters included: the
    // input element delivers it. Space too, so `<Space>` mappings see " ".
    return undefined;
  }
  let key = event.key;
  if (meta) key = baseOfCode(event.code, event.shiftKey) ?? key;
  if (event.ctrlKey && key.length === 1) {
    // `<C-a>` and `<C-A>` are one key to Neovim; Shift is said separately
    // only where it means something (`<C-S-a>` reaches a GUI's mappings).
    const lower = key.toLowerCase();
    const mods =
      "C-" +
      (event.shiftKey && lower !== key ? "S-" : "") +
      (meta ? "M-" : "") +
      (event.metaKey ? "D-" : "");
    return wrap(mods, /[a-z]/i.test(lower) ? lower : key);
  }
  const mods = (meta ? "M-" : "") + (event.metaKey ? "D-" : "");
  return wrap(mods, key);
}
