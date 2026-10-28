/**
 * A VS Code colour theme, resolved the way VS Code resolves it — by DevHub.
 *
 * DevHub's chrome and its terminal panes are painted from the colour theme
 * DevHub's own settings name (`[appearance] theme_dark` / `theme_light`). The
 * theme file is read by `main/shell/colorThemeCatalog.ts`; this module is the
 * other half, and has no filesystem in it: given the colours a theme sets and
 * its type, what colour VS Code would give each id.
 *
 * A colour the theme sets is that colour. One it leaves unset is the colour
 * registry's default for the theme's type — a literal, another colour, or a
 * transform of one — read from `colorDefaults.generated.ts`, which is
 * generated from the pinned VS Code source by
 * `scripts/generate-color-defaults.mjs`. The colour arithmetic below is VS
 * Code's own (`vs/base/common/color.ts`, `colorUtils.ts#executeTransform`),
 * ported rather than imported because the model has to run without a VS Code
 * build, and it formats exactly as `Color.toString()` does: `#rrggbb` when
 * opaque, `rgba(r, g, b, a)` otherwise.
 */

import type { ShellPalette } from "../ipc/palette.js";
import type { TerminalPaletteWire } from "../ipc/appShell.js";
import { COLOR_DEFAULTS } from "./colorDefaults.generated.js";
import { COLOR_IDS } from "./colorIds.js";

export { COLOR_IDS } from "./colorIds.js";

/** VS Code's `ColorScheme`, as the colour registry keys its defaults. */
export type ColorThemeType = "light" | "dark" | "hcDark" | "hcLight";

/** A colour value as the generated table writes it. */
export type ColorValueData =
  | null
  | string
  | { readonly rgba: readonly [number, number, number, number] }
  | {
      readonly op: "darken" | "lighten" | "transparent";
      readonly value: ColorValueData;
      readonly factor: number;
    }
  | {
      readonly op: "opaque";
      readonly value: ColorValueData;
      readonly background: ColorValueData;
    }
  | { readonly op: "oneOf"; readonly values: readonly ColorValueData[] }
  | {
      readonly op: "lessProminent";
      readonly value: ColorValueData;
      readonly background: ColorValueData;
      readonly factor: number;
      readonly transparency: number;
    }
  | {
      readonly op: "ifDefinedThenElse";
      readonly if: string;
      readonly then: ColorValueData;
      readonly else: ColorValueData;
    }
  | {
      readonly op: "mix";
      readonly color: ColorValueData;
      readonly with: ColorValueData;
      readonly ratio?: number;
    };

export type ColorDefaultsTable = Readonly<
  Record<string, Readonly<Record<ColorThemeType, ColorValueData>>>
>;

/**
 * A theme as its file says it: its type (from the contribution's `uiTheme`)
 * and the colours its `colors` set, `include`s already folded in.
 */
export interface ColorThemeDefinition {
  /** What VS Code calls it in `workbench.colorTheme`: the `id`, else the label. */
  readonly settingsId: string;
  readonly label: string;
  readonly type: ColorThemeType;
  /** Each colour id the theme sets, to the value it gives it. */
  readonly colors: Readonly<Record<string, string>>;
}

/** The theme type of a contribution's `uiTheme`; VS Code's default is dark. */
export function themeTypeOfUiTheme(uiTheme: unknown): ColorThemeType {
  switch (uiTheme) {
    case "vs":
      return "light";
    case "hc-black":
      return "hcDark";
    case "hc-light":
      return "hcLight";
    default:
      return "dark";
  }
}

// ----- colour arithmetic, after vs/base/common/color.ts

function roundFloat(value: number, decimals: number): number {
  const scale = Math.pow(10, decimals);
  return Math.round(value * scale) / scale;
}

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

interface Hsla {
  readonly h: number;
  readonly s: number;
  readonly l: number;
  readonly a: number;
}

function rgba(r: number, g: number, b: number, a = 1): Rgba {
  return {
    r: Math.min(255, Math.max(0, r)) | 0,
    g: Math.min(255, Math.max(0, g)) | 0,
    b: Math.min(255, Math.max(0, b)) | 0,
    a: roundFloat(Math.max(Math.min(1, a), 0), 3),
  };
}

