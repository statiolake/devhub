/**
 * The grids on screen: one 2D canvas per grid, positioned where
 * `layoutGrids` says, repainted a dirty row at a time.
 *
 * Thin on purpose — everything about *what* is on a grid is the reducer's
 * (`redraw.ts`). A row is painted as runs of one highlight: the background
 * filled, the text drawn (a run of single-width characters as one string,
 * anything wider cell by cell so a CJK glyph from a fallback font still
 * lands on its two cells), then the underline family and strikethrough in
 * the special colour. Ligatures are off (`font-variant-ligatures: none`):
 * a cell grid cannot place a glyph that spans cells it did not ask for.
 */

import type { GridBox, HlAttr, NeovimUiState, RedrawChanges } from "./redraw";
import type { CellMetrics } from "./mouse";
import { boxArms, fitIcon, glyphKind, glyphShapes, type Shape } from "./glyphs";
import {
  floatClusters,
  framePieces,
  underFrames,
  type FloatCorners,
  type FramedMember,
} from "./floats";
import {
  NO_THEME,
  barLayout,
  barsOf,
  fillerStart,
  floatScrollbars,
  isEndOfBuffer,
  isSeparatorLine,
  sameTheme,
  separatorsOf,
  shapedSpans,
  spanCorners,
  spanNotches,
  type Bars,
  type PaintTheme,
  type Separator,
} from "./chrome";
import {
  SIDES,
  frameGeometry,
  labelBox,
  type FrameLabel,
  type Side,
} from "./frame";

export interface FontSpec {
  readonly family: string;
  readonly size: number;
  /** Extra pixels between rows (`linespace`). */
  readonly linespace: number;
}

export interface Metrics extends CellMetrics {
  readonly baseline: number;
  /** The font's own advance; `width` is it on whole device pixels. */
  readonly advance: number;
  /** The font's ascent plus descent: the cell's height less `linespace`. */
  readonly textHeight: number;
  /** Where that text box starts in the cell (half the `linespace`). */
  readonly textTop: number;
}

const FALLBACK_FAMILY = `Menlo, "SF Mono", Monaco, "DejaVu Sans Mono", monospace`;

/**
 * The Symbols Nerd Font Mono DevHub bundles (`fonts/`, declared in
 * `neovim.css` with a `unicode-range` of the Nerd Font icon code points
 * only). It comes first in every font stack of the page: it answers for
 * nothing but icons, so the person's `guifont` keeps every other character,
 * and the icons of nvim-web-devicons, lualine, blink.cmp and the rest draw
 * whatever `guifont` says — a Nerd Font installed or not.
 */
export const ICON_FAMILY = `"DevHub Nerd Symbols"`;

/** `guifont` (`Fira Code,Menlo:h13`) as a CSS family list and a size. */
export function parseGuifont(
  value: unknown,
): { family?: string; size?: number } | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const [faces, ...options] = value.split(":");
  const family = (faces ?? "")
    .split(",")
    .map((face) => face.trim().replaceAll("_", " "))
    // A weight in the name (Neovide's "Hiragino Sans W3") is no CSS family:
    // the family is what a fallback can find.
    .map((face) => face.replace(/^(Hiragino .+?) W\d$/, "$1"))
    .filter((face) => face.length > 0)
    .map((face) => (/^[\w-]+$/.test(face) ? face : `"${face}"`))
    .join(", ");
  let size: number | undefined;
  for (const option of options) {
    const match = /^h(\d+(?:\.\d+)?)$/.exec(option);
    if (match) size = Number(match[1]);
  }
  return {
    ...(family.length > 0 ? { family } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

/** A CSS colour (a theme token's value) as 24-bit RGB, or `undefined`. */
export function rgbOfCss(value: string): number | undefined {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || value.trim() === "") return undefined;
  ctx.fillStyle = "#000001";
  ctx.fillStyle = value.trim();
  const out = ctx.fillStyle;
  if (typeof out !== "string" || !out.startsWith("#") || out === "#000001") {
    return undefined;
  }
  return Number.parseInt(out.slice(1, 7), 16);
}

export function cssColor(rgb: number, alpha = 1): string {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return alpha >= 1
    ? `rgb(${String(r)},${String(g)},${String(b)})`
    : `rgba(${String(r)},${String(g)},${String(b)},${String(alpha)})`;
}

/** `rgb` blended `percent` of the way to `under`, as `winblend` does. */
export function mixColors(rgb: number, under: number, percent: number): number {
  const t = Math.max(0, Math.min(100, percent)) / 100;
  const channel = (shift: number) => {
    const a = (rgb >> shift) & 0xff;
    const b = (under >> shift) & 0xff;
    return Math.round(a + (b - a) * t) << shift;
  };
  return channel(16) | channel(8) | channel(0);
}

/** A highlight's colours on the default ones, `reverse` applied. */
export function resolveColors(
  attr: HlAttr | undefined,
  defaults: { foreground: number; background: number; special: number },
): { fg: number; bg: number; sp: number } {
  let fg = attr?.foreground ?? defaults.foreground;
  let bg = attr?.background ?? defaults.background;
  if (attr?.reverse === true) [fg, bg] = [bg, fg];
  return { fg, bg, sp: attr?.special ?? fg };
}

export function fontOf(spec: FontSpec, attr?: HlAttr): string {
  return `${attr?.italic === true ? "italic " : ""}${attr?.bold === true ? "bold " : ""}${String(spec.size)}px ${ICON_FAMILY}, ${spec.family ? `${spec.family}, ${FALLBACK_FAMILY}` : FALLBACK_FAMILY}`;
}

/** `fontOf` without the icon font: what the cell is measured in. */
function textFontOf(spec: FontSpec): string {
  return `${String(spec.size)}px ${spec.family ? `${spec.family}, ${FALLBACK_FAMILY}` : FALLBACK_FAMILY}`;
}

/**
 * The cell, on whole device pixels: a cell that starts between two device
 * pixels is a cell whose text the compositor resamples, which is blur on a
 * Retina screen. `advance` is the font's own, which the painter spreads to
 * the cell's width with `letterSpacing`.
 */
export function measureFont(spec: FontSpec, dpr = 1): Metrics {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx)
    return {
      width: spec.size * 0.6,
      height: spec.size * 1.3,
      baseline: spec.size,
      advance: spec.size * 0.6,
      textHeight: spec.size * 1.05,
      textTop: spec.linespace / 2,
    };
  ctx.font = textFontOf(spec);
  const m = ctx.measureText("M");
  const ascent = m.fontBoundingBoxAscent || spec.size * 0.8;
  const descent = m.fontBoundingBoxDescent || spec.size * 0.25;
  const snap = (value: number) => Math.max(1, Math.round(value * dpr)) / dpr;
  return {
    width: snap(m.width),
    height: snap(Math.ceil(ascent + descent) + spec.linespace),
    baseline: snap(spec.linespace / 2 + ascent),
    advance: m.width,
    textHeight: ascent + descent,
    textTop: spec.linespace / 2,
  };
}

