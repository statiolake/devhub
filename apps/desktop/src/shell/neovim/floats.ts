/**
 * Floats that make one panel, pure. A picker (snacks: input, list,
 * preview; telescope) builds one visual panel out of several floats placed
 * edge to edge; each wearing its own frame and shadow shows the seams. So
 * floats whose rectangles touch or overlap (edge to edge, or a cell apart),
 * at about the same `zindex`, are one cluster: the painter draws one shadow
 * under the cluster's outline, rounds only the cluster's outer corners,
 * fills a one-cell seam between members without a border with their
 * ground, and draws the line between two members with borders once
 * (`framePieces`). A float alone is a cluster of one.
 */

import {
  lineSpan,
  lineWidth,
  type Corner,
  type FrameGeometry,
  type Side,
} from "./frame";
import type { GridBox } from "./redraw";

export interface CellRect {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
}

export interface FloatCorners {
  readonly tl: boolean;
  readonly tr: boolean;
  readonly br: boolean;
  readonly bl: boolean;
}

export interface FloatMember {
  readonly grid: number;
  /** Its box, border included. */
  readonly rect: CellRect;
  /** Its corners that are the cluster's outer corners: rounded. */
  readonly corners: FloatCorners;
  readonly lined: boolean;
}

export interface Seam extends CellRect {
  /** The two members it is between. */
  readonly between: readonly [number, number];
}

export interface FloatCluster {
  /** The members' grids, joined: stable while the members are. */
  readonly key: string;
  /** The lowest member's: the shadow goes under all of them. */
  readonly z: number;
  /** Every member has a border of its own. */
  readonly lined: boolean;
  readonly members: readonly FloatMember[];
  /** One-cell seams between members, filled with their ground. */
  readonly seams: readonly Seam[];
}

/** Floats whose zindex differ by more than this are not one panel. */
const Z_TOLERANCE = 5;

/** A box's cells, border included. */
function cellsOf(box: GridBox): CellRect {
  return { row: box.row, col: box.col, width: box.width, height: box.height };
}

/** The cells between two ranges: negative when they overlap. */
function gap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(a0, b0) - Math.min(a1, b1);
}

/**
 * Two rects are one panel when they share an edge (or overlap), or are one
 * cell apart along a shared span — not when they only meet at a corner.
 */
export function touching(a: CellRect, b: CellRect): boolean {
  const gx = gap(a.col, a.col + a.width, b.col, b.col + b.width);
  const gy = gap(a.row, a.row + a.height, b.row, b.row + b.height);
  return (gx <= 1 && gy < 0) || (gy <= 1 && gx < 0);
}

function covers(r: CellRect, row: number, col: number, grow: number): boolean {
  return (
    row >= r.row - grow &&
    row < r.row + r.height + grow &&
    col >= r.col - grow &&
    col < r.col + r.width + grow
  );
}

/** The seam between two members a cell apart, over the span they share. */
function seam(a: CellRect, b: CellRect): CellRect | undefined {
  const gx = gap(a.col, a.col + a.width, b.col, b.col + b.width);
  const gy = gap(a.row, a.row + a.height, b.row, b.row + b.height);
  if (gx === 1 && gy < 0) {
    const row = Math.max(a.row, b.row);
    return {
      row,
      col: Math.min(a.col + a.width, b.col + b.width),
      width: 1,
      height: Math.min(a.row + a.height, b.row + b.height) - row,
    };
  }
  if (gy === 1 && gx < 0) {
    const col = Math.max(a.col, b.col);
    return {
      row: Math.min(a.row + a.height, b.row + b.height),
      col,
      width: Math.min(a.col + a.width, b.col + b.width) - col,
      height: 1,
    };
  }
  return undefined;
}

/**
 * The corners of `rect` no other rect is next to (a cell's seam counts as
 * next to it): a panel's outer corners, the ones that are round.
 */
export function outerCorners(
  rect: CellRect,
  others: readonly CellRect[],
): FloatCorners {
  const outer = (row: number, col: number, dr: number, dc: number) =>
    !others.some(
      (o) =>
        covers(o, row + dr, col, 1) ||
        covers(o, row, col + dc, 1) ||
        covers(o, row + dr, col + dc, 1),
    );
  const top = rect.row;
  const left = rect.col;
  const bottom = rect.row + rect.height - 1;
  const right = rect.col + rect.width - 1;
  return {
    tl: outer(top, left, -1, -1),
    tr: outer(top, right, -1, 1),
    br: outer(bottom, right, 1, 1),
    bl: outer(bottom, left, 1, -1),
  };
}

