/**
 * Two generic pieces of the pointer, with no DOM (docs/neovim-editor.md,
 * "Cell overlays" and "Modifiers and the pointer"):
 *
 * - **Cell overlays** (`gui.overlay`): Lua names a window's cells and a
 *   highlight, and the page draws that highlight over them itself — the
 *   same highlight overrides as Visual's band in a drag, so nothing goes in
 *   the buffer and Neovim redraws nothing. Optionally a pointer shape over
 *   the cells, and `held`: drawn only while the modifier keys held when it
 *   came stay held, so it goes in the frame they go up (Neovim never hears
 *   a key go up). DevHub draws what Lua says and knows nothing of why
 *   (devhub.nvim's go to definition draws its link with it).
 * - **Modifier moves**: with Ctrl, Alt or Cmd held the pointer's moves go to
 *   Neovim as `nvim_input_mouse("move", …, modifiers)` — `<A-MouseMove>`
 *   and the like, for mappings — and so does a change of the modifiers with
 *   the pointer still (one move with the new set: a plain `<MouseMove>` when
 *   they go up). Plain moves are not sent at all. Neovim drops a move to the
 *   cell of its last mouse event, whatever the modifiers (`check_multiclick`
 *   in `os/input.c`), so a change at that cell is fed as the key itself
 *   (`MOUSE_MOVE_FEED_LUA`), at the mouse position Neovim already has.
 */

import type { HlAttr } from "./redraw";

/** A row of cells in a window's grid: `col0`..`col1`, inclusive. */
export interface OverlaySpan {
  readonly row: number;
  readonly col0: number;
  readonly col1: number;
}

/** What an overlay draws: a highlight's own attributes over each cell's. */
export interface OverlayStyle {
  readonly foreground?: number;
  readonly background?: number;
  readonly special?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly reverse?: boolean;
  readonly strikethrough?: boolean;
  readonly underline?: boolean;
  readonly undercurl?: boolean;
  readonly underdouble?: boolean;
  readonly underdotted?: boolean;
  readonly underdashed?: boolean;
}

/** `gui.overlay{ id, win, spans, hl, pointer, held }`, as the page reads it. */
export interface Overlay {
  readonly id: string;
  readonly win: number;
  readonly spans: readonly OverlaySpan[];
  readonly style: OverlayStyle;
  /** A CSS cursor over its cells (`"pointer"`: the hand). */
  readonly pointer?: string;
  readonly held: boolean;
}

/** An overlay set, or one taken away (`{ id }` alone). */
export type OverlayEvent =
  | { readonly kind: "set"; readonly overlay: Overlay }
  | { readonly kind: "clear"; readonly id: string };

const STYLE_KEYS: readonly [string, keyof OverlayStyle][] = [
  ["fg", "foreground"],
  ["bg", "background"],
  ["sp", "special"],
];
const FLAG_KEYS: readonly (keyof OverlayStyle)[] = [
  "bold",
  "italic",
  "reverse",
  "strikethrough",
  "underline",
  "undercurl",
  "underdouble",
  "underdotted",
  "underdashed",
];
const UNDERLINES = [
  "underline",
  "undercurl",
  "underdouble",
  "underdotted",
  "underdashed",
] as const;

function colour(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffff
    ? value
    : undefined;
}

/** `hl` as Lua sends it (`nvim_get_hl`'s keys: fg, bg, sp, underline, …). */
export function overlayStyleOf(value: unknown): OverlayStyle {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const v = value as Record<string, unknown>;
  const out: Record<string, number | boolean> = {};
  for (const [lua, key] of STYLE_KEYS) {
    const c = colour(v[lua]);
    if (c !== undefined) out[key] = c;
  }
  for (const key of FLAG_KEYS) if (v[key] === true) out[key] = true;
  return out as OverlayStyle;
}

function spansOf(value: unknown): OverlaySpan[] {
  const spans: OverlaySpan[] = [];
  for (const s of Array.isArray(value) ? value : []) {
    if (typeof s !== "object" || s === null) continue;
    const r = s as Record<string, unknown>;
    const row = r["row"];
    const col0 = r["col0"];
    const col1 = r["col1"];
    if (
      typeof row === "number" &&
      typeof col0 === "number" &&
      typeof col1 === "number" &&
      col1 >= col0
    )
      spans.push({ row, col0, col1 });
  }
  return spans;
}

/** The `overlay` GUI event's payload; anything odd is undefined. */
export function overlayEventOf(value: unknown): OverlayEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  const id = v["id"];
  if (typeof id !== "string" || id === "") return undefined;
  const win = v["win"];
  const spans = spansOf(v["spans"]);
  if (typeof win !== "number" || spans.length === 0)
    return { kind: "clear", id };
  const pointer = v["pointer"];
  return {
    kind: "set",
    overlay: {
      id,
      win,
      spans,
      style: overlayStyleOf(v["hl"]),
      ...(typeof pointer === "string" && /^[a-z-]+$/.test(pointer)
        ? { pointer }
        : {}),
      held: v["held"] === true,
    },
  };
}

