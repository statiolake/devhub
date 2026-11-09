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

import type {
  GridBox,
  HlAttr,
  LinesMoved,
  NeovimUiState,
  RedrawChanges,
} from "./redraw";
import type { CellMetrics } from "./mouse";
import { pinnedRows, type BufposAnchor, type FloatRef } from "./riders";
import { strokesFor, type Stroke, type StrokeKind } from "./strokes";
import { boxArms, fitIcon, glyphKind, glyphShapes, type Shape } from "./glyphs";
import { familyOf, markPath, type KindFamily } from "./kinds";
import {
  foldLineOf,
  placeDecor,
  wordsOf,
  type Decor,
  type FoldLine,
} from "./decor";
import {
  bandGround,
  floatClusters,
  framePieces,
  underFrames,
  type FloatCorners,
  type FramedMember,
} from "./floats";
import {
  NO_THEME,
  fillChosen,
  fillerStart,
  floatScrollbars,
  isEndOfBuffer,
  isSeparatorLine,
  sameTheme,
  separatorsOf,
  type PaintTheme,
  type Separator,
} from "./chrome";
import {
  WHEEL_IDLE_MS,
  isActive,
  coverage,
  newScrollView,
  shifted,
  step,
  wheeled,
  type ScrollRequest,
  type ScrollView,
} from "./smoothScroll";
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
/**
 * The UI face, as the completion menu's labels wear it (`neovim.css`):
 * decorations' words are set in it (`decor.ts`).
 */
const UI_FAMILY = `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`;

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

/**
 * How far a closed fold's line fill fades out (`paintFoldLine`): about a
 * dozen cells, the same in a window of any width.
 */
const FOLD_FADE = 260;

/**
 * How long lines a `dd`, `p` or `o` moved take to slide into place
 * (`slideLines`): short enough to be over before the next key is read
 * (typing at 120 wpm is ~100 ms a key), long enough to say where they came
 * from. The person's pick of three mocks (round 6: 0, 60, 100 ms).
 */
const SLIDE_MS = 60;

/**
 * A float's outer corners' radius (DevHub's frame); a border of lines has
 * none. A third of the default line (18 px): the corner reads as lifted at
 * the text's scale and never reaches a row's text. DevHub's own popups
 * (the completion menu, `gui.popup`, the command line) wear it too.
 */
export const FLOAT_RADIUS = 6;

/**
 * A selected row's band in a rounded float (a completion menu's, a
 * picker's) is inset by this much where its row has blank cells at both
 * ends, and rounded by the float's radius less it, so its corners are
 * concentric with the float's: the band is the float's own shape, smaller.
 * Half the radius: the rim and the band's corner share it equally.
 */
const BAND_INSET = FLOAT_RADIUS / 2;

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

/**
 * A window's pixel scrolling (`smoothScroll.ts`): its display, the ghost of
 * what was on screen when Neovim last scrolled it, and its winbar held in
 * place while the text moves.
 */
interface ScrollSlot {
  readonly view: ScrollView;
  /**
   * The window's text area, clipping what moves in it: the canvas and the
   * ghost are moved inside it by transforms only, which the compositor
   * does without painting anything again.
   */
  port?: HTMLDivElement;
  ghost?: HTMLCanvasElement;
  spare?: HTMLCanvasElement;
  pin?: HTMLCanvasElement;
}

export class GridPainter {
  private readonly canvases = new Map<number, GridCanvas>();
  /** Each window grid's pixel scrolling, by grid. */
  private readonly scrolls = new Map<number, ScrollSlot>();
  /** One shadow per panel of floats (`floats.ts`), by what it looks like. */
  private readonly clusters = new Map<
    string,
    {
      readonly ground: HTMLDivElement;
      readonly frames: readonly HTMLDivElement[];
      readonly labels?: HTMLDivElement;
      /** Its members' grids, as last laid out. */
      grids: readonly number[];
    }
  >();
  /**
   * Floats at a buffer position (`bufpos`), by window: they ride their
   * anchor window's text while it scrolls in pixels (`rideFloats`).
   */
  private bufposFloats: ReadonlyMap<number, BufposAnchor> = new Map();
  /** Each riding float as last seen with its line in view, by grid. */
  private readonly floatRefs = new Map<number, FloatRef>();
  /** Window grids following another's display (`scrollbind`), by leader. */
  private readonly followers = new Map<number, readonly number[]>();
  /** The rows each window grid has scrolled, as painted (`riders.ts`). */
  private readonly painted = new Map<number, number>();
  /** Each riding float's shift, by grid (pixels, down positive). */
  private readonly floatShifts = new Map<number, number>();
  private font: FontSpec;
  private metrics: Metrics;
  private theme: PaintTheme = NO_THEME;
  /** Lines sliding into place after a `dd` or an `o`, by grid. */
  private readonly slides = new Map<
    number,
    {
      readonly clip: HTMLElement;
      readonly image: HTMLCanvasElement;
      readonly x: number;
      readonly y: number;
    }
  >();
  /** Where each window's decorations are, as Lua last said (`decor.ts`). */
  private decor: Decor = new Map();
  /** The row's decorations' words, drawn after its text (`paintRow`). */
  private readonly words: {
    start: number;
    end: number;
    align: "left" | "right";
  }[] = [];
  /** Grid 1's columns between two windows (`separatorsOf`). */
  private separators: readonly Separator[] = [];
  private separatorsKey = "";
  /** The row's cells whose glyph is not drawn (`~`, a filler's `-`). */
  private readonly skip = new Set<number>();
  private dpr: number;
  /** Floats whose canvas is rounded (not a border of lines, not framed). */
  private readonly roundFloats = new Set<number>();
  /** The editor face's cap height: a kind mark's size. */
  private capHeight = 0;
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

