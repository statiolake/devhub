/**
 * Neovim's windows moving as their layout changes (`docs/pane-motion.md`):
 * a split, a close, `<C-w>=`, a maximize, and a tab switch. One flush is one
 * commit — Neovim sends `win_pos` and the windows' new grids together — so
 * the transition starts in the frame that draws it, from what was on
 * screen.
 *
 * Each window moves as one group (`GridPainter.motionGroup`): its pane, its
 * grid (or scroll port), what rides it and its cursor, and its status line,
 * a strip of grid 1's row under it drawn at the clip's foot. A window that
 * is gone is its last picture, and its old status line, covered as its
 * neighbours grow over it. Its content's origin follows its text: the rows
 * `topline` moved (`win_viewport`, before and after) are rows the content
 * moved, so a window that kept its cursor line in view by scrolling moves
 * its lines with the edge rather than under it.
 */

import { boundariesOf } from "./chrome";
import type { GridPainter } from "./painter";
import {
  classify,
  placeGroup,
  plan,
  reducedMotion,
  type Change,
  type CellRect,
  type Place,
  type Transition,
} from "./paneMotion";
import type { GridBox, NeovimUiState } from "./redraw";

/** Resize steps closer than this are a held key's or a drag's: at once. */
const STEP_REPEAT_MS = 250;

/** A window's place at rest, and whether a status line is under it. */
export interface WindowRest extends Place {
  readonly status: boolean;
}

/**
 * Each window at rest, as the painter places its pane (`placePanes`): out
 * to the middle of the separator column beside it, on device pixels; down
 * over the row under it when that is its status line (or the line between
 * it and the window below), not the command line.
 */
export function windowRests(
  boxes: readonly GridBox[],
  grid1: { readonly width: number; readonly height: number },
  cmdheight: number,
  cell: { readonly width: number; readonly height: number },
  dpr: number,
): Map<number, WindowRest> {
  const { width: cw, height: ch } = cell;
  const { panes } = boundariesOf(boxes, grid1.width, grid1.height);
  const half = (col: number) => Math.round((col + 0.5) * cw * dpr) / dpr;
  const out = new Map<number, WindowRest>();
  for (const pane of panes) {
    const box = boxes.find((b) => b.grid === pane.grid);
    if (box === undefined) continue;
    const status = box.row + box.height < grid1.height - cmdheight;
    out.set(box.grid, {
      rect: {
        left: pane.left ? half(box.col - 1) : box.col * cw,
        right: pane.right
          ? half(box.col + box.width)
          : (box.col + box.width) * cw,
        top: box.row * ch,
        bottom: (box.row + box.height + (status ? 1 : 0)) * ch,
      },
      x: box.col * cw,
      y: box.row * ch,
      opacity: 1,
      status,
    });
  }
  return out;
}

/** What a frame showed: its windows, their viewports, the tab. */
interface Seen {
  readonly windows: ReadonlyMap<number, GridBox>;
  readonly rests: ReadonlyMap<number, WindowRest>;
  readonly toplines: ReadonlyMap<number, number>;
  readonly tab: number | undefined;
  readonly tabIndex: number;
  readonly grid1: string;
}

/** The rows a window's content moved up between two viewports. */
export function viewportShift(
  before: number | undefined,
  after: number | undefined,
): number {
  return before === undefined || after === undefined ? 0 : after - before;
}

const windowsOf = (boxes: readonly GridBox[]) =>
  new Map(
    boxes
      .filter((b) => !b.float && b.win !== undefined && b.grid !== 1)
      .map((b) => [b.grid, b] as const),
  );

export class WindowMotion {
  private seen: Seen | undefined;
  private motion:
    | {
        readonly transition: Transition<number>;
        /** Where each moving grid is laid out (its first cell at rest). */
        readonly laid: ReadonlyMap<number, { x: number; y: number }>;
        readonly strips: ReadonlyMap<number, HTMLCanvasElement>;
        /** Gone windows' last pictures. */
        readonly pictures: ReadonlyMap<number, HTMLCanvasElement>;
        readonly grounds: ReadonlyMap<number, string>;
        readonly size: { readonly width: number; readonly height: number };
        readonly extent: { readonly width: number; readonly height: number };
        readonly separator: string;
        readonly hairline: number;
      }
    | undefined;
  private lastStep = -Infinity;
  private tick = 0;

  constructor(
    private readonly painter: GridPainter,
    private readonly root: HTMLElement,
  ) {}

  /** Whether windows are moving now. */
  get moving(): boolean {
    return this.motion !== undefined;
  }

