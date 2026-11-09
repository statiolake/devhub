/**
 * Decorations in a proportional face: text Neovim draws on cells that is
 * not the buffer's — virtual text at the end of a line, right-aligned or
 * inline (inlay hints), virtual lines, a closed fold's text. Lua says where
 * each is (`main/editor/neovimDecor.ts`); this finds it in a grid row, as
 * the cells it holds now, and says where its words go. Pure, so tested
 * without a page; `painter.ts` draws.
 *
 * Neovim lays these out in cells and keeps everything after them where the
 * cells say, so a decoration set in a proportional face is drawn inside the
 * cells Neovim gave it and never past them: the buffer text after an inlay
 * hint, the cursor, a click and a selection stay where they were. Its
 * ground stays the cells' (the highlight's box, as Neovim says); only its
 * words change face.
 */

import { glyphKind } from "./glyphs";

export type DecorKind = "eol" | "right" | "inline" | "lines" | "fold";

/** Where Lua says a decoration is: a row and column of its window's grid. */
export interface DecorSpan {
  readonly row: number;
  readonly col: number;
  readonly text: string;
  readonly kind: DecorKind;
  /**
   * A closed fold (`kind: "fold"`; `text` is all of its line from the
   * marker): its level, and — with Neovim's own `foldtext` — how many lines
   * it holds and its words without the `+--  N lines:` lead and the fold
   * marker. A person's `foldtext` has neither: its text is their words.
   */
  readonly level?: number;
  readonly count?: number;
  readonly words?: string;
}

/** Decorations by window, as the last `decor` event said. */
export type Decor = ReadonlyMap<number, readonly DecorSpan[]>;

const KINDS = new Set<string>(["eol", "right", "inline", "lines", "fold"]);

/** The `decor` event's payload (`{ wins = { [win] = spans } }`), checked. */
export function decorOf(payload: unknown): Decor {
  const out = new Map<number, DecorSpan[]>();
  const wins = (payload as { wins?: unknown } | undefined)?.wins;
  if (wins === null || typeof wins !== "object") return out;
  for (const [key, list] of Object.entries(wins)) {
    const win = Number(key);
    if (!Number.isInteger(win) || !Array.isArray(list)) continue;
    const spans: DecorSpan[] = [];
    for (const item of list) {
      const s = item as Record<string, unknown>;
      if (
        typeof s["row"] === "number" &&
        typeof s["col"] === "number" &&
        typeof s["text"] === "string" &&
        typeof s["kind"] === "string" &&
        KINDS.has(s["kind"])
      ) {
        spans.push({
          row: s["row"],
          col: s["col"],
          text: s["text"],
          kind: s["kind"] as DecorKind,
          ...(typeof s["level"] === "number" ? { level: s["level"] } : {}),
          ...(typeof s["count"] === "number" ? { count: s["count"] } : {}),
          ...(typeof s["words"] === "string" ? { words: s["words"] } : {}),
        });
      }
    }
    out.set(win, spans);
  }
  return out;
}

/** A row's cells: the text of each (`""` for a wide character's right half). */
export interface RowCells {
  readonly chars: readonly string[];
  /** Where the row starts in `chars`. */
  readonly base: number;
  readonly width: number;
}

/**
 * Whether the row holds exactly `text` from `col`: the cell after the
 * last one it takes, or `undefined`. A wide character takes its cell and
 * the empty one after it. With `cut`, text that runs into the row's end
 * (Neovim cuts what does not fit) matches as far as it goes.
 */
export function matchAt(
  row: RowCells,
  col: number,
  text: string,
  cut = false,
): number | undefined {
  if (col < 0 || col >= row.width || text.length === 0) return undefined;
  let at = 0;
  let cell = col;
  while (at < text.length) {
    if (cell >= row.width) return cut && cell > col ? cell : undefined;
    const c = row.chars[row.base + cell] ?? " ";
    if (c === "" || !text.startsWith(c, at)) return undefined;
    at += c.length;
    cell += row.chars[row.base + cell + 1] === "" ? 2 : 1;
  }
  return cell;
}

/** A decoration found in a row: its cells, and which side its slack goes. */
export interface DecorPlace {
  readonly start: number;
  readonly end: number;
  readonly align: "left" | "right";
}

/**
 * How far a decoration is looked for from where Lua placed it: Lua speaks
 * after the redraw it measured, and the next one (a character typed before
 * an inlay hint or at the end of a line with a diagnostic) moves it by a
 * few cells. Looked for at most this far, nearest first, so a decoration
 * a keystroke behind keeps its face rather than flicking to cells.
 */
const DRIFT = 4;

