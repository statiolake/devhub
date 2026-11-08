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

export interface FloatCluster {
  /** The members' grids, joined: stable while the members are. */
  readonly key: string;
  /** The lowest member's: the shadow goes under all of them. */
  readonly z: number;
  /** Every member draws a border of lines: no hairline of DevHub's. */
  readonly lined: boolean;
  readonly members: readonly FloatMember[];
  /** One-cell seams between members, filled with their ground. */
  readonly seams: readonly CellRect[];
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
      // A corner is outer when no other member is next to it (a cell's seam
      // counts as next to it).
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
        grid: box.grid,
        rect,
        lined: box.lined === true,
        corners: {
          tl: outer(top, left, -1, -1),
          tr: outer(top, right, -1, 1),
          br: outer(bottom, right, 1, 1),
          bl: outer(bottom, left, 1, -1),
        },
      };
    });
    const seams: CellRect[] = [];
    list.forEach((a, i) => {
      list.forEach((b, j) => {
        if (j <= i) return;
        const s = seam(a.rect, b.rect);
        if (s && s.width > 0 && s.height > 0) seams.push(s);
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