  /**
   * Where each window's decorations are now: the windows whose changed,
   * whose rows are to be painted again.
   */
  setDecor(decor: Decor): number[] {
    const changed: number[] = [];
    for (const win of new Set([...decor.keys(), ...this.decor.keys()])) {
      if (
        JSON.stringify(decor.get(win)) !== JSON.stringify(this.decor.get(win))
      )
        changed.push(win);
    }
    this.decor = decor;
    return changed;
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
    const onScreen = new Set(boxes.map((box) => box.grid));
    for (const [id, canvas] of this.canvases) {
      if (!state.grids.has(id)) {
        canvas.canvas.remove();
        this.canvases.delete(id);
      } else if (!onScreen.has(id)) {
        canvas.canvas.style.display = "none";
      }
    }
    for (const id of this.scrolls.keys()) {
      if (!onScreen.has(id)) this.dropScroll(id);
    }
    for (const [grid, rows] of changes.scrolled) {
      this.painted.set(grid, (this.painted.get(grid) ?? 0) + rows);
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
      if (round && box.lined !== true && box.frame === undefined)
        this.roundFloats.add(box.grid);
      else this.roundFloats.delete(box.grid);
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
      // A blank blended float (a picker's or a dialog's backdrop) is one
      // tint over everything: a layer of its colour, no bitmap to paint.
      const backdrop = box.float ? this.backdropOf(state, box) : undefined;
      if (backdrop !== undefined) {
        if (entry.width !== -2) {
          canvas.width = 1;
          canvas.height = 1;
          entry.width = -2;
        }
        canvas.style.width = `${String(grid.width * this.metrics.width)}px`;
        canvas.style.height = `${String(grid.height * this.metrics.height)}px`;
        canvas.style.background = backdrop;
        grid.dirty.clear();
        continue;
      }
      if (entry.width === -2) canvas.style.background = "";
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
      const scrolled = changes.scrolled.get(box.grid) ?? 0;
      const smooth = this.smoothable(state, box);
      if (!smooth || fresh) this.dropScroll(box.grid);
      else if (scrolled !== 0) this.scrolledBy(state, box, entry, scrolled);
      const rows =
        fresh || all
          ? Array.from({ length: grid.height }, (_, row) => row)
          : [...grid.dirty];
      const moved = changes.moved.get(box.grid);
      // Lines moved again, or the grid repainted whole: a slide under way
      // ends at once, so what is drawn is never behind Neovim.
      if (moved !== undefined || fresh || all) this.endSlide(box.grid);
      for (const row of rows) this.paintRow(entry, state, box, row);
      grid.dirty.clear();
      // Rows repainted under a slide (the cursor line's highlight, a
      // blame text) go on sliding as they are now.
      if (rows.length > 0) this.refreshSlide(box.grid, entry);
      if (
        moved &&
        !changes.scrolled.has(box.grid) &&
        !box.float &&
        box.win !== undefined &&
        box.grid !== 1
      ) {
        this.slideLines(entry, state, box, moved);
      }
      if (smooth) this.placeScroll(state, box);
    }
  }

  /**
   * A float that is a backdrop — no border, every cell blank, all in one
   * ground with `winblend` (its `Normal` and its `EndOfBuffer` rows are
   * two highlights of one colour) — as the CSS colour it tints with: its
   * ground at `100 - blend` percent, which is what Neovim's compositor
   * mixes.
   */
  private backdropOf(state: NeovimUiState, box: GridBox): string | undefined {
    if (box.frame || box.crop) return undefined;
    const grid = state.grids.get(box.grid);
    if (!grid || grid.width * grid.height === 0) return undefined;
    let tint: string | undefined;
    let last = -1;
    const n = grid.width * grid.height;
    for (let i = 0; i < n; i += 1) {
      if (grid.chars[i] !== " ") return undefined;
      const hl = grid.hls[i] ?? 0;
      if (hl === last) continue;
      last = hl;
      const attr = state.hl.get(hl);
      if (attr?.blend === undefined || attr.blend <= 0) return undefined;
      const { bg } = resolveColors(attr, state.defaults);
      const css = cssColor(bg, 1 - attr.blend / 100);
      if (tint !== undefined && css !== tint) return undefined;
      tint = css;
    }
    return tint;
  }

  /**
   * Whether a grid scrolls in pixels: a window's (not a float's, not the
   * message grid's), with Neovim saying how far it scrolls.
   */
  private smoothable(state: NeovimUiState, box: GridBox): boolean {
    return (
      !box.float &&
      box.grid !== 1 &&
      state.windows.get(box.grid)?.placement.kind === "window"
    );
  }

  /** The rows of a window's text area (its winbar and the like left out). */
  private textRows(state: NeovimUiState, box: GridBox) {
    const m = state.margins.get(box.grid);
    const top = Math.min(box.height, m?.top ?? 0);
    const bottom = Math.max(top, box.height - (m?.bottom ?? 0));
    return { top, bottom };
  }

  /**
   * Neovim scrolled a window by `rows`: before its canvas takes the new
   * rows, what is on screen now becomes the ghost (the canvas and the old
   * ghost, as displayed), and the display is measured from the new
   * `topline`. With reduced motion only the wheel's own scrolling is
   * followed; Neovim's jumps.
   */
  private scrolledBy(
    state: NeovimUiState,
    box: GridBox,
    entry: GridCanvas,
    rows: number,
  ): void {
    const now = performance.now();
    let slot = this.scrolls.get(box.grid);
    const led =
      slot !== undefined &&
      (slot.view.pending !== 0 || now - slot.view.wheelAt < WHEEL_IDLE_MS);
    if (!led && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.dropScroll(box.grid);
      return;
    }
    if (!slot) {
      slot = { view: newScrollView() };
      this.scrolls.set(box.grid, slot);
    }
    const { height: ch } = this.metrics;
    const text = this.textRows(state, box);
    this.takeGhost(slot, entry, text);
    shifted(slot.view, rows, ch, (text.bottom - text.top) * ch, now);
  }

