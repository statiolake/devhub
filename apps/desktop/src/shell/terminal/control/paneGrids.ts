/**
 * The control client's news (`ipc/terminalControl.ts`) as the Neovim
 * editor's painter takes it (`../../neovim/painter.ts`): one grid per tmux
 * pane, placed at the pane's rectangle in the window, and the panes' styles
 * as highlights. One painter, one font measurement and one baseline for
 * Neovim and the terminal alike (`docs/terminal-mode.md`, "The font, once").
 *
 * Pure: the surface (`ControlTerminalSurface.tsx`) owns the painter.
 */

import type {
  ControlToPage,
  PaneBox,
  PaneModes,
  SessionPane,
  VtCursor,
  VtFrame,
  VtStyle,
  WindowInfo,
} from "../../../ipc/terminalControl";
import { mixColors } from "../../neovim/painter";
import {
  emptyChanges,
  initialUiState,
  type GridBox,
  type HlAttr,
  type NeovimUiState,
  type RedrawChanges,
} from "../../neovim/redraw";

const UNDERLINES: Readonly<Record<number, keyof HlAttr>> = {
  1: "underline",
  2: "underdouble",
  3: "undercurl",
  4: "underdotted",
  5: "underdashed",
};

/**
 * A pane's style as a Neovim highlight. `defaults` are the terminal's own
 * colours, which hidden and faint text are drawn against.
 */
export function hlOf(
  style: VtStyle,
  defaults: { readonly foreground: number; readonly background: number },
): HlAttr {
  const hl: { -readonly [K in keyof HlAttr]: HlAttr[K] } = {};
  if (style.fg !== undefined) hl.foreground = style.fg;
  if (style.bg !== undefined) hl.background = style.bg;
  if (style.bold === true) hl.bold = true;
  if (style.italic === true) hl.italic = true;
  if (style.inverse === true) hl.reverse = true;
  if (style.strikethrough === true) hl.strikethrough = true;
  const underline =
    style.underline !== undefined ? UNDERLINES[style.underline] : undefined;
  if (underline !== undefined)
    (hl as Record<string, unknown>)[underline] = true;
  const ground = style.bg ?? defaults.background;
  // Faint (SGR 2): the ink half way to its ground, as terminals draw it.
  if (style.faint === true)
    hl.foreground = mixColors(style.fg ?? defaults.foreground, ground, 50);
  // Hidden (SGR 8): ink the colour of its ground.
  if (style.invisible === true) hl.foreground = ground;
  return hl;
}

/** A grid per pane: its id is the pane's, past grid 1 (which there is none of). */
export const gridOf = (pane: number): number => pane + 2;

export interface ControlView {
  readonly state: NeovimUiState;
  cols: number;
  rows: number;
  session: string;
  windows: readonly WindowInfo[];
  window: number | undefined;
  panes: readonly PaneBox[];
  /** Every pane of the session, every window's. */
  sessionPanes: readonly SessionPane[];
  client: string;
  prefixes: readonly string[];
  readonly cursors: Map<number, VtCursor | undefined>;
  /** The `display-popup` open now, in cells of the window (border included). */
  popup:
    | {
        readonly id: number;
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly border: boolean;
        readonly title: string;
        cursor: VtCursor | undefined;
        modes: PaneModes;
      }
    | undefined;
  /** The `command-prompt` or `confirm-before` open now: one line at the foot. */
  prompt: Omit<Extract<ControlToPage, { kind: "prompt" }>, "kind"> | undefined;
  /** The picker open now (`choose-tree`), its preview in `CHOOSER_GRID`. */
  chooser:
    | Omit<Extract<ControlToPage, { kind: "chooser" }>, "kind">
    | undefined;
  /** `display-panes`: the indexes drawn over the panes. */
  numbers:
    | Omit<Extract<ControlToPage, { kind: "display-panes" }>, "kind">
    | undefined;
  /** Panes in copy mode: what is drawn over their rows (`copy-mode`). */
  readonly copy: Map<
    number,
    Omit<Extract<ControlToPage, { kind: "copy-mode" }>, "kind" | "pane">
  >;
  /** Cells of a grid drawn in another look (a selection), and their own hl. */
  readonly overrides: Map<number, Map<number, number>>;
  /** The selection's colour (Neovim's Visual, the theme's selection). */
  selection: number;
  /** The `display-menu` open now. */
  menu: Omit<Extract<ControlToPage, { kind: "menu" }>, "kind"> | undefined;
  readonly modes: Map<number, PaneModes>;
  /** Each pane's own style ids, as highlights of the one table. */
  readonly hlIds: Map<string, number>;
}

