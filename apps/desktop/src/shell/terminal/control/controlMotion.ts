/**
 * tmux's panes moving as their layout changes (`docs/pane-motion.md`), for
 * the control surface (`ControlTerminalSurface.tsx`): where a pane rests,
 * what a layout change is, which panes' new pictures a change waits for,
 * and each frame's placement written to the painter's motion groups.
 */

import type { ControlToPage, PaneBox } from "../../../ipc/terminalControl";
import {
  PART_Z,
  type GridPainter,
  type MotionGroup,
} from "../../neovim/painter";
import {
  classify,
  placeGroup,
  rowShift,
  type Change,
  type Place,
  type Rect,
  type Transition,
} from "../../neovim/paneMotion";
import { gridOf, type ControlView } from "./paneGrids";
import { CONTROL_Z } from "./stacking";

const snapTo = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

/**
 * A pane's ground, as the resting path places it: out to the middle of
 * tmux's border cell beside it, on device pixels; to the window's edge on
 * a side that has no border.
 */
export function paneGround(
  p: PaneBox,
  cols: number,
  rows: number,
  cell: { readonly width: number; readonly height: number },
  dpr: number,
): Rect {
  const { width, height } = cell;
  return {
    left: p.x > 0 ? snapTo((p.x - 0.5) * width, dpr) : p.x * width,
    right:
      p.x + p.width < cols
        ? snapTo((p.x + p.width + 0.5) * width, dpr)
        : (p.x + p.width) * width,
    top: p.y > 0 ? snapTo((p.y - 0.5) * height, dpr) : p.y * height,
    bottom:
      p.y + p.height < rows
        ? snapTo((p.y + p.height + 0.5) * height, dpr)
        : (p.y + p.height) * height,
  };
}

/** A pane at rest: its ground, its grid at its first cell. */
export function restPlace(
  p: PaneBox,
  cols: number,
  rows: number,
  cell: { readonly width: number; readonly height: number },
  dpr: number,
): Place {
  return {
    rect: paneGround(p, cols, rows, cell, dpr),
    x: p.x * cell.width,
    y: p.y * cell.height,
    opacity: 1,
  };
}

/** What the surface showed before a layout was committed. */
export interface Shown {
  readonly cols: number;
  readonly rows: number;
  readonly window: number | undefined;
  readonly zoomed: boolean;
  readonly panes: readonly PaneBox[];
  /** The rows of each pane whose size changes, as text (`rowShift`). */
  readonly text: ReadonlyMap<number, readonly string[]>;
  /** Those panes' pictures (`GridPainter.picture`). */
  readonly pictures: ReadonlyMap<number, HTMLCanvasElement>;
}

/** A grid's rows as text. */
export function gridText(view: ControlView, pane: number): string[] {
  const grid = view.state.grids.get(gridOf(pane));
  if (grid === undefined) return [];
  const out: string[] = [];
  for (let row = 0; row < grid.height; row += 1)
    out.push(
      grid.chars.slice(row * grid.width, (row + 1) * grid.width).join(""),
    );
  return out;
}

export function zoomedOf(view: {
  readonly windows: readonly { id: number; zoomed: boolean }[];
  readonly window: number | undefined;
}): boolean {
  return view.windows.find((w) => w.id === view.window)?.zoomed ?? false;
}

/**
 * The panes a committed layout still waits for before it is drawn, so
 * that each pane's clip and its content start moving in the same frame:
 * every pane of the latest layout in `held` whose grid is not at its new
 * size yet, in the view or in a frame held with it (tmux's own reflow, read
 * again by the engine, comes a round trip after the layout); after a window
 * switch, every pane of the new window until a whole picture of it is held.
 */
