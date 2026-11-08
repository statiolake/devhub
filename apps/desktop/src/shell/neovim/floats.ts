/**
 * Floats that make one panel, pure. A picker (snacks: input, list,
 * preview; telescope) builds one visual panel out of several floats placed
 * edge to edge; each wearing its own frame and shadow shows the seams. So
 * floats whose rectangles touch or overlap (edge to edge, or a cell apart),
 * at about the same `zindex`, are one cluster: the painter draws one shadow
 * under the cluster's outline (and DevHub's hairline when no member draws a
 * border of its own), rounds only the cluster's outer corners, fills a
 * one-cell seam between members with their ground, and draws no frame per
 * member. A float alone is a cluster of one.
 */

import type { Corner, FrameGeometry, Side } from "./frame";
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
  /** What is drawn of it: its box without a left-out blank border. */
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
  /** Every member draws a border of lines: no hairline of DevHub's. */
  readonly lined: boolean;
  readonly members: readonly FloatMember[];
  /** One-cell seams between members, filled with their ground. */
  readonly seams: readonly Seam[];
}

/** Floats whose zindex differ by more than this are not one panel. */
const Z_TOLERANCE = 5;

/** The box as drawn: without its left-out blank border. */
export function drawnRect(box: GridBox): CellRect {
  const c = box.crop;
  return {
    row: box.row + (c?.top ?? 0),
    col: box.col + (c?.left ?? 0),
    width: box.width - (c?.left ?? 0) - (c?.right ?? 0),
    height: box.height - (c?.top ?? 0) - (c?.bottom ?? 0),
  };
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

/** The floats among `boxes`, grouped into the panels they make. */
export function floatClusters(boxes: readonly GridBox[]): FloatCluster[] {
  const floats = boxes
    .filter((b) => b.float)
    .map((box) => ({ box, rect: drawnRect(box) }))
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
      const others = list.filter((o) => o.box !== box).map((o) => o.rect);
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

/** A member of a panel whose border is a frame (`frame.ts`). */
export interface FramedMember {
  readonly grid: number;
  /** Its whole box, border included, in cells. */
  readonly rect: CellRect;
  readonly geometry: FrameGeometry;
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

/** The middle of a member's line on `side` (its edge where it has none). */
function lineMiddle(m: FramedMember, side: Side): number {
  const g = m.geometry;
  const w = g.widths[side];
  if (side === "left") return g.x + w / 2;
  if (side === "right") return g.x + g.w - w / 2;
  if (side === "top") return g.y + w / 2;
  return g.y + g.h - w / 2;
}

/**
 * The framed members of a panel as what to draw of each. An edge two
 * members share is drawn by one: the one whose side the other covers whole
 * (the left or upper one when each covers the other's), so a list beside a
 * preview, or an input over a list, shows one line between them.
 */
export function framePieces(
  members: readonly FramedMember[],
  dpr: number,
): FramePiece[] {
  const snap = (v: number) => Math.round(v * dpr) / dpr;
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
  for (const m of members) {
    for (const side of ["right", "bottom"] as const) {
      const others = across(m, side, members);
      if (others.length === 0) continue;
      const back = OPPOSITE[side];
      const mine = covered(m, side, others);
      const theirs = others.map((o) =>
        covered(o, back, across(o, back, members)),
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
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const others = across(m, side, members);
      if (others.length === 0) continue;
      const back = OPPOSITE[side];
      const mids = others.map(
        (o) => (lineMiddle(m, side) + lineMiddle(o, back)) / 2,
      );
      edges[side] = snap(mids.reduce((a, b) => a + b, 0) / mids.length);
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
 * Borderless floats whose every cell is under framed floats above them: a
 * picker's root box (snacks' layout window, `border = 'none'`) exactly
 * behind its framed list and preview. Drawn, it would fill the half cell
 * outside their lines the frames leave open; so it is not drawn, and a
 * click there goes to what is behind, as outside any frame.
 */
export function underFrames(boxes: readonly GridBox[]): Set<number> {
  const out = new Set<number>();
  const framed = boxes.filter((b) => b.float && b.frame !== undefined);
  if (framed.length === 0) return out;
  for (const box of boxes) {
    if (!box.float || box.frame || box.lined) continue;
    const above = framed.filter((f) => f.z > box.z);
    if (above.length === 0) continue;
    const r = drawnRect(box);
    let all = r.width > 0 && r.height > 0;
    for (let row = r.row; all && row < r.row + r.height; row += 1) {
      for (let col = r.col; all && col < r.col + r.width; col += 1) {
        all = above.some(
          (f) =>
            row >= f.row &&
            row < f.row + f.height &&
            col >= f.col &&
            col < f.col + f.width,
        );
      }
    }
    if (all) out.add(box.grid);
  }
  return out;
}

/**
 * Whether `row` of a float is a band (a menu's or a picker's selected row):
 * every cell of it from `first` to `last` has a ground other than the
 * float's own, and so do neither of its neighbours. The float's own ground
 * is the commonest along its first column (the row aside), so a row whose only neighbour is
 * the selection (a title kept above a list whose first item is selected) is
 * not taken for a band cut out of it. Answers the ground around the band.
 */
export function bandGround(
  rows: { readonly top: number; readonly bottom: number },
  first: number,
  last: number,
  row: number,
  bgAt: (row: number, col: number) => number | undefined,
): number | undefined {
  if (last <= first) return undefined;
  const neighbours = [row - 1, row + 1].filter(
    (r) => r >= rows.top && r < rows.bottom,
  );
  if (neighbours.length === 0) return undefined;
  const tally = new Map<number, number>();
  for (let r = rows.top; r < rows.bottom; r += 1) {
    if (r === row) continue;
    const bg = bgAt(r, first);
    if (bg !== undefined) tally.set(bg, (tally.get(bg) ?? 0) + 1);
  }
  let ground: number | undefined;
  let most = 0;
  for (const [bg, count] of tally) {
    if (count > most) [ground, most] = [bg, count];
  }
  if (ground === undefined) return undefined;
  if (
    neighbours.some(
      (r) => bgAt(r, first) !== ground || bgAt(r, last) !== ground,
    )
  )
    return undefined;
  for (let c = first; c <= last; c += 1) {
    const bg = bgAt(row, c);
    if (bg === undefined || bg === ground) return undefined;
  }
  return ground;
}
