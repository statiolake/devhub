/**
 * Where a grid's cells are a terminal's compromise, drawn as what they
 * mean: window separators as a line between two windows' grounds, `~`
 * past the end left out, a diff's filler hatched, a menu's scrollbar of
 * floats as a thin thumb. Pure — rows of colours in, decisions out — so
 * they are tested without a canvas (`chrome.test.ts`); `painter.ts` draws
 * them.
 *
 * Nothing here changes what is in a cell or where: the text, the cursor and
 * every click stay on the cells Neovim says.
 */

import type { GridBox, NeovimUiState } from "./redraw";
import { KINDS, KIND_GROUPS, iconKinds, kindGroups, type Kind } from "./kinds";

/**
 * What the painter knows of the colorscheme beyond the grid's own colours,
 * asked of Neovim by name (`THEME_LUA`) whenever highlights change.
 */
export interface PaintTheme {
  /** The global `fillchars`. */
  readonly fillchars: string;
  /** Each window's own `fillchars` (`:setlocal`), by window id. */
  readonly winFillchars: ReadonlyMap<number, string>;
  /** `cmdheight`: grid 1's last rows are the command line's, no bar. */
  readonly cmdheight: number;
  /**
   * The colours of what DevHub draws over the editor (notifications):
   * the floats' ground and ink (`NormalFloat`, else `Normal`), and the
   * diagnostics' colours for levels. Absent until asked.
   */
  readonly surface?: Surface;
  /** The completion menu's colours (`Pmenu*`); absent until asked. */
  readonly menu?: MenuColours;
  /**
   * Completion kinds (`kinds.ts`): each kind's colour from the person's
   * groups, and their kind icons (blink.cmp's `kind_icons`) glyph to kind.
   */
  readonly kinds?: KindTheme;
}

export interface KindTheme {
  readonly colours: ReadonlyMap<Kind, number>;
  readonly icons: ReadonlyMap<string, Kind>;
}

/** `Pmenu` and its parts, as the person's colorscheme gives them. */
export interface MenuColours {
  readonly bg?: number;
  readonly fg?: number;
  readonly selBg?: number;
  readonly selFg?: number;
  /** `PmenuKind`: the kind's name. */
  readonly kind?: number;
  /** `PmenuExtra`: the item's `menu` text (its source). */
  readonly extra?: number;
  /** `PmenuKindSel`, `PmenuExtraSel`: the same on the selected row. */
  readonly kindSel?: number;
  readonly extraSel?: number;
}

/** `PaintTheme.surface`: colours a GUI surface over the editor wears. */
export interface Surface {
  readonly bg?: number;
  readonly fg?: number;
  /** `Normal`'s ground and ink: the editor's own, under and in its text. */
  readonly ground?: number;
  readonly text?: number;
  readonly muted?: number;
  readonly info?: number;
  readonly warn?: number;
  readonly error?: number;
  readonly ok?: number;
}

export const NO_THEME: PaintTheme = {
  fillchars: "",
  winFillchars: new Map(),
  cmdheight: 1,
};

/**
 * Asked with `nvim_exec_lua` (`nvim_get_hl`): each group's colours,
 * links followed; `cmdheight`; the global `fillchars` and each window's
 * of the tab page; blink.cmp's kind icons once blink is loaded (only read:
 * asking would load a lazy plugin).
 */
export const THEME_LUA = `local names = ...
local out = { groups = {}, wins = {}, cmdheight = vim.o.cmdheight, fillchars = vim.go.fillchars }
for _, name in ipairs(names) do
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  if ok then out.groups[name] = hl end
end
local blink = package.loaded['blink.cmp.config']
if type(blink) == 'table' and type(blink.appearance) == 'table' and type(blink.appearance.kind_icons) == 'table' then
  out.kind_icons = blink.appearance.kind_icons
end
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  out.wins[tostring(win)] = vim.wo[win].fillchars
end
return out`;