  /**
   * Draw a flush (`draw`, the painter's paint) and, when its windows moved,
   * start them moving from what was on screen. `immediate`: a border being
   * dragged, whose steps follow the pointer at once.
   */
  paint(
    state: NeovimUiState,
    boxes: readonly GridBox[],
    opts: {
      readonly now: number;
      readonly cmdheight: number;
      readonly immediate: boolean;
      readonly separator: string;
      readonly draw: () => void;
    },
  ): void {
    const { now } = opts;
    const cell = this.painter.cell();
    const dpr = window.devicePixelRatio || 1;
    const base = state.grids.get(1);
    const grid1 = { width: base?.width ?? 0, height: base?.height ?? 0 };
    const windows = windowsOf(boxes);
    const tab = state.tabline?.current;
    const tabIndex = state.tabline?.tabs.findIndex((t) => t.tab === tab) ?? 0;
    const toplines = new Map<number, number>();
    for (const grid of windows.keys()) {
      const top = state.windows.get(grid)?.viewport?.topline;
      if (top !== undefined) toplines.set(grid, top);
    }
    const seen = this.seen;
    const next: Seen = {
      windows,
      rests: windowRests(boxes, grid1, opts.cmdheight, cell, dpr),
      toplines,
      tab,
      tabIndex,
      grid1: `${String(grid1.width)}x${String(grid1.height)}`,
    };
    this.seen = next;
    const change = seen === undefined ? undefined : changeOf(seen, next);
    if (seen === undefined || change === undefined) {
      opts.draw();
      if (this.motion !== undefined) this.frame(now);
      return;
    }
    const repeated =
      change.kind === "step" &&
      (opts.immediate || now - this.lastStep < STEP_REPEAT_MS);
    if (change.kind === "step") this.lastStep = now;
    if (
      repeated ||
      reducedMotion() ||
      seen.grid1 !== next.grid1 ||
      this.root.offsetParent === null
    ) {
      this.stop();
      opts.draw();
      return;
    }
    // What was on screen, before this flush is drawn.
    const shown =
      this.motion !== undefined
        ? this.motion.transition.at(now, dpr)
        : new Map<number, Place>(seen.rests);
    const goneKeys = [...shown.keys()].filter((g) => !windows.has(g));
    const m = this.motion;
    // A gone window is its last picture and its last status line: kept
    // from the transition before, or copied now, before this flush draws.
    const pictures = new Map<number, HTMLCanvasElement>();
    const strips = new Map<number, HTMLCanvasElement>();
    const laid = new Map<number, { x: number; y: number }>();
    const grounds = new Map<number, string>();
    for (const grid of goneKeys) {
      const box = seen.windows.get(grid);
      const rest = seen.rests.get(grid);
      const picture = m?.pictures.get(grid) ?? this.painter.picture(grid);
      if (picture !== undefined) pictures.set(grid, picture);
      const strip =
        m?.strips.get(grid) ??
        (box !== undefined && rest?.status === true
          ? this.statusStrip(box, cell, rest)
          : undefined);
      if (strip !== undefined) strips.set(grid, strip);
      const at =
        box !== undefined
          ? { x: box.col * cell.width, y: box.row * cell.height }
          : m?.laid.get(grid);
      if (at !== undefined) laid.set(grid, at);
      const ground = m?.grounds.get(grid) ?? this.painter.groundOf(grid);
      if (ground !== undefined) grounds.set(grid, ground);
    }
    // A window in both whose text scrolled (Neovim kept its cursor line in
    // view): its content moves by the rows `topline` moved, and the rows
    // that leave its grid are its old picture's, under the new grid.
    const shifts = new Map<number, number>();
    const leaving = new Map<number, HTMLCanvasElement>();
    for (const [grid, box] of windows) {
      const was = seen.windows.get(grid);
      if (was === undefined) continue;
      const d = viewportShift(seen.toplines.get(grid), toplines.get(grid));
      shifts.set(grid, d);
      const above = Math.min(was.height, Math.max(0, d));
      const below = Math.max(0, was.height - (d + box.height));
      if (above === 0 && below === 0) continue;
      const picture = this.painter.picture(grid);
      if (picture === undefined) continue;
      const h = cell.height;
      picture.style.clipPath =
        above > 0
          ? `inset(0 0 ${String((was.height - above) * h)}px 0)`
          : `inset(${String((was.height - below) * h)}px 0 0 0)`;
      picture.style.left = `${String(box.col * cell.width)}px`;
      picture.style.top = `${String((box.row - d) * h)}px`;
      leaving.set(grid, picture);
    }
    // Draw the commit at rest in the levels, then make the groups again.
    this.painter.endMotion();
    opts.draw();
    const transition = plan({
      now,
      change,
      shown,
      next: [...next.rests].map(([grid, rest]) => ({
        key: grid,
        rest,
        top: state.cursor.grid === grid,
      })),
      anchor: (grid, was) => ({
        x: was.x,
        y: was.y + (shifts.get(grid) ?? 0) * cell.height,
      }),
    });
    for (const [grid, box] of windows) {
      laid.set(grid, { x: box.col * cell.width, y: box.row * cell.height });
      const rest = next.rests.get(grid);
      const group = this.painter.motionGroup(grid, 1);
      const ground = this.painter.groundOf(grid);
      if (ground !== undefined) grounds.set(grid, ground);
      if (rest?.status === true) {
        const strip = this.statusStrip(box, cell, rest);
        if (strip !== undefined) strips.set(grid, strip);
      }
      const rows = leaving.get(grid);
      if (rows !== undefined) {
        rows.className = "nvim-grid nvim-motion-picture";
        // Over the pane's ground, under its grid (`PART_Z`).
        rows.style.zIndex = "1";
        group.content.append(rows);
      }
    }
    for (const [grid, picture] of pictures) {
      const at = laid.get(grid);
      if (at === undefined) continue;
      picture.className = "nvim-grid nvim-motion-picture";
      picture.style.zIndex = "3";
      picture.style.left = `${String(at.x)}px`;
      picture.style.top = `${String(at.y)}px`;
      this.painter.motionGroup(grid, 1).content.append(picture);
    }
    for (const [grid, strip] of strips)
      this.painter.motionGroup(grid, 1).clipB.append(strip);
    this.painter.hideBoundaries(true);
    this.motion = {
      transition,
      laid,
      strips,
      pictures,
      grounds,
      size: { width: this.root.clientWidth, height: this.root.clientHeight },
      extent: {
        width: grid1.width * cell.width,
        height: grid1.height * cell.height,
      },
      separator: opts.separator,
      hairline: this.painter.hairline(),
    };
    this.frame(now);
  }

