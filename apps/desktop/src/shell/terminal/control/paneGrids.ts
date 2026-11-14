/**
 * The control client's news (`ipc/terminalControl.ts`) as the Neovim
 * editor's painter takes it (`../../neovim/painter.ts`): one grid per tmux
 * pane, placed at the pane's rectangle in the window, and the panes' styles
 * as highlights. One painter, one font measurement and one baseline for
 * Neovim and the terminal alike (`docs/terminal-mode.md`, "The font, once").
 *
 * Pure: the surface (`ControlTerminalSurface.tsx`) owns the painter.
 */

import { CONTROL_Z } from "./stacking";
import type {
  ControlToPage,
  CopySpan,
  MouseBindings,
  PaneBox,
  PaneModes,
  SessionPane,
  VtCursor,
  VtFrame,
  VtStyle,
  WindowInfo,
} from "../../../ipc/terminalControl";
import { mixColors } from "../../neovim/painter";
import { borders as traceBorders, type BorderLine } from "../../neovim/chrome";
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
  /** How tmux takes the left button (`routeMouse`); absent until read. */
  mouseBindings: MouseBindings | undefined;
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
  /**
   * The rows a pane's copy mode scrolled (down positive) whose picture has
   * not come yet: the next frame of the pane is its new view, and goes
   * with them to the painter (`RedrawChanges.scrolled`), which slides it in
   * from where the old one was (`smoothScroll.ts`).
   */
  readonly copyShift: Map<number, number>;
  /**
   * Panes whose copy mode has closed while their live picture has not come
   * yet: the mode's view (its badge, its marks) stays until it does, so the
   * pane changes in one frame, not the badge first and the rows after.
   */
  readonly copyClosing: Set<number>;
  /**
   * What DevHub draws over a pane's cells of its own: its selection
   * (`selection.ts`) and the link under the pointer, underlined (`links.ts`).
   */
  readonly marks: Map<
    number,
    {
      readonly selection: readonly CopySpan[];
      readonly underline: readonly CopySpan[];
    }
  >;
  /** Each grid's cells' OSC 8 link ids (`VtRow.links`), row-major; 0 none. */
  readonly linkIds: Map<number, Uint32Array>;
  /** Each grid's link ids' URIs, as its frames last named them. */
  readonly linkUris: Map<number, Map<number, string>>;
  /** Each grid's rows that go on in the next (`VtRow.wrapped`). */
  readonly wrapped: Map<number, Set<number>>;
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
    mouseBindings: undefined,
    cursors: new Map(),
    popup: undefined,
    prompt: undefined,
    menu: undefined,
    chooser: undefined,
    numbers: undefined,
    copy: new Map(),
    copyShift: new Map(),
    copyClosing: new Set(),
    overrides: new Map(),
    marks: new Map(),
    linkIds: new Map(),
    linkUris: new Map(),
    wrapped: new Map(),
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

/**
 * A popup's ground: the panes' a step toward their ink (7 %), so a popup is
 * never the pane it stands on — `popup.css`'s `--float-ground`, the same
 * mix, which its frame wears.
 */
export function popupGround(defaults: {
  readonly foreground: number;
  readonly background: number;
}): number {
  return mixColors(defaults.background, defaults.foreground, 7);
}

