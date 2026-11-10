/**
 * Neovim's windows moving as their layout changes (`docs/pane-motion.md`):
 * a split, a close, `<C-w>=`, a maximize, and a tab switch. One flush is one
 * commit — Neovim sends `win_pos` and the windows' new grids together — so
 * the transition starts in the frame that draws it, from what was on
 * screen.
 *
 * Each window moves as one group (`GridPainter.motionGroup`): its pane, its
 * grid (or scroll port), what rides it and its cursor, and its footer (the
 * element drawn in its status line row, `placeFooters`) at the clip's foot,
 * as wide as the clip. A window that is gone is its last picture, and a
 * copy of its footer, covered as its neighbours grow over it. Its content's origin follows its text: the rows
 * `topline` moved (`win_viewport`, before and after) are rows the content
 * moved, so a window that kept its cursor line in view by scrolling moves
 * its lines with the edge rather than under it.
 *
 * A float anchored to a moving window (`relative='win'`, or to a float
 * that is) travels with it: Neovim puts it at its final place at once, and
 * it is carried from where it was by its window's track, the same
 * transforms on the same clock, in a group of its own in its level
 * (`GridPainter.carryFloats`), so the window's clip does not cut it and it
 * stacks as it does at rest. One at a buffer position (`bufpos`) follows
 * the window's text; any other, the window's corner.
 */

import { boundariesOf } from "./chrome";
import { PART_Z, type GridPainter, type MotionGroup } from "./painter";
import {
  classify,
  placeGroup,
  plan,
  reducedMotion,
  switchesForward,
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
  /** The tabs in the tab strip's order. */
  readonly tabs: readonly number[];
  readonly grid1: string;
}

/** The rows a window's content moved up between two viewports. */
export function viewportShift(
  before: number | undefined,
  after: number | undefined,
): number {
  return before === undefined || after === undefined ? 0 : after - before;
}

/**
 * The window a float is anchored to, through floats anchored to floats:
 * none for a window, or a float anchored to the editor (grid 1).
 */
export function anchorWindowOf(
  state: NeovimUiState,
  grid: number,
): number | undefined {
  let at = grid;
  for (let depth = 0; depth < 8; depth += 1) {
    const p = state.windows.get(at)?.placement;
    if (p === undefined) return undefined;
    if (p.kind === "window") return at === grid ? undefined : at;
    if (p.anchorGrid === 1) return undefined;
    at = p.anchorGrid;
  }
  return undefined;
}