export function newControlView(fallback: {
  foreground: number;
  background: number;
}): ControlView {
  return {
    state: initialUiState({ ...fallback, special: fallback.foreground }),
    cols: 0,
    rows: 0,
    session: "",
    windows: [],
    window: undefined,
    panes: [],
    sessionPanes: [],
    client: "",
    prefixes: [],
    cursors: new Map(),
    popup: undefined,
    prompt: undefined,
    menu: undefined,
    chooser: undefined,
    numbers: undefined,
    copy: new Map(),
    overrides: new Map(),
    selection: mixColors(fallback.foreground, fallback.background, 25),
    modes: new Map(),
    hlIds: new Map(),
  };
}

/** The popup's grid: grid 1, which no pane has (`gridOf`). */
export const POPUP_GRID = 1;
/** The picker's preview: grid 0, which neither a pane nor a popup has. */
export const CHOOSER_GRID = 0;
/** The popup's styles, apart from every pane's. */
const POPUP_STYLES = "popup";

/** One engine's frame into its grid: a pane's, the popup's. */
function applyFrame(
  view: ControlView,
  owner: string,
  id: number,
  frame: VtFrame,
  changes: RedrawChanges,
): void {
  for (const [styleId, style] of frame.styles) {
    const key = `${owner}:${String(styleId)}`;
    let hl = view.hlIds.get(key);
    if (hl === undefined) {
      hl = view.hlIds.size + 1;
      view.hlIds.set(key, hl);
    }
    view.state.hl.set(hl, hlOf(style, view.state.defaults));
  }
  let grid = view.state.grids.get(id);
  if (
    grid === undefined ||
    grid.width !== frame.cols ||
    grid.height !== frame.rows
  ) {
    const size = frame.cols * frame.rows;
    grid = {
      id,
      width: frame.cols,
      height: frame.rows,
      chars: new Array<string>(size).fill(" "),
      hls: new Int32Array(size),
      dirty: new Set(),
    };
    view.state.grids.set(id, grid);
    for (let row = 0; row < frame.rows; row++) grid.dirty.add(row);
    changes.grids.add(id);
  }
  const overrides = view.overrides.get(id);
  for (const row of frame.dirty) {
    if (row.y >= grid.height) continue;
    const at = row.y * grid.width;
    // The row is the engine's again: what was drawn over it is redrawn.
    if (overrides !== undefined)
      for (let x = 0; x < grid.width; x++) overrides.delete(at + x);
    for (let x = 0; x < grid.width && x < row.cells.length; x++) {
      grid.chars[at + x] = row.cells[x];
      const styleId = row.styles[x];
      grid.hls[at + x] =
        styleId === 0
          ? 0
          : (view.hlIds.get(`${owner}:${String(styleId)}`) ?? 0);
    }
    grid.dirty.add(row.y);
  }
}

