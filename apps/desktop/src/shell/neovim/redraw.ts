/**
 * Neovim's UI protocol, folded into a state the painter draws.
 *
 * DevHub attaches to a headless Neovim as its only UI with `ext_linegrid`,
 * `ext_multigrid`, `ext_popupmenu`, `ext_cmdline` and `ext_tabline`
 * (`docs/neovim-editor.md`). Every `redraw` notification is a list of
 * batches, `[name, ...argument tuples]`; `applyRedraw` folds one into
 * `NeovimUiState` and says what changed, and nothing else in the page reads
 * the protocol. It touches no DOM and no I/O, so it is tested event by event
 * (`redraw.test.ts`) and against a real Neovim (`main/editor/neovimUi.real.test.ts`).
 *
 * The state is mutated in place — a grid is a few thousand cells, rewritten
 * a row at a time on every keystroke, and copying it per event is what a GUI
 * cannot afford. What a caller may rely on is `RedrawChanges`: which grids'
 * rows are dirty and which widgets moved, read and cleared at each `flush`.
 */

/** A highlight, as `hl_attr_define`'s rgb map says it. Colours are 24-bit. */
export interface HlAttr {
  readonly foreground?: number;
  readonly background?: number;
  readonly special?: number;
  readonly reverse?: boolean;
  readonly italic?: boolean;
  readonly bold?: boolean;
  readonly strikethrough?: boolean;
  readonly underline?: boolean;
  readonly undercurl?: boolean;
  readonly underdouble?: boolean;
  readonly underdotted?: boolean;
  readonly underdashed?: boolean;
  /** 0–100: how transparent a float's background is. */
  readonly blend?: number;
}

/** One grid: `width × height` cells, row-major. */
export interface Grid {
  readonly id: number;
  width: number;
  height: number;
  /** The cell's text; `""` for the right half of a double-width character. */
  chars: string[];
  /** The cell's highlight id; 0 is the default colours. */
  hls: Int32Array;
  /** Rows rewritten since the last paint. */
  readonly dirty: Set<number>;
}

export type FloatAnchor = "NW" | "NE" | "SW" | "SE";

/** Where a grid goes, as the `win_*` events place it. */
export type GridPlacement =
  | {
      readonly kind: "window";
      readonly win: number;
      readonly row: number;
      readonly col: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "float";
      readonly win: number;
      readonly anchor: FloatAnchor;
      readonly anchorGrid: number;
      readonly anchorRow: number;
      readonly anchorCol: number;
      readonly focusable: boolean;
      readonly zindex: number;
    }
  | {
      readonly kind: "message";
      readonly row: number;
      readonly scrolled: boolean;
    };

export interface WindowState {
  readonly grid: number;
  placement: GridPlacement;
  hidden: boolean;
  /** From `win_viewport`, when one has come. */
  viewport?: {
    readonly topline: number;
    readonly botline: number;
    readonly curline: number;
    readonly curcol: number;
    readonly lineCount: number;
  };
}

/** `mode_info_set`'s entry for one mode: how the cursor looks in it. */
export interface ModeInfo {
  readonly name: string;
  readonly cursorShape: "block" | "horizontal" | "vertical";
  /** Of the cell, for `horizontal` and `vertical`. */
  readonly cellPercentage: number;
  /** 0 is the default colours reversed. */
  readonly attrId: number;
  readonly blinkon: number;
  readonly blinkoff: number;
  readonly blinkwait: number;
}

export interface PopupmenuItem {
  readonly word: string;
  readonly kind: string;
  readonly menu: string;
  readonly info: string;
}

export interface PopupmenuState {
  readonly items: readonly PopupmenuItem[];
  selected: number;
  readonly row: number;
  readonly col: number;
  /** `-1`: the command line's completion. */
  readonly grid: number;
}

/** A command line's text, as `[attr, text]` chunks. */
export type Chunks = readonly (readonly [number, string])[];

export interface CmdlineLevel {
  readonly content: Chunks;
  /** Byte offset of the cursor in the joined content. */
  pos: number;
  readonly firstc: string;
  readonly prompt: string;
  readonly indent: number;
  readonly level: number;
  /** `cmdline_special_char`: shown at the cursor until the next show. */
  special?: { readonly char: string; readonly shift: boolean };
}