  /** What the window shows now, drawn into its ghost (`scrolledBy`). */
  private takeGhost(
    slot: ScrollSlot,
    entry: GridCanvas,
    text: { top: number; bottom: number },
  ): void {
    const { canvas } = entry;
    const make = () => {
      const c = document.createElement("canvas");
      c.className = "nvim-grid nvim-scroll-ghost";
      return c;
    };
    const old = slot.view.ghost !== undefined ? slot.ghost : undefined;
    const into = old ? (slot.spare ?? make()) : (slot.ghost ?? make());
    if (into.width !== canvas.width || into.height !== canvas.height) {
      into.width = canvas.width;
      into.height = canvas.height;
    }
    const ctx = into.getContext("2d");
    if (!ctx) return;
    const dpr = this.dpr;
    const ch = this.metrics.height;
    const top = Math.round(text.top * ch * dpr);
    const bottom = Math.round(text.bottom * ch * dpr);
    const off = Math.round(slot.view.off * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, into.width, into.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, into.width, bottom - top);
    ctx.clip();
    if (old && slot.view.ghost !== undefined) {
      ctx.drawImage(old, 0, Math.round(slot.view.ghost * dpr) - off);
    }
    ctx.drawImage(canvas, 0, -off);
    ctx.restore();
    if (into !== slot.ghost) {
      if (slot.ghost) {
        slot.ghost.remove();
        slot.spare = slot.ghost;
      }
      slot.ghost = into;
    }
    if (into.parentElement !== canvas.parentElement) canvas.before(into);
  }

  /** Forget a grid's pixel scrolling: its canvas shows Neovim's grid as it is. */
  private dropScroll(grid: number): void {
    const slot = this.scrolls.get(grid);
    if (!slot) return;
    slot.ghost?.remove();
    slot.pin?.remove();
    this.scrolls.delete(grid);
    const entry = this.canvases.get(grid);
    if (entry && slot.port) {
      const { canvas } = entry;
      slot.port.before(canvas);
      canvas.style.transform = "";
      canvas.style.clipPath = "";
      canvas.style.left = slot.port.dataset.left ?? "0px";
      canvas.style.top = slot.port.dataset.top ?? "0px";
    }
    slot.port?.remove();
  }

  /**
   * The canvas, the ghost and the winbar's pin where the display is: the
   * text moved by `off`, clipped to the text area; the margins where they
   * are.
   */
  private placeScroll(state: NeovimUiState, box: GridBox): void {
    const slot = this.scrolls.get(box.grid);
    const entry = this.canvases.get(box.grid);
    if (!slot || !entry) return;
    const { canvas } = entry;
    const view = slot.view;
    if (!isActive(view)) {
      this.dropScroll(box.grid);
      return;
    }
    const { width: cw, height: ch } = this.metrics;
    const text = this.textRows(state, box);
    const H = box.height * ch;
    const t = text.top * ch;
    const b = text.bottom * ch;
    const off = view.off;
    let port = slot.port;
    if (!port) {
      port = document.createElement("div");
      port.className = "nvim-scroll-port";
      slot.port = port;
    }
    if (canvas.parentElement !== port) {
      canvas.before(port);
      port.append(canvas);
    }
    const left = `${String(box.col * cw)}px`;
    const top = `${String(box.row * ch)}px`;
    port.dataset.left = left;
    port.dataset.top = top;
    port.style.left = left;
    port.style.top = `${String(box.row * ch + t)}px`;
    port.style.width = canvas.style.width;
    port.style.height = `${String(b - t)}px`;
    port.style.zIndex = canvas.style.zIndex;
    port.style.display = canvas.style.display;
    canvas.style.left = "0px";
    canvas.style.top = `${String(-t)}px`;
    canvas.style.transform = off === 0 ? "" : `translateY(${String(-off)}px)`;
    // Its winbar must not slide into the text area with it (the pin shows
    // it in place).
    canvas.style.clipPath =
      t > 0 || b < H ? `inset(${String(t)}px 0 ${String(H - b)}px 0)` : "";
    const ghost = slot.ghost;
    if (ghost && view.ghost !== undefined) {
      ghost.style.display = "";
      ghost.style.left = "0px";
      ghost.style.top = `${String(-t)}px`;
      ghost.style.width = canvas.style.width;
      ghost.style.height = canvas.style.height;
      ghost.style.transform = `translateY(${String(view.ghost - off)}px)`;
    } else if (ghost) {
      ghost.style.display = "none";
    }
    this.pinMargins(slot, entry, text, box, off !== 0);
  }

  /** A winbar (the text area's margins) stays put while the text moves. */
  private pinMargins(
    slot: ScrollSlot,
    entry: GridCanvas,
    text: { top: number; bottom: number },
    box: GridBox,
    moving: boolean,
  ): void {
    if (!moving || (text.top === 0 && text.bottom === box.height)) {
      if (slot.pin) slot.pin.style.display = "none";
      return;
    }
    const { canvas } = entry;
    let pin = slot.pin;
    if (!pin) {
      pin = document.createElement("canvas");
      pin.className = "nvim-grid";
      slot.pin = pin;
    }
    if (!pin.isConnected) slot.port?.after(pin);
    if (pin.width !== canvas.width || pin.height !== canvas.height) {
      pin.width = canvas.width;
      pin.height = canvas.height;
    }
    pin.style.display = "";
    pin.style.left = `${String(box.col * this.metrics.width)}px`;
    pin.style.top = `${String(box.row * this.metrics.height)}px`;
    pin.style.width = canvas.style.width;
    pin.style.height = canvas.style.height;
    pin.style.zIndex = canvas.style.zIndex;
    const ctx = pin.getContext("2d");
    if (!ctx) return;
    const dpr = this.dpr;
    const ch = this.metrics.height;
    const top = Math.round(text.top * ch * dpr);
    const bottom = Math.round(text.bottom * ch * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pin.width, pin.height);
    if (top > 0) {
      ctx.drawImage(canvas, 0, 0, canvas.width, top, 0, 0, canvas.width, top);
    }
    if (bottom < canvas.height) {
      const h = canvas.height - bottom;
      ctx.drawImage(
        canvas,
        0,
        bottom,
        canvas.width,
        h,
        0,
        bottom,
        canvas.width,
        h,
      );
    }
  }