function hsla(h: number, s: number, l: number, a: number): Hsla {
  return {
    h: Math.max(Math.min(360, h), 0) | 0,
    s: roundFloat(Math.max(Math.min(1, s), 0), 3),
    l: roundFloat(Math.max(Math.min(1, l), 0), 3),
    a: roundFloat(Math.max(Math.min(1, a), 0), 3),
  };
}

function hslaOf({ r: r255, g: g255, b: b255, a }: Rgba): Hsla {
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (min + max) / 2;
  const chroma = max - min;
  if (chroma > 0) {
    s = Math.min(l <= 0.5 ? chroma / (2 * l) : chroma / (2 - 2 * l), 1);
    switch (max) {
      case r:
        h = (g - b) / chroma + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / chroma + 2;
        break;
      case b:
        h = (r - g) / chroma + 4;
        break;
    }
    h *= 60;
    h = Math.round(h);
  }
  return hsla(h, s, l, a);
}

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function rgbaOfHsla({ h: degrees, s, l, a }: Hsla): Rgba {
  const h = degrees / 360;
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  return rgba(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a);
}

/**
 * A colour: its RGBA, and its HSLA when it was made from one (VS Code keeps
 * both and lightens from the HSLA it has, so a chain of transforms rounds the
 * same way here as there).
 */
export class ThemeColor {
  readonly rgba: Rgba;
  readonly hsla: Hsla;

  private constructor(value: Rgba, hslaValue?: Hsla) {
    this.rgba = value;
    this.hsla = hslaValue ?? hslaOf(value);
  }

  static of(r: number, g: number, b: number, a = 1): ThemeColor {
    return new ThemeColor(rgba(r, g, b, a));
  }

  private static ofHsla(value: Hsla): ThemeColor {
    return new ThemeColor(rgbaOfHsla(value), value);
  }

  /** `Color.fromHex`: an unparsable value is red, as it is in VS Code. */
  static fromHex(hex: string): ThemeColor {
    return parseHex(hex) ?? ThemeColor.of(255, 0, 0, 1);
  }