function inside(a: CellRect, b: CellRect): boolean {
  return (
    a.row >= b.row &&
    a.col >= b.col &&
    a.row + a.height <= b.row + b.height &&
    a.col + a.width <= b.col + b.width
  );
}

/** The floats among `boxes`, grouped into the panels they make. */
export function floatClusters(boxes: readonly GridBox[]): FloatCluster[] {
  const floats = boxes
    .filter((b) => b.float)
    .map((box) => ({ box, rect: cellsOf(box) }))
    .filter((f) => f.rect.width > 0 && f.rect.height > 0);
  // Union-find over the floats that touch.
  const parent = floats.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    return r;
  };
  floats.forEach((a, i) => {
    floats.forEach((b, j) => {
      if (j <= i) return;
      if (Math.abs(a.box.z - b.box.z) > Z_TOLERANCE) return;
      if (touching(a.rect, b.rect)) parent[find(j)] = find(i);
    });
  });
  const groups = new Map<number, typeof floats>();
  floats.forEach((f, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(f);
    else groups.set(root, [f]);
  });
  return [...groups.values()].map((list) => {
    const members = list.map(({ box, rect }) => {
      // A member inside this one (a picker's list in its root box) does
      // not make its corner inner: the box's corner is the panel's.
      const others = list
        .filter((o) => o.box !== box && !inside(o.rect, rect))
        .map((o) => o.rect);
      return {
        grid: box.grid,
        rect,
        lined: box.lined === true,
        corners: outerCorners(rect, others),
      };
    });
    const seams: Seam[] = [];
    list.forEach((a, i) => {
      list.forEach((b, j) => {
        if (j <= i) return;
        const s = seam(a.rect, b.rect);
        if (s && s.width > 0 && s.height > 0)
          seams.push({ ...s, between: [a.box.grid, b.box.grid] });
      });
    });
    members.sort((a, b) => a.grid - b.grid);
    return {
      key: members.map((m) => String(m.grid)).join(","),
      z: Math.min(...list.map((f) => f.box.z)),
      lined: members.every((m) => m.lined),
      members,
      seams,
    };
  });
}

/**
 * A member of a panel in a frame (`frame.ts`): its border's, or, without a
 * border, the padding DevHub puts round its cells.
 */
export interface FramedMember {
  readonly grid: number;
  /** Its whole box, border included, in cells. */
  readonly rect: CellRect;
  readonly geometry: FrameGeometry;
  /**
   * False for a float without a border: where it meets another member
   * there is no line, the two grounds meet (a cell between them filled).
   */
  readonly ruled?: boolean;
  /** The sides a title or footer is on: a line shared there is that side's. */
  readonly labelled?: Readonly<Partial<Record<Side, boolean>>>;
}

/**
 * What DevHub draws of a framed member: its ground out to its lines, the
 * lines it draws, its rounded corners. Members side by side meet half way
 * between their lines, and the edge they share is drawn once.
 */
export interface FramePiece {
  readonly grid: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly radii: Readonly<Record<Corner, number>>;
  readonly draw: Readonly<Record<Side, boolean>>;
}

const SIDE_LIST = ["top", "right", "bottom", "left"] as const;

const OPPOSITE: Readonly<Record<Side, Side>> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

/** The members across `side` of `a`: their edge is within a cell of its. */
function across(
  a: FramedMember,
  side: Side,
  all: readonly FramedMember[],
): FramedMember[] {
  return all.filter((b) => {
    if (b === a) return false;
    const r = a.rect;
    const o = b.rect;
    const rows = gap(r.row, r.row + r.height, o.row, o.row + o.height) < 0;
    const cols = gap(r.col, r.col + r.width, o.col, o.col + o.width) < 0;
    const near = (d: number) => d >= -1 && d <= 1;
    if (side === "right") return rows && near(o.col - (r.col + r.width));
    if (side === "left") return rows && near(r.col - (o.col + o.width));
    if (side === "bottom") return cols && near(o.row - (r.row + r.height));
    return cols && near(r.row - (o.row + o.height));
  });
}