  /**
   * The wheel moved `dy` pixels over `box`; answers whether that window
   * scrolls in pixels (else the wheel is Neovim's, in line steps).
   */
  wheel(state: NeovimUiState, box: GridBox, dy: number): boolean {
    const grid = box.grid;
    if (!this.smoothable(state, box) || !this.canvases.has(grid)) return false;
    let slot = this.scrolls.get(grid);
    if (!slot) {
      slot = { view: newScrollView() };
      this.scrolls.set(grid, slot);
    }
    wheeled(slot.view, dy, performance.now());
    return true;
  }

  /** The display of a window grid that scrolls in pixels, if it does. */
  scrollView(grid: number): ScrollView | undefined {
    return this.scrolls.get(grid)?.view;
  }

  /** How far a window's display is from Neovim's `topline`, in pixels. */
  scrollOffset(grid: number): number {
    return this.scrolls.get(grid)?.view.off ?? 0;
  }

  /** The windows `scrollbind` moves with window grid `leader`. */
  setFollowers(leader: number, grids: readonly number[]): void {
    if (grids.length > 0) this.followers.set(leader, grids);
    else this.followers.delete(leader);
  }

  /** The rows a window grid has scrolled, as painted so far. */
  paintedRows(grid: number): number {
    return this.painted.get(grid) ?? 0;
  }

  /** The floats (by window) that are at a buffer position (`bufpos`). */
  setBufposFloats(wins: ReadonlyMap<number, BufposAnchor>): void {
    this.bufposFloats = wins;
  }

  /** How far a float riding its anchor's text is moved (`rideFloats`). */
  floatShift(grid: number): number {
    return this.floatShifts.get(grid) ?? 0;
  }

  /**
   * A float at a buffer position (a hover, a diagnostic, a signature from
   * a plugin's `relative='win'` with `bufpos`) is where Neovim puts it in
   * its anchor window's grid; while that window's display is moved from
   * the grid (`smoothScroll.ts`), the float is moved with it, its frame
   * and shadow too, so it stays on its text — also when Neovim, led past
   * the display, has its line out of view and pins it to the window's top
   * edge (`pinnedRows`). Other floats stay put, as Neovim keeps them.
   */
  private rideFloats(state: NeovimUiState, boxes: readonly GridBox[]): void {
    const shifts = new Map<number, number>();
    const seen = new Set<number>();
    for (const box of boxes) {
      if (!box.float || box.win === undefined) continue;
      const anchor = this.bufposFloats.get(box.win);
      if (!anchor) continue;
      const p = state.windows.get(box.grid)?.placement;
      if (p?.kind !== "float") continue;
      seen.add(box.grid);
      const off = this.scrolls.get(p.anchorGrid)?.view.off ?? 0;
      const viewport = state.windows.get(p.anchorGrid)?.viewport;
      const anchorBox = boxes.find((b) => b.grid === p.anchorGrid);
      let pin = 0;
      if (viewport && anchorBox) {
        const h = this.metrics.height;
        const text = this.textRows(state, anchorBox);
        const { rows, ref } = pinnedRows({
          anchor,
          anchorRow: p.anchorRow,
          painted: this.paintedRows(p.anchorGrid),
          topline: viewport.topline,
          botline: viewport.botline,
          ref: this.floatRefs.get(box.grid),
          off: off / h,
          textRows: text.bottom,
        });
        if (ref) this.floatRefs.set(box.grid, ref);
        // At rest the display is Neovim's grid: a line out of its view is
        // out of the display, and the float is where Neovim pins it.
        if (off !== 0) pin = rows * h;
      }
      if (off !== 0 || pin !== 0) shifts.set(box.grid, pin - off);
    }
    for (const grid of this.floatRefs.keys()) {
      if (!seen.has(grid)) this.floatRefs.delete(grid);
    }
    const move = (el: HTMLElement, dy: number | undefined) => {
      const t = dy === undefined ? "" : `translateY(${String(dy)}px)`;
      if (el.style.transform !== t) el.style.transform = t;
    };
    for (const grid of new Set([
      ...this.floatShifts.keys(),
      ...shifts.keys(),
    ])) {
      const entry = this.canvases.get(grid);
      if (entry) move(entry.canvas, shifts.get(grid));
    }
    for (const cluster of this.clusters.values()) {
      const grid = cluster.grids.find((g) => shifts.has(g));
      const dy = grid === undefined ? undefined : shifts.get(grid);
      move(cluster.ground, dy);
      for (const layer of cluster.frames) move(layer, dy);
      if (cluster.labels) move(cluster.labels, dy);
    }
    this.floatShifts.clear();
    for (const [grid, dy] of shifts) this.floatShifts.set(grid, dy);
  }

