/**
 * A key the person pressed, as Neovim's key notation (`:help key-notation`)
 * for `nvim_input`.
 *
 * Pure: it is handed what a `keydown` says, whether Option is Meta for this
 * key (`surfaces/optionKey.ts` decides that from `[terminal]
 * mac_option_is_meta`, as for DevHub's terminals) and what each physical key
 * types without Option (`surfaces/baseKeys.ts`: `<M-x>` for Option+X, not
 * `<M-≈>`; `<M-@>` for Option+@ on JIS), and answers the string to
 * send, or `undefined` for a key that is not Neovim's — a lone modifier, a
 * key the IME is composing, or a printable key that will arrive as text
 * through the input element instead (`ime.ts`).
 *
 * What DevHub and macOS own never gets here: `Cmd+Q` and the chords after it
 * are taken by main's key router before the page sees them
 * (`main/shell/keyboard.ts`), as for every other surface.
 */

import { BaseKeys } from "../surfaces/baseKeys";

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

/** Named keys by `code`, for a Meta chord whose `key` Option replaced. */
const NAMED_CODES: Readonly<Record<string, string>> = {
  Enter: "CR",
  NumpadEnter: "CR",
  Tab: "Tab",
  Backspace: "BS",
  Escape: "Esc",
};

const MODIFIER_CODE = /^(Shift|Control|Alt|Meta|OS)(Left|Right)$|^Lang[0-9]$/;

/** No layout learned: what `code` says, the US layout. */
const US_ONLY = new BaseKeys();

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
  layout: BaseKeys = US_ONLY,
): string | undefined {
  if (MODIFIER_KEYS.has(event.key) || MODIFIER_CODE.test(event.code)) {
    return undefined;
  }
  const meta = event.altKey && optionIsMeta;
  // A Meta chord is the physical key's, even when Chromium handed it to
  // the input method (a dead key's "Dead", keyCode 229's "Process").
  if (!meta && (event.isComposing === true || event.key === "Process")) {
    return undefined;
  }
  if (!meta && event.key === "Dead") return undefined;
  const named =
    NAMED[event.key] ?? (meta ? NAMED_CODES[event.code] : undefined);
  if (named !== undefined) {
    const mods =
      (event.ctrlKey ? "C-" : "") +
      (event.shiftKey ? "S-" : "") +
      (meta ? "M-" : "") +
      (event.metaKey ? "D-" : "");
    return `<${mods}${named}>`;
  }
  // One character from here on (`key` is the produced character).
  if ([...event.key].length !== 1 && !meta) return undefined;
  if (!event.ctrlKey && !meta && !event.metaKey) {
    // Plain text, Shift and the layout's Option characters included: the
    // input element delivers it. Space too, so `<Space>` mappings see " ".
    return undefined;
  }
  let key = event.key;
  if (meta) {
    const base = layout.base(event.code, event.shiftKey);
    if (base !== undefined) {
      key = base;
    } else {
      // A key whose Shift this layout has not shown: the key, and Shift.
      const unshifted = layout.base(event.code, false);
      if (unshifted !== undefined) {
        return wrap(
          (event.ctrlKey ? "C-" : "") + "S-M-" + (event.metaKey ? "D-" : ""),
          unshifted,
        );
      }
    }
    if ([...key].length !== 1) return undefined;
  }
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
  // Chrome on a Mac reports Cmd+Shift+Z as "z": the Shift is put back, so
  // `<D-Z>` (redo) is not `<D-z>` (undo).
  if (event.metaKey && event.shiftKey && /^[a-z]$/.test(key)) {
    key = key.toUpperCase();
  }
  const mods = (meta ? "M-" : "") + (event.metaKey ? "D-" : "");
  return wrap(mods, key);
}
