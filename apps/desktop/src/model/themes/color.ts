/**
 * The colour arithmetic DevHub's themes are derived with: sRGB hex in and
 * out, OKLab / OKLCH in between (Björn Ottosson's, as CSS Color 4 defines
 * them), and WCAG 2's contrast ratio.
 *
 * OKLab because it is perceptually even: a surface mixed 6% from the
 * background toward the foreground looks 6% lifted on any theme, a hue keeps
 * its hue when its lightness is moved to reach a contrast, and two colours
 * the eye calls "the same" are close in it. sRGB mixing would make a blue go
 * grey on the way and a yellow muddy.
 *
 * No filesystem, no DOM: the main process, the pages, the tests and the
 * mock renderer all use the same functions.
 */

export interface Rgb {
  /** 0–1 each, gamma-encoded sRGB. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Oklch {
  /** Lightness, 0–1. */
  readonly l: number;
  /** Chroma, 0 to about 0.4. */
  readonly c: number;
  /** Hue in degrees, 0–360. Meaningless when `c` is about 0. */
  readonly h: number;
}

interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;

/** Whether `value` is a colour a theme may name: `#rgb` or `#rrggbb`. */
export function isHexColor(value: string): boolean {
  return HEX.test(value) && value.startsWith("#");
}

/** `#rgb` / `#rrggbb` (the `#` optional) as sRGB; throws on anything else. */
export function parseHex(value: string): Rgb {
  const match = HEX.exec(value.trim());
  if (!match?.[1]) throw new Error(`not a colour: ${value}`);
  const digits = match[1];
  const full =
    digits.length === 3
      ? [...digits].map((digit) => digit + digit).join("")
      : digits;
  const byte = (index: number): number =>
    Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
  return { r: byte(0), g: byte(1), b: byte(2) };
}

/** Lower-case `#rrggbb`, each channel clamped to the gamut. */
export function hexOf({ r, g, b }: Rgb): string {
  const part = (value: number): string =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Any accepted spelling, normalised to `#rrggbb`. */
export function normalizeHex(value: string): string {
  return hexOf(parseHex(value));
}

function toLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function fromLinear(channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function oklabOf({ r, g, b }: Rgb): Oklab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function rgbOfOklab({ l: L, a, b }: Oklab): Rgb {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function inGamut({ r, g, b }: Rgb): boolean {
  const ok = (value: number): boolean => value >= -1e-4 && value <= 1 + 1e-4;
  return ok(r) && ok(g) && ok(b);
}

export function oklchOf(hex: string): Oklch {
  const { l, a, b } = oklabOf(parseHex(hex));
  const c = Math.sqrt(a * a + b * b);
  const h = c < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
}

/**
 * An OKLCH colour as `#rrggbb`. Out of gamut, chroma is reduced (hue and
 * lightness kept) until it fits — CSS Color 4's gamut mapping, by bisection.
 */
export function hexOfOklch({ l, c, h }: Oklch): string {
  const lightness = Math.max(0, Math.min(1, l));
  const at = (chroma: number): Rgb => {
    const radians = (h * Math.PI) / 180;
    return rgbOfOklab({
      l: lightness,
      a: chroma * Math.cos(radians),
      b: chroma * Math.sin(radians),
    });
  };
  let rgb = at(c);
  if (!inGamut(rgb)) {
    let low = 0;
    let high = c;
    for (let step = 0; step < 24; step += 1) {
      const middle = (low + high) / 2;
      if (inGamut(at(middle))) low = middle;
      else high = middle;
    }
    rgb = at(low);
  }
  return hexOf(rgb);
}

/** `from` moved `amount` (0–1) of the way to `to`, in OKLab. */
export function mix(from: string, to: string, amount: number): string {
  const a = oklabOf(parseHex(from));
  const b = oklabOf(parseHex(to));
  const t = Math.max(0, Math.min(1, amount));
  return hexOf(
    rgbOfOklab({
      l: a.l + (b.l - a.l) * t,
      a: a.a + (b.a - a.a) * t,
      b: a.b + (b.b - a.b) * t,
    }),
  );
}

/** WCAG 2's relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2's contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** How far apart two colours look: Euclidean distance in OKLab. */
export function distance(a: string, b: string): number {
  const x = oklabOf(parseHex(a));
  const y = oklabOf(parseHex(b));
  return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);
}

/** Whether the ground is a dark one: its OKLab lightness below the middle. */
export function isDark(background: string): boolean {
  return oklchOf(background).l < 0.6;
}

/**
 * `color` with its lightness moved away from `background`, hue and chroma
 * kept, until it reaches `ratio` against it — or as far as the gamut allows.
 * A colour that already reaches it is returned unchanged, so a theme's own
 * colour is never touched unless it would not read.
 */
export function withContrast(
  color: string,
  background: string,
  ratio: number,
): string {
  if (contrast(color, background) >= ratio) return color;
  const lch = oklchOf(color);
  const lighter = oklchOf(background).l < 0.6;
  let best = color;
  for (let step = 1; step <= 50; step += 1) {
    const l = lighter
      ? lch.l + ((1 - lch.l) * step) / 50
      : lch.l - (lch.l * step) / 50;
    const candidate = hexOfOklch({ ...lch, l });
    best = candidate;
    if (contrast(candidate, background) >= ratio) return candidate;
  }
  return best;
}

/** `hex` with its OKLCH lightness shifted by `delta` (clamped). */
export function shiftLightness(hex: string, delta: number): string {
  const lch = oklchOf(hex);
  return hexOfOklch({ ...lch, l: lch.l + delta });
}
