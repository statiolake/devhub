/**
 * The characters the painter draws itself instead of asking a font.
 *
 * - **Box drawing** (U+2500–257F): light, heavy, double, dashed, rounded,
 *   diagonal and half lines. A font's `│` stops short of the cell's top and
 *   bottom, and its `─` of the sides, so with any `linespace` (or a fallback
 *   font of other metrics) window separators and float borders break into
 *   dashes. Drawn as rectangles on whole device pixels, through the whole
 *   cell, they join their neighbours like a native border.
 * - **Block elements** (U+2580–259F): eighths, halves, quadrants and shades,
 *   filling the whole cell, `linespace` included.
 * - **Powerline separators** (U+E0B0–E0BF): triangles, thin arrows, half
 *   circles and slants, as tall as the cell so they meet the statusline's
 *   background above and below.
 * - **Nerd Font icons** (the private-use areas and the IEC power symbols) are
 *   not drawn here but are a kind of their own: the painter draws them in the
 *   bundled Symbols Nerd Font first, fitted into their cell (two when Neovim
 *   says the cell is wide).
 *
 * `glyphShapes` is pure — a character and a cell in, rectangles and paths in
 * CSS pixels out — so the geometry is tested without a canvas.
 */

export type GlyphKind = "box" | "block" | "powerline" | "icon";

/**
 * Each box-drawing character as its four arms from the cell's centre —
 * north, east, south, west — each `0` none, `1` light, `2` heavy, `3`
 * double; `....` for the arcs and diagonals, which are drawn as paths.
 * Generated from the Unicode character names ("DOWN LIGHT AND RIGHT HEAVY"
 * is `0210`).
 */
const BOX_ARMS: readonly string[] = [
  "0101 0202 1010 2020 0101 0202 1010 2020 0101 0202 1010 2020 0110 0210 0120 0220", // U+2500
  "0011 0012 0021 0022 1100 1200 2100 2200 1001 1002 2001 2002 1110 1210 2110 1120", // U+2510
  "2120 2210 1220 2220 1011 1012 2011 1021 2021 2012 1022 2022 0111 0112 0211 0212", // U+2520
  "0121 0122 0221 0222 1101 1102 1201 1202 2101 2102 2201 2202 1111 1112 1211 1212", // U+2530
  "2111 1121 2121 2112 2211 1122 1221 2212 1222 2122 2221 2222 0101 0202 1010 2020", // U+2540
  "0303 3030 0310 0130 0330 0013 0031 0033 1300 3100 3300 1003 3001 3003 1310 3130", // U+2550
  "3330 1013 3031 3033 0313 0131 0333 1303 3101 3303 1313 3131 3333 .... .... ....", // U+2560
  ".... .... .... .... 0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010", // U+2570
].flatMap((row) => row.split(" "));

/** The dashed lines: how many dashes to a cell. */
const DASHES: Readonly<Record<number, number>> = {
  0x2504: 3,
  0x2505: 3,
  0x2506: 3,
  0x2507: 3,
  0x2508: 4,
  0x2509: 4,
  0x250a: 4,
  0x250b: 4,
  0x254c: 2,
  0x254d: 2,
  0x254e: 2,
  0x254f: 2,
};

export interface Arms {
  readonly n: number;
  readonly e: number;
  readonly s: number;
  readonly w: number;
}

/** A box-drawing character's arms, or `undefined` (an arc, a diagonal, …). */
export function boxArms(c: string): Arms | undefined {
  const cp = c.codePointAt(0) ?? 0;
  if (c.length !== 1 || cp < 0x2500 || cp > 0x257f) return undefined;
  const code = BOX_ARMS[cp - 0x2500];
  if (code === undefined || code === "....") return undefined;
  return {
    n: Number(code[0]),
    e: Number(code[1]),
    s: Number(code[2]),
    w: Number(code[3]),
  };
}

function isNerdIcon(cp: number): boolean {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x23fb && cp <= 0x23fe) ||
    cp === 0x2b58
  );
}

