/**
 * DevHub's own selection in a terminal pane (`docs/terminal-mode.md`, "The
 * mouse"): a drag, a double-click's word, a triple-click's line, on the
 * cells the page draws — the pane's rows, or its copy mode's — never a DOM
 * selection. Where the mouse goes instead (the pane's program, tmux's own
 * bindings and copy mode) is `routeMouse`.
 *
 * Pure: the surface (`ControlTerminalSurface.tsx`) holds the selection,
 * draws its spans (`paneGrids.ts`) and copies its text.
 */

import type { CopySpan } from "../../../ipc/terminalControl";

/** A cell of a pane, from its top left. */
export interface Cell {
  readonly x: number;
  readonly y: number;
}

/** What a gesture selects by: a drag's cells, a double-click's words, a triple-click's lines. */
export type Unit = "cell" | "word" | "line";

export interface Selection {
  readonly pane: number;
  /** Where it began: the end a shift-click or a drag does not move. */
  readonly anchor: Cell;
  /** Where the pointer is. */
  readonly head: Cell;
  readonly unit: Unit;
}

/** The rows a selection is over: a pane's grid as the page draws it. */
export interface Rows {
  readonly width: number;
  readonly height: number;
  /** A cell's text: `""` the right half of a wide character. */
  cell(x: number, y: number): string;
  /** Row `y`'s text goes on in the next row (a soft wrap). */
  wrapped(y: number): boolean;
}

/** Characters that end a word, besides blanks: Ghostty's `selection-word-chars`. */
const BOUNDARY = new Set([..."\t'\"│`|:;,()[]{}<>$"]);

type Kind = "blank" | "boundary" | "word";

function kindOf(text: string): Kind {
  if (text === " " || text === "" || text === "\t") return "blank";
  return BOUNDARY.has(text) ? "boundary" : "word";
}

const before = (a: Cell, b: Cell) => a.y < b.y || (a.y === b.y && a.x < b.x);

/** The cell a wide character's right half belongs to: its left half. */
function head(rows: Rows, at: Cell): Cell {
  return at.x > 0 &&
    rows.cell(at.x, at.y) === "" &&
    rows.cell(at.x - 1, at.y) !== ""
    ? { x: at.x - 1, y: at.y }
    : at;
}

/** The last cell of the character at `at`: a wide character's right half. */
function tail(rows: Rows, at: Cell): Cell {
  return at.x + 1 < rows.width &&
    rows.cell(at.x, at.y) !== "" &&
    rows.cell(at.x + 1, at.y) === ""
    ? { x: at.x + 1, y: at.y }
    : at;
}

/** The cell after `at` in reading order across a soft wrap, if any. */
function next(rows: Rows, at: Cell): Cell | undefined {
  if (at.x + 1 < rows.width) return { x: at.x + 1, y: at.y };
  return at.y + 1 < rows.height && rows.wrapped(at.y)
    ? { x: 0, y: at.y + 1 }
    : undefined;
}

function previous(rows: Rows, at: Cell): Cell | undefined {
  if (at.x > 0) return { x: at.x - 1, y: at.y };
  return at.y > 0 && rows.wrapped(at.y - 1)
    ? { x: rows.width - 1, y: at.y - 1 }
    : undefined;
}

/**
 * The word at a cell, both ends inclusive: a run of word characters, of
 * blanks, or one boundary character (`(`, `|`, `:`…), as Ghostty takes
 * it. A wide character is one character of its run; a word goes on across
 * a soft wrap.
 */
export function wordAt(rows: Rows, at: Cell): { start: Cell; end: Cell } {
  const start0 = head(rows, at);
  const kind = kindOf(rows.cell(start0.x, start0.y));
  if (kind === "boundary") return { start: start0, end: tail(rows, start0) };
  const same = (c: Cell) => {
    const text = rows.cell(c.x, c.y);
    // A right half goes with its left half.
    if (text === "" && c.x > 0 && rows.cell(c.x - 1, c.y) !== "")
      return kindOf(rows.cell(c.x - 1, c.y)) === kind;
    return kindOf(text) === kind;
  };
  let start = start0;
  for (
    let p = previous(rows, start);
    p !== undefined && same(p);
    p = previous(rows, p)
  )
    start = p;
  let end = tail(rows, start0);
  for (let n = next(rows, end); n !== undefined && same(n); n = next(rows, n))
    end = n;
  return { start: head(rows, start), end: tail(rows, end) };
}

/** The line at row `y`: its rows from the first to the last of a soft wrap. */
export function lineAt(rows: Rows, y: number): { start: Cell; end: Cell } {
  let top = y;
  while (top > 0 && rows.wrapped(top - 1)) top--;
  let bottom = y;
  while (bottom + 1 < rows.height && rows.wrapped(bottom)) bottom++;
  return { start: { x: 0, y: top }, end: { x: rows.width - 1, y: bottom } };
}

/**
 * Where a selection starts and ends, both inclusive, in reading order: a
 * drag's cells (a wide character whole at either end), or the words or
 * lines its ends are in.
 */