/** Whether `others` line all of `a`'s `side` (a cell's break allowed). */
function covered(
  a: FramedMember,
  side: Side,
  others: readonly FramedMember[],
): boolean {
  if (others.length === 0) return false;
  const vertical = side === "left" || side === "right";
  const from = (vertical ? a.rect.row : a.rect.col) + 1;
  const to =
    (vertical ? a.rect.row + a.rect.height : a.rect.col + a.rect.width) - 1;
  const spans = others
    .map((o) =>
      vertical
        ? [o.rect.row, o.rect.row + o.rect.height]
        : [o.rect.col, o.rect.col + o.rect.width],
    )
    .sort((p, q) => (p[0] ?? 0) - (q[0] ?? 0));
  let reach = from;
  for (const [s, e] of spans) {
    if ((s ?? 0) > reach + 1) return false;
    reach = Math.max(reach, e ?? 0);
  }
  return reach >= to;
}

/** The true middle of a member's line on `side` (not yet on device pixels). */
function lineMiddle(m: FramedMember, side: Side): number {
  return m.geometry.middles[side];
}

/**
 * Where the line `m` and `o` share on `m`'s `side` runs (its middle). When
 * both have a border there, their two border cells are fused into one
 * line: where the one that holds a title or footer has it — along that
 * row's outer edge (`frameBands`), so a list's title under an input is in
 * the row under the line between them — else at the
 * middle of the two cells together, the edge they share, leaning to
 * neither. A border beside none, through the border; two without one meet
 * half way, ground to ground.
 */
function sharedMiddle(m: FramedMember, side: Side, o: FramedMember): number {
  const back = OPPOSITE[side];
  const mine = lineMiddle(m, side);
  const theirs = lineMiddle(o, back);
  const mRuled = m.ruled !== false;
  const oRuled = o.ruled !== false;
  if (mRuled !== oRuled) return mRuled ? mine : theirs;
  const mLabel = mRuled && m.labelled?.[side] === true;
  const oLabel = oRuled && o.labelled?.[back] === true;
  if (mLabel !== oLabel) return mLabel ? mine : theirs;
  return (mine + theirs) / 2;
}

/**
 * The framed members of a panel as what to draw of each. An edge two
 * members with borders share is drawn by one: the one whose side the other
 * covers whole (the left or upper one when each covers the other's), so a
 * list beside a preview, or an input over a list, shows one line between
 * them, where their border cells meet (`sharedMiddle`). A member
 * without a border draws no line where it meets another.
 */
export function framePieces(
  members: readonly FramedMember[],
  dpr: number,
): FramePiece[] {
  const draws = new Map<FramedMember, Record<Side, boolean>>(
    members.map((m) => [
      m,
      {
        top: m.geometry.widths.top > 0,
        right: m.geometry.widths.right > 0,
        bottom: m.geometry.widths.bottom > 0,
        left: m.geometry.widths.left > 0,
      },
    ]),
  );
  const drawOf = (m: FramedMember) =>
    draws.get(m) ?? { top: false, right: false, bottom: false, left: false };
  const ruled = members.filter((m) => m.ruled !== false);
  for (const m of members) {
    if (m.ruled !== false) continue;
    for (const side of SIDE_LIST) {
      if (across(m, side, members).length > 0) drawOf(m)[side] = false;
    }
  }
  for (const m of ruled) {
    for (const side of ["right", "bottom"] as const) {
      const others = across(m, side, ruled);
      if (others.length === 0) continue;
      const back = OPPOSITE[side];
      const mine = covered(m, side, others);
      const theirs = others.map((o) =>
        covered(o, back, across(o, back, ruled)),
      );
      if (drawOf(m)[side] && (!mine || theirs.every(Boolean))) {
        // This side's line runs along all of theirs that it covers.
        others.forEach((o, i) => {
          if (theirs[i]) drawOf(o)[back] = false;
        });
      } else if (mine && others.every((o) => drawOf(o)[back])) {
        drawOf(m)[side] = false;
      }
    }
  }
  return members.map((m) => {
    const g = m.geometry;
    const edges = { left: g.x, right: g.x + g.w, top: g.y, bottom: g.y + g.h };
    for (const side of SIDE_LIST) {
      const others = across(m, side, members);
      if (others.length === 0) continue;
      const mids = others.map((o) => sharedMiddle(m, side, o));
      const middle = mids.reduce((a, b) => a + b, 0) / mids.length;
      // The line is `width` across, centred on its middle, on whole device
      // pixels (`lineSpan`). A member that draws it reaches its far side; one
      // that does not stops at its near side, its ground not under it.
      const width = g.widths[side] > 0 ? g.widths[side] : lineWidth(dpr);
      const [start, end] = lineSpan(middle, width, dpr);
      const outward = side === "right" || side === "bottom";
      const back = OPPOSITE[side];
      if (!drawOf(m)[side] && others.every((o) => !drawOf(o)[back])) {
        // No line: the grounds meet at its middle.
        edges[side] = Math.round(middle * dpr) / dpr;
      } else {
        edges[side] = drawOf(m)[side] === outward ? end : start;
      }
    }
    // Round where no other framed member meets it (a borderless member
    // under them all — a picker's box — does not square their corners).
    const c = outerCorners(
      m.rect,
      members.filter((o) => o !== m).map((o) => o.rect),
    );
    const r = g.radii;
    return {
      grid: m.grid,
      x: edges.left,
      y: edges.top,
      w: edges.right - edges.left,
      h: edges.bottom - edges.top,
      radii: {
        tl: c.tl ? r.tl : 0,
        tr: c.tr ? r.tr : 0,
        br: c.br ? r.br : 0,
        bl: c.bl ? r.bl : 0,
      },
      draw: drawOf(m),
    };
  });
}