/** What kind of character the painter treats specially, if any. */
export function glyphKind(c: string): GlyphKind | undefined {
  const cp = c.codePointAt(0);
  if (cp === undefined || c.length > 2) return undefined;
  if (c.length === 2 && cp <= 0xffff) return undefined;
  if (cp >= 0x2500 && cp <= 0x257f) return "box";
  if (cp >= 0x2580 && cp <= 0x259f) return "block";
  if (cp >= 0xe0b0 && cp <= 0xe0bf) return "powerline";
  if (isNerdIcon(cp)) return "icon";
  return undefined;
}

/** A filled rectangle, a filled polygon or ellipse, or a stroked path. */
export type Shape =
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      /** Shades (`░ ▒ ▓`) are the foreground at a fraction. */
      readonly alpha?: number;
    }
  | {
      readonly kind: "fill" | "stroke";
      readonly path: readonly PathOp[];
      /** For `stroke`, in CSS pixels. */
      readonly lineWidth?: number;
    };

export type PathOp =
  | readonly ["M" | "L", number, number]
  /** `arcTo` from the current point through (x1, y1) towards (x2, y2). */
  | readonly ["T", number, number, number, number, number]
  /** An ellipse: centre, radii, start and end angle. */
  | readonly ["E", number, number, number, number, number, number]
  | readonly ["Z"];

export interface CellBox {
  /** In CSS pixels; `w` spans two cells for a wide one. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The line thickness, in device pixels: one CSS pixel at 12–13px type,
 * growing with the font, never less than a device pixel.
 */
export function lightThickness(fontSize: number, dpr: number): number {
  return Math.max(1, Math.round((dpr * fontSize) / 12.5));
}

/**
 * The shapes that draw `c` in `cell`, or `undefined` when a font should.
 * All geometry is worked out on whole device pixels and handed back in CSS
 * pixels, so a line is never smeared across two device pixels.
 */
export function glyphShapes(
  c: string,
  cell: CellBox,
  dpr: number,
  fontSize: number,
): Shape[] | undefined {
  const kind = glyphKind(c);
  if (kind === undefined || kind === "icon") return undefined;
  const cp = c.codePointAt(0) ?? 0;
  const g = new Grid(cell, dpr, lightThickness(fontSize, dpr));
  if (kind === "block") return blockShapes(cp, g);
  if (kind === "powerline") return powerlineShapes(cp, g);
  const arms = boxArms(c);
  if (arms) return armShapes(arms, DASHES[cp] ?? 0, g);
  return pathShapes(cp, g);
}

/** The cell in device pixels, and a way back to CSS pixels. */
class Grid {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly out: Shape[] = [];

  constructor(
    cell: CellBox,
    readonly dpr: number,
    /** A light line, device pixels. */
    readonly light: number,
  ) {
    this.x0 = Math.round(cell.x * dpr);
    this.x1 = Math.max(this.x0 + 1, Math.round((cell.x + cell.w) * dpr));
    this.y0 = Math.round(cell.y * dpr);
    this.y1 = Math.max(this.y0 + 1, Math.round((cell.y + cell.h) * dpr));
  }

  get width(): number {
    return this.x1 - this.x0;
  }

  get height(): number {
    return this.y1 - this.y0;
  }

  /** Where a vertical band `t` wide starts, centred in the cell. */
  vStart(t: number): number {
    return this.x0 + Math.floor((this.width - t) / 2);
  }

  /** Where a horizontal band `t` high starts, centred in the cell. */
  hStart(t: number): number {
    return this.y0 + Math.floor((this.height - t) / 2);
  }

  /** A rectangle given by device-pixel edges. */
  rect(left: number, top: number, right: number, bottom: number, alpha = 1) {
    if (right <= left || bottom <= top) return;
    const d = this.dpr;
    this.out.push({
      kind: "rect",
      x: left / d,
      y: top / d,
      w: (right - left) / d,
      h: (bottom - top) / d,
      ...(alpha < 1 ? { alpha } : {}),
    });
  }

