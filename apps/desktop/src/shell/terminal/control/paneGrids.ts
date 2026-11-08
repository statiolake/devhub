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
      }
    | undefined;
  /** The `command-prompt` or `confirm-before` open now: one line at the foot. */
  prompt: Omit<Extract<ControlToPage, { kind: "prompt" }>, "kind"> | undefined;
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
    modes: new Map(),
    hlIds: new Map(),
  };
}

/** The popup's grid: grid 1, which no pane has (`gridOf`). */
export const POPUP_GRID = 1;
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
  for (const row of frame.dirty) {
    if (row.y >= grid.height) continue;
    const at = row.y * grid.width;
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
    case "notice":
    case "ended":
      return changes;
  }
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
  return [...panesBoxes(view), ...popupBox];
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
 * In cells: `x`/`y` the gap cell, `length` how far it runs.
 */
export function borders(
  panes: readonly PaneBox[],
): { vertical: boolean; x: number; y: number; length: number }[] {
  const lines: { vertical: boolean; x: number; y: number; length: number }[] =
    [];
  for (const a of panes) {
    for (const b of panes) {
      if (b.x === a.x + a.width + 1) {
        const top = Math.max(a.y, b.y);
        const bottom = Math.min(a.y + a.height, b.y + b.height);
        if (bottom > top)
          lines.push({
            vertical: true,
            x: a.x + a.width,
            y: top,
            length: bottom - top,
          });
      }
      if (b.y === a.y + a.height + 1) {
        const left = Math.max(a.x, b.x);
        const right = Math.min(a.x + a.width, b.x + b.width);
        if (right > left)
          lines.push({
            vertical: false,
            x: left,
            y: a.y + a.height,
            length: right - left,
          });
      }
    }
  }
  return lines;
}
