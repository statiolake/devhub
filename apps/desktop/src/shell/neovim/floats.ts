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
    const r = drawnRect(box);
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
  const r = drawnRect(box);
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

/** A rectangle in CSS pixels of the editor. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What DevHub draws of a panel's member without a frame of lines. */
export interface PanelPart {
  readonly grid: number;
  /**
   * Its ground: its text area grown into the blank border Neovim keeps
   * for it (`GridBox.crop`): the border's cell inline, and `padBlock`
   * above and below — where another member is across it too, the rest of
   * that row having been cut (`compactPanels`), so the two meet.
   */
  readonly rect: PixelRect;
  /** Its sides on the panel's outline: those get the line. */
  readonly outer: Readonly<Record<Side, boolean>>;
  /** Its header and footer rows (a `title`, a `footer`) as bands. */
  readonly header?: PixelRect;
  readonly footer?: PixelRect;
}

/** A 1px line where two members meet, inside a panel. */
export interface PanelRule {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function inside(a: CellRect, b: CellRect): boolean {
  return (
    a.row >= b.row &&
    a.col >= b.col &&
    a.row + a.height <= b.row + b.height &&
    a.col + a.width <= b.col + b.width
  );
}

/**
 * Whether a member of a panel has another across `side` within `room` rows
 * of its drawn rect (a picker's input over its list): the blank border
 * rows between them are the panel's, not the outside's.
 */
function acrossBlock(
  r: CellRect,
  others: readonly CellRect[],
  side: "top" | "bottom",
  room: number,
): boolean {
  return others.some((o) => {
    if (gap(r.col, r.col + r.width, o.col, o.col + o.width) >= 0) return false;
    const d =
      side === "bottom"
        ? o.row - (r.row + r.height)
        : r.row - (o.row + o.height);
    return d >= 0 && d <= room;
  });
}

/**
 * The floats of each panel with every blank border row between two members
 * cut down to the block padding (docs/neovim-editor.md, "Floating
 * surfaces"): a `'solid'` border's row is the padding Neovim keeps, never a
 * whole row of ground (a picker's input of one line showed an empty row
 * under it, over its list's title). The members below such a row are drawn
 * that much higher, by a fractional `row`; a member holding others (a
 * picker's borderless root box) loses as much at its bottom (`crop`).
 * Neovim's cells are not moved: only where DevHub draws them, and a click
 * is read back through the same boxes (`mouse.ts`).
 */
export function compactPanels(
  boxes: readonly GridBox[],
  cellHeight: number,
  padBlock: number,
): GridBox[] {
  if (cellHeight <= 0) return [...boxes];
  const byGrid = new Map(boxes.map((b) => [b.grid, b]));
  const moved = new Map<number, GridBox>();
  for (const cluster of floatClusters(boxes)) {
    if (cluster.lined || cluster.members.length < 2) continue;
    const rects = cluster.members.map((m) => m.rect);
    const holds = (r: CellRect) => rects.some((o) => o !== r && inside(o, r));
    // A cut at a row line (in cells, before any is taken): what is drawn
    // from that line down goes up by its amount (in rows).
    const cuts = new Map<number, number>();
    const cut = (line: number, rows: number) => {
      if (rows <= 0) return;
      cuts.set(line, Math.max(cuts.get(line) ?? 0, rows));
    };
    const pad = Math.min(1, padBlock / cellHeight);
    for (const m of cluster.members) {
      const box = byGrid.get(m.grid);
      const crop = box?.crop;
      if (!box || !crop || holds(m.rect)) continue;
      const others = rects.filter(
        (o) => o !== m.rect && !inside(m.rect, o) && !holds(o),
      );
      if (
        crop.bottom >= 1 &&
        acrossBlock(m.rect, others, "bottom", crop.bottom)
      )
        cut(m.rect.row + m.rect.height, crop.bottom - pad);
      if (crop.top >= 1 && acrossBlock(m.rect, others, "top", crop.top))
        cut(m.rect.row, crop.top - pad);
    }
    const above = (row: number) =>
      [...cuts].reduce((n, [line, rows]) => (line <= row ? n + rows : n), 0);
    const held: { rect: CellRect; drawn: CellRect }[] = [];
    let blank = cuts.size > 0;
    for (const m of cluster.members) {
      const box = byGrid.get(m.grid);
      if (!box || holds(m.rect)) continue;
      const up = above(m.rect.row);
      // As drawn, its padding included (`panelLayout`).
      const crop = box.crop;
      const top = (crop?.top ?? 0) >= 1 ? pad : 0;
      const bottom = (crop?.bottom ?? 0) >= 1 ? pad : 0;
      if (crop !== undefined) blank = true;
      held.push({
        rect: m.rect,
        drawn: {
          ...m.rect,
          row: m.rect.row - up - top,
          height: m.rect.height + top + bottom,
        },
      });
      if (up > 0) moved.set(box.grid, { ...box, row: box.row - up });
    }
    // A member holding the others ends where they do: past them it would
    // be a band of ground the width of the panel.
    for (const m of cluster.members) {
      const box = byGrid.get(m.grid);
      if (!box || !blank || !holds(m.rect)) continue;
      const inner = held
        .filter((h) => inside(h.rect, m.rect))
        .map((h) => h.drawn);
      if (inner.length === 0) continue;
      const first = Math.min(...inner.map((h) => h.row));
      const last = Math.max(...inner.map((h) => h.row + h.height));
      const crop = box.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
      const top = Math.max(crop.top, first - box.row);
      const bottom = Math.max(crop.bottom, box.row + box.height - last);
      if (top === crop.top && bottom === crop.bottom) continue;
      moved.set(box.grid, { ...box, crop: { ...crop, top, bottom } });
    }
  }
  return boxes.map((b) => moved.get(b.grid) ?? b);
}

/**
 * A panel's members as drawn (the person's pick, 「接地」): each grown into
 * its blank border, its outer sides lined, its header and footer bands,
 * and a rule wherever two members meet. Members inside another (a
 * picker's root box under its input, list and preview) meet nothing.
 */
export function panelLayout(
  cluster: FloatCluster,
  boxes: ReadonlyMap<number, GridBox>,
  cell: { readonly width: number; readonly height: number },
  padBlock: number,
): { parts: PanelPart[]; rules: PanelRule[] } {
  const { width: cw, height: ch } = cell;
  const grown = cluster.members.map((m) => {
    const box = boxes.get(m.grid);
    const crop = box?.crop;
    const r = m.rect;
    // A blank border row is the block padding (`compactPanels` has taken
    // the rest of it where two members meet), on the panel's edge or not.
    // A member holding the others (a picker's root box) has no border of
    // its own: what `compactPanels` cut off it is not padding.
    const holder = cluster.members.some((o) => o !== m && inside(o.rect, r));
    const block = (side: "top" | "bottom") => {
      const room = crop?.[side] ?? 0;
      return room < 1 || holder ? 0 : padBlock;
    };
    const left = (crop?.left ?? 0) >= 1 ? cw : 0;
    const right = (crop?.right ?? 0) >= 1 ? cw : 0;
    const top = block("top");
    const bottom = block("bottom");
    const rect: PixelRect = {
      x: r.col * cw - left,
      y: r.row * ch - top,
      w: r.width * cw + left + right,
      h: r.height * ch + top + bottom,
    };
    const header =
      (box?.header ?? 0) > 0
        ? { x: rect.x, y: r.row * ch, w: rect.w, h: (box?.header ?? 0) * ch }
        : undefined;
    const footer =
      (box?.footer ?? 0) > 0
        ? {
            x: rect.x,
            y: (r.row + r.height - (box?.footer ?? 0)) * ch,
            w: rect.w,
            h: (box?.footer ?? 0) * ch,
          }
        : undefined;
    return { m, rect, header, footer };
  });
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  // Whether `others` cover the strip just past `side` of `rect` whole.
  const coveredPast = (rect: PixelRect, side: Side, self: number) => {
    const vertical = side === "left" || side === "right";
    const from = vertical ? rect.y : rect.x;
    const to = vertical ? rect.y + rect.h : rect.x + rect.w;
    const at =
      side === "left"
        ? rect.x - 0.5
        : side === "right"
          ? rect.x + rect.w + 0.5
          : side === "top"
            ? rect.y - 0.5
            : rect.y + rect.h + 0.5;
    const spans = grown
      .filter((g) => g.m.grid !== self)
      .map((g) => g.rect)
      .filter((o) =>
        vertical ? at >= o.x && at <= o.x + o.w : at >= o.y && at <= o.y + o.h,
      )
      .map((o) => (vertical ? [o.y, o.y + o.h] : [o.x, o.x + o.w]))
      .sort((p, q) => (p[0] ?? 0) - (q[0] ?? 0));
    let reach = from;
    for (const [s, e] of spans) {
      if ((s ?? 0) > reach + 0.5) return false;
      reach = Math.max(reach, e ?? 0);
    }
    return reach >= to - 0.5;
  };
  const parts: PanelPart[] = grown.map((g) => ({
    grid: g.m.grid,
    rect: g.rect,
    outer: {
      top: !coveredPast(g.rect, "top", g.m.grid),
      right: !coveredPast(g.rect, "right", g.m.grid),
      bottom: !coveredPast(g.rect, "bottom", g.m.grid),
      left: !coveredPast(g.rect, "left", g.m.grid),
    },
    ...(g.header ? { header: g.header } : {}),
    ...(g.footer ? { footer: g.footer } : {}),
  }));
  const rules: PanelRule[] = [];
  grown.forEach((a, i) => {
    grown.forEach((b, j) => {
      if (j <= i) return;
      if (inside(a.m.rect, b.m.rect) || inside(b.m.rect, a.m.rect)) return;
      const A = a.rect;
      const B = b.rect;
      const y0 = Math.max(A.y, B.y);
      const y1 = Math.min(A.y + A.h, B.y + B.h);
      const x0 = Math.max(A.x, B.x);
      const x1 = Math.min(A.x + A.w, B.x + B.w);
      if (y1 - y0 > 0.5) {
        if (near(A.x + A.w, B.x))
          rules.push({ x: B.x, y: y0, w: 0, h: y1 - y0 });
        else if (near(B.x + B.w, A.x))
          rules.push({ x: A.x, y: y0, w: 0, h: y1 - y0 });
      }
      if (x1 - x0 > 0.5) {
        if (near(A.y + A.h, B.y))
          rules.push({ x: x0, y: B.y, w: x1 - x0, h: 0 });
        else if (near(B.y + B.h, A.y))
          rules.push({ x: x0, y: A.y, w: x1 - x0, h: 0 });
      }
    });
  });
  // A seam a cell wide between members without a border: a rule through
  // its middle.
  for (const s of cluster.seams) {
    const cx = (s.col + s.width / 2) * cw;
    const cy = (s.row + s.height / 2) * ch;
    const filled = grown.some(
      (g) =>
        cx > g.rect.x &&
        cx < g.rect.x + g.rect.w &&
        cy > g.rect.y &&
        cy < g.rect.y + g.rect.h,
    );
    if (filled) continue;
    if (s.width === 1)
      rules.push({
        x: (s.col + 0.5) * cw,
        y: s.row * ch,
        w: 0,
        h: s.height * ch,
      });
    else
      rules.push({
        x: s.col * cw,
        y: (s.row + 0.5) * ch,
        w: s.width * cw,
        h: 0,
      });
  }
  return { parts, rules };
}