  /** The row of grid 1 under a window: its status line, as drawn now. */
  private statusStrip(
    box: GridBox,
    cell: { readonly width: number; readonly height: number },
    rest: WindowRest,
  ): HTMLCanvasElement | undefined {
    const w = rest.rect.right - box.col * cell.width;
    const strip = this.painter.picture(1, {
      x: box.col * cell.width,
      y: (box.row + box.height) * cell.height,
      w: Math.ceil(w / cell.width) * cell.width,
      h: cell.height,
    });
    if (strip === undefined) return undefined;
    strip.className = "nvim-grid nvim-motion-status";
    strip.style.left = "0px";
    strip.style.top = "0px";
    return strip;
  }

  /** Each moving window where it is at `now`; at rest once the time is up. */
  frame(now: number): void {
    const m = this.motion;
    if (m === undefined) return;
    if (m.transition.done(now)) {
      this.stop();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const ch = this.painter.cell().height;
    for (const [grid, place] of m.transition.at(now, dpr)) {
      const track = m.transition.tracks.get(grid);
      const laid = m.laid.get(grid);
      if (track === undefined || laid === undefined) continue;
      const group = this.painter.motionGroup(grid, 1);
      placeGroup(
        group,
        place,
        track.layer,
        laid,
        m.size,
        m.grounds.get(grid) ?? "",
      );
      const r = place.rect;
      // The status line at the clip's foot, from the content's left.
      const strip = m.strips.get(grid);
      if (strip !== undefined) {
        strip.style.transform = `translate(${String(place.x - (r.right - m.size.width))}px, ${String(m.size.height - ch)}px)`;
      }
      // The boundaries on its sides, down its text rows.
      const status = strip !== undefined ? ch : 0;
      while (group.edges.childElementCount < 2) {
        const el = document.createElement("div");
        el.className = "nvim-motion-edge";
        group.edges.append(el);
      }
      [
        { on: r.left > 0.5, at: r.left },
        { on: r.right < m.extent.width - 0.5, at: r.right },
      ].forEach((side, i) => {
        const el = group.edges.children[i] as HTMLElement;
        el.style.display = side.on ? "" : "none";
        if (!side.on) return;
        el.style.background = m.separator;
        const x = Math.round((side.at - m.hairline / 2) * dpr) / dpr;
        el.style.transform = `translate(${String(x)}px, ${String(r.top)}px) scale(${String(m.hairline)}, ${String(Math.max(0, r.bottom - r.top - status))})`;
      });
    }
    if (this.tick === 0) {
      this.tick = requestAnimationFrame((t) => {
        this.tick = 0;
        this.frame(t);
      });
    }
  }

  /** Every window at rest, placed by the painter as ever. */
  stop(): void {
    if (this.tick !== 0) cancelAnimationFrame(this.tick);
    this.tick = 0;
    if (this.motion === undefined) return;
    this.motion = undefined;
    this.painter.endMotion();
    this.painter.hideBoundaries(false);
  }

  dispose(): void {
    this.stop();
  }
}

/** What changed between two frames' windows, or nothing to move. */
function changeOf(a: Seen, b: Seen): Change | undefined {
  if (a.tab !== b.tab && a.tab !== undefined && b.tab !== undefined)
    return { kind: "switch", forward: b.tabIndex > a.tabIndex };
  const rects = (w: ReadonlyMap<number, GridBox>) =>
    new Map<number, CellRect>(
      [...w].map(([g, box]) => [
        g,
        { x: box.col, y: box.row, width: box.width, height: box.height },
      ]),
    );
  const kind = classify(rects(a.windows), rects(b.windows));
  if (kind === "same") return undefined;
  return { kind };
}