/** One engine's frame into its grid: a pane's, the popup's. */
function applyFrame(
  view: ControlView,
  owner: string,
  id: number,
  frame: VtFrame,
  changes: RedrawChanges,
): void {
  // A popup's cells stand on the popup's ground, not the panes'.
  const ground =
    owner === POPUP_STYLES ? popupGround(view.state.defaults) : undefined;
  const defaults =
    ground === undefined
      ? view.state.defaults
      : { ...view.state.defaults, background: ground };
  const hlId = (key: string) => {
    let hl = view.hlIds.get(key);
    if (hl === undefined) {
      hl = view.hlIds.size + 1;
      view.hlIds.set(key, hl);
    }
    return hl;
  };
  for (const [styleId, style] of frame.styles) {
    const hl = hlOf(style, defaults);
    view.state.hl.set(
      hlId(`${owner}:${String(styleId)}`),
      ground !== undefined && style.bg === undefined
        ? { ...hl, background: ground }
        : hl,
    );
  }
  if (ground !== undefined)
    view.state.hl.set(hlId(`${owner}:0`), { background: ground });
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
    view.linkIds.delete(id);
    view.wrapped.delete(id);
  }
  if (frame.links !== undefined) {
    let uris = view.linkUris.get(id);
    if (uris === undefined) {
      uris = new Map();
      view.linkUris.set(id, uris);
    }
    for (const [link, uri] of frame.links) uris.set(link, uri);
  }
  let linkIds = view.linkIds.get(id);
  let wrapped = view.wrapped.get(id);
  const overrides = view.overrides.get(id);
  for (const row of frame.dirty) {
    if (row.y >= grid.height) continue;
    const at = row.y * grid.width;
    // The row is the engine's again: what was drawn over it is redrawn.
    if (overrides !== undefined)
      for (let x = 0; x < grid.width; x++) overrides.delete(at + x);
    if (row.links !== undefined || linkIds !== undefined) {
      if (linkIds === undefined) {
        linkIds = new Uint32Array(grid.width * grid.height);
        view.linkIds.set(id, linkIds);
      }
      for (let x = 0; x < grid.width; x++)
        linkIds[at + x] = row.links?.[x] ?? 0;
    }
    if (row.wrapped === true) {
      if (wrapped === undefined) {
        wrapped = new Set();
        view.wrapped.set(id, wrapped);
      }
      wrapped.add(row.y);
    } else wrapped?.delete(row.y);
    for (let x = 0; x < grid.width && x < row.cells.length; x++) {
      grid.chars[at + x] = row.cells[x];
      const styleId = row.styles[x];
      grid.hls[at + x] =
        styleId === 0 && ground === undefined
          ? 0
          : (view.hlIds.get(`${owner}:${String(styleId)}`) ?? 0);
    }
    grid.dirty.add(row.y);
  }
}

/**
 * The rows a copy mode's view moved down between two of its states: its
 * top line's place in the history (`history - scroll`) moved by that much.
 * Output arriving meanwhile grows both and moves nothing.
 */
export function copyScrolled(
  before: { readonly scroll: number; readonly history: number },
  after: { readonly scroll: number; readonly history: number },
): number {
  return after.history - after.scroll - (before.history - before.scroll);
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
      if (message.mouse !== undefined) view.mouseBindings = message.mouse;
      changes.layout = true;
      return changes;
    }
    case "pane": {
      const { pane, frame } = message;
      applyFrame(view, String(pane), gridOf(pane), frame, changes);
      const shift = view.copyShift.get(pane);
      if (shift !== undefined && frame.full) {
        view.copyShift.delete(pane);
        changes.scrolled.set(gridOf(pane), shift);
      }
      const closed = view.copyClosing.has(pane) && frame.full;
      if (closed) {
        view.copyClosing.delete(pane);
        view.copy.delete(pane);
      }
      if (closed || view.copy.has(pane) || view.marks.has(pane))
        drawCopy(view, pane);
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
      view.copyClosing.delete(pane);
      const before = view.copy.get(pane);
      view.copy.set(pane, copy);
      // Entering, the pane was at the foot of its history: the mode may be
      // read only after the wheel that entered it has scrolled it too.
      const rows = copyScrolled(before ?? { ...copy, scroll: 0 }, copy);
      if (rows !== 0) {
        // Drawn with the new view's picture, which comes next.
        view.copyShift.set(pane, (view.copyShift.get(pane) ?? 0) + rows);
        return changes;
      }
      drawCopy(view, pane);
      changes.grids.add(gridOf(pane));
      changes.cursor = true;
      return changes;
    }
    case "copy-mode-closed": {
      // Left by scrolling to the end (`copy-mode -e`), or by a key: the
      // live screen is the bottom of the history, `scroll` rows down.
      const before = view.copy.get(message.pane);
      if (before !== undefined && before.scroll > 0)
        view.copyShift.set(
          message.pane,
          (view.copyShift.get(message.pane) ?? 0) + before.scroll,
        );
      // The live picture comes next (a full frame): the mode's view goes
      // with it (`copyClosing`).
      view.copyClosing.add(message.pane);
      return changes;
    }
    case "notice":
    case "cursor-link":
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
function over(
  view: ControlView,
  hl: number,
  ground: number | undefined,
  underline = false,
): number {
  const key = `over:${String(ground)}:${underline ? "u" : ""}:${String(hl)}`;
  let id = view.hlIds.get(key);
  if (id === undefined) {
    id = view.hlIds.size + 1;
    view.hlIds.set(key, id);
  }
  const base = view.state.hl.get(hl) ?? {};
  view.state.hl.set(
    id,
    ground === undefined
      ? { ...base, ...(underline ? { underline: true } : {}) }
      : {
          ...base,
          reverse: false,
          background: ground,
          ...(base.reverse === true
            ? { foreground: base.background ?? view.state.defaults.background }
            : {}),
          ...(underline ? { underline: true } : {}),
        },
  );
  return id;
}

