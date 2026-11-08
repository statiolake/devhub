/**
 * Text input for the Neovim page: the hidden textarea's events, as what to
 * show and what to send.
 *
 * Every character the person types — plain ASCII, a dead key's `é`, a
 * Japanese IME's `日本語` — arrives as text on a hidden, focused textarea
 * (keys with Ctrl, Meta or Cmd are `keys.ts`'s). While an IME composes, its
 * preedit is drawn inline at the cursor cell, underlined, and nothing reaches
 * Neovim; the committed text is sent once, when the composition ends. That
 * is the whole rule, and it is kept here as a pure machine so "no double
 * input" is a test (`ime.test.ts`) rather than a hope: Chromium sends an
 * `input` event *and* a `compositionend` for one commit, and only the second
 * is acted on.
 */

export interface ImeState {
  readonly composing: boolean;
  /** The preedit on screen, `""` when there is none. */
  readonly preedit: string;
}

export type ImeEvent =
  | { readonly type: "compositionstart" }
  | { readonly type: "compositionupdate"; readonly data: string }
  | { readonly type: "compositionend"; readonly data: string }
  | {
      readonly type: "input";
      readonly inputType: string;
      readonly data: string | null;
      readonly isComposing: boolean;
    }
  /** The page lost focus or was hidden: a composition in flight is dropped. */
  | { readonly type: "reset" };

export interface ImeStep {
  readonly state: ImeState;
  /** Text to hand Neovim (`nvim_input`, `<` escaped by the caller). */
  readonly commit?: string;
  /** Whether the textarea should be emptied. */
  readonly clear: boolean;
}

export const IDLE: ImeState = { composing: false, preedit: "" };

export function imeStep(state: ImeState, event: ImeEvent): ImeStep {
  switch (event.type) {
    case "compositionstart":
      return { state: { composing: true, preedit: "" }, clear: false };
    case "compositionupdate":
      return { state: { composing: true, preedit: event.data }, clear: false };
    case "compositionend":
      return event.data.length > 0
        ? { state: IDLE, commit: event.data, clear: true }
        : { state: IDLE, clear: true };
    case "input": {
      // The composition's own input events: its compositionend commits.
      if (
        state.composing ||
        event.isComposing ||
        event.inputType === "insertCompositionText" ||
        event.inputType === "insertFromComposition"
      ) {
        return { state, clear: false };
      }
      if (
        (event.inputType === "insertText" ||
          event.inputType === "insertReplacementText" ||
          event.inputType === "insertFromPaste") &&
        event.data !== null &&
        event.data.length > 0
      ) {
        return { state: IDLE, commit: event.data, clear: true };
      }
      // Deletions and the rest of the textarea's own editing mean
      // nothing to Neovim: the keydown already sent `<BS>`.
      return { state: IDLE, clear: true };
    }
    case "reset":
      return { state: IDLE, clear: true };
  }
}

/**
 * East Asian Wide and Fullwidth (Unicode's EastAsianWidth W and F, as
 * Neovim's default `ambiwidth=single` takes them): the ranges that take two
 * cells. Combining marks take none.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const COMBINING: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x3099, 0x309a],
  [0xfe00, 0xfe0f],
];

const within = (
  ranges: readonly (readonly [number, number])[],
  code: number,
): boolean => ranges.some(([a, b]) => code >= a && code <= b);

/** The cells a character takes in the grid: 2 wide, 0 combining, else 1. */
export function cellsOf(ch: string): 0 | 1 | 2 {
  const code = ch.codePointAt(0) ?? 0;
  if (within(COMBINING, code)) return 0;
  return within(WIDE, code) ? 2 : 1;
}

export interface PreeditCell {
  readonly ch: string;
  /** Its first cell, from the cursor's. */
  readonly col: number;
  readonly cells: number;
}

/**
 * The preedit as the grid will hold it once committed: each character on
 * its cells — a wide one (かな, 漢字) on two — so what is composed sits
 * exactly where the committed text will. A combining mark joins the
 * character before it.
 */
export function preeditLayout(text: string): {
  readonly chars: readonly PreeditCell[];
  readonly cells: number;
} {
  const chars: { ch: string; col: number; cells: number }[] = [];
  let col = 0;
  for (const ch of text) {
    const cells = cellsOf(ch);
    const last = chars.at(-1);
    if (cells === 0 && last) {
      last.ch += ch;
      continue;
    }
    chars.push({ ch, col, cells: Math.max(1, cells) });
    col += Math.max(1, cells);
  }
  return { chars, cells: col };
}