/**
 * Borderless floats that are the box of a panel of framed floats above
 * them, each with those framed floats: a picker's root box (snacks' layout
 * window, `border = 'none'`) behind its framed list and preview — a float
 * inside the rectangle the framed floats over it span. A framed float is
 * cut at its lines, the half cell outside them left open; the box under it
 * is drawn, clipped by that cut (`cutClip`), so what is under the panel
 * shows there and a click there goes to it, as outside any frame. A float
 * past that rectangle (a backdrop's tint over the whole screen, a hover
 * under the picker) is not its box: it is what is under the panel.
 */
export function frameCuts(
  boxes: readonly GridBox[],
): Map<number, readonly GridBox[]> {
  const out = new Map<number, readonly GridBox[]>();
  const framed = boxes.filter((b) => b.float && b.frame !== undefined);
  if (framed.length === 0) return out;
  for (const box of boxes) {
    if (!box.float || box.frame || box.lined) continue;
    const r: CellRect = box;
    if (r.width <= 0 || r.height <= 0) continue;
    const above = framed.filter(
      (f) =>
        f.z > box.z &&
        f.row < r.row + r.height &&
        f.row + f.height > r.row &&
        f.col < r.col + r.width &&
        f.col + f.width > r.col,
    );
    if (above.length === 0) continue;
    const top = Math.min(...above.map((f) => f.row));
    const left = Math.min(...above.map((f) => f.col));
    const bottom = Math.max(...above.map((f) => f.row + f.height));
    const right = Math.max(...above.map((f) => f.col + f.width));
    if (
      r.row >= top &&
      r.col >= left &&
      r.row + r.height <= bottom &&
      r.col + r.width <= right
    ) {
      out.set(box.grid, above);
    }
  }
  return out;
}

/** Whether a cell is in a framed float's cells: its cut, outside its lines. */
export function inFrameCells(
  above: readonly GridBox[],
  row: number,
  col: number,
): boolean {
  return above.some(
    (f) =>
      row >= f.row &&
      row < f.row + f.height &&
      col >= f.col &&
      col < f.col + f.width,
  );
}

/** A framed float's shape inside its lines (`framePieces`), in CSS pixels. */
export interface FrameShape {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly radii: Readonly<Record<Corner, number>>;
}

/**
 * The clip of a float under framed ones (`frameCuts`), as a CSS
 * `clip-path`, in the coordinates of an element at `origin`: its cells
 * outside the framed floats' cells, and inside those the framed floats'
 * shapes — never the half cell outside a frame's line. The parts do not
 * overlap, so the path's union is theirs. A framed float without a shape
 * known leaves its cells uncut.
 */
