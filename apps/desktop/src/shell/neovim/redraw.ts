/**
 * Neovim's UI protocol, folded into a state the painter draws.
 *
 * DevHub attaches to a headless Neovim as its only UI with `ext_linegrid`,
 * `ext_multigrid`, `ext_popupmenu`, `ext_cmdline`, `ext_messages` and
 * `ext_tabline`
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

import { NEOVIM_RESTARTED_EVENT } from "../../ipc/neovim.js";
import { analyzeFrame, type FloatFrame, type FloatLabels } from "./frame.js";

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
  /**
   * The groups it is made of (`ext_hlstate`'s info: each item's `ui_name`
   * and `hi_name`), so a selection or a diff's filler is known by name
   * rather than by colour.
   */
  readonly groups?: readonly string[];
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
  /**
   * The screen rows the window has scrolled since it was first seen (the
   * sum of `scroll_delta`): what Lua placed is moved by the rows scrolled
   * after it came (`riders.ts`).
   */
  scrolledRows?: number;
}

/** Cells on each side of a grid's text area. */
export interface Margins {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
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

/**
 * A message's text (`ext_messages`): each chunk's highlight (`attr`, as the
 * grids' ids), its text, and its highlight group's id (`hl_id`), which Lua
 * turns back into a group for the pager's buffer.
 */
export interface MsgChunk {
  readonly attr: number;
  readonly text: string;
  readonly hl: number;
}

/** A message, as `msg_show` says it. */
export interface MsgShow {
  readonly kind: string;
  readonly content: readonly MsgChunk[];
  readonly replaceLast: boolean;
  readonly history: boolean;
  readonly append: boolean;
  /** Neovim's id: a message with the same one replaces it. */
  readonly id: string;
  /** `"typed_cmd"`: the person typed the command that said it. */
  readonly trigger: string;
}

/** What `ext_messages` said since the page last took it (`takeMessages`). */
export type MessageEvent =
  | { readonly type: "show"; readonly msg: MsgShow }
  | {
      readonly type: "history";
      readonly entries: readonly {
        readonly kind: string;
        readonly content: readonly MsgChunk[];
      }[];
    };

export interface TabState {
  readonly tab: number;
  readonly name: string;
}

export interface NeovimUiState {
  readonly grids: Map<number, Grid>;
  /** Which window each grid is, as `win_pos` and `win_viewport` say. */
  readonly gridWins: Map<number, number>;
  /**
   * `win_viewport_margins`, by grid: the cells around a window's text
   * area — a float's border, a winbar. (It can come before the window's
   * position.)
   */
  readonly margins: Map<number, Margins>;
  /**
   * Each float's `title` and `footer`, by window handle, as
   * `nvim_win_get_config` answered (the page asks when a border holds text):
   * what lets a border's text be drawn as a label on its line.
   */
  readonly floatLabels: Map<number, FloatLabels>;
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
  /**
   * The command line last entered (`firstc` and text), not abandoned: what
   * names the output it printed (`:ls`) in the pager.
   */
  lastCommand: string | undefined;
  /**
   * The messages that ask before a prompt (`confirm`: `confirm()`,
   * `inputlist()`, the swap file's question, `z=`) and any said with them,
   * line by line: shown over the prompt's command line until it is answered.
   */
  prompt: (readonly MsgChunk[])[] | undefined;
  /** The search just entered (`search_cmd`) and its count, as Neovim echoes them. */
  searchEcho: { text: string; count: string } | undefined;
  /** `msg_showmode` (`-- INSERT --`, recording), `msg_showcmd`, `msg_ruler`. */
  showmode: readonly MsgChunk[];
  showcmd: readonly MsgChunk[];
  ruler: readonly MsgChunk[];
  /** Messages for the page to route (`messages.ts`), oldest first. */
  messages: MessageEvent[];
  tabline: { current: number; tabs: readonly TabState[] } | undefined;
  /**
   * Neovim draws a screen of its own on grid 1, over its windows, and
   * waits for a key (`:intro`): grid 1 is drawn over the windows until
   * Neovim draws its windows again (`screenOf`).
   */
  screen: boolean;
  /** This flush so far: grid 1 cleared, a window drawn (`screenOf`). */
  readonly pass: { cleared: boolean; windows: boolean };
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
  /** A message came, or the band's mode, showcmd, ruler or search echo changed. */
  messages: boolean;
  tabline: boolean;
  options: boolean;
  /** A `flush` arrived: what is in the state is a frame to draw. */
  flushed: boolean;
  /** Screen rows each window grid scrolled (`win_viewport`'s scroll_delta). */
  readonly scrolled: Map<number, number>;
  /**
   * Each grid's `grid_scroll` region and rows since the last paint, or
   * `null` when it had more than one (`painter.ts` slides lines a `dd` or
   * an `o` moved, when the window itself did not scroll).
   */
  readonly moved: Map<number, LinesMoved | null>;
}

/** A `grid_scroll`: the region's rows and columns, and how far it moved. */
export interface LinesMoved {
  readonly top: number;
  readonly bot: number;
  readonly left: number;
  readonly right: number;
  /** Up when positive (lines deleted above the region's end), as Neovim says. */
  readonly rows: number;
}

export function emptyChanges(): RedrawChanges {
  return {
    grids: new Set(),
    colors: false,
    cursor: false,
    layout: false,
    popupmenu: false,
    cmdline: false,
    messages: false,
    tabline: false,
    options: false,
    flushed: false,
    scrolled: new Map(),
    moved: new Map(),
  };
}

export function initialUiState(
  fallback = { foreground: 0xffffff, background: 0x000000, special: 0xff0000 },
): NeovimUiState {
  return {
    grids: new Map(),
    gridWins: new Map(),
    margins: new Map(),
    floatLabels: new Map(),
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
    lastCommand: undefined,
    prompt: undefined,
    searchEcho: undefined,
    showmode: [],
    showcmd: [],
    ruler: [],
    messages: [],
    tabline: undefined,
    screen: false,
    pass: { cleared: false, windows: false },
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

/** `ext_hlstate`'s info items' group names, each once. */
function groupsOf(info: unknown): string[] | undefined {
  if (!Array.isArray(info)) return undefined;
  const out = new Set<string>();
  for (const item of info) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    for (const key of ["ui_name", "hi_name"]) {
      const v = r[key];
      if (typeof v === "string" && v !== "") out.add(v);
    }
  }
  return out.size > 0 ? [...out] : undefined;
}

function attrOf(map: unknown, info?: unknown): HlAttr {
  const groups = groupsOf(info);
  if (map === null || typeof map !== "object") return groups ? { groups } : {};
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
    groups,
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

function msgChunksOf(value: unknown): MsgChunk[] {
  if (!Array.isArray(value)) return [];
  return value.map((chunk) => {
    const c = Array.isArray(chunk) ? chunk : [];
    return { attr: num(c[0]), text: str(c[1]), hl: num(c[2]) };
  });
}

/** A message's text, its chunks joined. */
export function msgText(content: readonly MsgChunk[]): string {
  return content.map((c) => c.text).join("");
}

/** Chunks split at their newlines: a message's lines. */
export function msgLines(content: readonly MsgChunk[]): MsgChunk[][] {
  const lines: MsgChunk[][] = [[]];
  for (const chunk of content) {
    const parts = chunk.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== "") lines.at(-1)?.push({ ...chunk, text: part });
    });
  }
  return lines;
}

