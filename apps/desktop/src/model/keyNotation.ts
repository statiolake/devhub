/**
 * How a key is written on screen, in one notation everywhere: a Mac's.
 *
 * DevHub shows keys from many sources — a Neovim plugin's hint row
 * (`<C-v>`, `<CR>`), tmux's tables (`C-q`, `M-x`), DevHub's own hints
 * (`Ctrl-X`, `Return`, `Esc`) — and each wrote them its own way: `^v`
 * beside `⌥v` beside `Return` beside an `Enter` keycap. One person reads all
 * of them, so they are all written as the menus of the Mac they sit on
 * write them:
 *
 * - **Modifiers are symbols, in the Mac's order**: `⌃` Control, `⌥` Option
 *   (Alt, Meta), `⇧` Shift, `⌘` Command, then the key.
 * - **A modified letter is a capital**, as it is printed on the key:
 *   `⌃V`, `⌥V`, `⇧V`. A letter on its own is the character typed and keeps
 *   its case — `j` and `J` are two different keys in Neovim, so neither is
 *   spelled as the other.
 * - **Named keys are their symbols**: `↩` Return (Enter, `<CR>`), `⎋`
 *   Escape, `⇥` Tab, `⌫` Backspace, `⌦` Delete, the arrows `↑ ↓ ← →`,
 *   `⇞ ⇟` Page Up and Down, `↖ ↘` Home and End. Space stays a word: a Mac
 *   has no symbol for it that reads.
 * - **A sequence is its keys apart by a space**: `<C-w>v` is `⌃W v`; a list
 *   already apart (`<C-j> <C-k>`, `j/k`) keeps its separators.
 *
 * Anything that is not a key in one of those notations is left as written,
 * so the function is safe on text already in this notation (`⌃V` is `⌃V`)
 * and on a hint that is a word (`:write`).
 */

/** The modifiers in the order a Mac writes them. */
const ORDER = ["⌃", "⌥", "⇧", "⌘"] as const;

/** Each notation's name for a modifier, lower-cased. */
const MODIFIER: Readonly<Record<string, (typeof ORDER)[number]>> = {
  c: "⌃",
  ctrl: "⌃",
  control: "⌃",
  "⌃": "⌃",
  "^": "⌃",
  m: "⌥",
  a: "⌥",
  alt: "⌥",
  meta: "⌥",
  opt: "⌥",
  option: "⌥",
  "⌥": "⌥",
  s: "⇧",
  shift: "⇧",
  "⇧": "⇧",
  d: "⌘",
  cmd: "⌘",
  command: "⌘",
  "⌘": "⌘",
};

/** Each notation's name for a key that types no character, lower-cased. */
const NAMED: Readonly<Record<string, string>> = {
  cr: "↩",
  enter: "↩",
  return: "↩",
  "↩": "↩",
  "⏎": "↩",
  nl: "↩",
  esc: "⎋",
  escape: "⎋",
  "⎋": "⎋",
  tab: "⇥",
  "⇥": "⇥",
  bs: "⌫",
  backspace: "⌫",
  bspace: "⌫",
  "⌫": "⌫",
  del: "⌦",
  delete: "⌦",
  dc: "⌦",
  "⌦": "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  "↑": "↑",
  "↓": "↓",
  "←": "←",
  "→": "→",
  pageup: "⇞",
  pagedown: "⇟",
  ppage: "⇞",
  npage: "⇟",
  home: "↖",
  end: "↘",
  space: "Space",
  lt: "<",
  bar: "|",
  bslash: "\\",
};

/** Names that are keys written bare, outside Vim's brackets (`Return`, `esc`). */
const BARE = new Set([
  "enter",
  "return",
  "esc",
  "escape",
  "tab",
  "backspace",
  "delete",
  "del",
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  "home",
  "end",
  "space",
]);

