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

export interface FontSpec {
  readonly family: string;
  readonly size: number;
  /** Extra pixels between rows (`linespace`). */
  readonly linespace: number;
}

export interface Metrics extends CellMetrics {
  readonly baseline: number;
}

const FALLBACK_FAMILY = `Menlo, "SF Mono", Monaco, "DejaVu Sans Mono", monospace`;

/** `guifont` (`Fira Code,Menlo:h13`) as a CSS family list and a size. */
export function parseGuifont(
  value: unknown,
): { family?: string; size?: number } | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const [faces, ...options] = value.split(":");
  const family = (faces ?? "")
    .split(",")
    .map((face) => face.trim().replaceAll("_", " "))
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
  return `${attr?.italic === true ? "italic " : ""}${attr?.bold === true ? "bold " : ""}${String(spec.size)}px ${spec.family ? `${spec.family}, ${FALLBACK_FAMILY}` : FALLBACK_FAMILY}`;
}

export function measureFont(spec: FontSpec): Metrics {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx)
    return {
      width: spec.size * 0.6,
      height: spec.size * 1.3,
      baseline: spec.size,
    };
  ctx.font = fontOf(spec);
  const m = ctx.measureText("M");
  const ascent = m.fontBoundingBoxAscent || spec.size * 0.8;
  const descent = m.fontBoundingBoxDescent || spec.size * 0.25;
  const height = Math.ceil(ascent + descent) + spec.linespace;
  return {
    width: m.width,
    height,
    baseline: Math.round(spec.linespace / 2 + ascent),
  };
}

interface GridCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

export class GridPainter {
  private readonly canvases = new Map<number, GridCanvas>();
  private font: FontSpec;
  private metrics: Metrics;
  private readonly dpr: number;

  constructor(
    private readonly root: HTMLElement,
    font: FontSpec,
  ) {
    this.font = font;
    this.metrics = measureFont(font);
    this.dpr = window.devicePixelRatio || 1;
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
    this.metrics = measureFont(font);
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
      canvas.style.display = "";
      canvas.style.left = `${String(box.col * this.metrics.width)}px`;
      canvas.style.top = `${String(box.row * this.metrics.height)}px`;
      canvas.style.zIndex = String(box.z);
      canvas.classList.toggle("nvim-float", box.float);
      if (
        entry.width !== grid.width ||
        entry.height !== grid.height ||
        fresh ||
        forceAll
      ) {
        const w = grid.width * this.metrics.width;
        const h = grid.height * this.metrics.height;
        canvas.width = Math.max(1, Math.ceil(w * this.dpr));
        canvas.height = Math.max(1, Math.ceil(h * this.dpr));
        canvas.style.width = `${String(w)}px`;
        canvas.style.height = `${String(h)}px`;
        entry.width = grid.width;
        entry.height = grid.height;
        fresh = true;
      }
      const rows =
        fresh || all
          ? Array.from({ length: grid.height }, (_, row) => row)
          : [...grid.dirty];
      for (const row of rows) this.paintRow(entry, state, box, row);
      grid.dirty.clear();
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
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const y = row * ch;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, grid.width * cw, ch);
    ctx.clip();
    ctx.clearRect(0, y, grid.width * cw, ch);
    const base = row * grid.width;
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
        base,
        col,
        end,
        hl,
        y,
        baseline,
      );
      col = end;
    }
    ctx.restore();
  }

  private paintRun(
    ctx: CanvasRenderingContext2D,
    state: NeovimUiState,
    box: GridBox,
    chars: readonly string[],
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
    ctx.fillStyle = cssColor(fg);
    ctx.font = fontOf(this.font, attr);
    ctx.textBaseline = "alphabetic";
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
      const simple =
        c.length === 1 &&
        c.charCodeAt(0) < 0x2e80 &&
        chars[base + col + 1] !== "";
      if (simple) {
        if (text.length === 0) textStart = col;
        text += c;
      } else {
        flush();
        if (c.trim().length > 0) ctx.fillText(c, col * cw, y + baseline);
        textStart = col + 1;
      }
    }
    flush();
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
