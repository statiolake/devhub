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
import { fitIcon, glyphKind, glyphShapes, type Shape } from "./glyphs";

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

export class GridPainter {
  private readonly canvases = new Map<number, GridCanvas>();
  private font: FontSpec;
  private metrics: Metrics;
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

  fontSpec(): FontSpec {
    return this.font;
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
    const all = forceAll || changes.colors;
    for (const box of boxes) {
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
      const crop = box.crop ?? NO_CROP;
      const cropKey = `${String(crop.top)},${String(crop.right)},${String(crop.bottom)},${String(crop.left)}`;
      canvas.style.display = "";
      canvas.style.left = `${String((box.col + crop.left) * this.metrics.width)}px`;
      canvas.style.top = `${String((box.row + crop.top) * this.metrics.height)}px`;
      canvas.style.zIndex = String(box.z);
      canvas.classList.toggle("nvim-float", box.float);
      canvas.classList.toggle("nvim-float-lined", box.lined === true);
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
          : [...grid.dirty];
      for (const row of rows) this.paintRow(entry, state, box, row);
      grid.dirty.clear();
      const scrolled = changes.scrolled.get(box.grid) ?? 0;
      if (scrolled !== 0 && !box.float && !fresh) {
        this.glide(canvas, scrolled, grid.height);
      }
    }
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
    const crop = box.crop ?? NO_CROP;
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
    let col = 0;
    while (col < grid.width) {
      const hl = grid.hls[base + col] ?? 0;
      let end = col + 1;
      while (end < grid.width && grid.hls[base + end] === hl) end += 1;
      this.paintRun(
        ctx,
        state,
        box,
        grid.chars,
        grid.hls,
        grid.width,
        base,
        col,
        end,
        hl,
        y,
        baseline,
      );
      col = end;
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

  private paintRun(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    box: GridBox,
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
    const blend = box.float && attr?.blend !== undefined ? attr.blend : 0;
    const x0 = start * cw;
    const x1 = end * cw;
    ctx.fillStyle = cssColor(bg, 1 - blend / 100);
    ctx.fillRect(x0, y, x1 - x0, ch);
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
