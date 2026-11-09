/**
 * A key the person pressed, as tmux names it for `send-keys -K`
 * (`C-a`, `M-x`, `S-Up`, `Enter`, `BSpace`, `;`): in control mode the key
 * goes through tmux's own key tables — the prefix and the bindings — and
 * tmux encodes it for the pane's program, Kitty keyboard and extended keys
 * included. The page decides only which key it was.
 *
 * Option is Meta per `[terminal] mac_option_is_meta` (`optionKey.ts`): when
 * it is, Option+x is `M-x`, by the physical key read through the layout
 * (`baseKeys.ts`); when it is not, the character the layout puts on Option
 * is the key. Cmd chords are DevHub's or the system's, never the terminal's,
 * except Ghostty's editing bindings (below).
 */

import type { MacOptionIsMeta } from "../../../model/macOption";
import { BaseKeys } from "../../surfaces/baseKeys";
import {
  MetaComposition,
  OptionKeys,
  type OptionKeyEvent,
} from "../../surfaces/optionKey";

export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly type?: string;
  readonly location?: number;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

const NAMED: Readonly<Record<string, string>> = {
  Enter: "Enter",
  Backspace: "BSpace",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PPage",
  PageDown: "NPage",
  Insert: "IC",
  Delete: "DC",
  " ": "Space",
};

/** Keys that are only modifiers, or dead keys mid-composition: nothing to send. */
const SILENT = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Dead",
  "Process",
  "Unidentified",
  "Fn",
]);

/**
 * The tmux key name for a keydown, or `undefined` when it is not the
 * terminal's (a bare modifier, a Cmd chord, a key the IME is composing).
 * `meta`: Option is Meta for this key (`OptionKeys`); `layout` says what a
 * physical key types without Option (`baseKeys.ts`), US when absent.
 *
 * A Meta chord is named by its physical key, never by `key`: that is what
 * Option made of it (`≈`, `å`, `∫`, a dead key's `"Dead"`, or `"Process"`
 * when Chromium handed it to the input method), so Option+X is `M-x`,
 * Option+Shift+X `M-X`, Option+E `M-e` and Option+@ on JIS `M-@`.
 *
 * The Mac editing chords are Ghostty's bindings, as in the xterm.js
 * terminal (`surfaces/keys.ts`): Cmd+Left `C-a`, Cmd+Right `C-e`,
 * Cmd+Backspace `C-u`, Option+Left `M-b` and Option+Right `M-f` — either
 * Option, whatever the setting.
 */
export function tmuxKey(
  event: KeyLike,
  meta: boolean,
  layout: BaseKeys = US_ONLY,
): string | undefined {
  const editing = editingKey(event);
  if (editing !== undefined) return editing;
  if (event.metaKey) return undefined;
  const alt = event.altKey && meta;
  if (alt) return physicalKey(event, layout, true);
  if (SILENT.has(event.key)) return undefined;
  let base: string;
  let shiftMatters = false;
  const named = NAMED[event.key];
  if (named !== undefined) {
    base = named;
    shiftMatters = named !== "Space";
    if (named === "Tab" && event.shiftKey) {
      base = "BTab";
      shiftMatters = false;
    }
  } else if (/^F([1-9]|1[0-2])$/.test(event.key)) {
    base = event.key;
    shiftMatters = true;
  } else if ([...event.key].length === 1) {
    base = event.key;
    // Ctrl+letter is the letter's control key whatever Shift says.
    if (event.ctrlKey && /^[A-Za-z]$/.test(base)) base = base.toLowerCase();
  } else {
    return undefined;
  }
  let name = base;
  if (shiftMatters && event.shiftKey) name = `S-${name}`;
  if (event.ctrlKey) name = `C-${name}`;
  return name;
}

/**
 * A key by its physical key, through `layout`: an Option-as-Meta chord
 * (`meta`), or a key typed while the composition a Meta dead key started is
 * being dropped, whose `key` macOS has already composed (`ñ` for Option+N
 * then n).
 */
export function physicalKey(
  event: KeyLike,
  layout: BaseKeys,
  meta: boolean,
): string | undefined {
  if (event.metaKey) return undefined;
  if (MODIFIERS.has(event.key) || MODIFIER_CODES.test(event.code)) {
    return undefined;
  }
  let base: string;
  let shiftMatters = false;
  const named = NAMED[event.key] ?? NAMED_CODES[event.code];
  if (named !== undefined) {
    base = named;
    shiftMatters = named !== "Space";
    if (named === "Tab" && event.shiftKey) {
      base = "BTab";
      shiftMatters = false;
    }
  } else if (/^F([1-9]|1[0-2])$/.test(event.key)) {
    base = event.key;
    shiftMatters = true;
  } else {
    let found = layout.base(event.code, event.shiftKey);
    if (found === undefined && event.shiftKey) {
      // A key whose Shift this layout has not shown: the key, and Shift.
      found = layout.base(event.code, false);
      shiftMatters = found !== undefined;
    }
    if (found === undefined) {
      // No physical key to go by (a synthetic event): `key`, when it is one
      // character Option did not make.
      if ([...event.key].length !== 1 || SILENT.has(event.key)) {
        return undefined;
      }
      found = event.key;
    }
    base = found;
    if (event.ctrlKey && /^[A-Za-z]$/.test(base)) base = base.toLowerCase();
  }
  let name = base;
  if (shiftMatters && event.shiftKey) name = `S-${name}`;
  if (meta) name = `M-${name}`;
  if (event.ctrlKey) name = `C-${name}`;
  return name;
}