/** `[2/5]` out of a `search_count` message (`/foo   [2/5]`). */
function searchCountOf(content: readonly MsgChunk[]): string {
  return /\[[^\]]*\]\s*$/.exec(msgText(content))?.[0].trim() ?? "";
}

function msgShow(
  state: NeovimUiState,
  changes: RedrawChanges,
  args: readonly unknown[],
): void {
  const msg: MsgShow = {
    kind: str(args[0]),
    content: msgChunksOf(args[1]),
    replaceLast: args[2] === true,
    history: args[3] === true,
    append: args[4] === true,
    id: typeof args[5] === "number" ? String(args[5]) : str(args[5]),
    trigger: str(args[6]),
  };
  changes.messages = true;
  switch (msg.kind) {
    case "confirm": {
      // What was said with it (the swap file's E325) is its heading: one
      // screen of Neovim's, shown together over the prompt.
      const said = state.messages.flatMap((m) =>
        m.type === "show" && m.msg.kind !== "empty" ? [m.msg] : [],
      );
      state.messages = state.messages.filter((m) => m.type !== "show");
      state.prompt = [...said, msg].flatMap((m) => msgLines(m.content));
      return;
    }
    case "search_cmd":
      state.searchEcho = { text: msgText(msg.content).trimEnd(), count: "" };
      return;
    case "search_count":
      state.searchEcho = {
        text:
          state.searchEcho?.text ??
          msgText(msg.content)
            .replace(/\[[^\]]*\]\s*$/, "")
            .trimEnd(),
        count: searchCountOf(msg.content),
      };
      return;
    case "empty":
      // `:echo ""`: what shares the command line's rows is cleared.
      state.searchEcho = undefined;
      return;
    default:
      state.messages.push({ type: "show", msg });
  }
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
  changes.moved.set(
    grid.id,
    changes.moved.has(grid.id) ? null : { top, bot, left, right, rows },
  );
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