interface GridCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** The crop it was sized for (`GridBox.crop`). */
  crop?: string;
}

const NO_CROP = { top: 0, right: 0, bottom: 0, left: 0 } as const;

/** A diff filler's hatching: pixels between its diagonals. */
const FILLER_STEP = 6;

/** A selection's or search match's corners (`chrome.ts`). */
const SHAPE_RADIUS = 3;

/** A float's outer corners' radius (DevHub's frame); a border of lines has none. */
const FLOAT_RADIUS = 6;

/**
 * What of a grid its canvas shows: a float's left-out blank border, or a
 * framed float's border (DevHub draws the frame).
 */
function cropOf(box: GridBox) {
  return box.frame?.margins ?? box.crop ?? NO_CROP;
}

function radii(corners: FloatCorners, r: number): string {
  const px = (on: boolean) => `${String(on ? r : 0)}px`;
  return `${px(corners.tl)} ${px(corners.tr)} ${px(corners.br)} ${px(corners.bl)}`;
}

/** One ground under a panel of floats (`placeClusters`). */
interface Piece {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly radius: string;
  readonly background: string;
  /** A framed member's lines: top, right, bottom, left, as CSS borders. */
  readonly borders?: readonly string[];
  /** A blended framed member's text area, left out. */
  readonly hole?: string;
  /** A framed member's zindex: its lines are drawn at it. */
  readonly z?: number;
}

/** A title or footer on a frame's line. */
interface Label {
  readonly x: number;
  readonly w: number;
  readonly cy: number;
  readonly background: string;
  readonly runs: readonly { text: string; color: string; font: string }[];
}

export class GridPainter {
  private readonly canvases = new Map<number, GridCanvas>();
  /** One shadow per panel of floats (`floats.ts`), by what it looks like. */
  private readonly clusters = new Map<
    string,
    {
      readonly ground: HTMLDivElement;
      readonly frames: readonly HTMLDivElement[];
      readonly labels?: HTMLDivElement;
    }
  >();
  private font: FontSpec;
  private metrics: Metrics;
  private theme: PaintTheme = NO_THEME;
  /** The status lines and winbars (`barsOf`), and what they were last. */
  private bars: Bars = new Map();
  private barsKey = "";
  /** Grid 1's columns between two windows (`separatorsOf`). */
  private separators: readonly Separator[] = [];
  private separatorsKey = "";
  /** `rowGrounds`, by grid and row, for the paint under way. */
  private readonly grounds = new Map<number, Int32Array>();
  /** The row's cells whose glyph is not drawn (a bar's joints). */
  private readonly skip = new Set<number>();
  private dpr: number;
  /** The row's icons, drawn after its backgrounds (`paintRow`). */
  private readonly icons: {
    c: string;
    x: number;
    cells: number;
    attr: HlAttr | undefined;
    fg: number;
    spill: boolean;
  }[] = [];
  /** Icons' ink boxes, by font and character. */
  private readonly inks = new Map<
    string,
    { left: number; right: number; ascent: number; descent: number }
  >();

  constructor(
    private readonly root: HTMLElement,
    font: FontSpec,
  ) {
    this.font = font;
    this.dpr = window.devicePixelRatio || 1;
    this.metrics = measureFont(font, this.dpr);
  }