  /**
   * One frame of every window's pixel scrolling: the displays moved, and
   * what to ask Neovim. Answers whether any is still moving.
   */
  scrollFrame(
    state: NeovimUiState,
    boxes: readonly GridBox[],
    ask: (grid: number, request: ScrollRequest) => void,
  ): boolean {
    const now = performance.now();
    let moving = false;
    // A window `scrollbind` moves with a scrolling one shows what that one
    // shows: the same offset from Neovim's view (both scroll by the same
    // rows, a diff's filler keeping them in line), within what it has.
    const leaders = new Map<number, ScrollView>();
    for (const [leader, grids] of this.followers) {
      const view = this.scrolls.get(leader)?.view;
      if (!view) {
        this.followers.delete(leader);
        continue;
      }
      for (const grid of grids) if (grid !== leader) leaders.set(grid, view);
    }
    const order = [...this.scrolls].sort(
      ([a], [b]) => Number(leaders.has(a)) - Number(leaders.has(b)),
    );
    for (const [grid, slot] of order) {
      const box = boxes.find((b) => b.grid === grid);
      if (!box) {
        this.dropScroll(grid);
        continue;
      }
      const text = this.textRows(state, box);
      const leader = leaders.get(grid);
      if (leader) {
        const view = slot.view;
        const { lo, hi } = coverage(view);
        view.off = Math.min(hi, Math.max(lo, leader.off));
        view.want = view.off;
        view.ease = undefined;
        view.settled = true;
        this.placeScroll(state, box);
        if (this.scrolls.has(grid)) moving = true;
        continue;
      }
      const request = step(
        slot.view,
        now,
        this.metrics.height,
        text.bottom - text.top,
        this.dpr,
      );
      if (request) ask(grid, request);
      this.placeScroll(state, box);
      if (this.scrolls.has(grid)) moving = true;
    }
    this.rideFloats(state, boxes);
    return moving;
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
   * The cell under a block cursor, drawn as its row draws it (`paintRun`:
   * the cell's face, the grid's baseline and cell, box drawing and icons as
   * shapes) in the cursor's colours, so its character sits on exactly the
   * pixels it has off the cursor. Two cells for a wide character.
   */
  paintCursorCell(
    canvas: HTMLCanvasElement,
    state: NeovimUiState,
    cursor: {
      readonly grid: number;
      readonly row: number;
      readonly col: number;
    },
    fg: number,
    bg: number,
  ): void {
    const { width: cw, height: ch, baseline } = this.metrics;
    const grid = state.grids.get(cursor.grid);
    const { row, col } = cursor;
    const inside = grid !== undefined && row < grid.height && col < grid.width;
    const base = inside ? row * grid.width : 0;
    const cells = inside && grid.chars[base + col + 1] === "" ? 2 : 1;
    const w = Math.ceil(cells * cw * this.dpr);
    const h = Math.ceil(ch * this.dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${String(cells * cw)}px`;
    canvas.style.height = `${String(ch)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = cssColor(bg);
    ctx.fillRect(0, 0, cells * cw, ch);
    if (!inside) return;
    ctx.translate(-col * cw, 0);
    // On a closed fold (its first cell is the cursor's): the chevron, as
    // the row draws it, not the `+` of the marker under it.
    const win = state.gridWins.get(cursor.grid);
    const spans = win === undefined ? undefined : this.decor.get(win);
    const fold = spans
      ? foldLineOf(
          { chars: grid.chars, base, width: grid.width },
          spans.filter((span) => span.row === row),
        )
      : undefined;
    if (fold && col >= fold.start) {
      if (col === fold.chevron) this.paintChevron(ctx, col * cw, 0, false, fg);
      return;
    }
    this.skip.clear();
    this.icons.length = 0;
    this.paintRun(
      ctx,
      state,
      grid.chars,
      grid.hls,
      grid.width,
      base,
      col,
      col + cells,
      grid.hls[base + col] ?? 0,
      0,
      baseline,
      fg,
    );
    for (const icon of this.icons) {
      ctx.fillStyle = cssColor(icon.fg);
      this.paintIcon(ctx, icon.c, icon.x, 0, icon.cells, icon.attr, icon.spill);
    }
    this.icons.length = 0;
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
        known.grids = cluster.members.map((m) => m.grid);
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
        grids: cluster.members.map((m) => m.grid),
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
    // Every ground first, then the shapes over them, then the text: no
    // run's ground covers the text of the run before it.
    const band = this.bandOf(state, box, grid, row);
    if (band) {
      // A selected row in a rounded float: the float's ground, then the
      // row's grounds inside the band's rounded outline.
      ctx.fillStyle = cssColor(band.ground);
      ctx.fillRect(0, y, grid.width * cw, ch);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(band.x0, y, band.x1 - band.x0, ch, band.radius);
      ctx.clip();
    }
    for (const run of runs) {
      this.paintGround(ctx, state, box, grid.chars, base, run, y);
    }
    if (band) ctx.restore();
    if (box.grid === 1) this.paintSeparators(ctx, state, grid, base, row, y);
    this.skip.clear();
    if (!box.float && box.grid !== 1) this.paintFiller(ctx, state, box, row, y);
    if (
      !box.float &&
      box.grid !== 1 &&
      isEndOfBuffer(
        grid.chars,
        base,
        grid.width,
        this.hasGroup(state, grid.hls[base] ?? 0, "EndOfBuffer") &&
          !fillChosen(this.theme, box.win, "eob"),
      )
    ) {
      this.skip.add(0);
    }
    // Decorations (virtual text, a fold's text) found where Lua says they
    // are: their words are set in the UI face after the row's text, inside
    // their cells (`decor.ts`), so the cells' own glyphs are not drawn.
    this.words.length = 0;
    const spans =
      box.win === undefined || box.float
        ? undefined
        : this.decor.get(box.win)?.filter((span) => span.row === row);
    const cells = { chars: grid.chars, base, width: grid.width };
    // A closed fold is the fold's from its marker to the window's edge.
    const fold = spans ? foldLineOf(cells, spans) : undefined;
    if (fold) {
      for (let col = fold.start; col < grid.width; col += 1) this.skip.add(col);
    }
    if (spans && spans.length > 0) {
      const others = spans.filter((span) => span.kind !== "fold");
      for (const place of placeDecor(cells, others)) {
        const words = wordsOf(cells, place);
        if (!words) continue;
        this.words.push({ ...words, align: place.align });
        for (let col = words.start; col < words.end; col += 1)
          this.skip.add(col);
      }
    }
    // The fold column's open and closed marks as chevrons (mock 3), only
    // where the config shows a fold column; its `|` levels are not drawn.
    const marks =
      !box.float && box.grid !== 1
        ? this.foldColumnMarks(state, grid, base)
        : [];
    for (const mark of marks) this.skip.add(mark.col);
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
      // A completion kind's glyph (the person's own `kind_icons` say which
      // kind it is) in a menu: the kind's mark (`kinds.ts`).
      const kind = box.float ? this.theme.kinds?.icons.get(icon.c) : undefined;
      if (kind) {
        const colour = this.theme.kinds?.colours.get(kind) ?? icon.fg;
        this.paintKind(ctx, familyOf(kind), icon.x, y, colour);
        continue;
      }
      ctx.fillStyle = cssColor(icon.fg);
      this.paintIcon(ctx, icon.c, icon.x, y, icon.cells, icon.attr, icon.spill);
    }
    this.icons.length = 0;
    for (const words of this.words) {
      this.paintWords(ctx, state, grid, base, words, y, baseline);
    }
    if (fold) this.paintFoldLine(ctx, state, grid, base, fold, y, baseline);
    for (const mark of marks) {
      const fg = resolveColors(
        state.hl.get(grid.hls[base + mark.col] ?? 0),
        state.defaults,
      ).fg;
      this.paintChevron(ctx, mark.col * cw, y, mark.open, fg);
    }
    this.words.length = 0;
    ctx.restore();
  }

  /**
   * A decoration's words in the UI face, a step under the editor's size —
   * words about the code, as the completion menu's labels are — each
   * highlight's run after the one before, on the grid's baseline, inside
   * the decoration's cells: narrower than the cells (the usual case) with
   * the slack on the side `align` leaves it; wider (rare) set narrower to
   * fit, so nothing after it moves.
   */
  private paintWords(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    grid: {
      readonly chars: readonly string[];
      readonly hls: ArrayLike<number>;
    },
    base: number,
    words: { start: number; end: number; align: "left" | "right" },
    y: number,
    baseline: number,
  ): void {
    const { width: cw } = this.metrics;
    const size = Math.max(1, this.font.size - 1);
    const pieces: { text: string; attr: HlAttr | undefined; width: number }[] =
      [];
    ctx.save();
    ctx.letterSpacing = "0px";
    ctx.textBaseline = "alphabetic";
    let total = 0;
    for (let col = words.start; col < words.end; ) {
      const hl = grid.hls[base + col] ?? 0;
      let text = "";
      let end = col;
      while (end < words.end && (grid.hls[base + end] ?? 0) === hl) {
        text += grid.chars[base + end] ?? "";
        end += 1;
      }
      const attr = state.hl.get(hl);
      ctx.font = this.wordsFont(attr, size);
      const width = ctx.measureText(text).width;
      pieces.push({ text, attr, width });
      total += width;
      col = end;
    }
    const room = (words.end - words.start) * cw;
    const scale = total > room ? room / total : 1;
    let x =
      words.align === "right"
        ? words.end * cw - total * scale
        : words.start * cw;
    for (const piece of pieces) {
      ctx.font = this.wordsFont(piece.attr, size);
      ctx.fillStyle = cssColor(resolveColors(piece.attr, state.defaults).fg);
      ctx.save();
      ctx.translate(x, 0);
      ctx.scale(scale, 1);
      if (piece.text.trim().length > 0)
        ctx.fillText(piece.text, 0, y + baseline);
      ctx.restore();
      x += piece.width * scale;
    }
    ctx.restore();
  }

  /**
   * Lines Neovim moved inside a window that did not scroll — a `dd`, a
   * `p` or an `o` (`grid_scroll` with no `scroll_delta`, which says
   * a window scrolled) — slide from where they were into place in
   * `SLIDE_MS`: what was deleted closes up, what was put in opens a gap.
   * An image of the region as now painted, moved inside a clip of the
   * region by a transform (the compositor's work); the canvas under it is
   * already final, so a key typed meanwhile is never held, and the next
   * paint of the grid ends the slide. A move of more than a third of the
   * window, a window being pixel-scrolled, and reduced motion slide
   * nothing.
   */
  private slideLines(
    entry: GridCanvas,
    state: NeovimUiState,
    box: GridBox,
    moved: LinesMoved,
  ): void {
    const { canvas } = entry;
    if (canvas.parentElement !== this.root) return;
    if (Math.abs(moved.rows) > Math.max(1, Math.floor(box.height / 3))) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const { width: cw, height: ch } = this.metrics;
    const x = moved.left * cw;
    const y = moved.top * ch;
    const w = (moved.right - moved.left) * cw;
    const h = (moved.bot - moved.top) * ch;
    if (w <= 0 || h <= 0) return;
    const clip = document.createElement("div");
    clip.className = "nvim-slide";
    clip.style.left = `${String(parseFloat(canvas.style.left) + x)}px`;
    clip.style.top = `${String(parseFloat(canvas.style.top) + y)}px`;
    clip.style.width = `${String(w)}px`;
    clip.style.height = `${String(h)}px`;
    clip.style.zIndex = canvas.style.zIndex;
    clip.style.background = cssColor(state.defaults.background);
    const image = document.createElement("canvas");
    image.width = Math.max(1, Math.round(w * this.dpr));
    image.height = Math.max(1, Math.round(h * this.dpr));
    image.style.width = `${String(w)}px`;
    image.style.height = `${String(h)}px`;
    clip.append(image);
    canvas.after(clip);
    this.slides.set(box.grid, { clip, image, x, y });
    this.refreshSlide(box.grid, entry);
    const slide = image.animate(
      [
        { transform: `translateY(${String(moved.rows * ch)}px)` },
        { transform: "translateY(0)" },
      ],
      { duration: SLIDE_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    slide.onfinish = () => {
      this.endSlide(box.grid, clip);
    };
  }

  /** A slide's image of its region, as the canvas holds it now. */
  private refreshSlide(grid: number, entry: GridCanvas): void {
    const slide = this.slides.get(grid);
    if (!slide) return;
    const { image } = slide;
    const ctx = image.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, image.width, image.height);
    ctx.drawImage(
      entry.canvas,
      Math.round(slide.x * this.dpr),
      Math.round(slide.y * this.dpr),
      image.width,
      image.height,
      0,
      0,
      image.width,
      image.height,
    );
  }

  private endSlide(grid: number, only?: HTMLElement): void {
    const slide = this.slides.get(grid);
    if (!slide || (only !== undefined && slide.clip !== only)) return;
    slide.clip.remove();
    this.slides.delete(grid);
  }

  /**
   * The fold column's marks on this row: its cells in `FoldColumn` whose
   * character is Neovim's default `+` (closed) or `-` (open). A person's own
   * `foldclose:`/`foldopen:` is theirs; `|` and `│`, the levels between,
   * are left blank (they ruled a line down the column that says nothing a
   * chevron does not).
   */
  private foldColumnMarks(
    state: NeovimUiState,
    grid: {
      readonly chars: readonly string[];
      readonly hls: ArrayLike<number>;
      readonly width: number;
    },
    base: number,
  ): { col: number; open: boolean | undefined }[] {
    const out: { col: number; open: boolean | undefined }[] = [];
    for (let col = 0; col < Math.min(grid.width, 12); col += 1) {
      if (!this.hasGroup(state, grid.hls[base + col] ?? 0, "FoldColumn"))
        continue;
      const c = grid.chars[base + col];
      if (c === "+") out.push({ col, open: false });
      else if (c === "-") out.push({ col, open: true });
      else if (c === "|" || c === "│") out.push({ col, open: undefined });
    }
    return out;
  }

  /**
   * A chevron in a cell: `›` closed, `⌄` open (`undefined`: nothing), two
   * strokes as thick as box drawing's line, so it is the same mark at any
   * font: drawn, not a glyph that each face shapes its own way.
   */
  private paintChevron(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    open: boolean | undefined,
    fg: number,
  ): void {
    if (open === undefined) return;
    const { width: cw, height: ch } = this.metrics;
    const cx = x + cw / 2;
    const cy = y + ch / 2;
    const s = Math.max(2, Math.min(cw, this.font.size) * 0.22);
    ctx.save();
    ctx.strokeStyle = cssColor(fg);
    ctx.lineWidth = Math.max(1, this.font.size / 11);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (open) {
      ctx.moveTo(cx - s, cy - s / 2);
      ctx.lineTo(cx, cy + s / 2);
      ctx.lineTo(cx + s, cy - s / 2);
    } else {
      ctx.moveTo(cx - s / 2, cy - s);
      ctx.lineTo(cx + s / 2, cy);
      ctx.lineTo(cx - s / 2, cy + s);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A closed fold's line (mock 3): `›` where its marker's level puts it
   * (two cells a level: depth by place, as the marker's dashes counted it),
   * its words in the UI face, how many lines it holds dimmer and a step
   * smaller right after them — counted, not a heading — and the fill as
   * one hairline fading out over about a dozen cells (`FOLD_FADE`): it
   * leads into the lines folded without ruling a line across the editor.
   * The ground is the cells' (`Folded`, the cursor line's), as Neovim says;
   * the cursor and a click are on the cells as before.
   */
  private paintFoldLine(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    grid: { readonly hls: ArrayLike<number>; readonly width: number },
    base: number,
    fold: FoldLine,
    y: number,
    baseline: number,
  ): void {
    const { width: cw, height: ch } = this.metrics;
    const attr = state.hl.get(grid.hls[base + fold.start] ?? 0);
    const colors = resolveColors(attr, state.defaults);
    const right = grid.width * cw;
    this.paintChevron(ctx, fold.chevron * cw, y, false, colors.fg);
    ctx.save();
    ctx.letterSpacing = "0px";
    ctx.textBaseline = "alphabetic";
    let x = (fold.chevron + 1.5) * cw;
    ctx.font = this.wordsFont(attr, Math.max(1, this.font.size - 1));
    const words = ctx.measureText(fold.words).width;
    const room = Math.max(0, right - x - 4 * cw);
    const scale = words > room && words > 0 ? room / words : 1;
    ctx.fillStyle = cssColor(colors.fg);
    ctx.save();
    ctx.translate(x, 0);
    ctx.scale(scale, 1);
    ctx.fillText(fold.words, 0, y + baseline);
    ctx.restore();
    x += words * scale;
    const dim = cssColor(mixColors(colors.fg, colors.bg, 45));
    if (fold.count !== undefined) {
      ctx.font = this.wordsFont(undefined, Math.max(1, this.font.size - 2));
      const label = `${String(fold.count)} line${fold.count === 1 ? "" : "s"}`;
      x += cw * 0.8;
      if (x + ctx.measureText(label).width < right) {
        ctx.fillStyle = dim;
        ctx.fillText(label, x, y + baseline);
        x += ctx.measureText(label).width;
      }
    }
    ctx.restore();
    // The fill: box drawing's own line (its thickness and place).
    const shapes = glyphShapes(
      "─",
      { x: 0, y, w: cw, h: ch },
      this.dpr,
      this.font.size,
    );
    const line = shapes?.find((shape) => shape.kind === "rect");
    const x0 = x + cw;
    const x1 = Math.min(right, x0 + FOLD_FADE);
    if (!line || line.kind !== "rect" || x1 <= x0) return;
    const fade = ctx.createLinearGradient(x0, 0, x1, 0);
    fade.addColorStop(0, cssColor(colors.fg, 0.45));
    fade.addColorStop(1, cssColor(colors.fg, 0));
    ctx.fillStyle = fade;
    ctx.fillRect(x0, line.y, x1 - x0, line.h);
  }

  private wordsFont(attr: HlAttr | undefined, size: number): string {
    return `${attr?.italic === true ? "italic " : ""}${attr?.bold === true ? "bold " : ""}${String(size)}px ${ICON_FAMILY}, ${UI_FAMILY}`;
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
    if (!grid || fillChosen(this.theme, box.win, "diff")) return;
    const base = row * grid.width;
    const colors = (col: number) =>
      resolveColors(state.hl.get(grid.hls[base + col] ?? 0), state.defaults);
    const start = fillerStart(grid.chars, base, grid.width, (col) =>
      this.hasGroup(state, grid.hls[base + col] ?? 0, "DiffDelete"),
    );
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

  /** Whether a highlight is made of `group` (`ext_hlstate`). */
  private hasGroup(state: NeovimUiState, hl: number, group: string) {
    return state.hl.get(hl)?.groups?.includes(group) === true;
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
    this.capHeight = 0;
  }

  /**
   * A kind's mark on its cell, a cap height square standing on the
   * baseline: as tall as the capitals of the word beside it, centred on
   * the cell, in the kind's colour (`kindGroups`, else the cell's).
   */
  private paintKind(
    ctx: CanvasRenderingContext2D,
    family: KindFamily,
    x: number,
    y: number,
    fg: number,
  ): void {
    const { width: cw, baseline } = this.metrics;
    if (this.capHeight === 0) {
      ctx.font = fontOf(this.font, undefined);
      this.capHeight = ctx.measureText("H").actualBoundingBoxAscent;
    }
    const size = this.capHeight;
    const mark = markPath(family, size);
    ctx.save();
    ctx.translate(x + (cw - size) / 2, y + baseline - size);
    const path = new Path2D(mark.d);
    if (mark.fill) {
      ctx.fillStyle = cssColor(fg);
      ctx.fill(path);
    } else {
      ctx.strokeStyle = cssColor(fg);
      ctx.lineWidth = mark.stroke;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /**
   * A float row that is a band: a rounded float's one row whose every cell
   * has a ground other than the float's (its neighbours', the float's
   * commonest), a menu's or a picker's selected row. Answers its outline in the canvas's own
   * coordinates, or `undefined` for a row drawn as cells.
   */
  private bandOf(
    state: NeovimUiState,
    box: GridBox,
    grid: {
      readonly width: number;
      readonly height: number;
      readonly chars: readonly string[];
      readonly hls: ArrayLike<number>;
    },
    row: number,
  ): { x0: number; x1: number; radius: number; ground: number } | undefined {
    if (!box.float || !this.roundFloats.has(box.grid)) return undefined;
    const crop = cropOf(box);
    const first = crop.left;
    const last = grid.width - crop.right - 1;
    if (last <= first) return undefined;
    const bgAt = (r: number, c: number) => {
      const attr = state.hl.get(grid.hls[r * grid.width + c] ?? 0);
      if ((attr?.blend ?? 0) > 0) return undefined;
      return resolveColors(attr, state.defaults).bg;
    };
    const ground = bandGround(
      { top: crop.top, bottom: grid.height - crop.bottom },
      first,
      last,
      row,
      bgAt,
    );
    if (ground === undefined) return undefined;
    const blank = (c: string | undefined) => c === " " || c === undefined;
    const base = row * grid.width;
    const inset =
      blank(grid.chars[base + first]) && blank(grid.chars[base + last])
        ? BAND_INSET
        : 0;
    const { width: cw } = this.metrics;
    return {
      x0: first * cw + inset,
      x1: (last + 1) * cw - inset,
      radius: FLOAT_RADIUS - inset,
      ground,
    };
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

  /** One stroke of `strokesFor`, in the current stroke style. */
  private paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
    ctx.lineWidth = stroke.width;
    ctx.lineCap = stroke.round ? "round" : "butt";
    ctx.beginPath();
    if (stroke.points) {
      stroke.points.forEach(([px, py], i) => {
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
    } else if (stroke.y !== undefined) {
      const x0 = stroke.x0 ?? 0;
      ctx.setLineDash(stroke.dash ? [...stroke.dash] : []);
      ctx.lineDashOffset = stroke.dash ? x0 : 0;
      ctx.moveTo(x0, stroke.y);
      ctx.lineTo(stroke.x1 ?? x0, stroke.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
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
    /** The text's colour instead of the highlight's (the cursor's). */
    ink?: number,
  ): void {
    const { width: cw, height: ch } = this.metrics;
    const attr = state.hl.get(hl);
    const colors = resolveColors(attr, state.defaults);
    const { bg, sp } = colors;
    const fg = ink ?? colors.fg;
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
      const kinds: StrokeKind[] = [];
      if (attr.undercurl) kinds.push("undercurl");
      else if (attr.underdouble) kinds.push("underdouble");
      else if (attr.underdotted) kinds.push("underdotted");
      else if (attr.underdashed) kinds.push("underdashed");
      else if (attr.underline) kinds.push("underline");
      if (attr.strikethrough) kinds.push("strikethrough");
      for (const kind of kinds) {
        ctx.strokeStyle = cssColor(kind === "strikethrough" ? fg : sp);
        for (const stroke of strokesFor(
          kind,
          x0,
          x1,
          y,
          ch,
          baseline,
          this.font.size,
          this.dpr,
        )) {
          this.paintStroke(ctx, stroke);
        }
      }
    }
  }
}
