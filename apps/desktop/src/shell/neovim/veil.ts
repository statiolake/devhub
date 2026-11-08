/**
 * The backdrop under notifications, pure: the shape of the text it is
 * behind, as a mask.
 *
 * fidget's lines sit over code. What makes them hard to read is the code's
 * fine detail right under the letters, so the backdrop recedes the code
 * there — a light blur and a tint of the editor's own ground — and nowhere
 * else. Its shape is the text's: each line a capsule as long as that line
 * (a short line between two long ones gets a short one), the capsules
 * unioned and then feathered as one, so there is no rectangle, no hull and
 * no edge anywhere — only code that grows quieter toward the letters. Over
 * empty ground a tint of that ground and a blur of nothing change no pixel:
 * the backdrop is invisible there.
 */

export interface VeilLine {
  /** The line's box in the veil's own coordinates, in CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Its opacity now (fading in or out): the capsule is that strong. */
  readonly opacity: number;
}

/**
 * The feather, by the editor's line: σ is a quarter of a line. Soft enough
 * that the outline is never seen as an edge (it is gone within a line),
 * tight enough that a short line between two long ones keeps its own short
 * region: the long lines reach less than a seventh into its row.
 */
export function veilSigma(lineHeight: number): number {
  return lineHeight / 4;
}

/**
 * How far a capsule reaches past its text: one and a half σ along the
 * line, so the letters at its ends sit on 93 % of the backdrop; half a σ
 * across it, so the first and last lines are covered while a short line
 * between long ones keeps most of its own row.
 */
export function veilPad(sigma: number): {
  readonly x: number;
  readonly y: number;
} {
  return { x: 1.5 * sigma, y: 0.5 * sigma };
}

/** The margin the veil needs beyond the lines for the feather to fade out. */
export function veilMargin(sigma: number): number {
  return Math.ceil(veilPad(sigma).x + 3 * sigma);
}

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * The mask, an SVG image of `width × height`: white capsules, one per line
 * at its opacity, blurred together by σ. `undefined` when nothing shows.
 */
export function veilMask(
  lines: readonly VeilLine[],
  width: number,
  height: number,
  sigma: number,
): string | undefined {
  const pad = veilPad(sigma);
  const shapes = lines
    .filter((l) => l.opacity > 0.01 && l.w > 0 && l.h > 0)
    .map((l) => {
      const w = l.w + 2 * pad.x;
      const h = l.h + 2 * pad.y;
      return `<rect x="${String(round(l.x - pad.x))}" y="${String(round(l.y - pad.y))}" width="${String(round(w))}" height="${String(round(h))}" rx="${String(round(h / 2))}" fill-opacity="${String(Math.round(l.opacity * 100) / 100)}"/>`;
    });
  if (shapes.length === 0) return undefined;
  // The capsules are drawn into one group and the group blurred: a union,
  // then one feather (overlapping lines that are there do not add up).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(Math.ceil(width))}" height="${String(Math.ceil(height))}"><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${String(round(sigma))}"/></filter><g filter="url(#f)" fill="#fff">${shapes.join("")}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