/** Whether two overlays draw the same thing. */
export function sameOverlay(a: Overlay, b: Overlay): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A cell's highlight under an overlay: its own, with the overlay's
 * attributes over it. Its own reverse goes unless the overlay says (a
 * reversed cell would put the overlay's ink in the background); an
 * underline style given replaces the cell's, in `sp`, else in the
 * overlay's `fg`, as Neovim draws a highlight's own underline.
 */
export function overlayAttr(attr: HlAttr, style: OverlayStyle): HlAttr {
  const out: Record<string, unknown> = { ...attr, reverse: false };
  const underlined = UNDERLINES.some((k) => style[k] === true);
  if (underlined) for (const k of UNDERLINES) out[k] = false;
  for (const [key, value] of Object.entries(style)) out[key] = value;
  if (
    underlined &&
    style.special === undefined &&
    style.foreground !== undefined
  )
    out["special"] = style.foreground;
  return out as HlAttr;
}

/** The grid's cells (row-major indices) the spans cover, clipped. */
export function spanCells(
  width: number,
  height: number,
  spans: readonly OverlaySpan[],
): number[] {
  const out: number[] = [];
  for (const { row, col0, col1 } of spans) {
    if (row < 0 || row >= height) continue;
    for (let col = Math.max(0, col0); col <= col1 && col < width; col += 1)
      out.push(row * width + col);
  }
  return out;
}

/** Whether `row`, `col` is one of the spans' cells. */
export function inSpans(
  spans: readonly OverlaySpan[],
  row: number,
  col: number,
): boolean {
  return spans.some((s) => s.row === row && col >= s.col0 && col <= s.col1);
}

/**
 * Whether moves with these modifiers (`mouseModifiers`' "CSAD") go to
 * Neovim: Ctrl, Alt or Cmd among them. Shift alone is typing a capital.
 */
export function forwardsMoves(modifiers: string): boolean {
  return /[CAD]/.test(modifiers);
}

/** The key Neovim would make of a move with these modifiers. */
export function mouseMoveKey(modifiers: string): string {
  return modifiers === ""
    ? "<MouseMove>"
    : `<${[...modifiers].join("-")}-MouseMove>`;
}

/**
 * A move Neovim would drop (the cell of its last mouse event), fed as the
 * key: mappings and `vim.on_key` see it as the move it is, at the mouse
 * position Neovim has, which is that cell.
 */
export const MOUSE_MOVE_FEED_LUA =
  "vim.api.nvim_feedkeys(vim.keycode(...), 'mt', false)";

/** A grid cell, as `nvim_input_mouse` takes it. */
export interface MouseCell {
  readonly grid: number;
  readonly row: number;
  readonly col: number;
}

/** What a move becomes: nothing, a mouse event, or the key fed. */
export type MoveSend =
  | undefined
  | {
      readonly via: "mouse";
      readonly at: MouseCell;
      readonly modifiers: string;
    }
  | { readonly via: "feed"; readonly key: string; readonly modifiers: string };

/**
 * The page's side of Neovim's mouse state, for modifier moves: the cell of
 * the last mouse event sent that Neovim compares a move with (a press, a
 * drag, a release or a move; the wheel does not count) and the modifiers
 * of the last move it was sent.
 */
export class ModifierMoves {
  private last: MouseCell | undefined;
  private sent = "";

  /** A press, drag or release went to Neovim at `at`. */
  mouse(at: MouseCell): void {
    this.last = at;
  }

  /** The modifiers Neovim last had a move with. */
  get modifiers(): string {
    return this.sent;
  }

  /**
   * The pointer at `at` with `modifiers` held (a move, or a modifier key
   * with the pointer still): what to send, if anything. With `again`, a
   * move already sent is sent once more.
   */
  move(at: MouseCell, modifiers: string, again = false): MoveSend {
    if (!forwardsMoves(modifiers) && !forwardsMoves(this.sent))
      return undefined;
    const still =
      this.last !== undefined &&
      this.last.grid === at.grid &&
      this.last.row === at.row &&
      this.last.col === at.col;
    // `again`: the same move said once more (the text moved under a still
    // pointer), with modifiers that send moves.
    if (
      still &&
      modifiers === this.sent &&
      !(again && forwardsMoves(modifiers))
    )
      return undefined;
    this.sent = modifiers;
    this.last = at;
    return still
      ? { via: "feed", key: mouseMoveKey(modifiers), modifiers }
      : { via: "mouse", at, modifiers };
  }
}
