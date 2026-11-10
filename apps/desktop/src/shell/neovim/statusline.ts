/**
 * Each window's footer: what is drawn in the status line row Neovim keeps
 * under it, now that grid 1 — the cells Neovim draws round its windows —
 * is not painted (`docs/neovim-editor.md`, "Status lines").
 *
 * Lua decides what each row shows (`main/editor/neovimStatusline.ts`) and
 * says it in a `statusline` event: a component tree (the config's
 * `gui.statusline`, or DevHub's default footer) or Neovim's own cells of
 * that row. Where the rows are is Neovim's layout, read here from the
 * windows' places, `laststatus` and `cmdheight`: Neovim keeps the rows, the
 * page only draws in them. Pure, so the choices are tested without a page.
 */

import {
  luaList,
  parseHlTable,
  parseNode,
  type ComponentNode,
  type HlTable,
} from "./components";
import type { GridBox } from "./redraw";

/** What one row shows. */
export type FooterEntry =
  | { readonly kind: "cells" }
  | {
      readonly kind: "tree";
      readonly node: ComponentNode;
      readonly hl: HlTable;
      /** DevHub's default footer: one hairline under it. */
      readonly edge: boolean;
      /** It draws a line through the row (`ui.line`): a boundary meets it there. */
      readonly line: boolean;
    };

export const CELLS: FooterEntry = { kind: "cells" };

export interface Statusline {
  /** `laststatus`, as Lua last said (the theme's until then). */
  readonly laststatus: number | undefined;
  /** The current window: with `laststatus=3` the one row is its. */
  readonly current: number | undefined;
  readonly entries: ReadonlyMap<number, FooterEntry>;
}

export const NO_STATUSLINE: Statusline = {
  laststatus: undefined,
  current: undefined,
  entries: new Map(),
};

type Rec = Readonly<Record<string, unknown>>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** Whether a tree draws a line through its row. */
export function hasLine(node: ComponentNode): boolean {
  if (node.type === "line") return true;
  if (node.type === "stack" || node.type === "hstack")
    return node.children.some(hasLine);
  return false;
}

function entryOf(value: unknown): FooterEntry {
  const r = rec(value);
  if (r?.["kind"] !== "tree") return CELLS;
  const node = parseNode(r["node"]);
  if (!node) return CELLS;
  return {
    kind: "tree",
    node,
    hl: parseHlTable(r["hl"]),
    edge: r["edge"] === true,
    line: hasLine(node),
  };
}

/**
 * Lua's `statusline` event applied: the windows it sent again replaced,
 * those it no longer keeps a row for dropped, the rest as they were.
 */
export function applyStatuslineEvent(
  state: Statusline,
  payload: unknown,
): Statusline {
  const p = rec(payload);
  if (!p) return state;
  const keep = new Set(
    luaList(p["keep"]).filter(
      (w): w is number => typeof w === "number" && Number.isInteger(w),
    ),
  );
  const entries = new Map<number, FooterEntry>();
  for (const [win, entry] of state.entries)
    if (keep.has(win)) entries.set(win, entry);
  for (const [key, value] of Object.entries(rec(p["wins"]) ?? {})) {
    const win = Number(key);
    if (Number.isInteger(win) && keep.has(win))
      entries.set(win, entryOf(value));
  }
  const ls = p["laststatus"];
  const cur = p["current"];
  return {
    laststatus: typeof ls === "number" ? ls : state.laststatus,
    current: typeof cur === "number" ? cur : state.current,
    entries,
  };
}

/** One status line row, in grid 1's cells, and what it shows. */
export interface Footer {
  /** `win:<id>`, or `global` for `laststatus=3`'s one row. */
  readonly key: string;
  readonly win: number;
  /** The window's grid: the footer moves with it. None for the global row. */
  readonly grid: number | undefined;
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly entry: FooterEntry;
  readonly current: boolean;
}

/**
 * The status line rows Neovim keeps in this layout, as Neovim lays them
 * out: with `laststatus` 1 or 2 the row under each window that has one
 * above the command line rows (with 1, only when there are two windows or
 * more — Neovim then has the row), with 3 the one row above them across
 * the editor, with 0 none. A row Lua has not spoken of yet is cells, as
 * Neovim drew it.
 */
export function footersOf(
  boxes: readonly GridBox[],
  grid1: { readonly width: number; readonly height: number },
  opts: {
    readonly laststatus: number;
    readonly cmdheight: number;
    readonly current: number | undefined;
    readonly statusline: Statusline;
  },
): Footer[] {
  const windows = boxes.filter(
    (b) => !b.float && b.win !== undefined && b.grid !== 1,
  );
  const { laststatus: ls, cmdheight, current, statusline } = opts;
  const last = grid1.height - cmdheight;
  if (windows.length === 0 || ls === 0) return [];
  if (ls === 3) {
    const win = statusline.current ?? current ?? windows[0]?.win ?? 0;
    if (last - 1 < 0) return [];
    return [
      {
        key: "global",
        win,
        grid: undefined,
        row: last - 1,
        col: 0,
        width: grid1.width,
        entry: statusline.entries.get(win) ?? CELLS,
        current: true,
      },
    ];
  }
  if (ls !== 1 && ls !== 2) return [];
  return windows.flatMap((b) => {
    const row = b.row + b.height;
    const win = b.win ?? 0;
    if (row >= last) return [];
    return [
      {
        key: `win:${String(win)}`,
        win,
        grid: b.grid,
        row,
        col: b.col,
        width: b.width,
        entry: statusline.entries.get(win) ?? CELLS,
        current: win === current,
      },
    ];
  });
}

/** The mode's name as a footer shows it (`mode_change`'s name). */
export function modeLabel(name: string): string {
  const MODES: Record<string, string> = {
    normal: "NORMAL",
    insert: "INSERT",
    replace: "REPLACE",
    visual: "VISUAL",
    visual_select: "SELECT",
    cmdline_normal: "COMMAND",
    cmdline_insert: "COMMAND",
    cmdline_replace: "COMMAND",
    operator: "NORMAL",
    terminal: "TERMINAL",
    showmatch: "INSERT",
  };
  return MODES[name] ?? name.toUpperCase();
}

/**
 * The cursor's place as a `position` slot shows it: `%l` its line, `%c`
 * its column (1-based), `%L` the buffer's lines, `%p` how far down, in
 * percent; `%%` a percent sign.
 */
export function formatPosition(
  format: string | undefined,
  at: {
    readonly curline: number;
    readonly curcol: number;
    readonly lineCount: number;
  },
): string {
  const line = at.curline + 1;
  const total = Math.max(1, at.lineCount);
  return (format ?? "Ln %l, Col %c").replace(/%([lcLp%])/g, (_, c) => {
    switch (c) {
      case "l":
        return String(line);
      case "c":
        return String(at.curcol + 1);
      case "L":
        return String(at.lineCount);
      case "p":
        return String(Math.round((Math.min(line, total) / total) * 100));
      default:
        return "%";
    }
  });
}

/**
 * The grid-1 cells a tree footer is drawn over: not read as cells (no
 * boundary's stub is drawn to a `─` Neovim put there), by index.
 */
export function nativeCells(
  footers: readonly Footer[],
  width: number,
): Set<number> {
  const out = new Set<number>();
  for (const f of footers) {
    if (f.entry.kind !== "tree") continue;
    // The gap column beside it too: its half is the footer's.
    for (let c = Math.max(0, f.col - 1); c <= f.col + f.width; c += 1)
      if (c < width) out.add(f.row * width + c);
  }
  return out;
}