/**
 * DevHub's own selection and the hovered link's underline on a pane
 * (`marks`): drawn over its cells as copy mode's selection is, in the same
 * colour, cell for cell. Empty spans take them away.
 */
export function setMarks(
  view: ControlView,
  pane: number,
  marks: {
    readonly selection: readonly CopySpan[];
    readonly underline: readonly CopySpan[];
  },
): RedrawChanges {
  const changes = emptyChanges();
  const before = view.marks.get(pane);
  if (before !== undefined && JSON.stringify(before) === JSON.stringify(marks))
    return changes;
  if (marks.selection.length === 0 && marks.underline.length === 0)
    view.marks.delete(pane);
  else view.marks.set(pane, marks);
  drawCopy(view, pane);
  changes.grids.add(gridOf(pane));
  return changes;
}

/**
 * Copy mode's selection and search matches over a pane's rows, in the
 * selection colour (Neovim's Visual) and half of it; then DevHub's own
 * selection in that colour, and the hovered link underlined (`marks`).
 */
function drawCopy(view: ControlView, pane: number): void {
  const id = gridOf(pane);
  const copy = view.copy.get(pane);
  const marks = view.marks.get(pane);
  const grid = view.state.grids.get(id);
  undraw(view, id);
  if ((copy === undefined && marks === undefined) || grid === undefined) return;
  let overrides = view.overrides.get(id);
  if (overrides === undefined) {
    overrides = new Map();
    view.overrides.set(id, overrides);
  }
  const match = mixColors(view.selection, view.state.defaults.background, 50);
  // Each cell's ground, then whether it is underlined, over its own look.
  const grounds = new Map<number, number>();
  const underlined = new Set<number>();
  const each = (
    spans: readonly { y: number; x0: number; x1: number }[],
    fn: (cell: number) => void,
  ) => {
    for (const { y, x0, x1 } of spans) {
      if (y < 0 || y >= grid.height) continue;
      for (let x = Math.max(0, x0); x <= x1 && x < grid.width; x++)
        fn(y * grid.width + x);
    }
  };
  each(copy?.matches ?? [], (cell) => grounds.set(cell, match));
  each(copy?.selection ?? [], (cell) => grounds.set(cell, view.selection));
  each(marks?.selection ?? [], (cell) => grounds.set(cell, view.selection));
  each(marks?.underline ?? [], (cell) => underlined.add(cell));
  for (const cell of new Set([...grounds.keys(), ...underlined])) {
    const own = overrides.get(cell) ?? grid.hls[cell];
    overrides.set(cell, own);
    grid.hls[cell] = over(view, own, grounds.get(cell), underlined.has(cell));
    grid.dirty.add(Math.floor(cell / grid.width));
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
            z: CONTROL_Z.popup,
            float: true,
            bare: true,
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
            z: CONTROL_Z.chooserPreview,
            float: true,
            bare: true,
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
      z: CONTROL_Z.panes,
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
 * DevHub draws a hairline down its middle instead of a character border,
 * joined where lines meet (`borders`, shared with Neovim's windows).
 */
export function borders(panes: readonly PaneBox[]): BorderLine[] {
  return traceBorders(panes);
}

export type { BorderLine };

/** A piece of a pane's outline (`paneOutlines`): the active pane's or not. */
export interface OutlineLine extends BorderLine {
  readonly active: boolean;
}

/**
 * The active pane's outline, when the window shows more than one pane (tmux
 * colours that pane's border), and every synchronized pane's while
 * `synchronize-panes` is on, since what is typed reaches all of them: the
 * hairlines on the pane's sides, as `borders` draws them, each reaching
 * half a cell past the pane's corner to the middle of the gap, where the
 * side across it runs. A side on the window's edge has no gap and no line,
 * as in tmux. Square, not rounded: a separator that runs on past a corner
 * (a T, a +) has to pass through the corner's point, which a rounded corner
 * leaves either as a stub beside the curve or as a gap in the line.
 * Synchronized panes' sides come first and the active pane's last, so where
 * they share one the active pane's is drawn over.
 */
export function paneOutlines(panes: readonly PaneBox[]): OutlineLine[] {
  if (panes.length < 2) return [];
  const cols = Math.max(...panes.map((p) => p.x + p.width));
  const rows = Math.max(...panes.map((p) => p.y + p.height));
  const lines: OutlineLine[] = [];
  const outlined = [
    ...panes.filter((p) => p.synchronized && !p.active),
    ...panes.filter((p) => p.active),
  ];
  for (const p of outlined) {
    const active = p.active;
    const right = p.x + p.width;
    const bottom = p.y + p.height;
    const top = p.y > 0 ? p.y - 0.5 : 0;
    const left = p.x > 0 ? p.x - 0.5 : 0;
    const down = (bottom < rows ? bottom + 0.5 : rows) - top;
    const across = (right < cols ? right + 0.5 : cols) - left;
    if (p.x > 0)
      lines.push({ vertical: true, x: p.x - 1, y: top, length: down, active });
    if (right < cols)
      lines.push({ vertical: true, x: right, y: top, length: down, active });
    if (p.y > 0)
      lines.push({
        vertical: false,
        x: left,
        y: p.y - 1,
        length: across,
        active,
      });
    if (bottom < rows)
      lines.push({
        vertical: false,
        x: left,
        y: bottom,
        length: across,
        active,
      });
  }
  return lines;
}

/**
 * `borders` less where an outline runs (`paneOutlines`): the outline is
 * that stretch of the separator, recoloured, not a second line beside it.
 */
export function plainBorders(
  lines: readonly BorderLine[],
  outlines: readonly BorderLine[],
): BorderLine[] {
  const out: BorderLine[] = [];
  for (const line of lines) {
    const at = line.vertical ? line.x : line.y;
    const from = line.vertical ? line.y : line.x;
    const cuts = outlines
      .filter(
        (o) => o.vertical === line.vertical && (o.vertical ? o.x : o.y) === at,
      )
      .map((o) => {
        const start = o.vertical ? o.y : o.x;
        return [start, start + o.length] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    let start = from;
    const end = from + line.length;
    const keep = (a: number, b: number) => {
      if (b <= a) return;
      out.push(
        line.vertical
          ? { vertical: true, x: line.x, y: a, length: b - a }
          : { vertical: false, x: a, y: line.y, length: b - a },
      );
    };
    for (const [a, b] of cuts) {
      if (b <= start || a >= end) continue;
      keep(start, Math.min(a, end));
      start = Math.max(start, b);
    }
    keep(start, end);
  }
  return out;
}

/**
 * Where a boundary line in tmux's border cell `at` lies across, in CSS
 * pixels from the panes' first cell: centred on the cell's middle, `thick`
 * wide (a 1px hairline, a 2px outline). On whole CSS pixels, a half
 * pixel off the middle at most; the panes' grounds (a Neovim's in its pane
 * among them) end under the line.
 */
export function boundaryLine(
  at: number,
  size: number,
  thick: number,
): readonly [number, number] {
  const from = Math.round((at + 0.5) * size - thick / 2);
  return [from, from + thick];
}