export function waitingFor(
  view: ControlView,
  held: readonly ControlToPage[],
  window: number | undefined,
): Set<number> {
  const out = new Set<number>();
  let layout: Extract<ControlToPage, { kind: "layout" }> | undefined;
  for (const m of held) if (m.kind === "layout") layout = m;
  if (layout === undefined) return out;
  const switched = layout.window !== window;
  for (const p of layout.panes) {
    const got = held.some(
      (m) =>
        m.kind === "pane" &&
        m.pane === p.pane &&
        m.frame.cols === p.width &&
        m.frame.rows === p.height &&
        (!switched || m.frame.full),
    );
    if (got) continue;
    const grid = view.state.grids.get(gridOf(p.pane));
    if (
      !switched &&
      grid !== undefined &&
      grid.width === p.width &&
      grid.height === p.height
    )
      continue;
    out.add(p.pane);
  }
  return out;
}

/**
 * What a change from `before` to the view now is: a window switch (the
 * new window's index past the old one's is forward), a zoom or unzoom, a
 * few cells' resize step, or a structural change; `undefined` for none.
 */
export function changeOf(before: Shown, view: ControlView): Change | undefined {
  if (before.window !== view.window) {
    const index = (id: number | undefined) =>
      view.windows.find((w) => w.id === id)?.index ?? 0;
    return {
      kind: "switch",
      forward: index(view.window) > index(before.window),
    };
  }
  const zoomed = zoomedOf(view);
  if (zoomed !== before.zoomed) {
    const pane = (zoomed ? view.panes : before.panes)[0]?.pane ?? -1;
    if ((zoomed ? view.panes : before.panes).length !== 1) return undefined;
    return { kind: "zoom", pane, zoomIn: zoomed };
  }
  const rects = (panes: readonly PaneBox[]) =>
    new Map(panes.map((p) => [p.pane, p] as const));
  const kind = classify(rects(before.panes), rects(view.panes));
  if (kind === "same") return undefined;
  return { kind };
}

/**
 * Where a pane in both layouts starts its content from: the new grid's
 * first cell where the old grid's would be, less the rows the content
 * moved up (`rowShift`, from the two pictures), so a line on screen goes on
 * from where it was.
 */
export function anchorOf(
  shifts: ReadonlyMap<number, number>,
  cellHeight: number,
): (pane: number, shown: Place) => { x: number; y: number } {
  return (pane, shown) => ({
    x: shown.x,
    y: shown.y + (shifts.get(pane) ?? 0) * cellHeight,
  });
}

/** How many rows each resized pane's content moved up (`rowShift`). */
export function shiftsOf(
  before: Shown,
  view: ControlView,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [pane, old] of before.text)
    if (view.panes.some((p) => p.pane === pane))
      out.set(pane, rowShift(old, gridText(view, pane)));
  return out;
}

/**
 * The rows of a resized pane's old picture that its new grid does not
 * hold — scrolled off its top as it got shorter, or below its new last
 * row — laid under the grid in the pane's content, where they were, so
 * they leave under the pane's moving edge rather than at once. The picture
 * is the old grid's, `shift` rows up from the new one's first row, cut
 * (once, not per frame) to the rows outside the new grid.
 */
export function leaving(
  picture: HTMLCanvasElement,
  box: PaneBox,
  shift: number,
  cell: { readonly width: number; readonly height: number },
): HTMLCanvasElement | undefined {
  const oldRows = Math.round(parseFloat(picture.style.height) / cell.height);
  const above = Math.min(oldRows, Math.max(0, shift));
  const below = Math.max(0, oldRows - (shift + box.height));
  if (above === 0 && below === 0) return undefined;
  const h = cell.height;
  const cut =
    above > 0
      ? `inset(0 0 ${String((oldRows - above) * h)}px 0)`
      : `inset(${String((oldRows - below) * h)}px 0 0 0)`;
  picture.className = "nvim-grid control-motion-leaving";
  picture.style.left = `${String(box.x * cell.width)}px`;
  picture.style.top = `${String((box.y - shift) * h)}px`;
  picture.style.clipPath = cut;
  // Over the pane's ground, under its grid (`PART_Z`).
  picture.style.zIndex = String(PART_Z.shadow);
  return picture;
}