/**
 * Where each of a row's decorations is, among `spans` (those Lua put on
 * this row): found where the row holds exactly its text now, or left out.
 */
export function placeDecor(
  row: RowCells,
  spans: readonly DecorSpan[],
): DecorPlace[] {
  const out: DecorPlace[] = [];
  for (const span of spans) {
    const found = findSpan(row, span);
    if (found === undefined) continue;
    const [start, end] = found;
    if (out.some((p) => start < p.end && p.start < end)) continue;
    out.push({ start, end, align: alignOf(span) });
  }
  return out;
}

function findSpan(
  row: RowCells,
  span: DecorSpan,
): [number, number] | undefined {
  const cut = span.kind !== "inline";
  switch (span.kind) {
    case "right": {
      // Right-aligned text ends at the window's edge.
      for (
        let col = row.width - 1;
        col >= Math.max(0, span.col - DRIFT);
        col -= 1
      ) {
        const end = matchAt(row, col, span.text);
        if (end === row.width) return [col, end];
      }
      return undefined;
    }
    case "eol": {
      // After the line's text, which ends at `col` (give or take a redraw).
      for (let col = Math.max(0, span.col - DRIFT); col < row.width; col += 1) {
        const end = matchAt(row, col, span.text, cut);
        if (end !== undefined) return [col, end];
      }
      return undefined;
    }
    default: {
      for (let d = 0; d <= DRIFT; d += 1) {
        for (const col of d === 0 ? [span.col] : [span.col + d, span.col - d]) {
          const end = matchAt(row, col, span.text, cut);
          if (end !== undefined) return [col, end];
        }
        // Folds and virtual lines are where Lua says, exactly.
        if (span.kind !== "inline") break;
      }
      return undefined;
    }
  }
}

/**
 * Which side of its cells a decoration's words keep to; the slack is on
 * the other. Right-aligned text keeps to the window's edge, as Neovim
 * aligns it. An inline hint that ends with `:` names what follows it (a
 * parameter's name before its argument): it keeps to that code, the slack
 * before it. Any other inline hint annotates what precedes it (`: i32`
 * after a binding, `-> T` after a call): it keeps to that, the slack after
 * — where the reading goes on. Everything else starts where Neovim starts
 * it.
 */
function alignOf(span: DecorSpan): "left" | "right" {
  if (span.kind === "right") return "right";
  if (span.kind === "inline" && span.text.trimEnd().endsWith(":"))
    return "right";
  return "left";
}

/**
 * The cells of a decoration whose words are set in the proportional face:
 * from its first cell that is neither blank nor a drawing (box drawing,
 * blocks, Powerline — they join neighbours and mark columns, as a virtual
 * line's `└──` under the column it points at) to its last non-blank one.
 * Blanks at either end are the decoration's padding and stay cells.
 * `undefined` when nothing is left to set.
 */
export function wordsOf(
  row: RowCells,
  place: { readonly start: number; readonly end: number },
): { start: number; end: number } | undefined {
  let start = place.start;
  for (; start < place.end; start += 1) {
    const c = row.chars[row.base + start] ?? " ";
    if (c === "" || c === " ") continue;
    const kind = glyphKind(c);
    if (kind === "box" || kind === "block" || kind === "powerline") continue;
    break;
  }
  let end = place.end;
  while (end > start) {
    const c = row.chars[row.base + end - 1] ?? " ";
    if (c !== " " && c !== "") break;
    end -= 1;
  }
  // A wide character's right half belongs with it.
  if (
    end > start &&
    row.chars[row.base + end - 1] !== "" &&
    row.chars[row.base + end] === ""
  )
    end += 1;
  return end > start ? { start, end } : undefined;
}

/**
 * A closed fold on a row (mock 3): where its line starts (the marker's
 * first cell) and what is drawn there, when the row holds its text there
 * now. Everything from `start` to the window's edge is the fold's: the
 * marker, the words and the fill.
 */
export interface FoldLine {
  readonly start: number;
  /** The chevron's cell: a level's two cells in from the marker's. */
  readonly chevron: number;
  readonly words: string;
  readonly count: number | undefined;
}

export function foldLineOf(
  row: RowCells,
  spans: readonly DecorSpan[],
): FoldLine | undefined {
  const span = spans.find((s) => s.kind === "fold");
  if (!span || matchAt(row, span.col, span.text, true) === undefined)
    return undefined;
  const level = Math.max(1, span.level ?? 1);
  const chevron = Math.min(row.width - 1, span.col + (level - 1) * 2);
  return {
    start: span.col,
    chevron,
    words: (span.words ?? span.text).trim(),
    count: span.count,
  };
}