export function cutClip(
  box: GridBox,
  above: readonly GridBox[],
  shapes: ReadonlyMap<number, FrameShape>,
  cell: { readonly width: number; readonly height: number },
  origin: { readonly x: number; readonly y: number },
): string {
  const r: CellRect = box;
  const cutters = above.filter((f) => shapes.has(f.grid));
  const parts: string[] = [];
  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  const rect = (x: number, y: number, w: number, h: number) =>
    `M${n(x - origin.x)} ${n(y - origin.y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  for (let row = r.row; row < r.row + r.height; row += 1) {
    let start: number | undefined;
    for (let col = r.col; col <= r.col + r.width; col += 1) {
      const open = col < r.col + r.width && !inFrameCells(cutters, row, col);
      if (open && start === undefined) start = col;
      if (!open && start !== undefined) {
        parts.push(
          rect(
            start * cell.width,
            row * cell.height,
            (col - start) * cell.width,
            cell.height,
          ),
        );
        start = undefined;
      }
    }
  }
  for (const f of cutters) {
    const s = shapes.get(f.grid);
    if (!s) continue;
    const { tl, tr, br, bl } = s.radii;
    const x = s.x - origin.x;
    const y = s.y - origin.y;
    // A corner without a radius is where the line before it ends.
    const arc = (rad: number, ex: number, ey: number) =>
      rad > 0 ? `A${n(rad)} ${n(rad)} 0 0 1 ${n(ex)} ${n(ey)}` : "";
    parts.push(
      `M${n(x + tl)} ${n(y)}L${n(x + s.w - tr)} ${n(y)}${arc(tr, x + s.w, y + tr)}` +
        `L${n(x + s.w)} ${n(y + s.h - br)}${arc(br, x + s.w - br, y + s.h)}` +
        `L${n(x + bl)} ${n(y + s.h)}${arc(bl, x, y + s.h - bl)}` +
        `L${n(x)} ${n(y + tl)}${arc(tl, x + tl, y)}Z`,
    );
  }
  return `path("${parts.join("")}")`;
}

/**
 * Whether a float is padded by DevHub (`frameGeometry`): no border of its
 * own, so its frame's line is half a cell outside its cells. Not a box the
 * frames over it cut, a float drawn bare, or a one-column float (a menu's
 * scrollbar: `fuseScrollbar` puts it in its menu's frame).
 */
function paddedFloats(boxes: readonly GridBox[]): (b: GridBox) => boolean {
  const cuts = frameCuts(boxes);
  return (b) =>
    b.float &&
    b.frame === undefined &&
    b.lined !== true &&
    b.bare !== true &&
    b.width > 1 &&
    !cuts.has(b.grid);
}

/**
 * The boxes with a panel moved half a row off the cursor's row, where a
 * float without a border in it is next to that row (a completion menu
 * under the line being typed, a signature above it): such a float's
 * padding is half a cell outside its cells (`frameGeometry`), and on the
 * cursor's row it would cover the text being typed. The whole panel moves
 * (a menu's scrollbar floats with it); Neovim's cells do not, and a click
 * is read back by the pixel (`mouse.ts`). `cursorRow` is in grid 1's rows.
 */
export function clearCursorRow(
  boxes: readonly GridBox[],
  cursorRow: number | undefined,
): GridBox[] {
  if (cursorRow === undefined) return [...boxes];
  const padded = paddedFloats(boxes);
  const byGrid = new Map(boxes.map((b) => [b.grid, b]));
  const shift = new Map<number, number>();
  for (const cluster of floatClusters(boxes.filter((b) => b.bare !== true))) {
    const members = cluster.members.flatMap((m) => byGrid.get(m.grid) ?? []);
    const pads = members.filter(padded);
    if (pads.length === 0) continue;
    const top = Math.min(...members.map((b) => b.row));
    const bottom = Math.max(...members.map((b) => b.row + b.height));
    const by =
      top > cursorRow && pads.some((b) => b.row === cursorRow + 1)
        ? 0.5
        : bottom <= cursorRow &&
            pads.some((b) => b.row + b.height === cursorRow)
          ? -0.5
          : 0;
    if (by !== 0) for (const b of members) shift.set(b.grid, by);
  }
  return boxes.map((b) => {
    const by = shift.get(b.grid);
    return by === undefined ? b : { ...b, row: b.row + by };
  });
}

/**
 * How far past grid 1 DevHub may draw on each side, in cells: the editor's
 * reach (a tmux pane's half border cell, `GridPainter.setReach`) less the
 * frame's line — 0 at a window's edge, where the editor is cut.
 */
export interface EdgeRoom {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The boxes with a panel moved in from the editor's edge, a whole cell,
 * where a float without a border in it is at that edge (a cmdline menu at
 * column 0, a hover on the last column): its padding and line are half a
 * cell outside its cells (`frameGeometry`), and past grid 1 they would be
 * cut by the editor's clip (or, at a tmux pane's border, drawn over the
 * hairline). Moved a cell, its line runs through the middle of the edge
 * cell, as a bordered float's does, its text still on whole cells. Floats are over the windows and never cut by a window's
 * boundary inside the editor; only the editor's own edge cuts, so only
 * there is the panel moved — whole, with its scrollbar, as
 * `clearCursorRow` moves it; Neovim's cells do not move, and a click is
 * read back by the pixel (`mouse.ts`). A panel too wide or tall to clear
 * both edges stays where it is on that axis, and one already moved off
 * the cursor's row keeps its rows: what is typed comes first.
 * `size` is grid 1's, in cells.
 */
export function clearEdges(
  boxes: readonly GridBox[],
  size: { readonly width: number; readonly height: number },
  room: EdgeRoom,
): GridBox[] {
  const padded = paddedFloats(boxes);
  const byGrid = new Map(boxes.map((b) => [b.grid, b]));
  const shift = new Map<number, { dx: number; dy: number }>();
  // In whole cells, so the text stays on the cells' pixels; a line on
  // the edge itself is half cut, so in too.
  const nudge = (lo: number, hi: number, min: number, max: number) => {
    const inward = lo <= min ? Math.max(1, Math.ceil(min - lo)) : 0;
    const outward = hi >= max ? Math.max(1, Math.ceil(hi - max)) : 0;
    if (inward > 0 && hi + inward <= max) return inward;
    if (outward > 0 && lo - outward >= min) return -outward;
    return 0;
  };
  for (const cluster of floatClusters(boxes.filter((b) => b.bare !== true))) {
    const members = cluster.members.flatMap((m) => byGrid.get(m.grid) ?? []);
    const pads = members.filter(padded);
    if (pads.length === 0) continue;
    // The frame's outer edges: half a cell outside the padded members.
    const left = Math.min(...pads.map((b) => b.col)) - 0.5;
    const thin = members.filter((b) => b.width === 1);
    const right = Math.max(
      ...pads.map((b) => b.col + b.width + 0.5),
      ...pads.map((b) => scrollbarLine(b, thin) ?? 0),
    );
    const top = Math.min(...pads.map((b) => b.row)) - 0.5;
    const bottom = Math.max(...pads.map((b) => b.row + b.height)) + 0.5;
    const dx = nudge(left, right, -room.left, size.width + room.right);
    const moved = members.some((b) => !Number.isInteger(b.row));
    const dy = moved
      ? 0
      : nudge(top, bottom, -room.top, size.height + room.bottom);
    if (dx !== 0 || dy !== 0)
      for (const b of members) shift.set(b.grid, { dx, dy });
  }
  return boxes.map((b) => {
    const by = shift.get(b.grid);
    return by === undefined
      ? b
      : { ...b, col: b.col + by.dx, row: b.row + by.dy };
  });
}

/**
 * Where the right line of a framed menu with a scrollbar beside it runs,
 * in cells of grid 1 (the cell edge it is centred on), or `undefined` when
 * it has none. blink.cmp and nvim-cmp draw a menu's scrollbar as one-column
 * floats on the menu's last column (its border) or the one after
 * (`floatScrollbars`); DevHub's frame would put its line through the
 * middle of that column, the thumb straddling it and the gutter half
 * outside the menu. The scrollbar's column is the frame's right padding
 * instead: the line along its outer edge, the thumb inside the frame.
 */
export function scrollbarLine(
  menu: CellRect,
  bars: readonly CellRect[],
): number | undefined {
  let edge: number | undefined;
  for (const bar of bars) {
    const beside =
      bar.width === 1 &&
      bar.col >= menu.col + menu.width - 1 &&
      bar.col <= menu.col + menu.width &&
      bar.row >= menu.row &&
      bar.row + bar.height <= menu.row + menu.height;
    if (beside) edge = Math.max(edge ?? 0, bar.col + 1);
  }
  return edge;
}

/** `geometry` with its right line centred on `middle` (CSS pixels), if further out. */
export function withRightLine(
  geometry: FrameGeometry,
  middle: number,
  dpr: number,
): FrameGeometry {
  if (middle <= geometry.middles.right) return geometry;
  const [, x1] = lineSpan(middle, geometry.widths.right, dpr);
  return {
    ...geometry,
    w: x1 - geometry.x,
    middles: { ...geometry.middles, right: middle },
  };
}
