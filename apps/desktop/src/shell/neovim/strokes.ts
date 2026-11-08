/**
 * The underline family and strikethrough as a typesetter draws them, not
 * as a terminal approximates them: a stroke as thick as the face asks
 * (a device pixel at least), on whole device pixels under the baseline;
 * undercurl a true wave whose phase is the row's, so runs and cells side by
 * side make one wave; dots round and dashes even, also in phase across
 * runs; strikethrough through the middle of the lowercase letters.
 *
 * Pure geometry, tested without a canvas; `painter.ts` strokes it.
 */

export type StrokeKind =
  | "underline"
  | "underdouble"
  | "underdotted"
  | "underdashed"
  | "undercurl"
  | "strikethrough";

/** A line to stroke: a straight one (dashed or not) or a wave's points. */
export interface Stroke {
  readonly width: number;
  /** A straight line from x0 to x1 at y… */
  readonly y?: number;
  readonly x0?: number;
  readonly x1?: number;
  /** …dashed: [on, off], its phase from the row's start. */
  readonly dash?: readonly [number, number];
  readonly round?: boolean;
  /** …or a wave through these points. */
  readonly points?: readonly (readonly [number, number])[];
}

/**
 * The strokes for `kind` under (or through) cells `x0..x1` of a row whose
 * top is `y`, `ch` tall, its baseline `baseline` from the top, in a face of
 * `size` pixels, on a screen of `dpr` device pixels per pixel.
 */
export function strokesFor(
  kind: StrokeKind,
  x0: number,
  x1: number,
  y: number,
  ch: number,
  baseline: number,
  size: number,
  dpr: number,
): Stroke[] {
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const px = 1 / dpr;
  const width = Math.max(px, snap(size / 14));
  const bottom = y + ch - width / 2;
  // A stroke's middle on a device pixel's middle when it is one wide.
  const at = (v: number) => {
    const s = snap(v);
    return Math.round(width * dpr) % 2 === 1 ? s + px / 2 : s;
  };
  const under = Math.min(
    bottom,
    at(y + baseline + Math.max(width * 1.5, size * 0.12)),
  );
  switch (kind) {
    case "underline":
      return [{ width, y: under, x0, x1 }];
    case "underdouble": {
      const gap = Math.max(width * 2, 2 * px);
      const first = Math.min(under, at(bottom - gap - width));
      return [
        { width, y: first, x0, x1 },
        { width, y: Math.min(bottom, at(first + gap)), x0, x1 },
      ];
    }
    case "underdotted":
      return [{ width, y: under, x0, x1, dash: [0, width * 2.5], round: true }];
    case "underdashed":
      return [{ width, y: under, x0, x1, dash: [width * 4, width * 3] }];
    case "strikethrough":
      return [{ width, y: at(y + baseline - size * 0.3), x0, x1 }];
    case "undercurl": {
      // A wavelength of about a third of the face, its amplitude a fifth of
      // that, kept above the row's bottom.
      const length = Math.max(4 * px, size / 3);
      const amp = Math.max(px, length / 5);
      const mid = Math.min(bottom - amp, under + amp / 2);
      const points: [number, number][] = [];
      const steps = Math.max(2, Math.ceil(((x1 - x0) * dpr) / 1));
      for (let i = 0; i <= steps; i += 1) {
        const x = x0 + ((x1 - x0) * i) / steps;
        // Phase from x = 0: the wave runs on from the cell before.
        points.push([x, mid - amp * Math.sin((2 * Math.PI * x) / length)]);
      }
      return [{ width, points }];
    }
  }
}