  private static luminanceOf(component: number): number {
    const c = component / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  relativeLuminance(): number {
    const { r, g, b } = this.rgba;
    return roundFloat(
      0.2126 * ThemeColor.luminanceOf(r) +
        0.7152 * ThemeColor.luminanceOf(g) +
        0.0722 * ThemeColor.luminanceOf(b),
      4,
    );
  }

  isLighterThan(other: ThemeColor): boolean {
    return this.relativeLuminance() > other.relativeLuminance();
  }

  isDarkerThan(other: ThemeColor): boolean {
    return this.relativeLuminance() < other.relativeLuminance();
  }

  lighten(factor: number): ThemeColor {
    const { h, s, l, a } = this.hsla;
    return ThemeColor.ofHsla(hsla(h, s, l + l * factor, a));
  }

  darken(factor: number): ThemeColor {
    const { h, s, l, a } = this.hsla;
    return ThemeColor.ofHsla(hsla(h, s, l - l * factor, a));
  }

  transparent(factor: number): ThemeColor {
    const { r, g, b, a } = this.rgba;
    return ThemeColor.of(r, g, b, a * factor);
  }

  isOpaque(): boolean {
    return this.rgba.a === 1;
  }

  mix(other: ThemeColor, factor = 0.5): ThemeColor {
    const ratio = Math.min(Math.max(factor, 0), 1);
    const from = this.rgba;
    const to = other.rgba;
    return ThemeColor.of(
      from.r + (to.r - from.r) * ratio,
      from.g + (to.g - from.g) * ratio,
      from.b + (to.b - from.b) * ratio,
      from.a + (to.a - from.a) * ratio,
    );
  }

  makeOpaque(background: ThemeColor): ThemeColor {
    if (this.isOpaque() || background.rgba.a !== 1) return this;
    const { r, g, b, a } = this.rgba;
    const under = background.rgba;
    return ThemeColor.of(
      under.r - a * (under.r - r),
      under.g - a * (under.g - g),
      under.b - a * (under.b - b),
      1,
    );
  }

  static lighterColor(
    of: ThemeColor,
    relative: ThemeColor,
    factor?: number,
  ): ThemeColor {
    if (of.isLighterThan(relative)) return of;
    const base = factor ? factor : 0.5;
    const lum1 = of.relativeLuminance();
    const lum2 = relative.relativeLuminance();
    return of.lighten((base * (lum2 - lum1)) / lum2);
  }

  static darkerColor(
    of: ThemeColor,
    relative: ThemeColor,
    factor?: number,
  ): ThemeColor {
    if (of.isDarkerThan(relative)) return of;
    const base = factor ? factor : 0.5;
    const lum1 = of.relativeLuminance();
    const lum2 = relative.relativeLuminance();
    return of.darken((base * (lum1 - lum2)) / lum1);
  }

  /** `Color.toString()`: hex when opaque, `rgba()` otherwise. */
  toString(): string {
    const { r, g, b, a } = this.rgba;
    if (a === 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
    return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(+a.toFixed(2))})`;
  }
}

function hex2(value: number): string {
  const text = value.toString(16);
  return text.length !== 2 ? `0${text}` : text;
}

function hexDigit(char: string): number {
  const value = parseInt(char, 16);
  return Number.isNaN(value) ? 0 : value;
}

function parseHex(hex: string): ThemeColor | undefined {
  if (hex[0] !== "#") return undefined;
  const d = (index: number): number => hexDigit(hex.charAt(index));
  switch (hex.length) {
    case 7:
      return ThemeColor.of(
        16 * d(1) + d(2),
        16 * d(3) + d(4),
        16 * d(5) + d(6),
        1,
      );
    case 9:
      return ThemeColor.of(
        16 * d(1) + d(2),
        16 * d(3) + d(4),
        16 * d(5) + d(6),
        (16 * d(7) + d(8)) / 255,
      );
    case 4:
      return ThemeColor.of(17 * d(1), 17 * d(2), 17 * d(3));
    case 5:
      return ThemeColor.of(17 * d(1), 17 * d(2), 17 * d(3), (17 * d(4)) / 255);
    default:
      return undefined;
  }
}

// ----- resolution, after colorThemeData.ts#getColor and colorUtils.ts

/**
 * A theme to ask colours of: `getColor` and `defines` as VS Code's
 * `ColorThemeData` answers them, over a defaults table.
 */
export class ResolvedColorTheme {
  private readonly cache = new Map<string, ThemeColor | undefined>();

  constructor(
    readonly definition: ColorThemeDefinition,
    private readonly defaults: ColorDefaultsTable = COLOR_DEFAULTS,
  ) {}

  get type(): ColorThemeType {
    return this.definition.type;
  }

  /** Whether the theme itself sets this colour. */
  defines(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.definition.colors, id);
  }

  /** The colour VS Code would give `id` under this theme, if any. */
  getColor(id: string): ThemeColor | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    // Marked before resolving, so a default that refers back to itself
    // ends as "no colour" rather than as a stack overflow.
    this.cache.set(id, undefined);
    const own = this.definition.colors[id];
    const color =
      own !== undefined
        ? ThemeColor.fromHex(own)
        : this.resolve(this.defaults[id]?.[this.type] ?? null);
    this.cache.set(id, color);
    return color;
  }

  /** The colour as `Color.toString()` writes it. */
  css(id: string): string | undefined {
    return this.getColor(id)?.toString();
  }

  private resolve(value: ColorValueData): ThemeColor | undefined {
    if (value === null) return undefined;
    if (typeof value === "string") {
      return value.startsWith("#")
        ? ThemeColor.fromHex(value)
        : this.getColor(value);
    }
    if ("rgba" in value) return ThemeColor.of(...value.rgba);
    switch (value.op) {
      case "darken":
        return this.resolve(value.value)?.darken(value.factor);
      case "lighten":
        return this.resolve(value.value)?.lighten(value.factor);
      case "transparent":
        return this.resolve(value.value)?.transparent(value.factor);
      case "mix": {
        const transparent = ThemeColor.of(0, 0, 0, 0);
        const primary = this.resolve(value.color) ?? transparent;
        const other = this.resolve(value.with) ?? transparent;
        return primary.mix(other, value.ratio);
      }
      case "opaque": {
        const background = this.resolve(value.background);
        const color = this.resolve(value.value);
        return background ? color?.makeOpaque(background) : color;
      }
      case "oneOf":
        for (const candidate of value.values) {
          const color = this.resolve(candidate);
          if (color) return color;
        }
        return undefined;
      case "ifDefinedThenElse":
        return this.resolve(this.defines(value.if) ? value.then : value.else);
      case "lessProminent": {
        const from = this.resolve(value.value);
        if (!from) return undefined;
        const background = this.resolve(value.background);
        if (!background) {
          return from.transparent(value.factor * value.transparency);
        }
        return from.isDarkerThan(background)
          ? ThemeColor.lighterColor(from, background, value.factor).transparent(
              value.transparency,
            )
          : ThemeColor.darkerColor(from, background, value.factor).transparent(
              value.transparency,
            );
      }
    }
  }
}

/** `WORKBENCH_BACKGROUND` in `vs/workbench/common/theme.ts`. */
function workbenchBackground(type: ColorThemeType): ThemeColor {
  switch (type) {
    case "light":
      return ThemeColor.fromHex("#F3F3F3");
    case "hcLight":
      return ThemeColor.fromHex("#FFFFFF");
    case "hcDark":
      return ThemeColor.fromHex("#000000");
    case "dark":
      return ThemeColor.fromHex("#252526");
  }
}

/** WCAG's contrast ratio between two opaque colours, 1 to 21. */
function contrast(a: ThemeColor, b: ThemeColor): number {
  const la = a.relativeLuminance();
  const lb = b.relativeLuminance();
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The shell's palette: the four material and ink anchors as the workbench's
 * window splash computes them (`partsSplash.ts`) — what DevHub's chrome used
 * to read off a workbench and now reads off the theme directly — and the
 * accent with the ink drawn on it.
 *
 * The accent is the theme's `textLink.foreground`. DevHub's accent is read as
 * ink far more often than as a fill — links, the selected row's glyph, a
 * focus ring, a chosen option's label, all on the surface — and the link
 * colour is the one a theme author has already made legible on the editor's
 * ground in both halves. (`focusBorder` is often translucent and pale, and
 * `button.background` is tuned to carry white text, so it is too dark to read
 * as ink on a dark ground.) It is made opaque over the surface, since every
 * use of it is drawn there.
 *
 * The ink on it is `button.foreground` where that holds on the accent (WCAG's
 * 4.5:1 for text), and otherwise whichever of it and the editor's background
 * holds better: a dark theme's link colour is
 * light, and white on it would not read, so the ink becomes the dark ground
 * the link was made to read on — the same pair, the other way round.
 */
export function shellPaletteOfTheme(theme: ResolvedColorTheme): ShellPalette {
  const base =
    theme.type === "light" || theme.type === "hcLight" ? "light" : "dark";
  const background = workbenchBackground(theme.type);
  const editor = theme.css(COLOR_IDS.editorBackground);
  const fallback = (
    theme.getColor(COLOR_IDS.editorBackground) ?? background
  ).toString();
  const sideBar = theme.css(COLOR_IDS.sideBarBackground);
  const titleBar = theme
    .getColor(COLOR_IDS.titleBarBackground)
    ?.makeOpaque(background)
    .toString();
  const surface = (
    theme.getColor(COLOR_IDS.editorBackground) ?? background
  ).makeOpaque(background);
  const accent =
    theme.getColor(COLOR_IDS.textLinkForeground)?.makeOpaque(surface) ??
    ThemeColor.fromHex(base === "dark" ? "#82aeca" : "#286486");
  const buttonInk = (
    theme.getColor(COLOR_IDS.buttonForeground) ?? ThemeColor.of(255, 255, 255)
  ).makeOpaque(accent);
  const accentInk =
    contrast(buttonInk, accent) >= 4.5 ||
    contrast(buttonInk, accent) >= contrast(surface, accent)
      ? buttonInk
      : surface;
  return {
    base,
    surface: editor ?? fallback,
    chrome: sideBar ?? titleBar ?? fallback,
    canvas: titleBar ?? sideBar ?? fallback,
    ink:
      theme.css(COLOR_IDS.foreground) ??
      (base === "dark" ? "#cccccc" : "#3b3b3b"),
    accent: accent.toString(),
    accentInk: accentInk.toString(),
  };
}

/**
 * An Agent pane's palette, as VS Code's own terminal resolves the same theme
 * (`XtermTerminal.getXtermTheme`, `TerminalInstanceColorProvider`). Four
 * colours have no registry default and VS Code falls back for them in code,
 * so the same fallbacks are made here:
 *
 * - `terminal.background` is the background of wherever the terminal sits.
 *   An Agent pane sits where an editor does, so it is the editor's — the rule
 *   VS Code has for a terminal in the editor area.
 * - `terminalCursor.foreground` is the terminal's foreground.
 * - `terminalCursor.background`, the character under a block cursor, is the
 *   terminal's background.
 * - `terminal.selectionForeground` stays unset: a selected cell keeps its own
 *   colour.
 */
export function terminalPaletteOfTheme(
  theme: ResolvedColorTheme,
): TerminalPaletteWire {
  const background =
    theme.css(COLOR_IDS.terminalBackground) ??
    theme.css(COLOR_IDS.editorBackground) ??
    workbenchBackground(theme.type).toString();
  const foreground =
    theme.css(COLOR_IDS.terminalForeground) ??
    theme.css(COLOR_IDS.foreground) ??
    "#cccccc";
  return {
    background,
    foreground,
    cursor: theme.css(COLOR_IDS.cursor) ?? foreground,
    cursorText: theme.css(COLOR_IDS.cursorText) ?? background,
    selectionBackground:
      theme.css(COLOR_IDS.selectionBackground) ?? "rgba(128, 128, 128, 0.4)",
    selectionForeground: theme.css(COLOR_IDS.selectionForeground),
    ansi: COLOR_IDS.ansi.map((id) => theme.css(id) ?? foreground),
  };
}

/**
 * The theme as VS Code's own `IInitialColorTheme` says one (`web.api.ts`):
 * its type and the colours its file sets — what a workbench's theme service
 * wears from its first frame when it has no theme of its own cached yet, until
 * it has read the theme's file itself. Every colour the theme leaves unset is
 * the registry's default there, exactly as it is here, so only what the file
 * says is handed over. A value that is not a hex colour is left out rather
 * than painted red (`Color.fromHex`).
 */
export interface InitialColorTheme {
  readonly themeType: ColorThemeType;
  readonly colors: Readonly<Record<string, string>>;
}

const HEX_COLOR = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function initialColorThemeOf(
  definition: ColorThemeDefinition,
): InitialColorTheme {
  const colors: Record<string, string> = {};
  for (const [id, value] of Object.entries(definition.colors)) {
    if (HEX_COLOR.test(value)) colors[id] = value;
  }
  return { themeType: definition.type, colors };
}

/** VS Code's `ThemeTypeSelector`: the class a theme type puts on the page. */
export type ThemeTypeSelector = "vs" | "vs-dark" | "hc-black" | "hc-light";

/**
 * A window splash's colours (`IPartsSplash` without `layoutInfo`) for a
 * workbench about to start in this theme, computed the way the workbench's
 * own `partsSplash.ts` computes the ones it stores: `background` is the
 * editor's background as `#rrggbb` (or the workbench's ground), the title bar
 * is opaque over that ground. With no layout the splash is the page's ground
 * and ink alone, which is the whole of what is right before the workbench has
 * laid anything out.
 */
export interface WindowSplashColors {
  readonly baseTheme: ThemeTypeSelector;
  readonly colorInfo: {
    readonly background: string;
    readonly foreground: string | undefined;
    readonly editorBackground: string | undefined;
    readonly titleBarBackground: string | undefined;
    readonly sideBarBackground: string | undefined;
  };
  /** The stored splash's, carried over when one is replaced. */
  readonly zoomLevel?: number;
}

export function windowSplashOfTheme(
  theme: ResolvedColorTheme,
): WindowSplashColors {
  const ground = workbenchBackground(theme.type);
  const { r, g, b } = (theme.getColor(COLOR_IDS.editorBackground) ?? ground)
    .rgba;
  return {
    baseTheme: themeTypeSelectorOf(theme.type),
    colorInfo: {
      background: `#${hex2(r)}${hex2(g)}${hex2(b)}`,
      foreground: theme.css(COLOR_IDS.foreground),
      editorBackground: theme.css(COLOR_IDS.editorBackground),
      titleBarBackground: theme
        .getColor(COLOR_IDS.titleBarBackground)
        ?.makeOpaque(ground)
        .toString(),
      sideBarBackground: theme.css(COLOR_IDS.sideBarBackground),
    },
  };
}

function themeTypeSelectorOf(type: ColorThemeType): ThemeTypeSelector {
  switch (type) {
    case "light":
      return "vs";
    case "hcDark":
      return "hc-black";
    case "hcLight":
      return "hc-light";
    case "dark":
      return "vs-dark";
  }
}