/** Ghostty's macOS editing bindings, exactly their modifier sets. */
function editingKey(event: KeyLike): string | undefined {
  if (event.shiftKey || event.ctrlKey) return undefined;
  if (event.metaKey && !event.altKey) {
    if (event.key === "ArrowLeft") return "C-a";
    if (event.key === "ArrowRight") return "C-e";
    if (event.key === "Backspace") return "C-u";
    return undefined;
  }
  if (event.altKey && !event.metaKey) {
    if (event.key === "ArrowLeft") return "M-b";
    if (event.key === "ArrowRight") return "M-f";
  }
  return undefined;
}

/** Named keys by `code`, for a Meta chord whose `key` Option replaced. */
const NAMED_CODES: Readonly<Record<string, string>> = {
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "BSpace",
  Tab: "Tab",
  Escape: "Escape",
  Space: "Space",
};

const MODIFIERS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "Fn",
]);
const MODIFIER_CODES =
  /^(Shift|Control|Alt|Meta|OS)(Left|Right)$|^CapsLock$|^Fn$|^Lang[0-9]$/;

/** No layout learned: what `code` says, the US layout. */
const US_ONLY = new BaseKeys();

/**
 * The control-mode terminal's keyboard: each keydown as the tmux key to send,
 * Option as Meta per the setting and by the physical key, and the
 * composition a Meta dead key starts kept from the pane.
 *
 * Option as Meta is decided before the composition check: Chromium may hand
 * an Option chord to the input method (a dead key: `key` "Dead", keyCode
 * 229) and it is still Meta. A composition such a key starts is dropped,
 * and the keys typed during it are named here by their physical key — the
 * next Meta chord (Option+N then Option+P is `M-n`, `M-p`), or the plain key
 * that would have committed the mark (Option+N then n is `M-n`, `n`). An
 * IME's composition, and one the right Option starts under `"left"`, are
 * untouched.
 */
export class TerminalKeys {
  readonly layout = new BaseKeys();
  private readonly option = new OptionKeys();
  private readonly composition = new MetaComposition();

  /** The tmux key for a keydown; `undefined`: the page's (text, an IME). */
  keydown(event: KeyLike, setting: MacOptionIsMeta): string | undefined {
    const meta = this.option.isMeta(setting, optionEvent("keydown", event));
    const optionMeta = meta && event.altKey;
    const dropping = this.composition.active;
    if (!optionMeta && !dropping) {
      this.layout.learn(event);
      if (event.isComposing === true || event.keyCode === 229) {
        this.composition.keydown(false);
        return undefined;
      }
    }
    // An IME's composition in flight keeps every key, Option's too.
    if (optionMeta && !dropping && event.isComposing === true) return undefined;
    this.composition.keydown(optionMeta);
    return dropping && !optionMeta
      ? physicalKey(event, this.layout, false)
      : tmuxKey(event, meta, this.layout);
  }

  keyup(event: KeyLike, setting: MacOptionIsMeta): void {
    this.option.isMeta(setting, optionEvent("keyup", event));
  }

  /**
   * A composition or input event: `true` when it belongs to a Meta key's
   * composition and is to be dropped (`MetaComposition`).
   */
  drops(type: string): boolean {
    return this.composition.drops(type);
  }

  /** Whether a Meta key's composition is being dropped now. */
  get dropping(): boolean {
    return this.composition.active;
  }

  /** Focus lost: whatever composition was in flight is over. */
  reset(): void {
    this.composition.reset();
  }
}

/** A DOM event's own fields: its getters do not survive a spread. */
function optionEvent(type: string, event: KeyLike): OptionKeyEvent {
  return {
    type,
    code: event.code,
    altKey: event.altKey,
    key: event.key,
    ...(event.location === undefined ? {} : { location: event.location }),
  };
}

/** A paste for a pane: bracketed when its program asked (`DECSET 2004`). */
export function pasteBytes(text: string, bracketed: boolean): Uint8Array {
  // A terminal paste ends lines with CR, as typed Return does.
  const body = text.replace(/\r?\n/g, "\r");
  return new TextEncoder().encode(
    bracketed ? `\x1b[200~${body}\x1b[201~` : body,
  );
}

/** An SGR mouse report (`DECSET 1006`): 1-based cell, `M` press, `m` release. */
export function sgrMouse(
  button: number,
  x: number,
  y: number,
  release: boolean,
): Uint8Array {
  return new TextEncoder().encode(
    `\x1b[<${String(button)};${String(x + 1)};${String(y + 1)}${release ? "m" : "M"}`,
  );
}