export interface TabState {
  readonly tab: number;
  readonly name: string;
}

export interface NeovimUiState {
  readonly grids: Map<number, Grid>;
  /** Which window each grid is, as `win_pos` and `win_viewport` say. */
  readonly gridWins: Map<number, number>;
  readonly windows: Map<number, WindowState>;
  readonly hl: Map<number, HlAttr>;
  defaults: { foreground: number; background: number; special: number };
  /**
   * What "no colour" (`-1`) in `default_colors_set` means: DevHub's own
   * theme, so a Neovim with no colorscheme still wears the window's colours.
   */
  fallback: { foreground: number; background: number; special: number };
  cursor: { grid: number; row: number; col: number };
  modes: ModeInfo[];
  cursorStyleEnabled: boolean;
  mode: { name: string; index: number };
  /** `option_set`: `guifont`, `linespace`, … as Neovim sent them. */
  readonly options: Map<string, unknown>;
  busy: boolean;
  mouse: boolean;
  title: string;
  popupmenu: PopupmenuState | undefined;
  /** The command lines on screen, by level (nested ones are `<C-r>=`). */
  cmdline: CmdlineLevel[];
  cmdlineBlock: Chunks[] | undefined;
  tabline: { current: number; tabs: readonly TabState[] } | undefined;
}

/** What one batch changed, for the painter. */
export interface RedrawChanges {
  /** Grids whose size, rows, placement or existence changed. */
  readonly grids: Set<number>;
  /** Colours or highlights changed: every grid repaints. */
  colors: boolean;
  cursor: boolean;
  layout: boolean;
  popupmenu: boolean;
  cmdline: boolean;
  tabline: boolean;
  options: boolean;
  /** A `flush` arrived: what is in the state is a frame to draw. */
  flushed: boolean;
  /** Screen rows each window grid scrolled (`win_viewport`'s scroll_delta). */
  readonly scrolled: Map<number, number>;
}

export function emptyChanges(): RedrawChanges {
  return {
    grids: new Set(),
    colors: false,
    cursor: false,
    layout: false,
    popupmenu: false,
    cmdline: false,
    tabline: false,
    options: false,
    flushed: false,
    scrolled: new Map(),
  };
}

export function initialUiState(
  fallback = { foreground: 0xffffff, background: 0x000000, special: 0xff0000 },
): NeovimUiState {
  return {
    grids: new Map(),
    gridWins: new Map(),
    windows: new Map(),
    hl: new Map(),
    defaults: { ...fallback },
    fallback,
    cursor: { grid: 1, row: 0, col: 0 },
    modes: [],
    cursorStyleEnabled: true,
    mode: { name: "normal", index: 0 },
    options: new Map(),
    busy: false,
    mouse: true,
    title: "",
    popupmenu: undefined,
    cmdline: [],
    cmdlineBlock: undefined,
    tabline: undefined,
  };
}

function newGrid(id: number, width: number, height: number): Grid {
  const size = Math.max(0, width * height);
  return {
    id,
    width,
    height,
    chars: new Array<string>(size).fill(" "),
    hls: new Int32Array(size),
    dirty: new Set(Array.from({ length: height }, (_, row) => row)),
  };
}

function resizeGrid(grid: Grid, width: number, height: number): void {
  const chars = new Array<string>(width * height).fill(" ");
  const hls = new Int32Array(width * height);
  const rows = Math.min(height, grid.height);
  const cols = Math.min(width, grid.width);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      chars[row * width + col] = grid.chars[row * grid.width + col] ?? " ";
      hls[row * width + col] = grid.hls[row * grid.width + col] ?? 0;
    }
  }
  grid.width = width;
  grid.height = height;
  grid.chars = chars;
  grid.hls = hls;
  grid.dirty.clear();
  for (let row = 0; row < height; row += 1) grid.dirty.add(row);
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function color(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 ? value : undefined;
}

