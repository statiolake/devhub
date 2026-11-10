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
 *
 * Every grid (a window, a terminal pane, a float, a tmux popup) is an
 * opaque canvas (`alpha: false`): every cell's ground is painted, and
 * Chromium sets text with subpixel antialiasing — on macOS, CoreText's font
 * smoothing — only on an opaque canvas. On one with alpha the same text is
 * grayscale and lighter, the thin, hazy look of
 * `-webkit-font-smoothing: antialiased` beside the old terminal (xterm.js
 * draws its glyphs on their ground for the same reason). Only a float with
 * a `winblend` cell keeps alpha (`gridBlends`): its ground lets the grid
 * under it show.
 */

import type {
  GridBox,
  HlAttr,
  Margins,
  LinesMoved,
  NeovimUiState,
  RedrawChanges,
} from "./redraw";
import type { CellMetrics } from "./mouse";
import { pinnedRows, type BufposAnchor, type FloatRef } from "./riders";
import { strokesFor, type Stroke, type StrokeKind } from "./strokes";
import {
  boxArms,
  glyphKind,
  glyphShapes,
  placeIcon,
  type GlyphBox,
  type Shape,
} from "./glyphs";
import { familyOf, markPath, type KindFamily } from "./kinds";
import { placeDecor, wordsOf, type Decor } from "./decor";
import {
  floatClusters,
  cutClip,
  frameCuts,
  framePieces,
  type FloatCorners,
  type FramedMember,
  type FrameShape,
} from "./floats";
import {
  NO_THEME,
  fillChosen,
  floatScrollbars,
  boundariesOf,
  paneRect,
  rowBleed,
  isEndOfBuffer,
  sameTheme,
  windowGround,
  type PaintTheme,
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
  type FrameSide,
  type Side,
} from "./frame";

export interface FontSpec {
  readonly family: string;
  readonly size: number;
  /**
   * The row as a multiple of the font's line box (`terminal_line_height`),
   * worked out on device pixels as xterm.js does (`cellMetrics`).
   */
  readonly lineHeight: number;
  /**
   * Extra pixels between rows instead (Neovim's `linespace`), when the
   * person's config sets one; `lineHeight` is then not used.
   */
  readonly linespace?: number;
}

export interface Metrics extends CellMetrics {
  readonly baseline: number;
  /** The font's own advance; `width` is it on whole device pixels. */
  readonly advance: number;
  /** The font's ascent plus descent: the cell's height less the leading. */
  readonly textHeight: number;
  /** Where that text box starts in the cell (half the leading). */
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

/**
 * An icon's design box for `placeIcon`: Symbols Nerd Font Mono draws every
 * icon in its em square (advance 1 em, ascent 0.8 em, descent 0.2 em), so an
 * icon whose advance is the em is in it and gets that square; any other
 * font's icon gets its own ink.
 */
export function iconBox(
  m: Pick<
    TextMetrics,
    | "width"
    | "actualBoundingBoxLeft"
    | "actualBoundingBoxRight"
    | "actualBoundingBoxAscent"
    | "actualBoundingBoxDescent"
  >,
  size: number,
): GlyphBox {
  if (Math.abs(m.width - size) <= size * 0.02) {
    return { left: 0, right: size, ascent: size * 0.8, descent: size * 0.2 };
  }
  return {
    left: m.actualBoundingBoxLeft,
    right: m.actualBoundingBoxRight,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
  };
}

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

/**
 * Whether a grid needs a canvas with alpha: only while one of its cells is
 * in a highlight with `winblend` (its ground lets the grid under it show).
 * Every other grid — a window, a pane, a float, a tmux popup — is an opaque
 * leaf: each cell's ground is painted, so its text is set with subpixel
 * antialiasing (see the top). Rounded corners and a scrollbar's thumb are
 * CSS clips of the element, which need no alpha in the bitmap.
 */
export function gridBlends(
  grid: { readonly hls: ArrayLike<number> },
  hl: ReadonlyMap<number, HlAttr>,
): boolean {
  let last = -1;
  for (let i = 0; i < grid.hls.length; i += 1) {
    const id = grid.hls[i] ?? 0;
    if (id === last) continue;
    last = id;
    if ((hl.get(id)?.blend ?? 0) > 0) return true;
  }
  return false;
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

/**
 * The UI face's sizes, as CSS custom properties, from the grid's size `size`:
 * text at the grid's size (hovers, toasts, the tab strip, buttons), labels a
 * step under (badges, pills, keys, decorations' words, which `wordsFont`
 * paints at the same size), small capitals and key caps two under, and code
 * in the grid's face at the grid's size. One scale, so that no surface is
 * set a size of its own beside the grid.
 */
export function uiTypeScale(size: number): Record<string, string> {
  const px = (n: number) => `${String(Math.max(1, n))}px`;
  return {
    "--nvim-font-size": px(size),
    "--nvim-ui-size": px(size),
    "--nvim-label-size": px(size - 1),
    "--nvim-small-size": px(size - 2),
  };
}

export function fontOf(spec: FontSpec, attr?: HlAttr): string {
  return `${attr?.italic === true ? "italic " : ""}${attr?.bold === true ? "bold " : ""}${String(spec.size)}px ${ICON_FAMILY}, ${spec.family ? `${spec.family}, ${FALLBACK_FAMILY}` : FALLBACK_FAMILY}`;
}

/** `fontOf` without the icon font: what the cell is measured in. */
function textFontOf(spec: FontSpec): string {
  return `${String(spec.size)}px ${spec.family ? `${spec.family}, ${FALLBACK_FAMILY}` : FALLBACK_FAMILY}`;
}

/**
 * The cell, on whole device pixels, from the font's line box (`ascent` and
 * `descent`, as the canvas reports them) and `advance`. A cell that starts
 * between two device pixels is a cell whose text the compositor resamples,
 * which is blur on a Retina screen. `advance` is the font's own, which the
 * painter spreads to the cell's width with `letterSpacing`.
 *
 * The row is xterm.js' (`WebglRenderer`): the line box on whole device
 * pixels, times `lineHeight`, floored — Source Code Pro 12 at 1.1 and
 * `devicePixelRatio` 2 is 30 × 1.1 = 33 device pixels, 16.5 px. (Rounding the
 * extra to whole css pixels first, as a `linespace` of `round(12 × 0.1)` = 1
 * did, made the same row 32 — every line half a pixel closer than the
 * terminal it replaced.) The leading is shared above and below the line box,
 * its top rounded to a device pixel, so the text is centred in the row as
 * xterm.js centres it. xterm.js then draws on the `ideographic` baseline at
 * the box's bottom, which for Source Code Pro is 2 px under where the font
 * puts its own (`alphabetic`) baseline: that, not the leading, is why text
 * in the old terminal sat low, and here sits where the font says.
 *
 * A Neovim `linespace` is added to the line box instead, whole, in css
 * pixels, as Neovim's GUIs do.
 */
export function cellMetrics(
  spec: FontSpec,
  font: { ascent: number; descent: number; advance: number },
  dpr = 1,
): Metrics {
  const box = Math.ceil((font.ascent + font.descent) * dpr);
  const height =
    spec.linespace !== undefined
      ? box + Math.max(0, Math.round(spec.linespace * dpr))
      : Math.max(box, Math.floor(box * Math.max(1, spec.lineHeight)));
  const top = Math.round((height - box) / 2);
  return {
    width: Math.max(1, Math.round(font.advance * dpr)) / dpr,
    height: height / dpr,
    baseline: Math.round(top + font.ascent * dpr) / dpr,
    advance: font.advance,
    textHeight: font.ascent + font.descent,
    textTop: top / dpr,
  };
}

export function measureFont(spec: FontSpec, dpr = 1): Metrics {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) {
    return cellMetrics(
      spec,
      {
        ascent: spec.size * 0.8,
        descent: spec.size * 0.25,
        advance: spec.size * 0.6,
      },
      dpr,
    );
  }
  ctx.font = textFontOf(spec);
  const m = ctx.measureText("M");
  return cellMetrics(
    spec,
    {
      ascent: m.fontBoundingBoxAscent || spec.size * 0.8,
      descent: m.fontBoundingBoxDescent || spec.size * 0.25,
      advance: m.width,
    },
    dpr,
  );
}

interface GridCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** The border it was sized without (`cropOf`), and its bleed. */
  crop?: string;
  /** How far the canvas reaches past the grid's cells (`Bleed`). */
  bleed: Bleed;
  /** Made without an alpha channel: not blending (`gridBlends`). */
  readonly opaque: boolean;
}