/** A moving pane: its track's key and where its grid is laid out. */
export interface Moving {
  readonly pane: number;
  /** Its box as the painter lays it out now (a gone pane's last). */
  readonly box: PaneBox;
  /** The window's size in cells that box is in (its ground's edges). */
  readonly cols: number;
  readonly rows: number;
  /** Whether it draws the active pane's outline on its edges. */
  readonly active: boolean;
}

/**
 * Each moving pane at `now`, written as transforms and opacity only: the
 * two clips to its rectangle, its content to its origin, the lines on its
 * edges along them. `size` is the surface's, the clips' own size; `ground`
 * the panes' ground colour; `extent` the window's cells' (a side on its
 * edge has no line).
 */
export function applyMotion(
  painter: GridPainter,
  transition: Transition<number>,
  moving: ReadonlyMap<number, Moving>,
  now: number,
  dpr: number,
  cell: { readonly width: number; readonly height: number },
  size: { readonly width: number; readonly height: number },
  ground: string,
  extent: { readonly width: number; readonly height: number },
): Map<number, Place> {
  const at = transition.at(now, dpr);
  for (const [pane, place] of at) {
    const track = transition.tracks.get(pane);
    const m = moving.get(pane);
    if (track === undefined || m === undefined) continue;
    const group = painter.motionGroup(gridOf(pane), CONTROL_Z.panes);
    placeGroup(
      group,
      place,
      track.layer,
      { x: m.box.x * cell.width, y: m.box.y * cell.height },
      size,
      ground,
    );
    edgesOf(group, place.rect, extent, m.active);
  }
  return at;
}

/**
 * The lines on a moving pane's own edges, centred on them as the resting
 * boundary is on the shared edge: a hairline, or the active pane's outline
 * (2px). A side on the window's edge has none; one that reaches it while
 * moving carries its line there.
 */
function edgesOf(
  group: MotionGroup,
  r: Rect,
  extent: { readonly width: number; readonly height: number },
  active: boolean,
): void {
  const thick = active ? 2 : 1;
  const sides = [
    { on: r.left > 0.5, vertical: true, at: r.left },
    { on: r.right < extent.width - 0.5, vertical: true, at: r.right },
    { on: r.top > 0.5, vertical: false, at: r.top },
    { on: r.bottom < extent.height - 0.5, vertical: false, at: r.bottom },
  ];
  while (group.edges.childElementCount < 4) {
    const el = document.createElement("div");
    el.className = "nvim-motion-edge control-motion-edge";
    group.edges.append(el);
  }
  sides.forEach((side, i) => {
    const el = group.edges.children[i] as HTMLElement;
    el.dataset.active = String(active);
    if (!side.on) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    const from = Math.round(side.at - thick / 2);
    el.style.transform = side.vertical
      ? `translate(${String(from)}px, ${String(r.top)}px) scale(${String(thick)}, ${String(Math.max(0, r.bottom - r.top))})`
      : `translate(${String(r.left)}px, ${String(from)}px) scale(${String(Math.max(0, r.right - r.left))}, ${String(thick)})`;
  });
}

/**
 * The pane under a point of the surface while panes move: the topmost
 * moving pane drawn there that is in the committed layout, and the cell of
 * its grid under the point, as drawn (its content's origin now), clamped to
 * its grid. A gone pane's picture takes no click.
 */
export function paneUnder(
  transition: Transition<number>,
  at: ReadonlyMap<number, Place>,
  panes: readonly PaneBox[],
  x: number,
  y: number,
  cell: { readonly width: number; readonly height: number },
): { pane: PaneBox; x: number; y: number } | undefined {
  const order = [...transition.tracks.values()]
    .filter((t) => t.role !== "gone")
    .sort((a, b) => b.layer - a.layer);
  for (const track of order) {
    const place = at.get(track.key);
    const pane = panes.find((p) => p.pane === track.key);
    if (place === undefined || pane === undefined) continue;
    const r = place.rect;
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
    const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, v));
    return {
      pane,
      x: clamp(Math.floor((x - place.x) / cell.width), pane.width),
      y: clamp(Math.floor((y - place.y) / cell.height), pane.height),
    };
  }
  return undefined;
}