/**
 * Whether grid 1 shows a screen of Neovim's own at this flush: Neovim
 * cleared grid 1 and drew text inside its windows' places without
 * drawing any window (`:intro`, waiting for a key) — with
 * `ext_multigrid` Neovim never draws there otherwise; it stays so until
 * a flush draws a window again, which Neovim does once the key comes.
 */
export function screenOf(state: NeovimUiState): boolean {
  if (state.pass.windows) return false;
  if (!state.pass.cleared) return state.screen;
  const grid = state.grids.get(1);
  if (!grid) return false;
  for (const w of state.windows.values()) {
    const p = w.placement;
    if (p.kind !== "window" || w.hidden) continue;
    for (let row = p.row; row < p.row + p.height && row < grid.height; row += 1)
      for (
        let col = p.col;
        col < p.col + p.width && col < grid.width;
        col += 1
      ) {
        const c = grid.chars[row * grid.width + col];
        if (c !== undefined && c !== " " && c !== "") return true;
      }
  }
  return false;
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

/**
 * DevHub's own marker in the redraw stream, not Neovim's: the UI attached
 * again to the server a `:restart` started (`neovimUiSessions.ts`), and
 * what follows is that server's screen from scratch. Everything the old
 * server said is forgotten here, in order with the new server's first
 * events, so the frame drawn at its first `flush` is wholly the new
 * server's and the one before stays on screen until then.
 */
export const RESTARTED_EVENT = NEOVIM_RESTARTED_EVENT;

function applyEvent(
  state: NeovimUiState,
  changes: RedrawChanges,
  name: string,
  args: readonly unknown[],
): void {
  switch (name) {
    case RESTARTED_EVENT: {
      for (const id of state.grids.keys()) changes.grids.add(id);
      // The old colours stay until the new server says its own, so the
      // ground does not flash to the fallback in between.
      const defaults = state.defaults;
      Object.assign(state, initialUiState(state.fallback), { defaults });
      changes.colors = true;
      changes.cursor = true;
      changes.layout = true;
      changes.popupmenu = true;
      changes.cmdline = true;
      changes.messages = true;
      changes.tabline = true;
      changes.options = true;
      return;
    }
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
      if (num(args[0]) !== 1 && state.gridWins.has(num(args[0])))
        state.pass.windows = true;
      return;
    case "grid_clear": {
      const grid = state.grids.get(num(args[0]));
      if (!grid) return;
      if (grid.id === 1) state.pass.cleared = true;
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
      state.margins.delete(id);
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
      state.hl.set(num(args[0]), attrOf(args[1], args[3]));
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
      const closing = state.windows.get(num(args[0]));
      if (closing?.placement.kind === "float")
        state.floatLabels.delete(closing.placement.win);
      state.windows.delete(num(args[0]));
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
      // How many screen rows the view scrolled, for a GUI that animates it.
      const delta = num(args[7]);
      if (delta !== 0) {
        const grid = num(args[0]);
        changes.scrolled.set(grid, (changes.scrolled.get(grid) ?? 0) + delta);
      }
      window.scrolledRows = (window.scrolledRows ?? 0) + delta;
      return;
    }
    case "win_viewport_margins": {
      const grid = num(args[0]);
      const margins = {
        top: num(args[2]),
        bottom: num(args[3]),
        left: num(args[4]),
        right: num(args[5]),
      };
      const known = state.margins.get(grid);
      if (
        known?.top !== margins.top ||
        known.bottom !== margins.bottom ||
        known.left !== margins.left ||
        known.right !== margins.right
      ) {
        state.margins.set(grid, margins);
        changes.layout = true;
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
    case "flush": {
      changes.flushed = true;
      const screen = screenOf(state);
      if (screen !== state.screen) {
        state.screen = screen;
        const grid1 = state.grids.get(1);
        for (let row = 0; row < (grid1?.height ?? 0); row += 1)
          grid1?.dirty.add(row);
        changes.grids.add(1);
        changes.layout = true;
      }
      state.pass.cleared = false;
      state.pass.windows = false;
      return;
    }
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
      // A new command line is typed where the last search was echoed.
      if (shown.prompt === "") state.searchEcho = undefined;
      changes.cmdline = true;
      changes.messages = true;
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
      const level = num(args[0], 1);
      const aborted = args[1] === true;
      const hidden = state.cmdline.find((one) => one.level === level);
      if (hidden && !aborted && hidden.prompt === "" && hidden.firstc !== "") {
        state.lastCommand =
          hidden.firstc + hidden.content.map(([, text]) => text).join("");
      }
      state.cmdline = state.cmdline.filter((one) => one.level < level);
      // A prompt is answered (or abandoned) when its command line goes.
      if (state.cmdline.length === 0 && state.prompt) {
        state.prompt = undefined;
        changes.messages = true;
      }
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
    case "msg_show":
      msgShow(state, changes, args);
      return;
    case "msg_clear":
      // The screen was cleared: what shares the command line's rows goes.
      // Notifications fade by themselves; a prompt waiting stays.
      state.searchEcho = undefined;
      if (state.cmdline.length === 0) state.prompt = undefined;
      changes.messages = true;
      return;
    case "msg_showmode":
      state.showmode = msgChunksOf(args[0]);
      changes.messages = true;
      return;
    case "msg_showcmd":
      state.showcmd = msgChunksOf(args[0]);
      changes.messages = true;
      return;
    case "msg_ruler":
      state.ruler = msgChunksOf(args[0]);
      changes.messages = true;
      return;
    case "msg_history_show": {
      const entries = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
      state.messages.push({
        type: "history",
        entries: entries.map((entry) => {
          const e = Array.isArray(entry) ? entry : [];
          return { kind: str(e[0]), content: msgChunksOf(e[1]) };
        }),
      });
      changes.messages = true;
      return;
    }
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
  /** A float with a border of its own: no padding of DevHub's round it. */
  readonly lined?: boolean;
  /**
   * That border as a frame (`frame.ts`), whatever its cells are (blank,
   * lines, a table of characters): the canvas is the text area, DevHub's
   * one rounded line goes through the middle of the border's cells, its
   * title and footer cells on it. Without it (text in a side, a border
   * wider than a cell), the border is drawn cell for cell.
   */
  readonly frame?: FloatFrame;
  /** Its border holds text its known `title` / `footer` do not explain. */
  readonly wantsLabels?: boolean;
  /**
   * A float its page frames itself (a tmux popup, the chooser's preview, a
   * framed view's windows: `claimFloats`): drawn as its cells, with no
   * panel of DevHub's round it.
   */
  readonly bare?: boolean;
}

/**
 * The boxes, with the floats whose windows `claimed` names bare: a page
 * draws their chrome (a framed `gui.view`'s frame, query, list and
 * preview windows), so the painter draws their cells and no frame,
 * padding or shadow of its own, as for a tmux popup.
 */
export function claimFloats(
  boxes: readonly GridBox[],
  claimed: ReadonlySet<number>,
): GridBox[] {
  if (claimed.size === 0) return [...boxes];
  return boxes.map((b) =>
    b.float && b.win !== undefined && claimed.has(b.win)
      ? { ...b, bare: true }
      : b,
  );
}

/**
 * How a float's border shows: `frame` when its cells make one (any
 * character, a `title` and `footer` on it), `lined` when they draw
 * something else, neither without one.
 */
export function floatBorder(
  grid: Grid,
  margins: Margins | undefined,
  labels?: FloatLabels,
): {
  lined?: boolean;
  frame?: FloatFrame;
  wantsLabels?: boolean;
} {
  if (!margins) return {};
  const { top, right, bottom, left } = margins;
  if (top + right + bottom + left === 0) return {};
  if (top + bottom >= grid.height || left + right >= grid.width)
    return { lined: true };
  const seen = analyzeFrame(grid, margins, labels);
  if (seen.frame) return { lined: true, frame: seen.frame };
  return seen.labels ? { lined: true, wantsLabels: true } : { lined: true };
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
        ...floatBorder(
          grid,
          state.margins.get(window.grid),
          state.floatLabels.get(p.win),
        ),
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