function attrOf(map: unknown): HlAttr {
  if (map === null || typeof map !== "object") return {};
  const m = map as Record<string, unknown>;
  const flag = (key: string) => (m[key] === true ? true : undefined);
  const out: Record<string, unknown> = {
    foreground: color(m["foreground"]),
    background: color(m["background"]),
    special: color(m["special"]),
    reverse: flag("reverse"),
    italic: flag("italic"),
    bold: flag("bold"),
    strikethrough: flag("strikethrough"),
    underline: flag("underline"),
    undercurl: flag("undercurl"),
    underdouble: flag("underdouble") ?? flag("underlineline"),
    underdotted: flag("underdotted") ?? flag("underdot"),
    underdashed: flag("underdashed") ?? flag("underdash"),
    blend: typeof m["blend"] === "number" ? m["blend"] : undefined,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out as HlAttr;
}

function modeInfoOf(entry: unknown): ModeInfo {
  const m = (entry ?? {}) as Record<string, unknown>;
  const shape = m["cursor_shape"];
  return {
    name: str(m["name"]),
    cursorShape:
      shape === "horizontal" || shape === "vertical" ? shape : "block",
    cellPercentage: num(m["cell_percentage"], 100) || 100,
    attrId: num(m["attr_id"]),
    blinkon: num(m["blinkon"]),
    blinkoff: num(m["blinkoff"]),
    blinkwait: num(m["blinkwait"]),
  };
}

function chunksOf(value: unknown): Chunks {
  if (!Array.isArray(value)) return [];
  return value.map((chunk) => {
    const pair = Array.isArray(chunk) ? chunk : [];
    return [num(pair[0]), str(pair[1])] as const;
  });
}

function gridOrNew(state: NeovimUiState, id: number): Grid {
  let grid = state.grids.get(id);
  if (!grid) {
    grid = newGrid(id, 0, 0);
    state.grids.set(id, grid);
  }
  return grid;
}

function gridLine(
  state: NeovimUiState,
  changes: RedrawChanges,
  args: readonly unknown[],
): void {
  const grid = state.grids.get(num(args[0]));
  if (!grid) return;
  const row = num(args[1]);
  if (row < 0 || row >= grid.height) return;
  let col = num(args[2]);
  const cells = Array.isArray(args[3]) ? (args[3] as unknown[]) : [];
  let hl = 0;
  const base = row * grid.width;
  for (const cell of cells) {
    if (!Array.isArray(cell)) continue;
    const text = str(cell[0]);
    if (cell.length > 1 && typeof cell[1] === "number") hl = cell[1];
    const repeat = cell.length > 2 ? num(cell[2], 1) : 1;
    for (let i = 0; i < repeat && col < grid.width; i += 1) {
      grid.chars[base + col] = text;
      grid.hls[base + col] = hl;
      col += 1;
    }
  }
  grid.dirty.add(row);
  changes.grids.add(grid.id);
}

function gridScroll(
  state: NeovimUiState,
  changes: RedrawChanges,
  args: readonly unknown[],
): void {
  const grid = state.grids.get(num(args[0]));
  if (!grid) return;
  const top = num(args[1]);
  const bot = Math.min(num(args[2]), grid.height);
  const left = num(args[3]);
  const right = Math.min(num(args[4]), grid.width);
  const rows = num(args[5]);
  if (rows === 0) return;
  const w = grid.width;
  const copyRow = (to: number, from: number) => {
    for (let col = left; col < right; col += 1) {
      grid.chars[to * w + col] = grid.chars[from * w + col] ?? " ";
      grid.hls[to * w + col] = grid.hls[from * w + col] ?? 0;
    }
    grid.dirty.add(to);
  };
  // The region moves up (`rows > 0`) or down; what is uncovered keeps its
  // old cells, which Neovim always rewrites with `grid_line` next.
  if (rows > 0) {
    for (let row = top; row < bot - rows; row += 1) copyRow(row, row + rows);
  } else {
    for (let row = bot - 1; row >= top - rows; row -= 1) {
      copyRow(row, row + rows);
    }
  }
  changes.grids.add(grid.id);
}

/** Fold one `redraw` notification's batches into `state`. */
export function applyRedraw(
  state: NeovimUiState,
  batches: readonly unknown[],
  changes: RedrawChanges = emptyChanges(),
): RedrawChanges {
  for (const batch of batches) {
    if (!Array.isArray(batch) || typeof batch[0] !== "string") continue;
    const name = batch[0];
    for (let i = 1; i < batch.length; i += 1) {
      const args = Array.isArray(batch[i]) ? (batch[i] as unknown[]) : [];
      applyEvent(state, changes, name, args);
    }
  }
  return changes;
}

function applyEvent(
  state: NeovimUiState,
  changes: RedrawChanges,
  name: string,
  args: readonly unknown[],
): void {
  switch (name) {
    case "grid_resize": {
      const id = num(args[0]);
      const width = Math.max(0, num(args[1]));
      const height = Math.max(0, num(args[2]));
      const grid = state.grids.get(id);
      if (grid) resizeGrid(grid, width, height);
      else state.grids.set(id, newGrid(id, width, height));
      changes.grids.add(id);
      changes.layout = true;
      return;
    }
    case "grid_line":
      gridLine(state, changes, args);
      return;
    case "grid_clear": {
      const grid = state.grids.get(num(args[0]));
      if (!grid) return;
      grid.chars.fill(" ");
      grid.hls.fill(0);
      for (let row = 0; row < grid.height; row += 1) grid.dirty.add(row);
      changes.grids.add(grid.id);
      return;
    }
    case "grid_destroy": {
      const id = num(args[0]);
      state.grids.delete(id);
      state.gridWins.delete(id);
      state.windows.delete(id);
      changes.grids.add(id);
      changes.layout = true;
      return;
    }
    case "grid_cursor_goto":
      state.cursor = {
        grid: num(args[0]),
        row: num(args[1]),
        col: num(args[2]),
      };
      changes.cursor = true;
      return;
    case "grid_scroll":
      gridScroll(state, changes, args);
      return;
    case "default_colors_set":
      state.defaults = {
        foreground: color(args[0]) ?? state.fallback.foreground,
        background: color(args[1]) ?? state.fallback.background,
        special: color(args[2]) ?? state.fallback.special,
      };
      changes.colors = true;
      return;
    case "hl_attr_define":
      state.hl.set(num(args[0]), attrOf(args[1]));
      changes.colors = true;
      return;
    case "win_pos": {
      const grid = num(args[0]);
      state.gridWins.set(grid, num(args[1]));
      gridOrNew(state, grid);
      setWindow(state, grid, {
        kind: "window",
        win: num(args[1]),
        row: num(args[2]),
        col: num(args[3]),
        width: num(args[4]),
        height: num(args[5]),
      });
      changes.layout = true;
      return;
    }
    case "win_float_pos": {
      const grid = num(args[0]);
      gridOrNew(state, grid);
      const anchor = str(args[2]);
      setWindow(state, grid, {
        kind: "float",
        win: num(args[1]),
        anchor:
          anchor === "NE" || anchor === "SW" || anchor === "SE" ? anchor : "NW",
        anchorGrid: num(args[3], 1),
        anchorRow: num(args[4]),
        anchorCol: num(args[5]),
        focusable: args[6] !== false,
        zindex: num(args[7], 50),
      });
      changes.layout = true;
      return;
    }
    case "win_external_pos":
      return;
    case "win_hide": {
      const window = state.windows.get(num(args[0]));
      if (window) window.hidden = true;
      changes.layout = true;
      return;
    }
    case "win_close": {
      state.windows.delete(num(args[0]));
      changes.layout = true;
      return;
    }
    case "msg_set_pos": {
      const grid = num(args[0]);
      gridOrNew(state, grid);
      setWindow(state, grid, {
        kind: "message",
        row: num(args[1]),
        scrolled: args[2] === true,
      });
      changes.layout = true;
      return;
    }
    case "win_viewport": {
      state.gridWins.set(num(args[0]), num(args[1]));
      const window = state.windows.get(num(args[0]));
      if (!window) return;
      window.viewport = {
        topline: num(args[2]),
        botline: num(args[3]),
        curline: num(args[4]),
        curcol: num(args[5]),
        lineCount: num(args[6]),
      };
      // 0.10+: how many screen rows the view scrolled, for a GUI that
      // animates it (0.9 sends none).
      const delta = num(args[7]);
      if (delta !== 0) {
        const grid = num(args[0]);
        changes.scrolled.set(grid, (changes.scrolled.get(grid) ?? 0) + delta);
      }
      return;
    }
    case "mode_info_set":
      state.cursorStyleEnabled = args[0] !== false;
      state.modes = Array.isArray(args[1])
        ? (args[1] as unknown[]).map(modeInfoOf)
        : [];
      changes.cursor = true;
      return;
    case "mode_change":
      state.mode = { name: str(args[0]), index: num(args[1]) };
      changes.cursor = true;
      return;
    case "option_set":
      state.options.set(str(args[0]), args[1]);
      changes.options = true;
      return;
    case "busy_start":
      state.busy = true;
      changes.cursor = true;
      return;
    case "busy_stop":
      state.busy = false;
      changes.cursor = true;
      return;
    case "mouse_on":
      state.mouse = true;
      return;
    case "mouse_off":
      state.mouse = false;
      return;
    case "set_title":
      state.title = str(args[0]);
      return;
    case "flush":
      changes.flushed = true;
      return;
    case "popupmenu_show": {
      const items = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
      state.popupmenu = {
        items: items.map((item) => {
          const parts = Array.isArray(item) ? item : [];
          return {
            word: str(parts[0]),
            kind: str(parts[1]),
            menu: str(parts[2]),
            info: str(parts[3]),
          };
        }),
        selected: num(args[1], -1),
        row: num(args[2]),
        col: num(args[3]),
        grid: num(args[4], 1),
      };
      changes.popupmenu = true;
      return;
    }
    case "popupmenu_select":
      if (state.popupmenu) state.popupmenu.selected = num(args[0], -1);
      changes.popupmenu = true;
      return;
    case "popupmenu_hide":
      state.popupmenu = undefined;
      changes.popupmenu = true;
      return;
    case "cmdline_show": {
      const level = num(args[5], 1);
      const shown: CmdlineLevel = {
        content: chunksOf(args[0]),
        pos: num(args[1]),
        firstc: str(args[2]),
        prompt: str(args[3]),
        indent: num(args[4]),
        level,
      };
      state.cmdline = [
        ...state.cmdline.filter((one) => one.level < level),
        shown,
      ];
      changes.cmdline = true;
      return;
    }
    case "cmdline_pos": {
      const one = state.cmdline.find((l) => l.level === num(args[1], 1));
      if (one) one.pos = num(args[0]);
      changes.cmdline = true;
      return;
    }
    case "cmdline_special_char": {
      const one = state.cmdline.find((l) => l.level === num(args[2], 1));
      if (one) one.special = { char: str(args[0]), shift: args[1] === true };
      changes.cmdline = true;
      return;
    }
    case "cmdline_hide": {
      // 0.9 sends no level; 0.10 sends it. Without one, the innermost goes.
      const level = args.length > 0 ? num(args[0]) : undefined;
      state.cmdline =
        level === undefined
          ? state.cmdline.slice(0, -1)
          : state.cmdline.filter((one) => one.level < level);
      changes.cmdline = true;
      return;
    }
    case "cmdline_block_show":
      state.cmdlineBlock = Array.isArray(args[0])
        ? (args[0] as unknown[]).map(chunksOf)
        : [];
      changes.cmdline = true;
      return;
    case "cmdline_block_append":
      state.cmdlineBlock = [...(state.cmdlineBlock ?? []), chunksOf(args[0])];
      changes.cmdline = true;
      return;
    case "cmdline_block_hide":
      state.cmdlineBlock = undefined;
      changes.cmdline = true;
      return;
    case "tabline_update": {
      const tabs = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
      state.tabline = {
        current: num(args[0]),
        tabs: tabs.map((tab) => {
          const m = (tab ?? {}) as Record<string, unknown>;
          return { tab: num(m["tab"]), name: str(m["name"]) };
        }),
      };
      changes.tabline = true;
      return;
    }
    default:
      // `hl_group_set`, `chdir`, `bell`, `update_menu`, … : nothing to draw.
      return;
  }
}

function setWindow(
  state: NeovimUiState,
  grid: number,
  placement: GridPlacement,
): void {
  const known = state.windows.get(grid);
  if (known) {
    known.placement = placement;
    known.hidden = false;
  } else {
    state.windows.set(grid, { grid, placement, hidden: false });
  }
}

/**
 * Place the window grids Neovim did not place, from where Lua says their
 * windows are. A UI that attaches to a Neovim another UI had is not sent
 * `win_pos` for a window that did not move — the current one, typically —
 * so its grid would have nowhere to be drawn. Windows already placed by
 * `win_pos` are left to it. Answers whether anything was placed.
 */
export function placeUnplacedWindows(
  state: NeovimUiState,
  layout: readonly {
    readonly win: number;
    readonly row: number;
    readonly col: number;
    readonly width: number;
    readonly height: number;
  }[],
): boolean {
  let placed = false;
  for (const [grid, win] of state.gridWins) {
    if (state.windows.has(grid) || !state.grids.has(grid)) continue;
    const at = layout.find((one) => one.win === win);
    if (!at) continue;
    setWindow(state, grid, {
      kind: "window",
      win,
      row: at.row,
      col: at.col,
      width: at.width,
      height: at.height,
    });
    placed = true;
  }
  return placed;
}

/** A grid's top-left, in cells of grid 1, and how it stacks. */
export interface GridBox {
  readonly grid: number;
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
  /** Higher is drawn over lower. Grid 1 is 0, windows 1, floats their zindex. */
  readonly z: number;
  readonly float: boolean;
  readonly win: number | undefined;
}

/**
 * Where every grid on screen goes, in grid 1's cells, lowest first. A float
 * is placed against its anchor grid's own box, which is placed first; a
 * hidden window and one whose anchor is not on screen are not on screen.
 */
export function layoutGrids(state: NeovimUiState): GridBox[] {
  const boxes = new Map<number, GridBox>();
  const base = state.grids.get(1);
  if (base) {
    boxes.set(1, {
      grid: 1,
      row: 0,
      col: 0,
      width: base.width,
      height: base.height,
      z: 0,
      float: false,
      win: undefined,
    });
  }
  const place = (window: WindowState, depth: number): GridBox | undefined => {
    const known = boxes.get(window.grid);
    if (known) return known;
    if (window.hidden || depth > 8) return undefined;
    const grid = state.grids.get(window.grid);
    if (!grid) return undefined;
    const p = window.placement;
    let box: GridBox | undefined;
    if (p.kind === "window") {
      box = {
        grid: window.grid,
        row: p.row,
        col: p.col,
        width: grid.width,
        height: grid.height,
        z: 1,
        float: false,
        win: p.win,
      };
    } else if (p.kind === "message") {
      box = {
        grid: window.grid,
        row: p.row,
        col: 0,
        width: grid.width,
        height: grid.height,
        z: 200,
        float: false,
        win: undefined,
      };
    } else {
      const anchorWindow = state.windows.get(p.anchorGrid);
      const anchor =
        p.anchorGrid === 1
          ? boxes.get(1)
          : anchorWindow
            ? place(anchorWindow, depth + 1)
            : undefined;
      if (!anchor) return undefined;
      let row = anchor.row + p.anchorRow;
      let col = anchor.col + p.anchorCol;
      if (p.anchor === "NE" || p.anchor === "SE") col -= grid.width;
      if (p.anchor === "SW" || p.anchor === "SE") row -= grid.height;
      // Kept on the screen, as Neovim's own compositor keeps a float that
      // would run past an edge (a hover near the right, a menu at the bottom).
      const screen = boxes.get(1);
      if (screen) {
        row = Math.min(row, screen.height - grid.height);
        col = Math.min(col, screen.width - grid.width);
      }
      box = {
        grid: window.grid,
        row: Math.max(0, Math.round(row)),
        col: Math.max(0, Math.round(col)),
        width: grid.width,
        height: grid.height,
        z: 100 + p.zindex,
        float: true,
        win: p.win,
      };
    }
    boxes.set(window.grid, box);
    return box;
  };
  for (const window of state.windows.values()) place(window, 0);
  return [...boxes.values()].sort((a, b) => a.z - b.z);
}

/** The text of one row of a grid, for tests and the accessibility tree. */
export function gridRowText(grid: Grid, row: number): string {
  return grid.chars.slice(row * grid.width, (row + 1) * grid.width).join("");
}

/** The cursor's style in the current mode. */
export function currentModeInfo(state: NeovimUiState): ModeInfo | undefined {
  return state.modes[state.mode.index];
}

/** A byte offset of UTF-8 text, as a character offset (cmdline positions). */
export function charOffsetOfByte(text: string, byte: number): number {
  let bytes = 0;
  let chars = 0;
  for (const ch of text) {
    if (bytes >= byte) break;
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    chars += ch.length;
  }
  return chars;
}