/** Fold one message into the view; what the painter has to redraw. */
export function applyControl(
  view: ControlView,
  message: ControlToPage,
): RedrawChanges {
  const changes = emptyChanges();
  switch (message.kind) {
    case "layout": {
      view.cols = message.cols;
      view.rows = message.rows;
      view.session = message.session;
      view.windows = message.windows;
      view.window = message.window;
      view.panes = message.panes;
      view.sessionPanes = message.sessionPanes;
      view.client = message.client;
      view.prefixes = message.prefixes;
      changes.layout = true;
      return changes;
    }
    case "pane": {
      const { pane, frame } = message;
      applyFrame(view, String(pane), gridOf(pane), frame, changes);
      if (view.copy.has(pane)) drawCopy(view, pane);
      view.cursors.set(pane, frame.cursor);
      view.modes.set(pane, message.modes);
      changes.cursor = true;
      return changes;
    }
    case "popup": {
      const { frame } = message;
      const fresh = view.popup?.id !== message.id;
      view.popup = {
        id: message.id,
        x: message.x,
        y: message.y,
        width: message.width,
        height: message.height,
        border: message.border,
        title: message.title,
        cursor: frame.cursor,
        modes: message.modes,
      };
      applyFrame(view, POPUP_STYLES, POPUP_GRID, frame, changes);
      changes.layout ||= fresh;
      changes.cursor = true;
      return changes;
    }
    case "popup-closed":
      if (view.popup?.id === message.id) {
        view.popup = undefined;
        view.state.grids.delete(POPUP_GRID);
        changes.layout = true;
        changes.cursor = true;
      }
      return changes;
    case "prompt": {
      const { kind: _, ...prompt } = message;
      view.prompt = prompt;
      changes.cursor = true;
      return changes;
    }
    case "prompt-closed":
      view.prompt = undefined;
      changes.cursor = true;
      return changes;
    case "menu": {
      const { kind: _, ...menu } = message;
      view.menu = menu;
      changes.cursor = true;
      return changes;
    }
    case "menu-closed":
      if (view.menu?.id === message.id) view.menu = undefined;
      changes.cursor = true;
      return changes;
    case "chooser": {
      const { kind: _, ...chooser } = message;
      const fresh = view.chooser?.id !== message.id;
      view.chooser = chooser;
      changes.layout ||= fresh;
      changes.cursor = true;
      return changes;
    }
    case "chooser-preview":
      if (view.chooser?.id === message.id) {
        applyFrame(view, "chooser", CHOOSER_GRID, message.frame, changes);
        changes.layout = true;
      }
      return changes;
    case "chooser-closed":
      if (view.chooser?.id === message.id) {
        view.chooser = undefined;
        view.state.grids.delete(CHOOSER_GRID);
        changes.layout = true;
        changes.cursor = true;
      }
      return changes;
    case "display-panes": {
      const { kind: _, ...numbers } = message;
      view.numbers = numbers;
      changes.cursor = true;
      return changes;
    }
    case "display-panes-closed":
      if (view.numbers?.id === message.id) view.numbers = undefined;
      changes.cursor = true;
      return changes;
    case "copy-mode": {
      const { kind: _, pane, ...copy } = message;
      view.copy.set(pane, copy);
      drawCopy(view, pane);
      changes.grids.add(gridOf(pane));
      changes.cursor = true;
      return changes;
    }
    case "copy-mode-closed":
      view.copy.delete(message.pane);
      undraw(view, gridOf(message.pane));
      changes.grids.add(gridOf(message.pane));
      changes.cursor = true;
      return changes;
    case "notice":
    case "clipboard":
    case "ended":
      return changes;
  }
}

/** A grid's cells drawn over put back to their own look. */
function undraw(view: ControlView, id: number): void {
  const overrides = view.overrides.get(id);
  const grid = view.state.grids.get(id);
  if (overrides === undefined || grid === undefined) return;
  for (const [cell, hl] of overrides) {
    grid.hls[cell] = hl;
    grid.dirty.add(Math.floor(cell / grid.width));
  }
  overrides.clear();
}

/**
 * A highlight drawn over another: its ink and attributes, on `ground`. One
 * per pair, made the first time it is asked for.
 */
function over(view: ControlView, hl: number, ground: number): number {
  const key = `over:${String(ground)}:${String(hl)}`;
  let id = view.hlIds.get(key);
  if (id === undefined) {
    id = view.hlIds.size + 1;
    view.hlIds.set(key, id);
  }
  const base = view.state.hl.get(hl) ?? {};
  view.state.hl.set(id, {
    ...base,
    reverse: false,
    background: ground,
    ...(base.reverse === true
      ? { foreground: base.background ?? view.state.defaults.background }
      : {}),
  });
  return id;
}

/**
 * Copy mode's selection and search matches over a pane's rows, in the
 * selection colour (Neovim's Visual) and half of it.
 */
function drawCopy(view: ControlView, pane: number): void {
  const id = gridOf(pane);
  const copy = view.copy.get(pane);
  const grid = view.state.grids.get(id);
  undraw(view, id);
  if (copy === undefined || grid === undefined) return;
  let overrides = view.overrides.get(id);
  if (overrides === undefined) {
    overrides = new Map();
    view.overrides.set(id, overrides);
  }
  const match = mixColors(view.selection, view.state.defaults.background, 50);
  const paint = (
    spans: readonly { y: number; x0: number; x1: number }[],
    ground: number,
  ) => {
    for (const { y, x0, x1 } of spans) {
      if (y < 0 || y >= grid.height) continue;
      for (let x = x0; x <= x1 && x < grid.width; x++) {
        const cell = y * grid.width + x;
        const own = overrides.get(cell) ?? grid.hls[cell];
        overrides.set(cell, own);
        grid.hls[cell] = over(view, own, ground);
      }
      grid.dirty.add(y);
    }
  };
  paint(copy.matches, match);
  paint(copy.selection, view.selection);
}

