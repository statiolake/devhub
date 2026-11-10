/**
 * Where a grid's cells are a terminal's compromise, drawn as what they
 * mean: window separators as a line between two windows' grounds, `~`
 * past the end left out, a menu's scrollbar of floats as a thin thumb.
 * Pure — rows of colours in, decisions out — so they are tested without a
 * canvas (`chrome.test.ts`); `painter.ts` draws them.
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
  /**
   * Each window's own grounds, by window id: its `Normal` and `NormalNC`
   * as its `winhighlight` maps them (`windowGround`).
   */
  readonly grounds?: ReadonlyMap<number, { normal?: number; nc?: number }>;
  /** `WinSeparator`'s colour: the boundary between panes. */
  readonly separator?: number;
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
  /**
   * `FloatBorder`'s ink and `StatusLine`'s ground, as the theme says them:
   * a float's 1px line and a title's band (`floatLook` derives what a
   * theme leaves unsaid).
   */
  readonly border?: number;
  readonly status?: number;
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
out.grounds = {}
local function bg(name)
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  return ok and hl.bg or nil
end
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  out.wins[tostring(win)] = vim.wo[win].fillchars
  local map = {}
  for from, to in vim.wo[win].winhighlight:gmatch('([^,:]+):([^,]+)') do map[from] = to end
  out.grounds[tostring(win)] = { normal = bg(map.Normal or 'Normal'), nc = bg(map.NormalNC or 'NormalNC') }
end
return out`;

export const THEME_GROUPS: readonly string[] = [
  "Normal",
  "NormalFloat",
  "FloatBorder",
  "StatusLine",
  "WinSeparator",
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
    border: colour("FloatBorder", "fg"),
    status: colour("StatusLine", "bg"),
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
  const grounds = new Map<number, { normal?: number; nc?: number }>();
  for (const [win, value] of Object.entries(record(out["grounds"]) ?? {})) {
    const id = Number(win);
    const g = record(value);
    if (!Number.isInteger(id) || !g) continue;
    const normal = typeof g["normal"] === "number" ? g["normal"] : undefined;
    const nc = typeof g["nc"] === "number" ? g["nc"] : undefined;
    grounds.set(id, {
      ...(normal !== undefined ? { normal } : {}),
      ...(nc !== undefined ? { nc } : {}),
    });
  }
  const separator = colour("WinSeparator", "fg");
  return {
    fillchars,
    grounds,
    ...(separator !== undefined ? { separator } : {}),
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
  item: "eob",
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
      JSON.stringify([...(b.kinds?.icons ?? [])]) &&
    JSON.stringify([...(a.grounds ?? [])]) ===
      JSON.stringify([...(b.grounds ?? [])]) &&
    a.separator === b.separator
  );
}

/**
 * A boundary between windows side by side: a run of grid 1's column `col`
 * from row `top` to `bottom` (exclusive) with a window on its left or right
 * and none on it. Neovim keeps that column (a TUI's separator, drawn in
 * cells); a GUI shows two panes and the edge between them, as VS Code and
 * Zed do: each window's pane takes the half of the column on its side and
 * a hairline is drawn on their shared edge. Worked out from the windows'
 * places and sizes only, never from what is drawn in the column.
 */
export interface Boundary {
  readonly col: number;
  readonly top: number;
  readonly bottom: number;
}

/** Each window's pane: its grid's cells and the half columns it takes. */
export interface Pane {
  readonly grid: number;
  readonly win: number;
  /** A boundary on its left, or on its right, that it reaches into. */
  readonly left: boolean;
  readonly right: boolean;
}

/** Grid 1's boundaries between the windows `boxes` lays out, and the panes. */
export function boundariesOf(
  boxes: readonly GridBox[],
  width: number,
  height: number,
): { boundaries: Boundary[]; panes: Pane[] } {
  const windows = boxes.filter((box) => !box.float && box.win !== undefined);
  const at = (row: number, col: number) =>
    windows.find(
      (b) =>
        b.row <= row &&
        row < b.row + b.height &&
        b.col <= col &&
        col < b.col + b.width,
    );
  const columns = new Set<number>();
  for (const box of windows) {
    if (box.col + box.width < width) columns.add(box.col + box.width);
    if (box.col > 0) columns.add(box.col - 1);
  }
  const boundaries: Boundary[] = [];
  for (const col of [...columns].sort((a, b) => a - b)) {
    let top: number | undefined;
    for (let row = 0; row <= height; row += 1) {
      const on =
        row < height &&
        !at(row, col) &&
        (at(row, col - 1) !== undefined || at(row, col + 1) !== undefined);
      if (on && top === undefined) top = row;
      if (!on && top !== undefined) {
        boundaries.push({ col, top, bottom: row });
        top = undefined;
      }
    }
  }
  const beside = (box: GridBox, col: number) =>
    boundaries.some(
      (b) => b.col === col && b.top <= box.row && box.row < b.bottom,
    );
  const panes = windows.map((box) => ({
    grid: box.grid,
    win: box.win ?? 0,
    left: beside(box, box.col - 1),
    right: beside(box, box.col + box.width),
  }));
  return { boundaries, panes };
}

/**
 * A window's ground, as its own highlights state it: its `Normal` (through
 * `winhighlight`), or its `NormalNC` while it is not the current window.
 */
export function windowGround(
  theme: PaintTheme,
  win: number,
  current: boolean,
): number | undefined {
  const g = theme.grounds?.get(win);
  if (!g) return undefined;
  return current ? g.normal : (g.nc ?? g.normal);
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
    if (!box.float || box.width !== 1 || box.frame) return false;
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