export const THEME_GROUPS: readonly string[] = [
  "Normal",
  "NormalFloat",
  "Comment",
  "DiagnosticInfo",
  "DiagnosticWarn",
  "DiagnosticError",
  "DiagnosticOk",
  "Pmenu",
  "PmenuSel",
  "PmenuKind",
  "PmenuExtra",
  "PmenuKindSel",
  "PmenuExtraSel",
  ...KIND_GROUPS,
];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `THEME_LUA`'s answer as a `PaintTheme`; anything odd is left out. */
export function themeOf(answer: unknown): PaintTheme {
  const out = record(answer);
  const groups = record(out?.["groups"]);
  if (!out || !groups) return NO_THEME;
  const cmdheight = typeof out["cmdheight"] === "number" ? out["cmdheight"] : 1;
  const fillchars =
    typeof out["fillchars"] === "string" ? out["fillchars"] : "";
  const winFillchars = new Map<number, string>();
  for (const [win, value] of Object.entries(record(out["wins"]) ?? {})) {
    const id = Number(win);
    if (Number.isInteger(id) && typeof value === "string")
      winFillchars.set(id, value);
  }
  const colour = (name: string, key: "fg" | "bg") => {
    const v = record(groups[name])?.[key];
    return typeof v === "number" ? v : undefined;
  };
  const surfaceEntries = Object.entries({
    bg: colour("NormalFloat", "bg") ?? colour("Normal", "bg"),
    fg: colour("NormalFloat", "fg") ?? colour("Normal", "fg"),
    ground: colour("Normal", "bg"),
    text: colour("Normal", "fg"),
    muted: colour("Comment", "fg"),
    info: colour("DiagnosticInfo", "fg"),
    warn: colour("DiagnosticWarn", "fg"),
    error: colour("DiagnosticError", "fg"),
    ok: colour("DiagnosticOk", "fg"),
  }).filter(([, v]) => v !== undefined);
  const menuEntries = Object.entries({
    bg: colour("Pmenu", "bg"),
    fg: colour("Pmenu", "fg"),
    selBg: colour("PmenuSel", "bg"),
    selFg: colour("PmenuSel", "fg"),
    kind: colour("PmenuKind", "fg"),
    extra: colour("PmenuExtra", "fg"),
    kindSel: colour("PmenuKindSel", "fg"),
    extraSel: colour("PmenuExtraSel", "fg"),
  }).filter(([, v]) => v !== undefined);
  const colours = new Map<Kind, number>();
  for (const kind of KINDS) {
    const fg = kindGroups(kind)
      .map(({ name, generic }) => {
        const own = colour(name, "fg");
        return generic !== undefined && own === colour(generic, "fg")
          ? undefined
          : own;
      })
      .find((v) => v !== undefined);
    if (fg !== undefined) colours.set(kind, fg);
  }
  const icons = iconKinds(record(out["kind_icons"]) ?? {});
  return {
    fillchars,
    winFillchars,
    cmdheight,
    ...(surfaceEntries.length > 0
      ? { surface: Object.fromEntries(surfaceEntries) as Surface }
      : {}),
    ...(menuEntries.length > 0
      ? { menu: Object.fromEntries(menuEntries) as MenuColours }
      : {}),
    ...(colours.size > 0 || icons.size > 0
      ? { kinds: { colours, icons } }
      : {}),
  };
}

/**
 * Whether a window's `fillchars` (its own, else the global one) has the
 * person's `item:` — then what Neovim draws for it is theirs, and kept.
 */
export function fillChosen(
  theme: PaintTheme,
  win: number | undefined,
  item: "eob" | "diff",
): boolean {
  const value =
    (win !== undefined ? theme.winFillchars.get(win) : undefined) ??
    theme.fillchars;
  return value.split(",").some((part) => part.startsWith(`${item}:`));
}