  /**
   * The window moved to a screen of another density: the cell is measured
   * again and every canvas redrawn at it. Answers whether it had changed.
   */
  syncDevicePixelRatio(): boolean {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === this.dpr) return false;
    this.dpr = dpr;
    this.metrics = measureFont(this.font, dpr);
    return true;
  }

  cell(): Metrics {
    return this.metrics;
  }

  setFont(font: FontSpec): boolean {
    if (
      font.family === this.font.family &&
      font.size === this.font.size &&
      font.linespace === this.font.linespace
    ) {
      return false;
    }
    this.font = font;
    this.metrics = measureFont(font, this.dpr);
    return true;
  }

  /** What the colorscheme says beyond the grid (`chrome.ts`); answers whether it changed. */
  setTheme(theme: PaintTheme): boolean {
    if (sameTheme(theme, this.theme)) return false;
    this.theme = theme;
    return true;
  }

  fontSpec(): FontSpec {
    return this.font;
  }

  /** What the colorscheme says beyond the grid, as last asked. */
  paintTheme(): PaintTheme {
    return this.theme;
  }

  /** Bring every canvas in line with the state; repaint what changed. */
  paint(
    state: NeovimUiState,
    changes: RedrawChanges,
    boxes: readonly GridBox[],
    forceAll: boolean,
  ): void {
    this.grounds.clear();
    const onScreen = new Set(boxes.map((box) => box.grid));
    for (const [id, canvas] of this.canvases) {
      if (!state.grids.has(id)) {
        canvas.canvas.remove();
        this.canvases.delete(id);
      } else if (!onScreen.has(id)) {
        canvas.canvas.style.display = "none";
      }
    }
    const all = forceAll || changes.colors;
    const hidden = underFrames(boxes);
    const shown = boxes.filter((box) => !hidden.has(box.grid));
    for (const grid of hidden) {
      const entry = this.canvases.get(grid);
      if (entry) entry.canvas.style.display = "none";
    }
    const corners = this.placeClusters(state, shown);
    const scrollbars = floatScrollbars(state, shown);
    this.placeBars(state, shown);
    this.placeSeparators(state, shown);
    for (const box of shown) {
      const grid = state.grids.get(box.grid);
      if (!grid) continue;
      let entry = this.canvases.get(box.grid);
      let fresh = false;
      if (!entry) {
        const canvas = document.createElement("canvas");
        canvas.className = "nvim-grid";
        const ctx = canvas.getContext("2d", { alpha: true });
        if (!ctx) continue;
        entry = { canvas, ctx, width: -1, height: -1 };
        this.canvases.set(box.grid, entry);
        this.root.append(canvas);
        fresh = true;
      }
      const { canvas } = entry;
      // A float's blank border is left out: the canvas is its text area,
      // where Neovim put it (`paintRow` draws the grid shifted by it).
      const crop = cropOf(box);
      const cropKey = `${String(crop.top)},${String(crop.right)},${String(crop.bottom)},${String(crop.left)}`;
      canvas.style.display = "";
      canvas.style.left = `${String((box.col + crop.left) * this.metrics.width)}px`;
      canvas.style.top = `${String((box.row + crop.top) * this.metrics.height)}px`;
      canvas.style.zIndex = String(box.z);
      canvas.classList.toggle("nvim-float", box.float);
      const round = corners.get(box.grid);
      canvas.style.borderRadius =
        round && box.lined !== true ? radii(round, FLOAT_RADIUS) : "";
      canvas.classList.toggle("nvim-framed", box.frame !== undefined);
      // A menu's scrollbar drawn as floats: the thumb a thin rounded bar
      // in the middle of its cell, the gutter left to the menu's ground,
      // as an overlay scrollbar.
      const part = scrollbars.get(box.grid);
      canvas.style.clipPath =
        part === "thumb"
          ? this.thumbClip()
          : part === "gutter"
            ? "inset(50%)"
            : "";
      if (
        entry.width !== grid.width ||
        entry.height !== grid.height ||
        entry.crop !== cropKey ||
        fresh ||
        forceAll
      ) {
        const w = (grid.width - crop.left - crop.right) * this.metrics.width;
        const h = (grid.height - crop.top - crop.bottom) * this.metrics.height;
        canvas.width = Math.max(1, Math.ceil(w * this.dpr));
        canvas.height = Math.max(1, Math.ceil(h * this.dpr));
        canvas.style.width = `${String(w)}px`;
        canvas.style.height = `${String(h)}px`;
        entry.width = grid.width;
        entry.height = grid.height;
        entry.crop = cropKey;
        fresh = true;
      }
      const rows =
        fresh || all
          ? Array.from({ length: grid.height }, (_, row) => row)
          : this.withNeighbours(grid.dirty, grid.height);
      for (const row of rows) this.paintRow(entry, state, box, row);
      grid.dirty.clear();
      const scrolled = changes.scrolled.get(box.grid) ?? 0;
      if (scrolled !== 0 && !box.float && !fresh) {
        this.glide(canvas, scrolled, grid.height);
      }
    }
  }

  /**
   * Where the status lines and winbars are; when that changed, the rows
   * they were and are on are repainted.
   */
  private placeBars(state: NeovimUiState, boxes: readonly GridBox[]): void {
    const bars = barsOf(state, boxes, this.theme.cmdheight);
    const key = JSON.stringify([...bars].map(([g, rows]) => [g, [...rows]]));
    if (key === this.barsKey) return;
    for (const map of [this.bars, bars]) {
      for (const [grid, rows] of map) {
        const dirty = state.grids.get(grid)?.dirty;
        for (const row of rows.keys()) dirty?.add(row);
      }
    }
    this.bars = bars;
    this.barsKey = key;
  }

  /**
   * The window separators and the grounds on their sides; when those
   * changed (a split, `NormalNC` on the window left), grid 1's rows they
   * were and are on are repainted.
   */
  private placeSeparators(
    state: NeovimUiState,
    boxes: readonly GridBox[],
  ): void {
    const base = state.grids.get(1);
    const separators = separatorsOf(
      boxes,
      base?.width ?? 0,
      base?.height ?? 0,
      (grid, index) => {
        const g = state.grids.get(grid);
        const attr = state.hl.get(g?.hls[index] ?? 0);
        return resolveColors(attr, state.defaults).bg;
      },
    );
    const key = JSON.stringify(separators);
    if (key === this.separatorsKey) return;
    const dirty = state.grids.get(1)?.dirty;
    for (const sep of [...this.separators, ...separators]) dirty?.add(sep.row);
    this.separators = separators;
    this.separatorsKey = key;
  }

  /** A float scrollbar's thumb (`floatScrollbars`) as a thin rounded bar. */
  private thumbClip(): string {
    const { width: cw } = this.metrics;
    const w = Math.min(4, cw);
    const side = (cw - w) / 2;
    return `inset(1px ${String(side)}px 1px ${String(side)}px round ${String(w / 2)}px)`;
  }

  /**
   * The rows to repaint for `dirty`: with shaped colours about, the rows
   * next to each too — a selection's corners there depend on it.
   */
  private withNeighbours(dirty: ReadonlySet<number>, height: number) {
    if (this.theme.shaped.size === 0) return [...dirty];
    const rows = new Set<number>();
    for (const row of dirty) {
      if (row > 0) rows.add(row - 1);
      rows.add(row);
      if (row + 1 < height) rows.add(row + 1);
    }
    return [...rows];
  }

  /**
   * An IME's preedit, drawn as the grid draws text: the grid's font, its
   * baseline and cell, each character on its cells (`preeditLayout`), so the
   * composition sits where the committed text will; underlined across its
   * cells as the grid underlines, a bar after it for the caret.
   */
  paintPreedit(
    canvas: HTMLCanvasElement,
    layout: {
      readonly chars: readonly { ch: string; col: number; cells: number }[];
      readonly cells: number;
    },
    fg: number,
    bg: number,
  ): void {
    const { width: cw, height: ch, baseline } = this.metrics;
    const w = Math.max(1, layout.cells) * cw + 2;
    canvas.width = Math.max(1, Math.ceil(w * this.dpr));
    canvas.height = Math.max(1, Math.ceil(ch * this.dpr));
    canvas.style.width = `${String(w)}px`;
    canvas.style.height = `${String(ch)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = cssColor(bg);
    ctx.fillRect(0, 0, w, ch);
    ctx.fillStyle = cssColor(fg);
    ctx.font = fontOf(this.font);
    ctx.textBaseline = "alphabetic";
    ctx.letterSpacing = "0px";
    for (const c of layout.chars) ctx.fillText(c.ch, c.col * cw, baseline);
    ctx.strokeStyle = cssColor(fg);
    ctx.lineWidth = 1;
    const uy = baseline + 2.5;
    ctx.beginPath();
    ctx.moveTo(0, uy);
    ctx.lineTo(layout.cells * cw, uy);
    ctx.stroke();
    ctx.fillRect(layout.cells * cw, 0, 2, ch);
  }

  /**
   * The shadow under each panel of floats (`floatClusters`): one element per
   * cluster under its members, holding a ground for each member and seam,
   * whose drop shadow follows their union's outline. A member whose border
   * is a frame (`frame.ts`) gets its ground out to its lines and no
   * further, the lines and its title and footer drawn here: the float is cut
   * at its line. Kept while the cluster looks the same, so a member's redraw
   * does not touch it. Answers each member's outer corners, for its canvas's
   * radius.
   */
  private placeClusters(
    state: NeovimUiState,
    boxes: readonly GridBox[],
  ): Map<number, FloatCorners> {
    const { width: cw, height: ch } = this.metrics;
    const corners = new Map<number, FloatCorners>();
    const live = new Set<string>();
    const blendOf = (grid: number) => {
      const hl = state.grids.get(grid)?.hls[0] ?? 0;
      return state.hl.get(hl)?.blend ?? 0;
    };
    // A float that lets what is under it show (winblend) gets no ground,
    // unless it is framed: then the ring between its lines and its text.
    const shown = boxes.filter(
      (box) =>
        box.float && (box.frame !== undefined || blendOf(box.grid) === 0),
    );
    const byGrid = new Map(shown.map((box) => [box.grid, box]));
    const colors = (hl: number) =>
      resolveColors(hl ? state.hl.get(hl) : undefined, state.defaults);
    const px = (v: number) => `${String(v)}px`;
    for (const cluster of floatClusters(shown)) {
      const first = cluster.members[0];
      const grid = first ? state.grids.get(first.grid) : undefined;
      const ground = colors(grid?.hls[0] ?? 0).bg;
      const blended = cluster.members.some((m) => blendOf(m.grid) > 0);
      const pieces: Piece[] = [];
      const labels: Label[] = [];
      const framed: (FramedMember & { box: GridBox })[] = [];
      for (const m of cluster.members) {
        corners.set(m.grid, m.corners);
        const box = byGrid.get(m.grid);
        if (box?.frame) {
          framed.push({
            grid: m.grid,
            rect: m.rect,
            box,
            geometry: frameGeometry(
              box.frame,
              box,
              this.metrics,
              this.dpr,
              this.font.size,
            ),
          });
          continue;
        }
        if (blendOf(m.grid) > 0) continue;
        pieces.push({
          x: m.rect.col * cw,
          y: m.rect.row * ch,
          w: m.rect.width * cw,
          h: m.rect.height * ch,
          radius: m.lined ? "0" : radii(m.corners, FLOAT_RADIUS),
          background: cssColor(ground),
        });
      }
      const framedGrids = new Set(framed.map((f) => f.grid));
      for (const seam of cluster.seams) {
        if (seam.between.every((g) => framedGrids.has(g))) continue;
        pieces.push({
          x: seam.col * cw,
          y: seam.row * ch,
          w: seam.width * cw,
          h: seam.height * ch,
          radius: "0",
          background: cssColor(ground),
        });
      }
      const geometries = new Map(framed.map((f) => [f.grid, f]));
      for (const piece of framePieces(framed, this.dpr)) {
        const member = geometries.get(piece.grid);
        const frame = member?.box.frame;
        if (!member || !frame) continue;
        const sideHl = SIDES.map((side) => frame.sides[side]?.hl).find(
          (hl) => hl !== undefined,
        );
        const ring = colors(sideHl ?? 0);
        const blend = blendOf(piece.grid);
        const border = (side: Side) => {
          const s = frame.sides[side];
          const width = member.geometry.widths[side];
          if (!piece.draw[side] || !s || width <= 0) return "none";
          return `${px(width)} ${member.geometry.styles[side]} ${cssColor(colors(s.hl).fg)}`;
        };
        pieces.push({
          x: piece.x,
          y: piece.y,
          w: piece.w,
          h: piece.h,
          radius: `${px(piece.radii.tl)} ${px(piece.radii.tr)} ${px(piece.radii.br)} ${px(piece.radii.bl)}`,
          background: cssColor(ring.bg, 1 - blend / 100),
          borders: SIDES.map(border),
          z: member.box.z,
          ...(blend > 0 ? { hole: this.textArea(member.box, piece) } : {}),
        });
        for (const label of frame.labels) {
          labels.push(
            this.label(
              state,
              label,
              labelBox(label, member.box, member.geometry, this.metrics),
            ),
          );
        }
      }
      const lined = cluster.lined;
      const key = JSON.stringify([cluster.z, lined, blended, pieces, labels]);
      live.add(key);
      const known = this.clusters.get(key);
      if (known) {
        // Over the canvases, which may have come since.
        if (known.labels && known.labels !== this.root.lastElementChild)
          this.root.append(known.labels);
        continue;
      }
      const el = document.createElement("div");
      el.className = `nvim-float-shadow${lined ? " nvim-float-shadow-lined" : ""}${blended ? " nvim-float-shadow-none" : ""}`;
      el.style.zIndex = String(cluster.z);
      const pieceOf = (part: Piece, lines: boolean) => {
        const piece = document.createElement("div");
        piece.style.left = px(part.x);
        piece.style.top = px(part.y);
        piece.style.width = px(part.w);
        piece.style.height = px(part.h);
        piece.style.borderRadius = part.radius;
        piece.style.background = part.background;
        if (part.borders) {
          piece.style.boxSizing = "border-box";
          piece.style.borderTop = part.borders[0] ?? "none";
          piece.style.borderRight = part.borders[1] ?? "none";
          piece.style.borderBottom = part.borders[2] ?? "none";
          piece.style.borderLeft = part.borders[3] ?? "none";
        }
        if (part.hole) piece.style.clipPath = part.hole;
        if (!lines) {
          // The ground only, for the shadow's outline.
          piece.style.border = "none";
          piece.style.background = part.hole ? "transparent" : part.background;
        }
        return piece;
      };
      // A framed member's ground and lines at its own zindex, under its
      // canvas but over a lower member's (a picker's borderless box under
      // its framed list): one element per zindex, before the canvases.
      const frames = new Map<number, HTMLDivElement>();
      for (const part of pieces) {
        el.append(pieceOf(part, part.z === undefined));
        if (part.z === undefined) continue;
        let layer = frames.get(part.z);
        if (!layer) {
          layer = document.createElement("div");
          layer.className = "nvim-float-frames";
          layer.style.zIndex = String(part.z);
          frames.set(part.z, layer);
        }
        layer.append(pieceOf(part, true));
      }
      // The labels over the members (a sibling's canvas may reach a line):
      // an element of their own, at the members' top zindex, after them.
      const textHeight = Math.round(this.metrics.textHeight) + 2;
      const over =
        labels.length > 0 ? document.createElement("div") : undefined;
      if (over) {
        over.className = "nvim-frame-labels";
        over.style.zIndex = String(
          Math.max(...cluster.members.map((m) => byGrid.get(m.grid)?.z ?? 0)),
        );
      }
      for (const label of labels) {
        const tag = document.createElement("div");
        tag.className = "nvim-frame-label";
        const pad = Math.max(4, Math.round(cw * 0.5));
        tag.style.left = px(label.x - pad);
        tag.style.minWidth = px(label.w + 2 * pad);
        tag.style.top = px(label.cy - textHeight / 2);
        tag.style.height = px(textHeight);
        tag.style.lineHeight = px(textHeight);
        tag.style.padding = `0 ${px(pad)}`;
        tag.style.borderRadius = px(textHeight / 2);
        tag.style.background = label.background;
        for (const run of label.runs) {
          const span = document.createElement("span");
          span.textContent = run.text;
          span.style.color = run.color;
          span.style.font = run.font;
          span.style.lineHeight = px(textHeight);
          tag.append(span);
        }
        over?.append(tag);
      }
      // Under the canvases of the same zindex: they come later.
      for (const layer of frames.values()) this.root.prepend(layer);
      this.root.prepend(el);
      if (over) this.root.append(over);
      this.clusters.set(key, {
        ground: el,
        frames: [...frames.values()],
        ...(over ? { labels: over } : {}),
      });
    }
    for (const [key, entry] of this.clusters) {
      if (!live.has(key)) {
        entry.ground.remove();
        for (const layer of entry.frames) layer.remove();
        entry.labels?.remove();
        this.clusters.delete(key);
      }
    }
    return corners;
  }

  /** A title or footer, in its highlights, at `at`. */
  private label(
    state: NeovimUiState,
    label: FrameLabel,
    at: { x: number; w: number; cy: number },
  ): Label {
    const colors = (hl: number) =>
      resolveColors(hl ? state.hl.get(hl) : undefined, state.defaults);
    return {
      x: at.x,
      w: at.w,
      cy: at.cy,
      background: cssColor(colors(label.runs[0]?.hl ?? 0).bg),
      runs: label.runs.map((run) => ({
        text: run.text,
        color: cssColor(colors(run.hl).fg),
        font: fontOf(this.font, state.hl.get(run.hl)),
      })),
    };
  }

  /**
   * A blended framed float's text area, cut out of its ring's ground (its
   * canvas draws its own, blended once), as a `clip-path` in the piece's
   * own coordinates.
   */
  private textArea(
    box: GridBox,
    piece: { x: number; y: number; w: number; h: number },
  ): string {
    const { width: cw, height: ch } = this.metrics;
    const m = box.frame?.margins ?? NO_CROP;
    const x0 = (box.col + m.left) * cw - piece.x;
    const y0 = (box.row + m.top) * ch - piece.y;
    const x1 = (box.col + box.width - m.right) * cw - piece.x;
    const y1 = (box.row + box.height - m.bottom) * ch - piece.y;
    const n = (v: number) => String(Math.round(v * 100) / 100);
    return `path(evenodd, "M0 0H${n(piece.w)}V${n(piece.h)}H0Z M${n(x0)} ${n(y0)}H${n(x1)}V${n(y1)}H${n(x0)}Z")`;
  }

  private paintRow(
    entry: GridCanvas,
    state: NeovimUiState,
    box: GridBox,
    row: number,
  ): void {
    const grid = state.grids.get(box.grid);
    if (!grid || row >= grid.height) return;
    const { ctx } = entry;
    const { width: cw, height: ch, baseline } = this.metrics;
    const crop = cropOf(box);
    if (row < crop.top || row >= grid.height - crop.bottom) return;
    ctx.setTransform(
      this.dpr,
      0,
      0,
      this.dpr,
      -crop.left * cw * this.dpr,
      -crop.top * ch * this.dpr,
    );
    const y = row * ch;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, grid.width * cw, ch);
    ctx.clip();
    ctx.clearRect(0, y, grid.width * cw, ch);
    const base = row * grid.width;
    this.icons.length = 0;
    const runs: { start: number; end: number; hl: number }[] = [];
    let col = 0;
    while (col < grid.width) {
      const hl = grid.hls[base + col] ?? 0;
      let end = col + 1;
      while (end < grid.width && grid.hls[base + end] === hl) end += 1;
      runs.push({ start: col, end, hl });
      col = end;
    }
    // Every ground first, then the shapes over them, then the text: a
    // selection's rounded corner shows the ground beside it, and no run's
    // ground covers the text of the run before it.
    for (const run of runs) {
      this.paintGround(ctx, state, box, grid.chars, base, run, y);
    }
    if (box.grid === 1) this.paintSeparators(ctx, state, grid, base, row, y);
    this.paintShaped(ctx, state, box, row, y);
    this.skip.clear();
    this.paintBars(ctx, state, box, row, y);
    this.paintPills(ctx, state, box, row, y);
    if (!box.float && box.grid !== 1) this.paintFiller(ctx, state, box, row, y);
    if (
      !box.float &&
      box.grid !== 1 &&
      isEndOfBuffer(
        grid.chars,
        base,
        grid.width,
        resolveColors(state.hl.get(grid.hls[base] ?? 0), state.defaults).fg,
        this.theme.eob,
      )
    ) {
      this.skip.add(0);
    }
    for (const run of runs) {
      this.paintRun(
        ctx,
        state,
        grid.chars,
        grid.hls,
        grid.width,
        base,
        run.start,
        run.end,
        run.hl,
        y,
        baseline,
      );
    }
    // After every background of the row: an icon may reach into the blank
    // cell after it, which a later run would otherwise paint over.
    for (const icon of this.icons) {
      ctx.fillStyle = cssColor(icon.fg);
      this.paintIcon(ctx, icon.c, icon.x, y, icon.cells, icon.attr, icon.spill);
    }
    this.icons.length = 0;
    ctx.restore();
  }

  /**
   * A window separator's cell (a vertical line, `│` by default) as the two
   * windows meeting: each half in the ground of the window on its side, the
   * line (drawn over, a device pixel or so) alone between them, as editor
   * groups meet. A blank separator (`vert: `) is a band by choice: left.
   */
  private paintSeparators(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    grid: {
      readonly chars: readonly string[];
      readonly hls: ArrayLike<number>;
    },
    base: number,
    row: number,
    y: number,
  ): void {
    const { width: cw, height: ch } = this.metrics;
    const { chars } = grid;
    const across = (c: string) => {
      const arms = boxArms(c);
      return arms !== undefined && arms.e > 0 && arms.w > 0 && arms.n === 0;
    };
    for (const sep of this.separators) {
      if (sep.row !== row) continue;
      if (!isSeparatorLine(chars[base + sep.col] ?? "")) continue;
      const x = sep.col * cw;
      const mid = Math.round((x + cw / 2) * this.dpr) / this.dpr;
      ctx.fillStyle = cssColor(sep.left);
      ctx.fillRect(x, y, mid - x, ch);
      ctx.fillStyle = cssColor(sep.right);
      ctx.fillRect(mid, y, x + cw - mid, ch);
      // A status line drawn as a line (`─`, a person's `stl:`) beside it
      // meets the separator's line instead of stopping half a cell short.
      for (const [dc, stub] of [
        [-1, "╴"],
        [1, "╶"],
      ] as const) {
        const next = base + sep.col + dc;
        if (!across(chars[next] ?? "")) continue;
        const fg = resolveColors(
          state.hl.get(grid.hls[next] ?? 0),
          state.defaults,
        ).fg;
        const shapes = glyphShapes(
          stub,
          { x, y, w: cw, h: ch },
          this.dpr,
          this.font.size,
        );
        if (shapes) this.paintShapes(ctx, shapes, fg);
      }
    }
  }

  /**
   * A status line or winbar as a bar (`barLayout`): its segments of other
   * colours as pills, a little inside the row and rounded at their ends,
   * and Powerline's filled separators between them as the bar's ground.
   */
  private paintBars(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    box: GridBox,
    row: number,
    y: number,
  ): void {
    const spans = this.bars.get(box.grid)?.get(row);
    const grid = state.grids.get(box.grid);
    if (!spans || !grid) return;
    const { width: cw, height: ch, textHeight } = this.metrics;
    const chars = grid.chars.slice(row * grid.width, (row + 1) * grid.width);
    const grounds = this.rowGrounds(state, box, row);
    // As tall as the text and a pixel more each side, never the whole row.
    const snap = (v: number) => Math.round(v * this.dpr) / this.dpr;
    const h = snap(Math.min(ch - 2, textHeight + 2));
    const top = snap(y + (ch - h) / 2);
    const r = Math.min(h / 2, cw);
    for (const span of spans) {
      const bar = barLayout(chars, grounds, span);
      if (bar.pills.length === 0 && bar.joints.length === 0) continue;
      ctx.fillStyle = cssColor(bar.ground);
      for (const pill of bar.pills) {
        ctx.fillRect(pill.start * cw, y, (pill.end - pill.start) * cw, ch);
      }
      for (const col of bar.joints) {
        ctx.fillRect(col * cw, y, cw, ch);
        this.skip.add(col);
      }
      for (const pill of bar.pills) {
        const x0 = pill.start * cw;
        const x1 = pill.end * cw;
        const left = pill.roundLeft ? r : 0;
        const right = pill.roundRight ? r : 0;
        ctx.fillStyle = cssColor(pill.bg);
        ctx.beginPath();
        ctx.roundRect(x0, top, x1 - x0, h, [left, right, right, left]);
        ctx.fill();
      }
    }
  }

  /**
   * Text Neovim adds to a line in a colour of its own (`PaintTheme.pills`:
   * diagnostics' virtual text, inlay hints) as a pill: a little inside the
   * row, rounded at its ends, the ground beside it around it. Its cells are
   * where Neovim put them, so the cursor and `$` land as before.
   */
  private paintPills(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    box: GridBox,
    row: number,
    y: number,
  ): void {
    const { pills } = this.theme;
    if (pills.size === 0) return;
    const grounds = this.rowGrounds(state, box, row);
    const spans = shapedSpans(grounds, pills);
    if (spans.length === 0) return;
    const { width: cw, height: ch, textHeight } = this.metrics;
    const snap = (v: number) => Math.round(v * this.dpr) / this.dpr;
    const h = snap(Math.min(ch - 2, textHeight + 2));
    const top = snap(y + (ch - h) / 2);
    const r = Math.min(h / 2, cw * 0.75);
    for (const span of spans) {
      const x0 = span.start * cw;
      const x1 = span.end * cw;
      const left = span.start > 0 ? grounds[span.start - 1] : undefined;
      const right = grounds[span.end];
      const beside =
        left !== undefined && left >= 0 && !pills.has(left)
          ? left
          : right !== undefined && right >= 0 && !pills.has(right)
            ? right
            : state.defaults.background;
      ctx.fillStyle = cssColor(beside);
      ctx.fillRect(x0, y, x1 - x0, ch);
      ctx.fillStyle = cssColor(span.bg);
      ctx.beginPath();
      ctx.roundRect(x0, top, x1 - x0, h, r);
      ctx.fill();
    }
  }

  /**
   * A diff's filler row (`-` in `DiffDelete`, the default `diff:`) as a
   * hatched band, as GUI diff views mark lines that are not there: thin
   * diagonals in its foreground, continuous from row to row.
   */
  private paintFiller(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    box: GridBox,
    row: number,
    y: number,
  ): void {
    const grid = state.grids.get(box.grid);
    const diff = this.theme.diffDelete;
    if (!grid || !diff) return;
    const base = row * grid.width;
    const colors = (col: number) =>
      resolveColors(state.hl.get(grid.hls[base + col] ?? 0), state.defaults);
    const start = fillerStart(grid.chars, base, grid.width, colors, diff);
    if (start === undefined) return;
    const { width: cw, height: ch } = this.metrics;
    const x0 = start * cw;
    const x1 = grid.width * cw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y, x1 - x0, ch);
    ctx.clip();
    ctx.strokeStyle = cssColor(colors(grid.width - 1).fg);
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = FILLER_STEP;
    // Lines x + y = k·step, so they run on across rows of the grid.
    const first = Math.floor((x0 + y) / step) * step;
    for (let k = first; k <= x1 + y + ch + step; k += step) {
      ctx.moveTo(k - y, y);
      ctx.lineTo(k - y - ch, y + ch);
    }
    ctx.stroke();
    ctx.restore();
    for (let col = start; col < grid.width; col += 1) this.skip.add(col);
  }

  /**
   * The backgrounds of one row's cells, `reverse` applied; kept for the
   * paint (a row is asked for by its neighbours' shapes too).
   */
  private rowGrounds(state: NeovimUiState, box: GridBox, row: number) {
    const key = box.grid * 65536 + row;
    const known = this.grounds.get(key);
    if (known) return known;
    const grid = state.grids.get(box.grid);
    const out = new Int32Array(grid?.width ?? 0);
    this.grounds.set(key, out);
    if (!grid || row < 0 || row >= grid.height) return out.fill(-1);
    const base = row * grid.width;
    for (let col = 0; col < grid.width; col += 1) {
      const attr = state.hl.get(grid.hls[base + col] ?? 0);
      // A blended cell is no selection to shape.
      out[col] =
        box.float && (attr?.blend ?? 0) > 0
          ? -1
          : resolveColors(attr, state.defaults).bg;
    }
    return out;
  }

  /**
   * Selections and search matches (`PaintTheme.shaped`) as one rounded
   * shape over the rows they span: each run's cells take the ground beside
   * it, and the run is filled over that with its corners rounded where the
   * row above or below does not continue it.
   */
  private paintShaped(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    box: GridBox,
    row: number,
    y: number,
  ): void {
    const { shaped } = this.theme;
    if (shaped.size === 0) return;
    const grounds = this.rowGrounds(state, box, row);
    const spans = shapedSpans(grounds, shaped);
    if (spans.length === 0) return;
    const above = shapedSpans(this.rowGrounds(state, box, row - 1), shaped);
    const below = shapedSpans(this.rowGrounds(state, box, row + 1), shaped);
    const { width: cw, height: ch } = this.metrics;
    const r = Math.max(0, Math.min(SHAPE_RADIUS, cw / 2, ch / 2));
    for (const span of spans) {
      const x0 = span.start * cw;
      const x1 = span.end * cw;
      const left = span.start > 0 ? grounds[span.start - 1] : -1;
      const right = span.end < grounds.length ? grounds[span.end] : -1;
      const beside =
        left !== undefined && left >= 0 && !shaped.has(left)
          ? left
          : right !== undefined && right >= 0 && !shaped.has(right)
            ? right
            : state.defaults.background;
      ctx.fillStyle = cssColor(beside);
      ctx.fillRect(x0, y, x1 - x0, ch);
      const c = spanCorners(span, above, below);
      ctx.fillStyle = cssColor(span.bg);
      ctx.beginPath();
      ctx.roundRect(x0, y, x1 - x0, ch, [
        c.tl ? r : 0,
        c.tr ? r : 0,
        c.br ? r : 0,
        c.bl ? r : 0,
      ]);
      ctx.fill();
      // The inside corners where the row above or below runs on past this
      // one: the selection's colour, cut round by the ground beside.
      const n = spanNotches(span, above, below);
      const notch = (
        on: boolean,
        x: number,
        top: number,
        cx: number,
        cy: number,
      ) => {
        if (!on || r <= 0) return;
        ctx.fillStyle = cssColor(span.bg);
        ctx.fillRect(x, top, r, r);
        ctx.fillStyle = cssColor(beside);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      };
      notch(n.tl, x0 - r, y, x0 - r, y + r);
      notch(n.tr, x1, y, x1 + r, y + r);
      notch(n.bl, x0 - r, y + ch - r, x0 - r, y + ch - r);
      notch(n.br, x1, y + ch - r, x1 + r, y + ch - r);
    }
  }

  /**
   * A window that scrolled a few rows slides into place (the wheel, `<C-e>`,
   * a search nearby) instead of jumping. The canvas already holds the new
   * rows; it starts where the old ones were and is clipped to its own box
   * as it moves, so nothing slides over the statusline. Not for a jump of
   * more than a third of the window (`<C-d>`, `G`), where a slide would
   * show a band of nothing, nor with reduced motion.
   */
  private glide(canvas: HTMLCanvasElement, rows: number, height: number) {
    if (Math.abs(rows) > Math.max(3, Math.floor(height / 3))) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof canvas.animate !== "function") return;
    const offset = rows * this.metrics.height;
    const top = Math.max(0, -offset);
    const bottom = Math.max(0, offset);
    canvas.animate(
      [
        {
          transform: `translateY(${String(offset)}px)`,
          clipPath: `inset(${String(top)}px 0 ${String(bottom)}px 0)`,
        },
        { transform: "translateY(0)", clipPath: "inset(0 0 0 0)" },
      ],
      { duration: 90, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  }

  /** Rectangles and paths from `glyphShapes`, in the foreground. */
  private paintShapes(
    ctx: CanvasRenderingContext2D,
    shapes: readonly Shape[],
    fg: number,
  ): void {
    ctx.save();
    ctx.fillStyle = cssColor(fg);
    ctx.strokeStyle = cssColor(fg);
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    for (const shape of shapes) {
      if (shape.kind === "rect") {
        ctx.globalAlpha = shape.alpha ?? 1;
        ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.beginPath();
      for (const op of shape.path) {
        if (op[0] === "M") ctx.moveTo(op[1], op[2]);
        else if (op[0] === "L") ctx.lineTo(op[1], op[2]);
        else if (op[0] === "T") ctx.arcTo(op[1], op[2], op[3], op[4], op[5]);
        else if (op[0] === "E")
          ctx.ellipse(op[1], op[2], op[3], op[4], 0, op[5], op[6]);
        else ctx.closePath();
      }
      if (shape.kind === "fill") ctx.fill();
      else {
        ctx.lineWidth = shape.lineWidth ?? 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * A Nerd Font icon in the bundled symbols font first, fitted to its cell
   * — two when Neovim says it is wide — and centred on the text box, so an
   * icon from a font of other metrics neither spills into its neighbour nor
   * sits off the baseline.
   */
  private paintIcon(
    ctx: CanvasRenderingContext2D,
    c: string,
    x: number,
    y: number,
    cells: number,
    attr: HlAttr | undefined,
    spill = false,
  ): void {
    const { width: cw, textHeight, textTop } = this.metrics;
    const font = fontOf(this.font, attr);
    ctx.font = font;
    ctx.letterSpacing = "0px";
    const key = `${font}\u0000${c}`;
    let ink = this.inks.get(key);
    if (!ink) {
      const m = ctx.measureText(c);
      ink = {
        left: m.actualBoundingBoxLeft,
        right: m.actualBoundingBoxRight,
        ascent: m.actualBoundingBoxAscent,
        descent: m.actualBoundingBoxDescent,
      };
      this.inks.set(key, ink);
    }
    const box = { w: cells * cw, h: textHeight };
    const fit = fitIcon(ink, box, cells > 1);
    ctx.save();
    // An icon spilling into the blank after it starts on its own cell and
    // takes only the room it needs, so the gap before the text stays.
    const width = (ink.left + ink.right) * fit.scale;
    const cx = spill ? x + Math.max(cw / 2, width / 2) : x + box.w / 2;
    ctx.translate(cx, y + textTop + textHeight / 2);
    ctx.scale(fit.scale, fit.scale);
    ctx.fillText(c, fit.dx, fit.dy);
    ctx.restore();
  }

  /** Fonts arrived (the icon font, a `guifont`): icon fits are measured again. */
  fontsLoaded(): void {
    this.inks.clear();
  }

  /** A run's background, `winblend` applied. */
  private paintGround(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    box: GridBox,
    chars: readonly string[],
    base: number,
    run: { readonly start: number; readonly end: number; readonly hl: number },
    y: number,
  ): void {
    const { width: cw, height: ch } = this.metrics;
    const { start, end } = run;
    const attr = state.hl.get(run.hl);
    const { bg } = resolveColors(attr, state.defaults);
    const blend = box.float && attr?.blend !== undefined ? attr.blend : 0;
    ctx.fillStyle = cssColor(bg, 1 - blend / 100);
    ctx.fillRect(start * cw, y, (end - start) * cw, ch);
    if (blend > 0) {
      // Neovim's compositor shows what is under a blended float only
      // through its blank cells; under its text it is the float's. A cell
      // with text gets a ground of its own — its background blended into
      // the editor's — so the two texts never overprint (fidget's
      // notifications are `winblend` 100).
      ctx.fillStyle = cssColor(mixColors(bg, state.defaults.background, blend));
      for (let col = start; col < end; col += 1) {
        const c = chars[base + col] ?? " ";
        if (c === "" || c === " ") continue;
        const wide = chars[base + col + 1] === "";
        ctx.fillRect(col * cw, y, (wide ? 2 : 1) * cw, ch);
      }
    }
  }

  /** A run's text, glyphs and lines, over the grounds. */
  private paintRun(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    chars: readonly string[],
    hls: ArrayLike<number>,
    rowWidth: number,
    base: number,
    start: number,
    end: number,
    hl: number,
    y: number,
    baseline: number,
  ): void {
    const { width: cw, height: ch } = this.metrics;
    const attr = state.hl.get(hl);
    const { fg, bg, sp } = resolveColors(attr, state.defaults);
    const x0 = start * cw;
    const x1 = end * cw;
    ctx.fillStyle = cssColor(fg);
    ctx.font = fontOf(this.font, attr);
    ctx.textBaseline = "alphabetic";
    // A run is one string; the gap between the font's advance and the
    // cell's (whole device pixels) is spread between its letters, so every
    // glyph still starts on its cell.
    ctx.letterSpacing = `${String(cw - this.metrics.advance)}px`;
    let text = "";
    let textStart = start;
    const flush = () => {
      if (text.trim().length > 0)
        ctx.fillText(text, textStart * cw, y + baseline);
      text = "";
    };
    for (let col = start; col < end; col += 1) {
      const c = chars[base + col] ?? " ";
      if (c === "") continue;
      if (this.skip.has(col)) {
        flush();
        textStart = col + 1;
        continue;
      }
      const wide = chars[base + col + 1] === "";
      const kind = glyphKind(c);
      const simple =
        kind === undefined &&
        c.length === 1 &&
        c.charCodeAt(0) < 0x2e80 &&
        !wide;
      if (simple) {
        if (text.length === 0) textStart = col;
        text += c;
      } else {
        flush();
        const cells = wide ? 2 : 1;
        const shapes =
          kind === "box" || kind === "block" || kind === "powerline"
            ? glyphShapes(
                c,
                { x: col * cw, y, w: cells * cw, h: ch },
                this.dpr,
                this.font.size,
              )
            : undefined;
        if (shapes !== undefined) {
          this.paintShapes(ctx, shapes, fg);
        } else if (kind === "icon") {
          // An icon followed by a blank cell of the same background gets
          // both cells, as kitty and WezTerm give it: nvim-web-devicons,
          // lualine and the completion menus all put a space after their
          // icons, and a Mono icon squeezed into one cell is half the size
          // the Nerd Font draws it.
          const next = base + col + 1;
          const roomy =
            !wide &&
            col + 1 < rowWidth &&
            chars[next] === " " &&
            resolveColors(state.hl.get(hls[next] ?? 0), state.defaults).bg ===
              bg;
          this.icons.push({
            c,
            x: col * cw,
            cells: roomy ? 2 : cells,
            spill: roomy,
            attr,
            fg,
          });
        } else if (c.trim().length > 0) {
          ctx.letterSpacing = "0px";
          ctx.fillText(c, col * cw, y + baseline);
          ctx.letterSpacing = `${String(cw - this.metrics.advance)}px`;
        }
        textStart = col + 1;
      }
    }
    flush();
    ctx.letterSpacing = "0px";
    if (
      attr?.underline ||
      attr?.undercurl ||
      attr?.underdouble ||
      attr?.underdotted ||
      attr?.underdashed ||
      attr?.strikethrough
    ) {
      ctx.strokeStyle = cssColor(sp);
      ctx.lineWidth = 1;
      const uy = y + baseline + 2.5;
      ctx.beginPath();
      if (attr.undercurl) {
        const amp = 1.5;
        ctx.moveTo(x0, uy);
        for (let x = x0; x < x1; x += 2) {
          ctx.lineTo(
            x + 1,
            uy + (Math.floor((x - x0) / 2) % 2 === 0 ? -amp : amp),
          );
        }
      } else if (
        attr.underline ||
        attr.underdouble ||
        attr.underdotted ||
        attr.underdashed
      ) {
        if (attr.underdotted) ctx.setLineDash([1, 2]);
        else if (attr.underdashed) ctx.setLineDash([3, 2]);
        ctx.moveTo(x0, uy);
        ctx.lineTo(x1, uy);
        if (attr.underdouble) {
          ctx.moveTo(x0, uy + 2);
          ctx.lineTo(x1, uy + 2);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (attr.strikethrough) {
        ctx.strokeStyle = cssColor(fg);
        ctx.beginPath();
        ctx.moveTo(x0, y + ch / 2);
        ctx.lineTo(x1, y + ch / 2);
        ctx.stroke();
      }
    }
  }
}
