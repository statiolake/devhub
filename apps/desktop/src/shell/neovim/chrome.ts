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
import { KINDS, KIND_GROUPS, kindGroup, type Kind } from "./kinds";

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
   * Completion kinds (`kinds.ts`): each kind's colour, the colour its
   * words wear in the buffer.
   */
  readonly kinds?: KindTheme;
  /**
   * Each window's own grounds, by window id: its `Normal` and `NormalNC`
   * as its `winhighlight` maps them (`windowGround`).
   */
  readonly grounds?: ReadonlyMap<number, { normal?: number; nc?: number }>;
  /** `WinSeparator`'s colour: the boundary between panes. */
  readonly separator?: number;
  /**
   * `Visual`'s colours, for its band drawn ahead of Neovim in a drag
   * (`dragBand.ts`); absent until asked, or when it reverses instead.
   */
  readonly visual?: { readonly bg: number; readonly fg?: number };
  /**
   * `laststatus`: with 1 or 2 a window's status line is its own (`boundariesOf`).
   */
  readonly laststatus?: number;
}

export interface KindTheme {
  readonly colours: ReadonlyMap<Kind, number>;
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
 * of the tab page. Nothing of any plugin: DevHub knows Neovim, not what
 * the person installed in it.
 */
export const THEME_LUA = `local names = ...
local out = { groups = {}, wins = {}, cmdheight = vim.o.cmdheight, laststatus = vim.o.laststatus, fillchars = vim.go.fillchars }
for _, name in ipairs(names) do
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  if ok then out.groups[name] = hl end
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
  "Visual",
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
  const laststatus =
    typeof out["laststatus"] === "number" ? out["laststatus"] : undefined;
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
    const fg = colour(kindGroup(kind), "fg");
    if (fg !== undefined) colours.set(kind, fg);
  }
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
  const visualBg = colour("Visual", "bg");
  const visualFg = colour("Visual", "fg");
  const visual =
    visualBg !== undefined && record(groups["Visual"])?.["reverse"] !== true
      ? { bg: visualBg, ...(visualFg !== undefined ? { fg: visualFg } : {}) }
      : undefined;
  return {
    fillchars,
    grounds,
    ...(separator !== undefined ? { separator } : {}),
    ...(visual !== undefined ? { visual } : {}),
    ...(laststatus !== undefined ? { laststatus } : {}),
    winFillchars,
    cmdheight,
    ...(surfaceEntries.length > 0
      ? { surface: Object.fromEntries(surfaceEntries) as Surface }
      : {}),
    ...(menuEntries.length > 0
      ? { menu: Object.fromEntries(menuEntries) as MenuColours }
      : {}),
    ...(colours.size > 0 ? { kinds: { colours } } : {}),
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
    JSON.stringify([...(a.grounds ?? [])]) ===
      JSON.stringify([...(b.grounds ?? [])]) &&
    a.separator === b.separator &&
    JSON.stringify(a.visual) === JSON.stringify(b.visual) &&
    a.laststatus === b.laststatus
  );
}

/**
 * A line between regions that meet across a gap of cells (tmux's border
 * cells, Neovim's separator column and row): down the middle of a gap
 * column or across the middle of a gap row. In cells: `x`/`y` where it
 * starts (on the gap cell's middle line), `length` how far it runs; halves
 * are cells too.
 */
export interface BorderLine {
  readonly vertical: boolean;
  readonly x: number;
  readonly y: number;
  readonly length: number;
}

/** A region of cells: a tmux pane, a Neovim window with its status line. */
export interface CellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The lines between regions laid out with one cell between neighbours: a
 * hairline down (or across) the middle of each gap cell, instead of a
 * character border. Traced cell by cell over the gaps, so lines meet: a gap
 * cell beside a region carries a line through it (down it beside one to its
 * left or right, across it beside one above or below), and every gap cell
 * reaches half a cell towards a neighbour whose line runs towards it —
 * where a line ends on another (a T) and where four regions meet (a +),
 * the lines join. A gap is any cell of the regions' extent (from 0, 0) no
 * region covers.
 */
export function borders(regions: readonly CellRect[]): BorderLine[] {
  if (regions.length < 2) return [];
  const cols = Math.max(...regions.map((p) => p.x + p.width));
  const rows = Math.max(...regions.map((p) => p.y + p.height));
  const covered = new Uint8Array(cols * rows);
  for (const p of regions)
    for (let y = Math.max(0, p.y); y < p.y + p.height; y++)
      covered.fill(1, y * cols + Math.max(0, p.x), y * cols + p.x + p.width);
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < cols && y < rows;
  const isPane = (x: number, y: number) =>
    inside(x, y) && covered[y * cols + x] === 1;
  const isGap = (x: number, y: number) =>
    inside(x, y) && covered[y * cols + x] === 0;
  // A line down the cell (beside a region left or right), across it (above or below).
  const down = (x: number, y: number) =>
    isGap(x, y) && (isPane(x - 1, y) || isPane(x + 1, y));
  const across = (x: number, y: number) =>
    isGap(x, y) && (isPane(x, y - 1) || isPane(x, y + 1));
  // Each column's and row's covered half-cells, as runs to merge.
  const vertical = new Map<number, [number, number][]>();
  const horizontal = new Map<number, [number, number][]>();
  const add = (
    map: Map<number, [number, number][]>,
    at: number,
    from: number,
    to: number,
  ) => {
    const list = map.get(at) ?? [];
    list.push([from, to]);
    map.set(at, list);
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!isGap(x, y)) continue;
      if (down(x, y)) add(vertical, x, y, y + 1);
      if (across(x, y)) add(horizontal, y, x, x + 1);
      if (down(x, y - 1)) add(vertical, x, y, y + 0.5);
      if (down(x, y + 1)) add(vertical, x, y + 0.5, y + 1);
      if (across(x - 1, y)) add(horizontal, y, x, x + 0.5);
      if (across(x + 1, y)) add(horizontal, y, x + 0.5, x + 1);
    }
  }
  const lines: BorderLine[] = [];
  const merge = (map: Map<number, [number, number][]>, isVertical: boolean) => {
    for (const [at, runs] of [...map].sort((a, b) => a[0] - b[0])) {
      runs.sort((a, b) => a[0] - b[0]);
      let [start, end] = runs[0];
      const flush = () =>
        lines.push(
          isVertical
            ? { vertical: true, x: at, y: start, length: end - start }
            : { vertical: false, x: start, y: at, length: end - start },
        );
      for (const [from, to] of runs.slice(1)) {
        if (from <= end) end = Math.max(end, to);
        else {
          flush();
          [start, end] = [from, to];
        }
      }
      flush();
    }
  };
  merge(vertical, true);
  merge(horizontal, false);
  return lines;
}

/**
 * Each window's pane: its grid's cells and the half cells it takes of the
 * gaps beside it (a separator column on its left or right, a separator row
 * above or below it).
 */
export interface Pane {
  readonly grid: number;
  readonly win: number;
  /** A gap on its left, right, above or below that it reaches into. */
  readonly left: boolean;
  readonly right: boolean;
  readonly top: boolean;
  readonly bottom: boolean;
  /** Its status line is the row under it (`laststatus` 1 or 2). */
  readonly status: boolean;
}

/**
 * Grid 1's layout of windows as a GUI shows it, as VS Code and Zed show
 * editor groups: regions with a hairline where they meet, not a TUI's
 * separator cells. A region is a window with its status line: with
 * `laststatus` 1 or 2 the row under each window is its own (its footer),
 * so stacked windows meet at it and a separator column runs down beside
 * it; with 0 or 3 there is none, and stacked windows meet at a separator
 * row, a hairline like the column's. `lines` are in grid 1's cells
 * (`borders`), `gaps` the cells they run through (grid 1's, not drawn as
 * cells), `vgaps` those of them a line runs down. Worked out from the
 * windows' places and sizes only, never from what is drawn in the gaps.
 */
export function boundariesOf(
  boxes: readonly GridBox[],
  width: number,
  height: number,
  laststatus = 2,
): {
  lines: BorderLine[];
  panes: Pane[];
  gaps: Set<number>;
  vgaps: Set<number>;
} {
  const windows = boxes.filter((box) => !box.float && box.win !== undefined);
  const withStatus = laststatus === 1 || laststatus === 2;
  const regions = windows.map((b) => ({
    x: b.col,
    y: b.row,
    width: b.width,
    height: Math.min(b.height + (withStatus ? 1 : 0), height - b.row),
  }));
  const gaps = new Set<number>();
  const vgaps = new Set<number>();
  if (regions.length === 0) return { lines: [], panes: [], gaps, vgaps };
  const left = Math.min(...regions.map((r) => r.x));
  const top = Math.min(...regions.map((r) => r.y));
  const lines = borders(
    regions.map((r) => ({ ...r, x: r.x - left, y: r.y - top })),
  ).map((l) => ({ ...l, x: l.x + left, y: l.y + top }));
  for (const l of lines) {
    const from = Math.floor(l.vertical ? l.y : l.x);
    const to = Math.ceil((l.vertical ? l.y : l.x) + l.length);
    for (let at = from; at < to; at += 1) {
      const i = l.vertical ? at * width + l.x : l.y * width + at;
      gaps.add(i);
      if (l.vertical) vgaps.add(i);
    }
  }
  const inRegion = (row: number, col: number) =>
    regions.some(
      (r) =>
        r.x <= col && col < r.x + r.width && r.y <= row && row < r.y + r.height,
    );
  const gap = (row: number, col: number) =>
    row >= 0 &&
    col >= 0 &&
    row < height &&
    col < width &&
    gaps.has(row * width + col) &&
    !inRegion(row, col);
  const panes = windows.map((box) => ({
    grid: box.grid,
    win: box.win ?? 0,
    left: gap(box.row, box.col - 1),
    right: gap(box.row, box.col + box.width),
    top: gap(box.row - 1, box.col),
    bottom: gap(box.row + box.height, box.col),
    status: withStatus && box.row + box.height < height,
  }));
  return { lines, panes, gaps, vgaps };
}

/** How far past its cells an editor's ground reaches, in CSS pixels. */
export interface Edges {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Where a window's pane is, in CSS pixels of grid 1: its cells, and exactly
 * half of each gap beside it (`Pane`), on device pixels, so the edges of
 * windows split across and down line up whatever their neighbours; on
 * grid 1's own edges, out to the editor's `reach` (a tmux pane's half
 * border cells).
 */
export function paneRect(
  pane: Pane,
  box: GridBox,
  grid1: { readonly width: number; readonly height: number },
  cell: { readonly width: number; readonly height: number },
  dpr: number,
  reach: Edges,
): Edges {
  const { width: cw, height: ch } = cell;
  const halfX = (col: number) => Math.round((col + 0.5) * cw * dpr) / dpr;
  const halfY = (row: number) => Math.round((row + 0.5) * ch * dpr) / dpr;
  const end = box.col + box.width;
  const foot = box.row + box.height;
  return {
    left: pane.left
      ? halfX(box.col - 1)
      : box.col === 0
        ? -reach.left
        : box.col * cw,
    right: pane.right
      ? halfX(end)
      : end >= grid1.width
        ? grid1.width * cw + reach.right
        : end * cw,
    top: pane.top
      ? halfY(box.row - 1)
      : box.row === 0
        ? -reach.top
        : box.row * ch,
    bottom: pane.bottom
      ? halfY(foot)
      : foot >= grid1.height
        ? grid1.height * ch + reach.bottom
        : foot * ch,
  };
}

/** A rectangle of a row's bleed (`Bleed`) and the cell whose ground it is. */
export interface BleedRect {
  readonly col: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * A grid row's grounds continued past its cells (`painter.ts`, `Bleed`):
 * its first cell's to the left, its last cell's to the right; on the
 * grid's first row up and its last row down, each cell's own, the corners
 * the end cells'. In CSS pixels of the grid, the row at `row * ch`.
 */
export function rowBleed(
  width: number,
  height: number,
  row: number,
  cell: { readonly width: number; readonly height: number },
  bleed: {
    readonly l: number;
    readonly r: number;
    readonly t: number;
    readonly b: number;
  },
): BleedRect[] {
  const { width: cw, height: ch } = cell;
  const out: BleedRect[] = [];
  if (width <= 0) return out;
  const last = width - 1;
  const W = width * cw;
  const y = row * ch;
  if (bleed.l > 0) out.push({ col: 0, x: -bleed.l, y, w: bleed.l, h: ch });
  if (bleed.r > 0) out.push({ col: last, x: W, y, w: bleed.r, h: ch });
  const ends: [boolean, number, number][] = [
    [row === 0 && bleed.t > 0, -bleed.t, bleed.t],
    [row === height - 1 && bleed.b > 0, y + ch, bleed.b],
  ];
  for (const [on, yy, h] of ends) {
    if (!on) continue;
    if (bleed.l > 0) out.push({ col: 0, x: -bleed.l, y: yy, w: bleed.l, h });
    for (let col = 0; col <= last; col += 1)
      out.push({ col, x: col * cw, y: yy, w: cw, h });
    if (bleed.r > 0) out.push({ col: last, x: W, y: yy, w: bleed.r, h });
  }
  return out;
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