export function sameTheme(a: PaintTheme, b: PaintTheme): boolean {
  return (
    a.cmdheight === b.cmdheight &&
    a.fillchars === b.fillchars &&
    JSON.stringify([...a.winFillchars]) ===
      JSON.stringify([...b.winFillchars]) &&
    JSON.stringify(a.surface) === JSON.stringify(b.surface) &&
    JSON.stringify(a.menu) === JSON.stringify(b.menu) &&
    JSON.stringify([...(a.kinds?.colours ?? [])]) ===
      JSON.stringify([...(b.kinds?.colours ?? [])]) &&
    JSON.stringify([...(a.kinds?.icons ?? [])]) ===
      JSON.stringify([...(b.kinds?.icons ?? [])])
  );
}

/** The colour most of `bgs` have. */
function commonest(bgs: readonly number[]): number | undefined {
  const counts = new Map<number, number>();
  let best: number | undefined;
  let most = 0;
  for (const bg of bgs) {
    const n = (counts.get(bg) ?? 0) + 1;
    counts.set(bg, n);
    if (n > most) {
      most = n;
      best = bg;
    }
  }
  return best;
}

/** The background a grid's cell is drawn in. */
export type BgOf = (grid: number, index: number) => number;

/** A vertical separator's cell of grid 1, between what is either side. */
export interface Separator {
  readonly row: number;
  readonly col: number;
  /** The grounds on each side of it. */
  readonly left: number;
  readonly right: number;
}

/**
 * Whether a window's cell is drawn in the window's own ground (its
 * `Normal`, its sign column's), not in a highlight laid over a line or a
 * region of its text (a diff's, the cursor line's, Visual's).
 */
export type IsGround = (grid: number, index: number) => boolean;

/**
 * The cells of grid 1 in a column right of a window or left of one, and
 * the grounds either side: a window's is its own ground (`isGround`), the
 * colour most of those of its cells next to the column have (its `Normal`,
 * its sign column's), else of those anywhere in it — never a highlight laid
 * over its text, so a cursor line does not bleed into it, and what scrolls past
 * (a diff hunk taller than half the window) does not recolour it: the
 * separator is the windows' edge, which scrolling never touches; elsewhere
 * (a status line beside) that cell's. The separator's two halves continue
 * what is beside them and only its line is left between.
 */
export function separatorsOf(
  boxes: readonly GridBox[],
  width: number,
  height: number,
  bgOf: BgOf,
  isGround: IsGround = () => true,
): Separator[] {
  const windows = boxes.filter((box) => !box.float && box.win !== undefined);
  const at = (row: number, col: number) =>
    windows.find(
      (b) =>
        b.row <= row &&
        row < b.row + b.height &&
        b.col <= col &&
        col < b.col + b.width,
    );
  // A window's ground along its first and last columns.
  const edges = new Map<number, { first: number; last: number }>();
  const edgeOf = (box: GridBox) => {
    let edge = edges.get(box.grid);
    if (!edge) {
      let whole: number | null | undefined = null;
      const anywhere = () => {
        if (whole !== null) return whole;
        const own: number[] = [];
        for (let i = 0; i < box.width * box.height; i += 1)
          if (isGround(box.grid, i)) own.push(bgOf(box.grid, i));
        whole = commonest(own);
        return whole;
      };
      // The ground at a column, else anywhere in the window, else (no cell
      // in its own ground: a hunk filling it) the column's commonest.
      const at = (col: number) => {
        const all: number[] = [];
        const own: number[] = [];
        for (let row = 0; row < box.height; row += 1) {
          const i = row * box.width + col;
          const bg = bgOf(box.grid, i);
          all.push(bg);
          if (isGround(box.grid, i)) own.push(bg);
        }
        return commonest(own) ?? anywhere() ?? commonest(all) ?? 0;
      };
      edge = { first: at(0), last: at(box.width - 1) };
      edges.set(box.grid, edge);
    }
    return edge;
  };
  const columns = new Set<number>();
  for (const box of windows) {
    if (box.col + box.width < width) columns.add(box.col + box.width);
    if (box.col > 0) columns.add(box.col - 1);
  }
  const out: Separator[] = [];
  for (const col of [...columns].sort((a, b) => a - b)) {
    for (let row = 0; row < height; row += 1) {
      if (at(row, col)) continue;
      const l = at(row, col - 1);
      const r = at(row, col + 1);
      if (!l && !r) continue;
      out.push({
        row,
        col,
        left: l ? edgeOf(l).last : bgOf(1, row * width + col - 1),
        right: r ? edgeOf(r).first : bgOf(1, row * width + col + 1),
      });
    }
  }
  return out;
}