/** Floats carried by a window's motion, in one level (`carryFloats`). */
interface Riders {
  readonly group: MotionGroup;
  /** The window they are anchored to. */
  readonly anchor: number;
  /** At its text (`bufpos`): they follow its content, not its corner. */
  readonly text: boolean;
  /** The rows its text moved in its grid (`topline`), up positive. */
  readonly shift: number;
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
        /** Each moving window's footer; a gone one's, a copy. */
        readonly footers: ReadonlyMap<number, HTMLElement>;
        /** Gone windows' last pictures. */
        readonly pictures: ReadonlyMap<number, HTMLCanvasElement>;
        readonly grounds: ReadonlyMap<number, string>;
        readonly size: { readonly width: number; readonly height: number };
        readonly extent: { readonly width: number; readonly height: number };
        readonly separator: string;
        readonly hairline: number;
        /** The floats each moving window carries, by carrier. */
        readonly riders: ReadonlyMap<string, Riders>;
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
    const tabs = state.tabline?.tabs.map((t) => t.tab) ?? [];
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
      tabs,
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
    // A gone window is its last picture and its last footer: kept from
    // the transition before, or copied now, before this flush draws.
    const pictures = new Map<number, HTMLCanvasElement>();
    const footers = new Map<number, HTMLElement>();
    const laid = new Map<number, { x: number; y: number }>();
    const grounds = new Map<number, string>();
    for (const grid of goneKeys) {
      const box = seen.windows.get(grid);
      const rest = seen.rests.get(grid);
      const picture = m?.pictures.get(grid) ?? this.painter.picture(grid);
      if (picture !== undefined) pictures.set(grid, picture);
      // A copy: the live footer, which this flush takes away, is the
      // painter's (and its tree the page's), never carried off.
      const kept = m?.footers.get(grid);
      const footer = kept?.classList.contains("nvim-footer-picture")
        ? kept
        : rest?.status === true
          ? this.painter.footerPicture(grid)
          : undefined;
      if (footer !== undefined) footers.set(grid, footer);
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
        // Its footer, in its group's clip (`GridPainter.put`).
        const footer = this.painter.footerOf(grid);
        if (footer !== undefined) footers.set(grid, footer);
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
    for (const [grid, footer] of footers) {
      if (windows.has(grid)) continue;
      this.painter.motionGroup(grid, 1).clipB.append(footer);
    }
    // The floats anchored to a moving window, carried by its track.
    const carried = new Map<
      string,
      { anchor: number; z: number; text: boolean; floats: number[] }
    >();
    for (const box of boxes) {
      if (!box.float || box.win === undefined) continue;
      const anchor = anchorWindowOf(state, box.grid);
      if (anchor === undefined || !transition.tracks.has(anchor)) continue;
      const text = this.painter.atBufpos(box.win);
      const key = `${String(anchor)}:${String(box.z)}:${text ? "text" : "win"}`;
      const riders = carried.get(key) ?? {
        anchor,
        z: box.z,
        text,
        floats: [],
      };
      riders.floats.push(box.grid);
      carried.set(key, riders);
    }
    const riders = new Map<string, Riders>();
    for (const [key, r] of carried) {
      riders.set(key, {
        group: this.painter.carryFloats(key, r.z, r.floats),
        anchor: r.anchor,
        text: r.text,
        shift: shifts.get(r.anchor) ?? 0,
      });
    }
    this.painter.hideBoundaries(true);
    this.motion = {
      transition,
      laid,
      footers,
      pictures,
      grounds,
      size: { width: this.root.clientWidth, height: this.root.clientHeight },
      extent: {
        width: grid1.width * cell.width,
        height: grid1.height * cell.height,
      },
      separator: opts.separator,
      hairline: this.painter.hairline(),
      riders,
    };
    this.frame(now);
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
    const at = m.transition.at(now, dpr);
    for (const [grid, place] of at) {
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
      // The footer at the clip's foot, as wide as the clip (in the clip's
      // inner element, whose bottom right is the clip's).
      const footer = m.footers.get(grid);
      if (footer !== undefined) placeFooter(footer, r, m.size, ch);
      // The boundaries on its sides, down its text rows.
      const status = footer !== undefined ? ch : 0;
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
    // The floats carried by their windows: moved as their window's content
    // is, from its laid-out place; one at the window's corner without the
    // rows its text moved, which are left of them as the track goes.
    for (const riders of m.riders.values()) {
      const place = at.get(riders.anchor);
      const laid = m.laid.get(riders.anchor);
      const track = m.transition.tracks.get(riders.anchor);
      if (place === undefined || laid === undefined || track === undefined)
        continue;
      const elapsed = now - m.transition.t0;
      const left =
        track.ms <= 0 || elapsed >= track.ms
          ? 0
          : 1 - track.curve(Math.max(0, elapsed / track.ms));
      const lift = riders.text
        ? 0
        : Math.round(riders.shift * ch * left * dpr) / dpr;
      placeGroup(
        riders.group,
        {
          rect: { left: 0, top: 0, right: m.size.width, bottom: m.size.height },
          x: place.x - laid.x,
          y: place.y - laid.y - lift,
          opacity: place.opacity,
        },
        PART_Z.grid,
        { x: 0, y: 0 },
        m.size,
        "",
      );
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

/**
 * A footer at the foot of its pane's clip `r` while the pane moves: in the
 * clip's inner element (`clipB`, the surface's size, its bottom right on
 * the clip's), from the clip's left, as wide as it, its row the clip's
 * last.
 */
export function placeFooter(
  footer: HTMLElement,
  r: {
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
  },
  size: { readonly width: number; readonly height: number },
  ch: number,
): void {
  footer.style.left = "0px";
  footer.style.top = "0px";
  footer.style.width = `${String(Math.max(0, r.right - r.left))}px`;
  footer.style.transform = `translate(${String(r.left - r.right + size.width)}px, ${String(size.height - ch)}px)`;
}

/** What changed between two frames' windows, or nothing to move. */
function changeOf(a: Seen, b: Seen): Change | undefined {
  if (a.tab !== b.tab && a.tab !== undefined && b.tab !== undefined)
    return {
      kind: "switch",
      forward: switchesForward(a.tab, b.tab, a.tabs, b.tabs),
    };
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