const NO_CROP = { top: 0, right: 0, bottom: 0, left: 0 } as const;

/** How far past an editor's grid 1 its ground reaches (`setReach`), in CSS pixels. */
export interface Reach {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const NO_REACH: Reach = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * How far a grid's canvas reaches past its cells on each side, in CSS
 * pixels: the half cell of a boundary beside it (or the editor's reach),
 * where each of its rows goes on in the ground of its cell on that edge —
 * a current line, a diff line, a status line, a sidebar's own ground run
 * right up to the hairline. Above its first row and below its last (grid
 * 1's only), the row's grounds go on up or down.
 */
export interface Bleed {
  readonly l: number;
  readonly r: number;
  readonly t: number;
  readonly b: number;
}

const NO_BLEED: Bleed = { l: 0, r: 0, t: 0, b: 0 };

/** A selection's or search match's corners (`chrome.ts`). */

/**
 * How long lines a `dd`, `p` or `o` moved take to slide into place
 * (`slideLines`): short enough to be over before the next key is read
 * (typing at 120 wpm is ~100 ms a key), long enough to say where they came
 * from. The person's pick of three mocks (round 6: 0, 60, 100 ms).
 */
const SLIDE_MS = 60;

/**
 * A floating surface's token (`tokens.css`, "Floating surfaces";
 * docs/neovim-editor.md) as a number: a float's corner. Read once from the
 * page's stylesheet; the fallback is the token's own, for a page without
 * it (a test).
 */
function floatToken(name: string, fallback: number): number {
  const root =
    typeof document === "undefined" ? undefined : document.documentElement;
  const value = root
    ? Number.parseFloat(getComputedStyle(root).getPropertyValue(name))
    : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
}

/**
 * What a float wears, from the theme's groups (the person's pick,
 * 「接地」): its ground and ink (`NormalFloat`), its 1px line
 * (`FloatBorder`'s ink) and a title's band (`StatusLine`'s ground). A
 * `FloatBorder` that is only the float's own ink or ground (linked to
 * `NormalFloat`, as a config does so a `'solid'` border draws nothing)
 * names no line: then the ground 18 % of the way to the ink, as a theme's
 * `FloatBorder` sits. Without `StatusLine`, the band is half way between
 * the editor's ground and the float's, where a theme puts it.
 */
export interface FloatLook {
  readonly ground: number;
  readonly ink: number;
  readonly line: number;
  readonly band: number;
}

export function floatLook(
  theme: PaintTheme,
  defaults: { readonly foreground: number; readonly background: number },
): FloatLook {
  const s = theme.surface;
  const ground = s?.bg ?? defaults.background;
  const ink = s?.fg ?? defaults.foreground;
  const named = s?.border;
  const line =
    named !== undefined && named !== ink && named !== ground
      ? named
      : mixColors(ground, ink, 18);
  const band =
    s?.status ?? mixColors(s?.ground ?? defaults.background, ground, 50);
  return { ground, ink, line, band };
}

/**
 * What of a grid its canvas shows: a framed float's text area, without its
 * border (DevHub draws the frame).
 */
function cropOf(box: GridBox) {
  return box.frame?.margins ?? NO_CROP;
}

/** Rounded corners as CSS: the float's radius token where `corners` say. */
function radii(corners: FloatCorners): string {
  const r = (on: boolean) => (on ? "var(--float-radius)" : "0");
  return `${r(corners.tl)} ${r(corners.tr)} ${r(corners.br)} ${r(corners.bl)}`;
}

/**
 * Where each part of a level stacks inside it: declared, so that nothing
 * depends on which element happened to be appended last. A level is one
 * element per `GridBox.z` (`GridPainter.level`): the windows' at 1, each
 * float zindex's at 100 + zindex, a tmux popup's at its own. Inside it a
 * window's pane (its ground out to the boundaries beside it), the
 * shadow under a panel of floats, then a float's frame (its padding's
 * ground and its line), then
 * the grids (a canvas, or a window's scroll port), then what rides a grid's
 * text (inline images, cards, line decorations), then what lies over a grid
 * (a winbar held while the text scrolls, lines sliding into place), then the
 * cursor, then what covers a grid's cells whole (a GUI window, a view),
 * then a frame's title and footer cells, then the boundaries between the
 * windows' panes (`placePanes`). Riders, the cursor and covers are the
 * page's, each in its grid's own clipping element (`GridPainter.over`).
 */
export const PART_Z = {
  pane: 0,
  shadow: 1,
  frames: 2,
  grid: 3,
  riders: 4,
  over: 5,
  cursor: 6,
  covers: 7,
  labels: 8,
  boundary: 9,
} as const;

/**
 * A moving pane's elements (`GridPainter.motionGroup`): `outer` in the
 * level, `clipA` cutting left and top, `clipB` right and bottom, `content`
 * holding the grid's parts; `edges` beside the clips, for the lines the
 * pane draws on its own edges while it moves.
 */
export interface MotionGroup {
  readonly outer: HTMLDivElement;
  readonly clipA: HTMLDivElement;
  readonly clipB: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly edges: HTMLDivElement;
}

/** A motion group's elements, empty (`GridPainter.motionGroup`). */
function makeMotionGroup(): MotionGroup {
  const make = (className: string) => {
    const el = document.createElement("div");
    el.className = className;
    return el;
  };
  const group = {
    outer: make("nvim-motion"),
    clipA: make("nvim-motion-clip"),
    clipB: make("nvim-motion-clip"),
    content: make("nvim-motion-content"),
    edges: make("nvim-motion-edges"),
  };
  group.clipB.append(group.content);
  group.clipA.append(group.clipB);
  group.outer.append(group.clipA, group.edges);
  return group;
}

/** What the page lays over a grid, in that grid's clip (`GridPainter.over`). */
/**
 * `shadow` is under the grid and not cut by it: what a page draws round a
 * bare float it frames itself (a framed view's shadow).
 */
export type OverPart = "shadow" | "riders" | "cursor" | "covers";

/** A grid's clip for one `OverPart`, and the element its content goes in. */
interface OverClip {
  readonly clip: HTMLDivElement;
  readonly inner: HTMLDivElement;
  readonly grid: number;
  readonly part: OverPart;
}

/** One ground under a panel of floats (`placeClusters`). */
interface Piece {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly radius: string;
  readonly background: string;
  /** A framed member's line: top, right, bottom, left, as CSS borders. */
  readonly borders?: readonly string[];
  /** A blended framed member's text area, left out. */
  readonly hole?: string;
  /** A member under framed floats: their cut (`cutClip`). */
  readonly clip?: string;
  /** A framed member's zindex: its lines are drawn at it. */
  readonly z?: number;
}

/** A title or footer on a frame's line: its cells, as Neovim sent them. */
interface Label {
  readonly x: number;
  readonly w: number;
  readonly cy: number;
  readonly runs: readonly {
    text: string;
    cells: number;
    color: string;
    background: string;
    font: string;
  }[];
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
  /** One stacking element per `GridBox.z`, by z (`PART_Z`). */
  private readonly levels = new Map<number, HTMLDivElement>();
  /** Each grid's pane while it moves (`motionGroup`), by grid. */
  private readonly motion = new Map<number, MotionGroup>();
  /**
   * Floats carried by their anchor window's motion (`carryFloats`): each
   * carrier's group and level, by its key, and each float's carrier.
   */
  private readonly carriers = new Map<
    string,
    { readonly group: MotionGroup; readonly z: number }
  >();
  private readonly carried = new Map<number, string>();
  /** Where each part of a grid's was put, to move it into its group and back. */
  private readonly parts = new Map<
    HTMLElement,
    { z: number; part: keyof typeof PART_Z; grid: number }
  >();
  /** Each grid's clips for what the page lays over it, by grid and part. */
  private readonly overs = new Map<string, OverClip>();
  private lastBoxes: readonly GridBox[] = [];
  private lastMargins: NeovimUiState["margins"] = new Map();
  /** Each window grid's pixel scrolling, by grid. */
  private readonly scrolls = new Map<number, ScrollSlot>();
  /**
   * Grids that are not Neovim's windows but scroll the same way when their
   * owner says by how many rows (`RedrawChanges.scrolled`): tmux's panes in
   * copy mode, with the glide each one's shift takes.
   */
  private readonly shiftedGrids = new Map<number, number>();
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
  /** The floats' corner (`floatToken`). */
  private radius: number | undefined;
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
  /**
   * Grid 1's cells the boundaries between windows run through
   * (`boundariesOf`), by index: not drawn as cells; `vgaps`, those a line
   * runs down, are grounded half and half by the cells beside them.
   */
  private gaps: ReadonlySet<number> = new Set();
  private vgaps: ReadonlySet<number> = new Set();
  private gapsKey = "";
  /**
   * How far past grid 1 the editor's ground reaches on each side, in CSS
   * pixels: the half cells of a tmux pane's border its Neovim takes
   * (`setReach`). Grid 1 and the windows on that side continue their rows
   * into it.
   */
  private reach: Reach = NO_REACH;
  /**
   * How far each window's canvas reaches past its cells (`placePanes`), and
   * each grid laid out by someone else (`setGridReach`): into the half cell
   * of the boundary beside it, where its rows go on in their own grounds.
   */
  private readonly bleeds = new Map<number, Bleed>();
  private gridReach: ReadonlyMap<number, Bleed> = new Map();
  /** Each window's pane, by grid; the boundaries' hairlines and stubs. */
  private readonly panes = new Map<number, HTMLDivElement>();
  private chrome: HTMLDivElement[] = [];
  private boundariesHidden = false;
  /** Grounds of panes laid out by someone else (`placeGrounds`), by key. */
  private readonly grounds = new Map<number, HTMLDivElement>();
  private chromeKey = "";
  /** The window the cursor was last in, for `NormalNC`. */
  private currentWin: number | undefined;
  /** The row's cells whose glyph is not drawn (`~`, a boundary's column, a decoration's words). */
  private readonly skip = new Set<number>();
  private dpr: number;
  /** The editor face's cap height: a kind mark's size. */
  private capHeight = 0;
  /** The row's icons, drawn after its backgrounds (`paintRow`). */
  private readonly icons: {
    c: string;
    x: number;
    cells: number;
    attr: HlAttr | undefined;
    fg: number;
    /** Centred across its cells (a sign), not on the first. */
    centre: boolean;
  }[] = [];
  /** Icons' design boxes, by font and character (`iconBox`). */
  private readonly inks = new Map<string, GlyphBox>();

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
      font.lineHeight === this.font.lineHeight &&
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

  /**
   * The element everything at stacking order `z` is drawn in: its own
   * stacking context, so its parts stack by `PART_Z` and every level stacks
   * by its z, whatever their order in the page.
   */
  private level(z: number): HTMLDivElement {
    let el = this.levels.get(z);
    if (!el) {
      el = document.createElement("div");
      el.className = "nvim-level";
      el.style.zIndex = String(z);
      el.dataset.z = String(z);
      this.levels.set(z, el);
      this.root.append(el);
    }
    return el;
  }

  /**
   * The element of stacking order `z`, for what its owner places in it and
   * moves by transforms of its own — a Neovim drawn in a tmux pane, which
   * is never moved from one parent to another (an iframe in it would load
   * again) and stacks among the panes' motion groups by the same z.
   */
  levelElement(z: number): HTMLElement {
    return this.level(z);
  }

  /**
   * `el` as part `part` of level `z`, moved there if it was elsewhere; a
   * part of `grid`'s while that grid's pane moves, in its motion group
   * (`motionGroup`) instead, in the same order.
   */
  private put(
    el: HTMLElement,
    z: number,
    part: keyof typeof PART_Z,
    grid?: number,
  ): void {
    const group =
      grid === undefined
        ? undefined
        : (this.motion.get(grid) ?? this.carrierOf(grid, z));
    const parent = group?.content ?? this.level(z);
    if (group !== undefined && group.outer.parentElement !== this.level(z))
      this.level(z).append(group.outer);
    if (el.parentElement !== parent) parent.append(el);
    el.style.zIndex = String(PART_Z[part]);
    if (grid !== undefined) this.parts.set(el, { z, part, grid });
  }

  /**
   * A grid's pane while it moves (`docs/pane-motion.md`): its parts — its
   * ground, its canvas or scroll port, what the page lays over it — in one
   * element that the surface moves by transforms only. Two nested clips the
   * surface's size cut its left and top, then its right and bottom; the
   * content inside carries the parts, still placed in the surface's pixels.
   * Made at a transition's start, let go at its end (`endMotion`): at rest
   * the parts are in their level as ever.
   */
  motionGroup(grid: number, z: number): MotionGroup {
    let group = this.motion.get(grid);
    if (group === undefined) {
      group = makeMotionGroup();
      this.motion.set(grid, group);
      this.level(z).append(group.outer);
      for (const [el, at] of this.parts) {
        if (!el.isConnected) this.parts.delete(el);
        else if (at.grid === grid && el.parentElement === this.levels.get(at.z))
          this.put(el, at.z, at.part, grid);
      }
    }
    return group;
  }

  /**
   * Floats anchored to a moving window (`relative='win'`, at a position
   * in it or at its text) carried by that window's motion
   * (`WindowMotion`): their parts — canvas, panel, frame, labels, what the
   * page lays over them — in one group of their own in their level `z`,
   * moved by the same transforms on the same clock as their window's
   * content. It cuts nothing but the surface: the window's clip does not
   * cut them, and they stack in their level as at rest. `key` names the
   * carrier (a window and a level); let go at the transition's end
   * (`endMotion`).
   */
  carryFloats(key: string, z: number, floats: readonly number[]): MotionGroup {
    let carrier = this.carriers.get(key);
    if (carrier === undefined) {
      carrier = { group: makeMotionGroup(), z };
      carrier.group.outer.classList.add("nvim-motion-floats");
      this.carriers.set(key, carrier);
      this.level(z).append(carrier.group.outer);
    }
    const mine = new Set(floats);
    for (const grid of floats) this.carried.set(grid, key);
    for (const [el, at] of this.parts) {
      if (!el.isConnected) this.parts.delete(el);
      else if (mine.has(at.grid) && el.parentElement === this.levels.get(at.z))
        this.put(el, at.z, at.part, at.grid);
    }
    return carrier.group;
  }

  /** The group a float's part at level `z` is carried in, if it is. */
  private carrierOf(grid: number, z: number): MotionGroup | undefined {
    const key = this.carried.get(grid);
    const carrier = key === undefined ? undefined : this.carriers.get(key);
    return carrier?.z === z ? carrier.group : undefined;
  }

  /** Every pane at rest: the parts back in their levels, the groups gone. */
  endMotion(): void {
    if (this.motion.size === 0 && this.carriers.size === 0) return;
    const groups = [
      ...this.motion.values(),
      ...[...this.carriers.values()].map((c) => c.group),
    ];
    this.motion.clear();
    this.carriers.clear();
    this.carried.clear();
    for (const [el, at] of this.parts) {
      if (!el.isConnected) this.parts.delete(el);
      else if (groups.some((g) => el.parentElement === g.content))
        this.put(el, at.z, at.part, at.grid);
    }
    for (const g of groups) g.outer.remove();
    this.dropEmptyLevels();
  }

  /**
   * A copy of a grid's picture as it is drawn now, at its CSS size: what a
   * pane showed before its grid was resized, for the rows that leave it
   * as it moves (`docs/pane-motion.md`).
   */
  picture(
    grid: number,
    region?: { x: number; y: number; w: number; h: number },
  ): HTMLCanvasElement | undefined {
    const entry = this.canvases.get(grid);
    if (entry === undefined || entry.width < 0) return undefined;
    const source = entry.canvas;
    const { bleed } = entry;
    // In the grid's own pixels: its bleed left out.
    const given = region ?? {
      x: 0,
      y: 0,
      w: parseFloat(source.style.width) - bleed.l - bleed.r,
      h: parseFloat(source.style.height) - bleed.t - bleed.b,
    };
    const r = { ...given, x: given.x + bleed.l, y: given.y + bleed.t };
    const d = this.dpr;
    const copy = document.createElement("canvas");
    copy.width = Math.max(1, Math.round(r.w * d));
    copy.height = Math.max(1, Math.round(r.h * d));
    copy.style.width = `${String(r.w)}px`;
    copy.style.height = `${String(r.h)}px`;
    copy
      .getContext("2d")
      ?.drawImage(
        source,
        Math.round(r.x * d),
        Math.round(r.y * d),
        copy.width,
        copy.height,
        0,
        0,
        copy.width,
        copy.height,
      );
    return copy;
  }

  /** How wide a boundary between windows is drawn (`placePanes`). */
  hairline(): number {
    const { width: cw, height: ch } = this.metrics;
    const shape = glyphShapes(
      "│",
      { x: 0, y: 0, w: cw, h: ch },
      this.dpr,
      this.font.size,
    )?.find((p) => p.kind === "rect");
    return shape?.kind === "rect" ? shape.w : 1 / this.dpr;
  }

  /** A window's pane's ground as drawn (`placePanes`), as CSS. */
  groundOf(grid: number): string | undefined {
    return this.panes.get(grid)?.style.background;
  }

  /**
   * The boundaries between windows' panes hidden while the panes move:
   * each moving pane draws the lines on its own edges; they are placed
   * again at rest.
   */
  hideBoundaries(hidden: boolean): void {
    this.boundariesHidden = hidden;
    for (const el of this.chrome) el.style.display = hidden ? "none" : "";
  }

  /** The grids whose panes are moving now. */
  moving(): ReadonlySet<number> {
    return new Set(this.motion.keys());
  }

  /**
   * The element what the page lays over `grid` as `part` goes in: inside a
   * clip of the grid's own (its text area; a cover, the whole grid), in the
   * grid's level at `PART_Z[part]`, so it stacks with the grid by
   * declaration and is cut by the grid's edges as its text is. Its content
   * is placed in the editor's pixels, as the grids are.
   */
  over(grid: number, part: OverPart): HTMLElement {
    const key = `${String(grid)}:${part}`;
    let entry = this.overs.get(key);
    if (!entry) {
      const clip = document.createElement("div");
      clip.className = `nvim-clip nvim-clip-${part}`;
      clip.style.display = "none";
      const inner = document.createElement("div");
      inner.className = "nvim-clip-inner";
      clip.append(inner);
      entry = { clip, inner, grid, part };
      this.overs.set(key, entry);
      const box = this.lastBoxes.find((b) => b.grid === grid);
      if (box) this.placeOver(entry, box);
      else this.root.append(clip);
    }
    return entry.inner;
  }

  /** The clips of what lies over the grids, where the grids are now. */
  private placeOvers(state: NeovimUiState, boxes: readonly GridBox[]): void {
    this.lastBoxes = boxes;
    this.lastMargins = state.margins;
    for (const [key, entry] of this.overs) {
      const box = boxes.find((b) => b.grid === entry.grid);
      if (box) {
        this.placeOver(entry, box);
      } else if (!state.grids.has(entry.grid)) {
        // Gone: what the page still has in it goes with it.
        entry.clip.remove();
        this.overs.delete(key);
      } else {
        entry.clip.style.display = "none";
      }
    }
  }

  private placeOver(entry: OverClip, box: GridBox): void {
    const { width: cw, height: ch } = this.metrics;
    let top = 0;
    let bottom = box.height;
    let left = 0;
    let right = box.width;
    if (entry.part !== "covers" && entry.part !== "shadow") {
      // The text area: a window's without its winbar, a float's without
      // its border (Neovim's margins count it) or blank border.
      const crop = cropOf(box);
      const m = this.lastMargins.get(box.grid);
      top = Math.min(box.height, Math.max(crop.top, m?.top ?? 0));
      bottom = Math.max(
        top,
        box.height - Math.max(crop.bottom, m?.bottom ?? 0),
      );
      left = Math.min(box.width, Math.max(crop.left, m?.left ?? 0));
      right = Math.max(left, box.width - Math.max(crop.right, m?.right ?? 0));
    }
    const x = (box.col + left) * cw;
    const y = (box.row + top) * ch;
    const { clip, inner } = entry;
    this.put(clip, box.z, entry.part, box.grid);
    clip.style.display = "";
    clip.style.left = `${String(x)}px`;
    clip.style.top = `${String(y)}px`;
    clip.style.width = `${String((right - left) * cw)}px`;
    clip.style.height = `${String((bottom - top) * ch)}px`;
    inner.style.left = `${String(-x)}px`;
    inner.style.top = `${String(-y)}px`;
  }

  /** Levels nothing is drawn in any more. */
  private dropEmptyLevels(): void {
    for (const [z, el] of this.levels) {
      if (el.childElementCount === 0) {
        el.remove();
        this.levels.delete(z);
      }
    }
  }

  /** A float's corner (`--float-radius`), read once the page is styled. */
  private floatRadius(): number {
    this.radius ??= floatToken("--float-radius", 4);
    return this.radius;
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
    // A borderless float under framed ones is drawn, clipped by their cut
    // (`frameCuts`): never in the half cell outside a frame's line.
    const shown = boxes;
    const cuts = frameCuts(boxes);
    const shapes = new Map<number, FrameShape>();
    const scrollbars = floatScrollbars(state, shown);
    this.placeClusters(state, shown, cuts, shapes, scrollbars);
    this.placePanes(state, shown);
    for (const box of shown) {
      const grid = state.grids.get(box.grid);
      if (!grid) continue;
      let entry = this.canvases.get(box.grid);
      let fresh = false;
      // A canvas's alpha is fixed when it is made: a float that starts or
      // stops blending gets a new one.
      const opaque = !box.float || !gridBlends(grid, state.hl);
      if (entry && entry.opaque !== opaque) {
        this.dropScroll(box.grid);
        entry.canvas.remove();
        this.canvases.delete(box.grid);
        entry = undefined;
      }
      if (!entry) {
        const canvas = document.createElement("canvas");
        canvas.className = "nvim-grid";
        const ctx = canvas.getContext("2d", { alpha: !opaque });
        if (!ctx) continue;
        entry = { canvas, ctx, width: -1, height: -1, opaque, bleed: NO_BLEED };
        this.canvases.set(box.grid, entry);
        fresh = true;
      }
      const { canvas } = entry;
      // In its level (a float whose zindex changed moves); a window
      // scrolling in pixels is in its port, which is.
      const port = this.scrolls.get(box.grid)?.port;
      if (port?.isConnected === true && canvas.parentElement === port)
        this.put(port, box.z, "grid", box.grid);
      else this.put(canvas, box.z, "grid", box.grid);
      // A float's blank border is left out: the canvas is its text area,
      // where Neovim put it (`paintRow` draws the grid shifted by it).
      const crop = cropOf(box);
      const bleed = this.bleedOf(box);
      const cropKey = `${String(crop.top)},${String(crop.right)},${String(crop.bottom)},${String(crop.left)}:${String(bleed.l)},${String(bleed.r)},${String(bleed.t)},${String(bleed.b)}`;
      canvas.style.display = "";
      canvas.style.left = `${String((box.col + crop.left) * this.metrics.width - bleed.l)}px`;
      canvas.style.top = `${String((box.row + crop.top) * this.metrics.height - bleed.t)}px`;
      canvas.classList.toggle("nvim-float", box.float);
      canvas.classList.toggle("nvim-framed", box.frame !== undefined);
      // A menu's scrollbar drawn as floats: the thumb a thin rounded bar
      // in the middle of its cell, the gutter left to the menu's ground,
      // as an overlay scrollbar.
      const part = scrollbars.get(box.grid);
      const cut = cuts.get(box.grid);
      canvas.style.clipPath =
        part === "thumb"
          ? this.thumbClip()
          : part === "gutter"
            ? "inset(50%)"
            : cut !== undefined
              ? cutClip(box, cut, shapes, this.metrics, {
                  x: (box.col + crop.left) * this.metrics.width,
                  y: (box.row + crop.top) * this.metrics.height,
                })
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
        const w =
          (grid.width - crop.left - crop.right) * this.metrics.width +
          bleed.l +
          bleed.r;
        const h =
          (grid.height - crop.top - crop.bottom) * this.metrics.height +
          bleed.t +
          bleed.b;
        canvas.width = Math.max(1, Math.ceil(w * this.dpr));
        canvas.height = Math.max(1, Math.ceil(h * this.dpr));
        canvas.style.width = `${String(w)}px`;
        canvas.style.height = `${String(h)}px`;
        entry.width = grid.width;
        entry.height = grid.height;
        entry.crop = cropKey;
        entry.bleed = bleed;
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
    this.placeOvers(state, boxes);
    this.dropEmptyLevels();
  }

  /**
   * A float that is a backdrop — no border, every cell blank, all in one
   * ground with `winblend` (its `Normal` and its `EndOfBuffer` rows are
   * two highlights of one colour) — as the CSS colour it tints with: its
   * ground at `100 - blend` percent, which is what Neovim's compositor
   * mixes.
   */
  private backdropOf(state: NeovimUiState, box: GridBox): string | undefined {
    if (box.frame) return undefined;
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
    if (this.shiftedGrids.has(box.grid)) return true;
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
    const glide = this.shiftedGrids.get(box.grid);
    if (glide !== undefined && slot.view.ease) {
      // Seen from the frame it lands in: the whole glide is drawn.
      slot.view.ease = { from: slot.view.off, start: now };
      slot.view.easeMs = glide;
    }
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
      canvas.style.zIndex = String(PART_Z.grid);
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
    const left = `${String(box.col * cw - entry.bleed.l)}px`;
    const top = `${String(box.row * ch)}px`;
    port.dataset.left = left;
    port.dataset.top = top;
    port.style.left = left;
    port.style.top = `${String(box.row * ch + t)}px`;
    port.style.width = canvas.style.width;
    port.style.height = `${String(b - t)}px`;
    port.style.zIndex = String(PART_Z.grid);
    port.style.display = canvas.style.display;
    // In the port: the canvas over the ghost, where they meet.
    canvas.style.zIndex = "1";
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
      ghost.style.zIndex = "0";
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
    pin.style.left = `${String(box.col * this.metrics.width - entry.bleed.l)}px`;
    pin.style.top = `${String(box.row * this.metrics.height)}px`;
    pin.style.width = canvas.style.width;
    pin.style.height = canvas.style.height;
    pin.style.zIndex = String(PART_Z.over);
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
    wheeled(
      slot.view,
      dy,
      performance.now(),
      this.metrics.height,
      !matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    return true;
  }

  /**
   * Grids (not Neovim's windows) whose scrolls the owner says, and how long
   * each one's shift glides (`shiftedGrids`).
   */
  setShiftedGrids(grids: ReadonlyMap<number, number>): void {
    for (const grid of this.shiftedGrids.keys())
      if (!grids.has(grid)) this.dropScroll(grid);
    this.shiftedGrids.clear();
    for (const [grid, ms] of grids) this.shiftedGrids.set(grid, ms);
  }

  /** Whether any grid's display is away from its grid (moving, or held). */
  get scrolling(): boolean {
    return this.scrolls.size > 0;
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

  /** Whether window `win` is a float at a buffer position (`bufpos`). */
  atBufpos(win: number): boolean {
    return this.bufposFloats.has(win);
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
   * How far past grid 1 the editor's ground reaches (a tmux pane's half
   * border cells, `placeNeovims`); answers whether it changed.
   */
  setReach(reach: Reach): boolean {
    const r = this.reach;
    if (
      r.left === reach.left &&
      r.right === reach.right &&
      r.top === reach.top &&
      r.bottom === reach.bottom
    )
      return false;
    this.reach = reach;
    return true;
  }

  /**
   * How far each grid laid out by someone else (tmux's panes) reaches past
   * its cells: to the hairline on each side (`Bleed`, sideways only).
   */
  setGridReach(reach: ReadonlyMap<number, Bleed>): void {
    this.gridReach = reach;
  }

  /** How far `box`'s canvas reaches past its cells (`Bleed`). */
  private bleedOf(box: GridBox): Bleed {
    if (box.float) return NO_BLEED;
    if (box.grid === 1) {
      const r = this.reach;
      return { l: r.left, r: r.right, t: r.top, b: r.bottom };
    }
    return (
      this.bleeds.get(box.grid) ?? this.gridReach.get(box.grid) ?? NO_BLEED
    );
  }

  /** A row's grounds continued into its canvas's bleed (`rowBleed`). */
  private paintBleed(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    grid: {
      readonly width: number;
      readonly height: number;
      readonly hls: ArrayLike<number>;
    },
    row: number,
    bleed: Bleed,
  ): void {
    if (bleed.l <= 0 && bleed.r <= 0 && bleed.t <= 0 && bleed.b <= 0) return;
    const base = row * grid.width;
    for (const r of rowBleed(
      grid.width,
      grid.height,
      row,
      this.metrics,
      bleed,
    )) {
      const attr = state.hl.get(grid.hls[base + r.col] ?? 0);
      ctx.fillStyle = cssColor(resolveColors(attr, state.defaults).bg);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }

  /**
   * The windows as panes with a boundary between them, as a GUI shows them
   * (VS Code, Zed), not a TUI's separator cells: each region (a window and
   * its status line, `boundariesOf`) meets its neighbour at one hairline,
   * in `WinSeparator`'s colour, on the middle of the gap cells Neovim keeps
   * between them, over the windows' level. Each window's pane is an
   * element under its grid in its own ground (its `Normal`, or `NormalNC`
   * when not current, as its highlights state them) reaching exactly half
   * into each gap beside it — and out to the editor's reach on its edges
   * (`setReach`) — and its canvas reaches as far sideways (`Bleed`), each
   * row going on in its own edge cell's ground, so nothing but the
   * hairline divides two regions. All from the windows' places, sizes and
   * highlights: grid 1's cells in the gaps are not drawn as cells
   * (`paintRow`), and nothing a window scrolls or redraws touches them. A
   * status line drawn as a line (`─`, a person's `stl:`) beside a boundary
   * meets it (a stub to the hairline), and a boundary ending on its
   * junction (`┴`) ends on that line.
   */
  private placePanes(state: NeovimUiState, boxes: readonly GridBox[]): void {
    const base = state.grids.get(1);
    const W = base?.width ?? 0;
    const H = base?.height ?? 0;
    const { lines, panes, gaps, vgaps } = boundariesOf(
      boxes,
      W,
      H,
      this.theme.laststatus ?? 2,
    );
    // Grid 1's rows a boundary leaves or reaches are painted again (their
    // cells in it are not drawn).
    const key = [...gaps].join(",");
    if (key !== this.gapsKey) {
      const dirty = base?.dirty;
      if (W > 0)
        for (const i of [...this.gaps, ...gaps]) dirty?.add(Math.floor(i / W));
      this.gaps = gaps;
      this.vgaps = vgaps;
      this.gapsKey = key;
    }
    const cursorWin = state.gridWins.get(state.cursor.grid);
    if (cursorWin !== undefined) this.currentWin = cursorWin;
    const { width: cw, height: ch } = this.metrics;
    const dpr = this.dpr;
    const reach = this.reach;
    // The hairline down a column, across a row: where grid 1 draws a `│`
    // or a `─` there (the shapes of its `┴` and its status lines'), so
    // they meet.
    const vertical = (col: number) => {
      const shape = glyphShapes(
        "│",
        { x: col * cw, y: 0, w: cw, h: ch },
        dpr,
        this.font.size,
      )?.find((p) => p.kind === "rect");
      return shape?.kind === "rect"
        ? { x: shape.x, w: shape.w }
        : { x: Math.round((col + 0.5) * cw * dpr) / dpr, w: 1 / dpr };
    };
    const horizontal = (row: number) => {
      const shape = glyphShapes(
        "─",
        { x: 0, y: row * ch, w: cw, h: ch },
        dpr,
        this.font.size,
      )?.find((p) => p.kind === "rect");
      return shape?.kind === "rect"
        ? { y: shape.y, h: shape.h }
        : { y: Math.round((row + 0.5) * ch * dpr) / dpr, h: 1 / dpr };
    };
    const onScreen = new Set<number>();
    this.bleeds.clear();
    for (const pane of panes) {
      const box = boxes.find((b) => b.grid === pane.grid);
      if (!box) continue;
      onScreen.add(pane.grid);
      let el = this.panes.get(pane.grid);
      if (!el) {
        el = document.createElement("div");
        el.className = "nvim-pane";
        this.panes.set(pane.grid, el);
      }
      this.put(el, box.z, "pane", pane.grid);
      const { left, right, top, bottom } = paneRect(
        pane,
        box,
        { width: W, height: H },
        this.metrics,
        dpr,
        reach,
      );
      const end = box.col + box.width;
      el.style.left = `${String(left)}px`;
      el.style.top = `${String(top)}px`;
      el.style.width = `${String(right - left)}px`;
      el.style.height = `${String(bottom - top)}px`;
      const ground =
        windowGround(this.theme, pane.win, pane.win === this.currentWin) ??
        state.defaults.background;
      el.style.background = cssColor(ground);
      const bleed = { l: box.col * cw - left, r: right - end * cw, t: 0, b: 0 };
      if (bleed.l > 0 || bleed.r > 0) this.bleeds.set(pane.grid, bleed);
    }
    for (const [grid, el] of this.panes) {
      if (onScreen.has(grid)) continue;
      el.remove();
      this.panes.delete(grid);
    }
    // The hairlines, and the stubs where a status line drawn as a line
    // (grid 1's own row, not a window's) runs into one from the side.
    const colour = this.theme.separator ?? state.defaults.foreground;
    const pieces: { x: number; y: number; w: number; h: number; c: number }[] =
      [];
    const inWindow = (row: number, col: number) =>
      boxes.some(
        (b) =>
          !b.float &&
          b.win !== undefined &&
          b.row <= row &&
          row < b.row + b.height &&
          b.col <= col &&
          col < b.col + b.width,
      );
    const armsAt = (row: number, col: number) =>
      base && row >= 0 && row < H && col >= 0 && col < W && !inWindow(row, col)
        ? boxArms(base.chars[row * W + col] ?? "")
        : undefined;
    for (const line of lines) {
      let from = line.vertical ? line.y : line.x;
      let to = from + line.length;
      if (line.vertical) {
        // Ending on a junction a status line draws (`┴`, `┬`): on its line.
        const last = armsAt(Math.ceil(to) - 1, line.x);
        if (Number.isInteger(to) && last && last.s === 0 && last.n !== 0)
          to -= 0.5;
        const first = armsAt(Math.floor(from), line.x);
        if (Number.isInteger(from) && first && first.n === 0 && first.s !== 0)
          from += 0.5;
        const { x, w } = vertical(line.x);
        const y0 = Number.isInteger(from)
          ? from === 0
            ? -reach.top
            : from * ch
          : horizontal(Math.floor(from)).y;
        const y1 = Number.isInteger(to)
          ? to >= H
            ? H * ch + reach.bottom
            : to * ch
          : (() => {
              const h = horizontal(Math.floor(to));
              return h.y + h.h;
            })();
        pieces.push({ x, y: y0, w, h: y1 - y0, c: colour });
      } else {
        const { y, h } = horizontal(line.y);
        const x0 = Number.isInteger(from)
          ? from === 0
            ? -reach.left
            : from * cw
          : vertical(Math.floor(from)).x;
        const x1 = Number.isInteger(to)
          ? to >= W
            ? W * cw + reach.right
            : to * cw
          : (() => {
              const v = vertical(Math.floor(to));
              return v.x + v.w;
            })();
        pieces.push({ x: x0, y, w: x1 - x0, h, c: colour });
      }
      if (!base || !line.vertical) continue;
      const { x, w } = vertical(line.x);
      for (let row = Math.floor(from); row < Math.ceil(to); row += 1) {
        for (const dc of [-1, 1]) {
          const col = line.x + dc;
          const arms = armsAt(row, col);
          if (!arms || arms.e === 0 || arms.w === 0 || arms.n !== 0) continue;
          const shape = glyphShapes(
            "─",
            { x: col * cw, y: row * ch, w: cw, h: ch },
            dpr,
            this.font.size,
          )?.find((p) => p.kind === "rect");
          if (shape?.kind !== "rect") continue;
          const i = row * W + col;
          const start = dc < 0 ? col * cw + cw : x + w;
          const stop = dc < 0 ? x : col * cw;
          pieces.push({
            x: Math.min(start, stop),
            y: shape.y,
            w: Math.abs(stop - start),
            h: shape.h,
            c: resolveColors(state.hl.get(base.hls[i] ?? 0), state.defaults).fg,
          });
        }
      }
    }
    const chromeKey = JSON.stringify(pieces);
    if (chromeKey === this.chromeKey) return;
    this.chromeKey = chromeKey;
    for (const el of this.chrome) el.remove();
    this.chrome = pieces.map((p) => {
      const el = document.createElement("div");
      el.className = "nvim-boundary";
      el.style.left = `${String(p.x)}px`;
      el.style.top = `${String(p.y)}px`;
      el.style.width = `${String(p.w)}px`;
      el.style.height = `${String(p.h)}px`;
      el.style.background = cssColor(p.c);
      if (this.boundariesHidden) el.style.display = "none";
      this.put(el, 1, "boundary");
      return el;
    });
  }

  /**
   * Panes laid out by someone else (tmux's, in a control-mode terminal):
   * each one's ground, in CSS pixels, under its grid in level `z`, reaching
   * into the border beside it as `placePanes` does for Neovim's windows.
   */
  placeGrounds(
    grounds: readonly {
      readonly key: number;
      readonly z: number;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly colour: number;
      /** The grid whose pane it is: in its motion group while it moves. */
      readonly grid?: number;
    }[],
  ): void {
    const keep = new Set<number>();
    for (const g of grounds) {
      keep.add(g.key);
      let el = this.grounds.get(g.key);
      if (!el) {
        el = document.createElement("div");
        el.className = "nvim-pane";
        this.grounds.set(g.key, el);
      }
      this.put(el, g.z, "pane", g.grid);
      el.style.left = `${String(g.x)}px`;
      el.style.top = `${String(g.y)}px`;
      el.style.width = `${String(g.w)}px`;
      el.style.height = `${String(g.h)}px`;
      el.style.background = cssColor(g.colour);
    }
    for (const [key, el] of this.grounds) {
      if (keep.has(key)) continue;
      el.remove();
      this.grounds.delete(key);
    }
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
    // Its ground is painted whole: opaque, so its text is set as the
    // grid's is (subpixel, font smoothing; see the top).
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = cssColor(bg);
    ctx.fillRect(0, 0, cells * cw, ch);
    if (!inside) return;
    ctx.translate(-col * cw, 0);
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
      this.paintIcon(
        ctx,
        icon.c,
        icon.x,
        0,
        icon.cells,
        icon.attr,
        icon.centre,
      );
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
    // Its ground is painted whole: opaque, so its text is set as the
    // grid's is (subpixel, font smoothing; see the top).
    const ctx = canvas.getContext("2d", { alpha: false });
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
   * whose drop shadow follows their union's outline. Every float is in a
   * frame (`frame.ts`; docs/neovim-editor.md, "Floating surfaces"): one
   * rounded 1px line half a cell from its text, the ground between them its
   * border's (or, without a border, its own), the title and footer cells
   * on the line — the float is cut at it. Not a picker's box under framed
   * floats (cut by them, `frameCuts`), a float that blends, or a border
   * drawn cell for cell. Kept while the cluster looks the same, so a
   * member's redraw does not touch it.
   */
  private placeClusters(
    state: NeovimUiState,
    boxes: readonly GridBox[],
    cuts: ReadonlyMap<number, readonly GridBox[]>,
    shapes: Map<number, FrameShape>,
    scrollbars: ReadonlyMap<number, unknown>,
  ): void {
    const { width: cw, height: ch } = this.metrics;
    const live = new Set<string>();
    const blendOf = (grid: number) => {
      const hl = state.grids.get(grid)?.hls[0] ?? 0;
      return state.hl.get(hl)?.blend ?? 0;
    };
    // A float that lets what is under it show (winblend) gets no ground,
    // unless it is framed: then the ring between its line and its text.
    const shown = boxes.filter(
      (box) =>
        box.float &&
        box.bare !== true &&
        (box.frame !== undefined || blendOf(box.grid) === 0),
    );
    const byGrid = new Map(shown.map((box) => [box.grid, box]));
    const colors = (hl: number) =>
      resolveColors(hl ? state.hl.get(hl) : undefined, state.defaults);
    const px = (v: number) => `${String(v)}px`;
    const radius = this.floatRadius();
    const look = floatLook(this.theme, state.defaults);
    // A member's frame: its border's, or the padding round a float without
    // one; none for a box the frames over it cut, a menu's scrollbar drawn
    // as floats, or a border drawn cell for cell.
    const marginsOf = (box: GridBox): Margins | undefined => {
      if (box.frame) return box.frame.margins;
      if (box.lined === true || cuts.has(box.grid) || scrollbars.has(box.grid))
        return undefined;
      return NO_CROP;
    };
    // Every framed member's shape first: a float under framed ones, in
    // its cluster or another, is clipped by theirs (`cutClip`).
    const panels = floatClusters(shown).map((cluster) => {
      const framed: (FramedMember & { box: GridBox })[] = [];
      for (const m of cluster.members) {
        const box = byGrid.get(m.grid);
        const margins = box ? marginsOf(box) : undefined;
        if (!box || !margins) continue;
        framed.push({
          grid: m.grid,
          rect: m.rect,
          box,
          ruled: box.frame !== undefined,
          labelled: Object.fromEntries(
            (box.frame?.labels ?? []).map((l) => [l.side, true]),
          ),
          geometry: frameGeometry(margins, box, this.metrics, this.dpr, radius),
        });
      }
      const framedPieces = framePieces(framed, this.dpr);
      for (const piece of framedPieces) shapes.set(piece.grid, piece);
      return { cluster, framed, framedPieces };
    });
    for (const { cluster, framed, framedPieces } of panels) {
      const blended = cluster.members.some((m) => blendOf(m.grid) > 0);
      const pieces: Piece[] = [];
      const labels: Label[] = [];
      const geometries = new Map(framed.map((f) => [f.grid, f]));
      // The others' grounds, for the shadow: a box cut by the frames over
      // it (`cutClip`), a border drawn cell for cell.
      for (const m of cluster.members) {
        const box = byGrid.get(m.grid);
        if (!box || geometries.has(m.grid) || blendOf(m.grid) > 0) continue;
        const x = m.rect.col * cw;
        const y = m.rect.row * ch;
        const cut = cuts.get(box.grid);
        pieces.push({
          x,
          y,
          w: m.rect.width * cw,
          h: m.rect.height * ch,
          radius: m.lined ? "0" : radii(m.corners),
          background: cssColor(this.floatGround(state, box)),
          ...(cut
            ? { clip: cutClip(box, cut, shapes, this.metrics, { x, y }) }
            : {}),
        });
      }
      for (const seam of cluster.seams) {
        if (seam.between.every((g) => geometries.has(g))) continue;
        const box = byGrid.get(seam.between[0]);
        if (!box) continue;
        pieces.push({
          x: seam.col * cw,
          y: seam.row * ch,
          w: seam.width * cw,
          h: seam.height * ch,
          radius: "0",
          background: cssColor(this.floatGround(state, box)),
        });
      }
      for (const piece of framedPieces) {
        const member = geometries.get(piece.grid);
        if (!member) continue;
        const frame = member.box.frame;
        const side = frame
          ? SIDES.map((s) => frame.sides[s]).find((s) => s !== undefined)
          : undefined;
        // Inside the line, the border's ground (without one, the float's).
        const ground =
          side !== undefined
            ? colors(side.hl).bg
            : this.floatGround(state, member.box);
        const line = cssColor(this.frameLine(state, side, ground, look));
        const blend = blendOf(piece.grid);
        const border = (s: Side) =>
          piece.draw[s]
            ? `${px(member.geometry.widths[s])} solid ${line}`
            : "none";
        pieces.push({
          x: piece.x,
          y: piece.y,
          w: piece.w,
          h: piece.h,
          radius: `${px(piece.radii.tl)} ${px(piece.radii.tr)} ${px(piece.radii.br)} ${px(piece.radii.bl)}`,
          background: cssColor(ground, 1 - blend / 100),
          borders: SIDES.map(border),
          z: member.box.z,
          ...(blend > 0 ? { hole: this.textArea(member.box, piece) } : {}),
        });
        for (const label of frame?.labels ?? []) {
          labels.push(
            this.label(
              state,
              label,
              labelBox(label, member.box, member.geometry, this.metrics),
            ),
          );
        }
      }
      const key = JSON.stringify([cluster.z, blended, pieces, labels]);
      live.add(key);
      const known = this.clusters.get(key);
      if (known) {
        known.grids = cluster.members.map((m) => m.grid);
        continue;
      }
      const el = document.createElement("div");
      el.className = `nvim-float-shadow${blended ? " nvim-float-shadow-none" : ""}`;
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
        else if (part.clip) piece.style.clipPath = part.clip;
        if (!lines) {
          // The ground only, for the shadow's outline.
          piece.style.border = "none";
          piece.style.background = part.hole ? "transparent" : part.background;
        }
        return piece;
      };
      // A framed member's ground and line at its own zindex, under its
      // canvas but over a lower member's (a picker's box under its list):
      // one element per zindex, in that zindex's level.
      // Each part tagged with a member at its zindex, so it goes with the
      // floats when a window's motion carries them (`carryFloats`).
      const memberAt = (z: number) =>
        cluster.members.find((m) => byGrid.get(m.grid)?.z === z)?.grid;
      const frames = new Map<number, HTMLDivElement>();
      for (const part of pieces) {
        el.append(pieceOf(part, false));
        if (part.z === undefined) continue;
        let layer = frames.get(part.z);
        if (!layer) {
          layer = document.createElement("div");
          layer.className = "nvim-float-frames";
          this.put(layer, part.z, "frames", memberAt(part.z));
          frames.set(part.z, layer);
        }
        layer.append(pieceOf(part, true));
      }
      // The title and footer cells over the members (a sibling's canvas may
      // reach a line): an element of their own, at the members' top
      // zindex, after them. On whole device pixels: a half pixel is snapped
      // edge by edge, a label a pixel taller or shorter than its neighbour.
      const snap = (v: number) => Math.round(v * this.dpr) / this.dpr;
      const textHeight = Math.round(this.metrics.textHeight);
      const spacing = px(cw - this.metrics.advance);
      const over =
        labels.length > 0 ? document.createElement("div") : undefined;
      if (over) over.className = "nvim-frame-labels";
      for (const label of labels) {
        const tag = document.createElement("div");
        tag.className = "nvim-frame-label";
        tag.style.left = px(label.x);
        tag.style.width = px(label.w);
        tag.style.top = px(snap(label.cy - textHeight / 2));
        tag.style.height = px(textHeight);
        tag.style.lineHeight = px(textHeight);
        for (const run of label.runs) {
          const span = document.createElement("span");
          span.textContent = run.text;
          span.style.width = px(run.cells * cw);
          span.style.color = run.color;
          span.style.background = run.background;
          span.style.font = run.font;
          span.style.lineHeight = px(textHeight);
          span.style.letterSpacing = spacing;
          tag.append(span);
        }
        over?.append(tag);
      }
      // Under the members' canvases, by part, not by place in the page;
      // the labels over every member.
      this.put(el, cluster.z, "shadow", memberAt(cluster.z));
      if (over) {
        const top = Math.max(
          ...cluster.members.map((m) => byGrid.get(m.grid)?.z ?? 0),
        );
        this.put(over, top, "labels", memberAt(top));
      }
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
  }

  /**
   * A float's own ground: the commonest along its edges (a menu's first
   * row may be its selection), its padding's colour where it has no border.
   */
  private floatGround(state: NeovimUiState, box: GridBox): number {
    const grid = state.grids.get(box.grid);
    if (!grid || grid.width * grid.height === 0)
      return state.defaults.background;
    const tally = new Map<number, number>();
    const count = (row: number, col: number) => {
      const hl = grid.hls[row * grid.width + col] ?? 0;
      tally.set(hl, (tally.get(hl) ?? 0) + 1);
    };
    for (let col = 0; col < grid.width; col += 1) {
      count(0, col);
      count(grid.height - 1, col);
    }
    for (let row = 0; row < grid.height; row += 1) {
      count(row, 0);
      count(row, grid.width - 1);
    }
    let hl = 0;
    let most = 0;
    for (const [id, n] of tally) {
      if (n > most) [hl, most] = [id, n];
    }
    return resolveColors(hl ? state.hl.get(hl) : undefined, state.defaults).bg;
  }

  /**
   * A frame's line colour, the same whatever the border's cells: its
   * highlight's ink (`FloatBorder`; the theme's, without a border) where it
   * names one — not the float's own ink or ground, as a config that links
   * it to `NormalFloat` has it — else the ground 18 % toward the ink, where
   * themes put `FloatBorder` (`floatLook`).
   */
  private frameLine(
    state: NeovimUiState,
    side: FrameSide | undefined,
    ground: number,
    look: FloatLook,
  ): number {
    const named = side
      ? resolveColors(state.hl.get(side.hl), state.defaults).fg
      : this.theme.surface?.border;
    if (named !== undefined && named !== ground && named !== look.ink)
      return named;
    return mixColors(ground, look.ink, 18);
  }

  /** A title or footer's cells, in their highlights, at `at`. */
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
      runs: label.runs.map((run) => ({
        text: run.text,
        cells: run.cells,
        color: cssColor(colors(run.hl).fg),
        background: cssColor(colors(run.hl).bg),
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
    const { bleed } = entry;
    ctx.setTransform(
      this.dpr,
      0,
      0,
      this.dpr,
      (bleed.l - crop.left * cw) * this.dpr,
      (bleed.t - crop.top * ch) * this.dpr,
    );
    const y = row * ch;
    this.paintBleed(ctx, state, grid, row, bleed);
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
    for (const run of runs) {
      this.paintGround(ctx, state, box, grid.chars, base, run, y);
    }
    this.skip.clear();
    // Grid 1's cells a boundary runs through are the panes' and the
    // hairline's (`placePanes`): not drawn as cells. One a line runs down
    // is grounded half and half, each half as the cell beside it (a status
    // line's, where the windows' panes do not reach), so each region's
    // ground goes on to the line.
    if (box.grid === 1)
      for (let c = 0; c < grid.width; c += 1) {
        const i = base + c;
        if (!this.gaps.has(i)) continue;
        this.skip.add(c);
        if (!this.vgaps.has(i)) continue;
        const mid = Math.round((c + 0.5) * cw * this.dpr) / this.dpr;
        const side = (at: number) =>
          cssColor(
            resolveColors(
              state.hl.get(
                grid.hls[base + Math.max(0, Math.min(grid.width - 1, at))] ?? 0,
              ),
              state.defaults,
            ).bg,
          );
        ctx.fillStyle = side(c - 1);
        ctx.fillRect(c * cw, y, mid - c * cw, ch);
        ctx.fillStyle = side(c + 1);
        ctx.fillRect(mid, y, (c + 1) * cw - mid, ch);
      }
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
    // Decorations (Neovim's own virtual text) found where Lua says they are:
    // their words are set in the UI face after the row's text, inside their
    // cells (`decor.ts`), so the cells' own glyphs are not drawn.
    this.words.length = 0;
    const spans =
      box.win === undefined || box.float
        ? undefined
        : this.decor.get(box.win)?.filter((span) => span.row === row);
    const cells = { chars: grid.chars, base, width: grid.width };
    if (spans && spans.length > 0) {
      for (const place of placeDecor(cells, spans)) {
        const words = wordsOf(cells, place);
        if (!words) continue;
        this.words.push({ ...words, align: place.align });
        for (let col = words.start; col < words.end; col += 1)
          this.skip.add(col);
      }
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
      // A completion kind's glyph (the person's own `kind_icons` say which
      // kind it is) in a menu: the kind's mark (`kinds.ts`).
      const kind = box.float ? this.theme.kinds?.icons.get(icon.c) : undefined;
      if (kind) {
        const colour = this.theme.kinds?.colours.get(kind) ?? icon.fg;
        this.paintKind(ctx, familyOf(kind), icon.x, y, colour);
        continue;
      }
      ctx.fillStyle = cssColor(icon.fg);
      this.paintIcon(
        ctx,
        icon.c,
        icon.x,
        y,
        icon.cells,
        icon.attr,
        icon.centre,
      );
    }
    this.icons.length = 0;
    for (const words of this.words) {
      this.paintWords(ctx, state, grid, base, words, y, baseline);
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
    // Not while the canvas is in a scroll port (pixel scrolling).
    if (canvas.parentElement?.classList.contains("nvim-level") !== true) return;
    if (Math.abs(moved.rows) > Math.max(1, Math.floor(box.height / 3))) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const { width: cw, height: ch } = this.metrics;
    // In the canvas's pixels (its bleed before the cells).
    const x = moved.left * cw + entry.bleed.l;
    const y = moved.top * ch + entry.bleed.t;
    const w = (moved.right - moved.left) * cw;
    const h = (moved.bot - moved.top) * ch;
    if (w <= 0 || h <= 0) return;
    const clip = document.createElement("div");
    clip.className = "nvim-slide";
    clip.style.left = `${String(parseFloat(canvas.style.left) + x)}px`;
    clip.style.top = `${String(parseFloat(canvas.style.top) + y)}px`;
    clip.style.width = `${String(w)}px`;
    clip.style.height = `${String(h)}px`;
    clip.style.zIndex = String(PART_Z.over);
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

  private wordsFont(attr: HlAttr | undefined, size: number): string {
    return `${attr?.italic === true ? "italic " : ""}${attr?.bold === true ? "bold " : ""}${String(size)}px ${ICON_FAMILY}, ${UI_FAMILY}`;
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
   * A Nerd Font icon in the bundled symbols font first, put in its cells —
   * two when Neovim says it is wide or a blank follows it — as Ghostty puts
   * it (`placeIcon`): the same for the editor and the terminal panes.
   */
  private paintIcon(
    ctx: CanvasRenderingContext2D,
    c: string,
    x: number,
    y: number,
    cells: number,
    attr: HlAttr | undefined,
    centre = false,
  ): void {
    const { width: cw, height: ch, textHeight, textTop } = this.metrics;
    const capHeight = this.capHeightOf(ctx);
    const font = fontOf(this.font, attr);
    ctx.font = font;
    ctx.letterSpacing = "0px";
    const key = `${font}\u0000${c}`;
    let box = this.inks.get(key);
    if (!box) {
      box = iconBox(ctx.measureText(c), this.font.size);
      this.inks.set(key, box);
    }
    const at = placeIcon(c.codePointAt(0) ?? 0, box, {
      x,
      y,
      cellWidth: cw,
      cellHeight: ch,
      cells,
      faceTop: textTop,
      faceHeight: textHeight,
      capHeight,
      align: centre ? "centre" : "first",
    });
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(at.sx, at.sy);
    ctx.fillText(c, 0, 0);
    ctx.restore();
  }

  /** The grid font's capital height, measured once per font. */
  private capHeightOf(ctx: CanvasRenderingContext2D): number {
    if (this.capHeight === 0) {
      ctx.font = fontOf(this.font, undefined);
      this.capHeight = ctx.measureText("H").actualBoundingBoxAscent;
    }
    return this.capHeight;
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
    const size = this.capHeightOf(ctx);
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
        !wide &&
        !(c !== " " && signPadded(state, chars, hls, base, col, rowWidth));
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
          // both cells, as Ghostty, kitty and WezTerm give it:
          // nvim-web-devicons, lualine and the completion menus all put a
          // space after their icons, and a Mono icon squeezed into one cell
          // is half the size the Nerd Font draws it. A sign's blank is its
          // own second cell: it is centred across the two.
          const next = base + col + 1;
          const sign = signPadded(state, chars, hls, base, col, rowWidth);
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
            attr,
            fg,
            centre: sign && roomy,
          });
        } else if (c.trim().length > 0) {
          // A sign's text (`E`, `●`) centred on its two cells, as an
          // icon sign is; anything else on its own cell.
          const shift =
            cells === 1 && signPadded(state, chars, hls, base, col, rowWidth)
              ? cw / 2
              : 0;
          ctx.letterSpacing = "0px";
          ctx.fillText(c, col * cw + shift, y + baseline);
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

/**
 * Whether the cell at `col` is a sign whose second cell is its padding: in
 * the sign column (`SignColumn`, or `CursorLineSign` on the cursor's line,
 * as `ext_hlstate` names it) and followed by a blank of the same highlight.
 * Neovim gives every sign two cells, a one-cell sign's text padded with a
 * space; a sign is centred across both, not drawn in the first.
 */
export function signPadded(
  state: NeovimUiState,
  chars: readonly string[],
  hls: ArrayLike<number>,
  base: number,
  col: number,
  rowWidth: number,
): boolean {
  if (col + 1 >= rowWidth || chars[base + col + 1] !== " ") return false;
  const hl = hls[base + col] ?? 0;
  if (hls[base + col + 1] !== hl) return false;
  const groups = state.hl.get(hl)?.groups;
  return (
    groups !== undefined &&
    (groups.includes("SignColumn") || groups.includes("CursorLineSign")) &&
    !groups.includes("FoldColumn")
  );
}