  css(v: number): number {
    return v / this.dpr;
  }
}

function thickness(weight: number, light: number): number {
  return weight === 2 ? Math.max(light + 1, light * 2) : light;
}

/**
 * Straight arms from the centre. A light or heavy arm runs from the edge
 * to the far side of the perpendicular arms (so `┼` and `┿` join square);
 * a double arm is two light lines, which meet a double perpendicular at its
 * inner and outer lines (`╔`, `╬`) or end on a single one (`╞`).
 */
function armShapes(arms: Arms, dashes: number, g: Grid): Shape[] {
  const L = g.light;
  const band = 3 * L; // a double line: line, gap, line
  // The perpendicular span each axis offers the other to end on.
  const vWeights = [arms.n, arms.s].filter((w) => w > 0);
  const hWeights = [arms.e, arms.w].filter((w) => w > 0);
  const vDouble = vWeights.includes(3);
  const hDouble = hWeights.includes(3);
  const vT = Math.max(
    0,
    ...vWeights.map((w) => (w === 3 ? band : thickness(w, L))),
  );
  const hT = Math.max(
    0,
    ...hWeights.map((w) => (w === 3 ? band : thickness(w, L))),
  );
  // The vertical lines' x (band start for doubles), the horizontal ones' y.
  const xa = g.vStart(band);
  const xb = xa + 2 * L;
  const ya = g.hStart(band);
  const yb = ya + 2 * L;

  if (dashes > 0) {
    const w = Math.max(arms.n, arms.e, arms.s, arms.w);
    const t = thickness(w, L);
    const vertical = arms.n > 0;
    const length = vertical ? g.height : g.width;
    const segment = length / dashes;
    for (let i = 0; i < dashes; i += 1) {
      const from = Math.round(i * segment + segment * 0.2);
      const to = Math.round(i * segment + segment * 0.8);
      if (vertical) {
        g.rect(g.vStart(t), g.y0 + from, g.vStart(t) + t, g.y0 + to);
      } else {
        g.rect(g.x0 + from, g.hStart(t), g.x0 + to, g.hStart(t) + t);
      }
    }
    return g.out;
  }

  // Horizontal arms: where they start (east) or end (west) on the vertical.
  const hSpan = (own: number): [number, number] => {
    if (vWeights.length === 0) {
      const s = g.vStart(own);
      return [s, s + own];
    }
    const s = g.vStart(vT);
    return [s, s + vT];
  };
  const vSpan = (own: number): [number, number] => {
    if (hWeights.length === 0) {
      const s = g.hStart(own);
      return [s, s + own];
    }
    const s = g.hStart(hT);
    return [s, s + hT];
  };

  for (const side of ["e", "w"] as const) {
    const weight = arms[side];
    if (weight === 0) continue;
    if (weight !== 3) {
      const t = thickness(weight, L);
      const top = g.hStart(t);
      const [s, e] = hSpan(t);
      if (side === "e") g.rect(s, top, g.x1, top + t);
      else g.rect(g.x0, top, e, top + t);
      continue;
    }
    // Two lines, at ya (upper) and yb (lower).
    let upper: number;
    let lower: number;
    if (vDouble) {
      if (side === "e") {
        upper = arms.n === 3 ? xb : xa;
        lower = arms.s === 3 ? xb : xa;
      } else {
        upper = arms.n === 3 ? xa + L : xb + L;
        lower = arms.s === 3 ? xa + L : xb + L;
      }
    } else {
      const [s, e] = hSpan(band);
      upper = lower = side === "e" ? s : e;
    }
    if (side === "e") {
      g.rect(upper, ya, g.x1, ya + L);
      g.rect(lower, yb, g.x1, yb + L);
    } else {
      g.rect(g.x0, ya, upper, ya + L);
      g.rect(g.x0, yb, lower, yb + L);
    }
  }

  for (const side of ["s", "n"] as const) {
    const weight = arms[side];
    if (weight === 0) continue;
    if (weight !== 3) {
      const t = thickness(weight, L);
      const left = g.vStart(t);
      const [s, e] = vSpan(t);
      if (side === "s") g.rect(left, s, left + t, g.y1);
      else g.rect(left, g.y0, left + t, e);
      continue;
    }
    // Two lines, at xa (left) and xb (right).
    let left: number;
    let right: number;
    if (hDouble) {
      if (side === "s") {
        left = arms.w === 3 ? yb : ya;
        right = arms.e === 3 ? yb : ya;
      } else {
        left = arms.w === 3 ? ya + L : yb + L;
        right = arms.e === 3 ? ya + L : yb + L;
      }
    } else {
      const [s, e] = vSpan(band);
      left = right = side === "s" ? s : e;
    }
    if (side === "s") {
      g.rect(xa, left, xa + L, g.y1);
      g.rect(xb, right, xb + L, g.y1);
    } else {
      g.rect(xa, g.y0, xa + L, left);
      g.rect(xb, g.y0, xb + L, right);
    }
  }
  return g.out;
}

/** The rounded corners and the diagonals. */
function pathShapes(cp: number, g: Grid): Shape[] {
  const L = g.light;
  const lineWidth = g.css(L);
  if (cp >= 0x256d && cp <= 0x2570) {
    // ╭ ╮ ╯ ╰: from the middle of one edge to the middle of the next, the
    // straight parts on the same device pixels as `─` and `│`.
    const cx = g.css(g.vStart(L) + L / 2);
    const cy = g.css(g.hStart(L) + L / 2);
    const east = cp === 0x256d || cp === 0x2570;
    const south = cp === 0x256d || cp === 0x256e;
    const hx = g.css(east ? g.x1 : g.x0);
    const vy = g.css(south ? g.y1 : g.y0);
    const r = Math.min(Math.abs(hx - cx), Math.abs(vy - cy));
    g.out.push({
      kind: "stroke",
      lineWidth,
      path: [
        ["M", hx, cy],
        ["T", cx, cy, cx, vy, r],
        ["L", cx, vy],
      ],
    });
    return g.out;
  }
  const [l, t, r, b] = [g.x0, g.y0, g.x1, g.y1].map((v) => g.css(v)) as [
    number,
    number,
    number,
    number,
  ];
  const path: PathOp[] = [];
  if (cp === 0x2571 || cp === 0x2573) path.push(["M", r, t], ["L", l, b]);
  if (cp === 0x2572 || cp === 0x2573) path.push(["M", l, t], ["L", r, b]);
  g.out.push({ kind: "stroke", lineWidth, path });
  return g.out;
}

/** U+2580–259F: eighths, halves, quadrants, shades — the whole cell. */
function blockShapes(cp: number, g: Grid): Shape[] {
  const { x0, x1, y0, y1 } = g;
  const W = g.width;
  const H = g.height;
  const eighthsDown = (n: number) => y1 - Math.max(1, Math.round((H * n) / 8));
  const eighthsRight = (n: number) => x0 + Math.max(1, Math.round((W * n) / 8));
  const mx = x0 + Math.round(W / 2);
  const my = y0 + Math.round(H / 2);
  if (cp === 0x2580) g.rect(x0, y0, x1, my);
  else if (cp >= 0x2581 && cp <= 0x2588)
    g.rect(x0, eighthsDown(cp - 0x2580), x1, y1);
  else if (cp >= 0x2589 && cp <= 0x258f)
    g.rect(x0, y0, eighthsRight(0x2590 - cp), y1);
  else if (cp === 0x2590) g.rect(mx, y0, x1, y1);
  else if (cp >= 0x2591 && cp <= 0x2593)
    g.rect(x0, y0, x1, y1, (cp - 0x2590) / 4);
  else if (cp === 0x2594)
    g.rect(x0, y0, x1, y0 + Math.max(1, Math.round(H / 8)));
  else if (cp === 0x2595)
    g.rect(x1 - Math.max(1, Math.round(W / 8)), y0, x1, y1);
  else {
    // Quadrants: upper-left, upper-right, lower-left, lower-right.
    const quadrants: Readonly<Record<number, string>> = {
      0x2596: "0010",
      0x2597: "0001",
      0x2598: "1000",
      0x2599: "1011",
      0x259a: "1001",
      0x259b: "1110",
      0x259c: "1101",
      0x259d: "0100",
      0x259e: "0110",
      0x259f: "0111",
    };
    const q = quadrants[cp] ?? "0000";
    if (q[0] === "1") g.rect(x0, y0, mx, my);
    if (q[1] === "1") g.rect(mx, y0, x1, my);
    if (q[2] === "1") g.rect(x0, my, mx, y1);
    if (q[3] === "1") g.rect(mx, my, x1, y1);
  }
  return g.out;
}

/**
 * U+E0B0–E0BF, Powerline's separators, from edge to edge of the cell:
 * E0B0–E0B3 the triangles and thin arrows, E0B4–E0B7 the half circles,
 * E0B8–E0BF the slants.
 */
function powerlineShapes(cp: number, g: Grid): Shape[] {
  const [l, t, r, b] = [g.x0, g.y0, g.x1, g.y1].map((v) => g.css(v)) as [
    number,
    number,
    number,
    number,
  ];
  const my = (t + b) / 2;
  const lw = g.css(g.light);
  const inset = lw / 2;
  const fill = (...points: [number, number][]) => {
    const [first, ...rest] = points;
    if (!first) return;
    g.out.push({
      kind: "fill",
      path: [["M", ...first], ...rest.map((p) => ["L", ...p] as const), ["Z"]],
    });
  };
  const stroke = (...points: [number, number][]) => {
    const [first, ...rest] = points;
    if (!first) return;
    g.out.push({
      kind: "stroke",
      lineWidth: lw,
      path: [["M", ...first], ...rest.map((p) => ["L", ...p] as const)],
    });
  };
  const half = Math.PI / 2;
  switch (cp) {
    case 0xe0b0:
      fill([l, t], [r, my], [l, b]);
      break;
    case 0xe0b1:
      stroke([l, t + inset], [r - inset, my], [l, b - inset]);
      break;
    case 0xe0b2:
      fill([r, t], [l, my], [r, b]);
      break;
    case 0xe0b3:
      stroke([r, t + inset], [l + inset, my], [r, b - inset]);
      break;
    case 0xe0b4:
      g.out.push({
        kind: "fill",
        path: [["M", l, t], ["E", l, my, r - l, my - t, -half, half], ["Z"]],
      });
      break;
    case 0xe0b5:
      g.out.push({
        kind: "stroke",
        lineWidth: lw,
        path: [["E", l, my, r - l - inset, my - t - inset, -half, half]],
      });
      break;
    case 0xe0b6:
      g.out.push({
        kind: "fill",
        path: [["M", r, b], ["E", r, my, r - l, my - t, half, 3 * half], ["Z"]],
      });
      break;
    case 0xe0b7:
      g.out.push({
        kind: "stroke",
        lineWidth: lw,
        path: [["E", r, my, r - l - inset, my - t - inset, half, 3 * half]],
      });
      break;
    case 0xe0b8:
      fill([l, t], [r, b], [l, b]);
      break;
    case 0xe0b9:
    case 0xe0bf:
      stroke([l, t], [r, b]);
      break;
    case 0xe0ba:
      fill([r, t], [r, b], [l, b]);
      break;
    case 0xe0bb:
    case 0xe0bd:
      stroke([r, t], [l, b]);
      break;
    case 0xe0bc:
      fill([l, t], [r, t], [l, b]);
      break;
    case 0xe0be:
      fill([l, t], [r, t], [r, b]);
      break;
  }
  return g.out;
}

/**
 * How an icon glyph of the given ink box is fitted into its cells: the
 * scale (never up for one cell; for two, up to three quarters of their
 * width and most of the text's height) and
 * the offset from the cell box's centre to the text origin, so the ink is
 * centred.
 */
export function fitIcon(
  ink: { left: number; right: number; ascent: number; descent: number },
  box: { w: number; h: number },
  wide: boolean,
): { scale: number; dx: number; dy: number } {
  const gw = ink.left + ink.right;
  const gh = ink.ascent + ink.descent;
  if (gw <= 0 || gh <= 0) return { scale: 1, dx: 0, dy: 0 };
  // Two cells keep a margin on each side, so the icon never touches the
  // text either side of it.
  const scale = Math.min(
    wide ? 1.5 : 1,
    (box.w * (wide ? 0.75 : 1)) / gw,
    (box.h * (wide ? 0.85 : 1)) / gh,
  );
  return {
    scale,
    dx: -(ink.right - ink.left) / 2,
    dy: (ink.ascent - ink.descent) / 2,
  };
}
