/**
 * Scrollbar marks, as VS Code's overview ruler and Zed's scrollbar
 * markers: where in the buffer its diagnostics are, the search's matches
 * (while `hlsearch` shows them), the lines git sees changed (gitsigns'
 * hunks) and the cursor — each a short tick at its line's place along the
 * window's scrollbar, in the colorscheme's colour for it. Lua sends the
 * lines (`devhub_gui`'s `M._marks`, a `marks` event); the cursor's line is
 * `win_viewport`'s. Lanes as VS Code's: git on the left, the search in the
 * middle, diagnostics on the right; the cursor across. A click on one
 * goes to its line (`scrollbar.ts`).
 */

import { cssColor } from "./painter";

export interface WindowMarks {
  /** Lines with diagnostics, with the worst severity (1 error … 4 hint). */
  readonly diag: readonly (readonly [number, number])[];
  /** Hunks: first line, lines, and 1 added, 2 changed, 3 removed. */
  readonly git: readonly (readonly [number, number, number])[];
  /** Lines with a match of the search. */
  readonly search: readonly number[];
}

export interface ScrollMarks {
  readonly wins: ReadonlyMap<number, WindowMarks>;
  /** The groups' colours, as Neovim resolves them (`fg`, `bg`). */
  readonly colors: ReadonlyMap<string, { fg?: number; bg?: number }>;
}

export const NO_MARKS: ScrollMarks = { wins: new Map(), colors: new Map() };

function rec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ints(value: unknown, size: number): number[][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const list: unknown = size === 1 ? [entry] : entry;
    if (!Array.isArray(list) || list.length < size) return [];
    const nums = list.slice(0, size);
    return nums.every((n) => typeof n === "number" && Number.isFinite(n))
      ? [nums as number[]]
      : [];
  });
}

/** A `marks` event, read; anything of the wrong shape is left out. */
export function parseMarks(payload: unknown): ScrollMarks {
  const p = rec(payload);
  if (!p) return NO_MARKS;
  const wins = new Map<number, WindowMarks>();
  for (const [key, value] of Object.entries(rec(p["wins"]) ?? {})) {
    const win = Number(key);
    const w = rec(value);
    if (!Number.isInteger(win) || !w) continue;
    wins.set(win, {
      diag: ints(w["diag"], 2) as [number, number][],
      git: ints(w["git"], 3) as [number, number, number][],
      search: ints(w["search"], 1).map(([n]) => n ?? 0),
    });
  }
  const colors = new Map<string, { fg?: number; bg?: number }>();
  for (const [name, value] of Object.entries(rec(p["colors"]) ?? {})) {
    const c = rec(value);
    if (!c) continue;
    const fg = typeof c["fg"] === "number" ? c["fg"] : undefined;
    const bg = typeof c["bg"] === "number" ? c["bg"] : undefined;
    colors.set(name, {
      ...(fg !== undefined ? { fg } : {}),
      ...(bg !== undefined ? { bg } : {}),
    });
  }
  return { wins, colors };
}

/** A tick on the scrollbar, in its pixels. */
export interface MarkRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  /** What it marks, and the line (1-based) a click on it goes to. */
  readonly kind?: "diag" | "search" | "git" | "cursor";
  readonly line?: number;
}

const SEVERITY = [
  "DiagnosticError",
  "DiagnosticWarn",
  "DiagnosticInfo",
  "DiagnosticHint",
];
const GIT = [
  ["GitSignsAdd", "Added"],
  ["GitSignsChange", "Changed"],
  ["GitSignsDelete", "Removed"],
];

/**
 * The ticks for one window's scrollbar, `width` by `height` pixels, of a
 * buffer of `lineCount` lines with the cursor on `cursor` (1-based): each
 * at least `min` pixels tall; the worst diagnostic drawn last (on top).
 */
export function markRects(
  marks: WindowMarks | undefined,
  colors: ScrollMarks["colors"],
  lineCount: number,
  cursor: number,
  width: number,
  height: number,
  cursorColor: string,
  min = 2,
): MarkRect[] {
  if (lineCount <= 0 || height <= 0) return [];
  const y = (line: number) => ((line - 1) / lineCount) * height;
  const span = (lines: number) => Math.max(min, (lines / lineCount) * height);
  const fg = (names: readonly string[]) => {
    for (const name of names) {
      const c = colors.get(name)?.fg;
      if (c !== undefined) return cssColor(c);
    }
    return undefined;
  };
  const out: MarkRect[] = [];
  const lane = width / 4;
  for (const [line, count, kind] of marks?.git ?? []) {
    const color = fg(GIT[kind - 1] ?? []);
    if (color === undefined) continue;
    out.push({
      x: 0,
      y: y(line),
      w: lane,
      h: span(count),
      color,
      kind: "git",
      line,
    });
  }
  const search = colors.get("Search");
  const searchColor =
    search?.bg !== undefined
      ? cssColor(search.bg)
      : search?.fg !== undefined
        ? cssColor(search.fg)
        : undefined;
  if (searchColor !== undefined) {
    for (const line of marks?.search ?? []) {
      out.push({
        x: lane,
        y: y(line),
        w: 2 * lane,
        h: span(1),
        color: searchColor,
        kind: "search",
        line,
      });
    }
  }
  const diag = [...(marks?.diag ?? [])].sort((a, b) => b[1] - a[1]);
  for (const [line, severity] of diag) {
    const color = fg([SEVERITY[severity - 1] ?? "DiagnosticHint"]);
    if (color === undefined) continue;
    out.push({
      x: 2.5 * lane,
      y: y(line),
      w: 1.5 * lane,
      h: span(1),
      color,
      kind: "diag",
      line,
    });
  }
  if (cursor > 0) {
    out.push({
      x: 0,
      y: y(cursor),
      w: width,
      h: Math.max(1, min / 2),
      color: cursorColor,
      kind: "cursor",
      line: cursor,
    });
  }
  return out;
}