export function selectionRange(
  selection: Selection,
  rows: Rows,
): { start: Cell; end: Cell } {
  const clamp = (c: Cell): Cell => ({
    x: Math.max(0, Math.min(rows.width - 1, c.x)),
    y: Math.max(0, Math.min(rows.height - 1, c.y)),
  });
  let a = clamp(selection.anchor);
  let b = clamp(selection.head);
  if (before(b, a)) [a, b] = [b, a];
  switch (selection.unit) {
    case "cell":
      return { start: head(rows, a), end: tail(rows, b) };
    case "word":
      return { start: wordAt(rows, a).start, end: wordAt(rows, b).end };
    case "line":
      return { start: lineAt(rows, a.y).start, end: lineAt(rows, b.y).end };
  }
}

/** The selection as spans of its rows, to draw in the selection colour. */
export function selectionSpans(selection: Selection, rows: Rows): CopySpan[] {
  const { start, end } = selectionRange(selection, rows);
  const spans: CopySpan[] = [];
  for (let y = start.y; y <= end.y; y++) {
    const x0 = y === start.y ? start.x : 0;
    const x1 = y === end.y ? end.x : rows.width - 1;
    if (x1 >= x0) spans.push({ y, x0, x1 });
  }
  return spans;
}

/**
 * The selection's text, as a terminal copies it: each wide character once,
 * a soft-wrapped row joined to the next, every other row its own line with
 * its trailing blanks dropped.
 */
export function selectedText(selection: Selection, rows: Rows): string {
  const { start, end } = selectionRange(selection, rows);
  let text = "";
  for (let y = start.y; y <= end.y; y++) {
    const x0 = y === start.y ? start.x : 0;
    const x1 = y === end.y ? end.x : rows.width - 1;
    let line = "";
    for (let x = x0; x <= x1; x++) line += rows.cell(x, y);
    const joined = y < end.y && rows.wrapped(y);
    text += joined ? line : line.replace(/[ \t]+$/, "");
    if (y < end.y && !joined) text += "\n";
  }
  return text;
}

/** A shift-click: the selection's far end from the click stays, the click is its new end. */
export function extendTo(selection: Selection, at: Cell): Selection {
  // The anchor that stays is the end farther from the click, as Ghostty
  // and iTerm extend.
  const { anchor, head: h } = selection;
  const [first, last] = before(h, anchor) ? [h, anchor] : [anchor, h];
  const keep = before(at, first) ? last : before(last, at) ? first : anchor;
  return { ...selection, anchor: keep, head: at };
}

/** The rows of a pane's grid as `Rows`: row-major cells, and the wrapped rows. */
export function gridRows(
  grid: {
    readonly width: number;
    readonly height: number;
    readonly chars: readonly string[];
  },
  wrapped: ReadonlySet<number> | undefined,
): Rows {
  return {
    width: grid.width,
    height: grid.height,
    cell: (x, y) => grid.chars[y * grid.width + x] ?? " ",
    wrapped: (y) => wrapped?.has(y) ?? false,
  };
}

/** The mouse's left-button gestures, as tmux names their bindings. */
export const MOUSE_KEYS = {
  down: "MouseDown1Pane",
  drag: "MouseDrag1Pane",
  end: "MouseDragEnd1Pane",
  double: "DoubleClick1Pane",
  triple: "TripleClick1Pane",
} as const;
export type Gesture = keyof typeof MOUSE_KEYS;

/** What `routeMouse` decides by. */
export interface MouseFacts {
  /** Over a Neovim DevHub draws in the pane: its own mouse. */
  readonly neovim: boolean;
  /** Shift or Option held: DevHub's selection whatever else would take it. */
  readonly forced: boolean;
  /** The pane's program asked for the mouse (SGR reports). */
  readonly reports: boolean;
  readonly copyMode: boolean;
  /**
   * tmux's `mouse` option and which of the gestures' keys are bound, in
   * the root table and in copy mode's (`mode-keys`); absent until read.
   */
  readonly tmux:
    | {
        readonly on: boolean;
        readonly root: readonly string[];
        readonly copy: readonly string[];
      }
    | undefined;
}

export type MouseRoute = "neovim" | "program" | "tmux" | "devhub";

/**
 * Who takes a left-button gesture over a pane, in order: a Neovim drawn
 * there takes its own; Shift or Option forces DevHub's selection (as in
 * iTerm and Ghostty); a program that asked for the mouse (vim, `less
 * --mouse`, htop) gets it; with tmux's `mouse` on, a gesture tmux binds
 * in the table it would look in (copy mode's while the pane is in it) is
 * tmux's, as a normal client's would be; anything else is DevHub's
 * selection.
 */
export function routeMouse(gesture: Gesture, facts: MouseFacts): MouseRoute {
  if (facts.neovim) return "neovim";
  if (facts.forced) return "devhub";
  if (facts.reports) return "program";
  const tmux = facts.tmux;
  if (tmux?.on === true) {
    const bound = facts.copyMode ? tmux.copy : tmux.root;
    if (bound.includes(MOUSE_KEYS[gesture])) return "tmux";
  }
  return "devhub";
}