/** Where each shown pane's grid goes, in cells of the window. */
export function paneBoxes(view: ControlView): GridBox[] {
  const popup = view.popup;
  const inset = popup?.border === true ? 1 : 0;
  const popupBox: GridBox[] =
    popup === undefined || !view.state.grids.has(POPUP_GRID)
      ? []
      : [
          {
            grid: POPUP_GRID,
            row: popup.y + inset,
            col: popup.x + inset,
            width: popup.width - 2 * inset,
            height: popup.height - 2 * inset,
            z: 50,
            float: true,
            win: undefined,
          },
        ];
  const chooser = view.chooser;
  const chooserBox: GridBox[] =
    chooser === undefined || !view.state.grids.has(CHOOSER_GRID)
      ? []
      : [
          {
            grid: CHOOSER_GRID,
            row: chooser.preview.y,
            col: chooser.preview.x,
            width: chooser.preview.width,
            height: chooser.preview.height,
            z: 60,
            float: true,
            win: undefined,
          },
        ];
  return [...panesBoxes(view), ...popupBox, ...chooserBox];
}

function panesBoxes(view: ControlView): GridBox[] {
  return view.panes
    .filter((box) => view.state.grids.has(gridOf(box.pane)))
    .map((box) => ({
      grid: gridOf(box.pane),
      row: box.y,
      col: box.x,
      width: box.width,
      height: box.height,
      z: 1,
      float: false,
      win: undefined,
    }));
}

/** The pane at a cell of the window, if one is there (a border is none). */
export function paneAt(
  view: ControlView,
  col: number,
  row: number,
): PaneBox | undefined {
  return view.panes.find(
    (box) =>
      col >= box.x &&
      col < box.x + box.width &&
      row >= box.y &&
      row < box.y + box.height,
  );
}

/**
 * The lines between panes: tmux leaves one cell between neighbours, and
 * DevHub draws a hairline down its middle instead of a character border.
 * Traced cell by cell over the gaps, so lines meet: a gap cell beside a pane
 * carries a line through it (down it beside a pane to its left or right,
 * across it beside one above or below), and every gap cell reaches half a
 * cell towards a neighbour whose line runs towards it — where a line ends on
 * another (a T) and where four panes meet (a +), the lines join. In cells:
 * `x`/`y` where it starts (on the gap cell's middle line), `length` how far
 * it runs; halves are cells too.
 */
export function borders(
  panes: readonly PaneBox[],
): { vertical: boolean; x: number; y: number; length: number }[] {
  if (panes.length < 2) return [];
  const cols = Math.max(...panes.map((p) => p.x + p.width));
  const rows = Math.max(...panes.map((p) => p.y + p.height));
  const pane = new Uint8Array(cols * rows);
  for (const p of panes)
    for (let y = p.y; y < p.y + p.height; y++)
      pane.fill(1, y * cols + p.x, y * cols + p.x + p.width);
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < cols && y < rows;
  const isPane = (x: number, y: number) =>
    inside(x, y) && pane[y * cols + x] === 1;
  const isGap = (x: number, y: number) =>
    inside(x, y) && pane[y * cols + x] === 0;
  // A line down the cell (beside a pane left or right), across it (above or below).
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
  const lines: { vertical: boolean; x: number; y: number; length: number }[] =
    [];
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
 * The outlines over the panes, in cells of the window: the active pane's,
 * when the window shows more than one (tmux colours that pane's border; a GUI
 * can go round it), and every synchronized pane's while `synchronize-panes`
 * is on, since what is typed reaches all of them. Each runs down the middle
 * of the gap cells around its pane, on the hairlines; at the window's edge,
 * where tmux leaves no gap, it keeps to the edge.
 */
export function paneRings(panes: readonly PaneBox[]): {
  readonly active: boolean;
  readonly synchronized: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}[] {
  if (panes.length < 2) return [];
  const cols = Math.max(...panes.map((p) => p.x + p.width));
  const rows = Math.max(...panes.map((p) => p.y + p.height));
  return panes
    .filter((p) => p.active || p.synchronized)
    .map((p) => {
      const left = Math.max(0, p.x - 0.5);
      const top = Math.max(0, p.y - 0.5);
      const right = Math.min(cols, p.x + p.width + 0.5);
      const bottom = Math.min(rows, p.y + p.height + 0.5);
      return {
        active: p.active,
        synchronized: p.synchronized,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
    });
}