/** Modifier names that are modifiers bare (`C-q`, `Ctrl-X`): not Vim's `a`, `d`. */
const BARE_MODIFIERS = new Set([
  "c",
  "m",
  "s",
  "ctrl",
  "control",
  "alt",
  "meta",
  "opt",
  "option",
  "shift",
  "cmd",
  "command",
]);

/** A key without its modifiers, in this notation; undefined when it is none. */
function baseKey(
  text: string,
  modified: boolean,
  bracketed: boolean,
): string | undefined {
  const lower = text.toLowerCase();
  const named = NAMED[lower];
  if (named !== undefined && (bracketed || modified || BARE.has(lower)))
    return named;
  if (named !== undefined && [...text].length === 1) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/iu.test(text)) return text.toUpperCase();
  if ([...text].length !== 1) return undefined;
  return modified ? text.toUpperCase() : text;
}

/** Modifier symbols plus a key, the modifiers in the Mac's order. */
function written(mods: ReadonlySet<string>, key: string): string {
  return ORDER.filter((m) => mods.has(m)).join("") + key;
}

/**
 * One key with its modifiers, in any of the notations above (`<C-v>`,
 * `C-v`, `Ctrl-V`, `Ctrl+v`, `^v`, `⌃V`, `<CR>`, `Return`, `esc`), or
 * undefined when the text is not one.
 */
export function keyCap(text: string): string | undefined {
  const bracket = /^<([^<>]+)>$/u.exec(text);
  const inner = bracket?.[1] ?? text;
  const bracketed = bracket !== null;
  if (inner.length === 0) return undefined;
  // `^v`: the terminal's caret notation for Control.
  const caret = /^\^(\S)$/u.exec(inner);
  if (caret && !bracketed)
    return written(new Set(["⌃"]), caret[1].toUpperCase());
  // Symbols run together (`⌃⇧V`), or names joined by `-` or `+`.
  const mods = new Set<string>();
  let rest = inner;
  for (;;) {
    const symbol = /^([⌃⌥⇧⌘])(.+)$/u.exec(rest);
    if (symbol) {
      mods.add(symbol[1]);
      rest = symbol[2];
      continue;
    }
    const named = /^([A-Za-z]+)[-+](.+)$/u.exec(rest);
    const name = named?.[1].toLowerCase();
    const modifier = name !== undefined ? MODIFIER[name] : undefined;
    if (
      named &&
      name !== undefined &&
      modifier !== undefined &&
      (bracketed || BARE_MODIFIERS.has(name))
    ) {
      mods.add(modifier);
      rest = named[2];
      continue;
    }
    break;
  }
  const key = baseKey(rest, mods.size > 0, bracketed);
  if (key === undefined) return undefined;
  return written(mods, key);
}

/** A Vim key sequence (`<C-w>v`, `gg`, `<Leader>f`) as its keys. */
function vimSequence(text: string): string[] | undefined {
  const keys: string[] = [];
  let plain = "";
  const re = /<[^<>\s]+>/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const key = keyCap(m[0]);
    if (key === undefined) return undefined;
    plain += text.slice(last, m.index);
    if (plain !== "") keys.push(plain);
    plain = "";
    keys.push(key);
    last = m.index + m[0].length;
  }
  if (keys.length === 0) return undefined;
  plain += text.slice(last);
  if (plain !== "") keys.push(plain);
  return keys;
}

/**
 * Keys as a hint shows them (`formatKeys("<C-j> <C-k>")` is `⌃J ⌃K`,
 * `formatKeys("Ctrl-X")` is `⌃X`, `formatKeys("j/k")` is `j/k`): each
 * word that is a key in another notation, in this one; anything else as
 * it was.
 */
export function formatKeys(text: string): string {
  return text
    .split(/(\s+|\/)/u)
    .map((word) => {
      if (word === "" || /^\s+$/u.test(word) || word === "/") return word;
      const one = keyCap(word);
      if (one !== undefined) return one;
      return vimSequence(word)?.join(" ") ?? word;
    })
    .join("");
}
