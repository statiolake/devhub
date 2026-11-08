/**
 * A key the person pressed, as tmux names it for `send-keys -K`
 * (`C-a`, `M-x`, `S-Up`, `Enter`, `BSpace`, `;`): in control mode the key
 * goes through tmux's own key tables — the prefix and the bindings — and
 * tmux encodes it for the pane's program, Kitty keyboard and extended keys
 * included. The page decides only which key it was.
 *
 * Option is Meta per `[terminal] mac_option_is_meta` (`optionKey.ts`): when
 * it is, Option+x is `M-x`; when it is not, the character the layout puts on
 * Option is the key. Cmd chords are DevHub's or the system's, never the
 * terminal's.
 */

export interface KeyLike {
  readonly key: string;
  readonly code: string;
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
 * `meta`: Option is Meta for this key.
 */
export function tmuxKey(event: KeyLike, meta: boolean): string | undefined {
  if (event.metaKey || SILENT.has(event.key)) return undefined;
  const alt = event.altKey && meta;
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
    // With Option as Meta the character is the key's own, not the one the
    // layout puts on Option (`≈` for Option+X): the physical key says it.
    if (alt) base = keyOfCode(event.code, event.shiftKey) ?? base;
    // Ctrl+letter is the letter's control key whatever Shift says.
    if (event.ctrlKey && /^[A-Za-z]$/.test(base)) base = base.toLowerCase();
  } else {
    return undefined;
  }
  let name = base;
  if (shiftMatters && event.shiftKey) name = `S-${name}`;
  if (alt) name = `M-${name}`;
  if (event.ctrlKey) name = `C-${name}`;
  return name;
}

/** The US-layout character of a physical key, for Meta chords. */
function keyOfCode(code: string, shift: boolean): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return shift ? letter[1] : letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return shift ? ")!@#$%^&*("[Number(digit[1])] : digit[1];
  const punctuation: Record<string, [string, string]> = {
    Minus: ["-", "_"],
    Equal: ["=", "+"],
    BracketLeft: ["[", "{"],
    BracketRight: ["]", "}"],
    Backslash: ["\\", "|"],
    Semicolon: [";", ":"],
    Quote: ["'", '"'],
    Comma: [",", "<"],
    Period: [".", ">"],
    Slash: ["/", "?"],
    Backquote: ["`", "~"],
  };
  const pair = punctuation[code];
  return pair === undefined ? undefined : pair[shift ? 1 : 0];
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