/** A separator's character: a vertical line, light or heavy, or `|`. */
export function isSeparatorLine(c: string): boolean {
  return c === "│" || c === "┃" || c === "|" || c === "║";
}

/**
 * A window row that is only an end-of-buffer `~` (the default `eob`; its
 * highlight `EndOfBuffer`'s, by name, `isEob`): the row past the end of
 * the buffer.
 */
export function isEndOfBuffer(
  chars: readonly string[],
  base: number,
  width: number,
  isEob: boolean,
): boolean {
  if (!isEob || chars[base] !== "~") return false;
  for (let col = 1; col < width; col += 1) {
    if ((chars[base + col] ?? " ") !== " ") return false;
  }
  return true;
}

/**
 * A diff's filler row (a line the other side has): from some column on,
 * nothing but `-` in a highlight made of `DiffDelete` (`isFill`). Answers
 * that column, or `undefined`.
 */
export function fillerStart(
  chars: readonly string[],
  base: number,
  width: number,
  isFill: (col: number) => boolean,
): number | undefined {
  const fill = (col: number) => chars[base + col] === "-" && isFill(col);
  if (width === 0 || !fill(width - 1)) return undefined;
  let start = width - 1;
  while (start > 0 && fill(start - 1)) start -= 1;
  // A real line of dashes is not a whole row of them in DiffDelete's
  // colours from the text column on; still, a short run is left alone.
  return width - start >= Math.min(8, width) ? start : undefined;
}

/** What a one-column float is to a menu beside it. */
export type ScrollbarPart = "thumb" | "gutter";

/**
 * Completion menus' and docs' scrollbars drawn as floats (blink.cmp,
 * nvim-cmp: a one-cell-wide, unfocusable float of blank cells in a colour,
 * the thumb over the gutter) on a menu's right edge: on its last column
 * (its border) or the one after, within its rows. Answers each such
 * float's part: the one with another over it is the gutter, the rest
 * thumbs. A one-column float that is not on a menu's edge is left alone.
 */
export function floatScrollbars(
  state: NeovimUiState,
  boxes: readonly GridBox[],
): Map<number, ScrollbarPart> {
  const thin = boxes.filter((box) => {
    if (!box.float || box.width !== 1 || box.crop || box.frame) return false;
    const placement = state.windows.get(box.grid)?.placement;
    if (placement?.kind !== "float" || placement.focusable) return false;
    const grid = state.grids.get(box.grid);
    return grid !== undefined && grid.chars.every((c) => c === " " || c === "");
  });
  const menus = boxes.filter((box) => box.float && box.width > 1);
  const bars = thin.filter((bar) =>
    menus.some(
      (menu) =>
        bar.z >= menu.z &&
        bar.col >= menu.col + menu.width - 1 &&
        bar.col <= menu.col + menu.width &&
        bar.row >= menu.row &&
        bar.row + bar.height <= menu.row + menu.height,
    ),
  );
  const out = new Map<number, ScrollbarPart>();
  for (const bar of bars) {
    const over = bars.some(
      (other) =>
        other !== bar &&
        other.col === bar.col &&
        other.z > bar.z &&
        other.row >= bar.row &&
        other.row + other.height <= bar.row + bar.height,
    );
    out.set(bar.grid, over ? "gutter" : "thumb");
  }
  return out;
}
