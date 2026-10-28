/**
 * The colours a diagram is drawn in: DevHub's own tokens, as the page has
 * resolved them right now.
 *
 * A diagram is an image, and an image does not inherit a colour or resolve a
 * `var()`: whatever it is drawn in has to be written into it. So the tokens
 * that matter are read off the document — which is where a Workbench's colour
 * theme has put them (`tokens.css`, `applyPalette`) — and turned into plain
 * hex, which is what Mermaid's theme takes. A theme change, or the system
 * appearance flipping under a page with no theme, is a new key, and every
 * diagram on screen is drawn again in the new colours.
 */

import { useMemo, useSyncExternalStore } from "react";
import { documentColorScheme, observeColorScheme } from "../appearance";

export interface DiagramTheme {
  readonly scheme: "light" | "dark";
  /** What a diagram is drawn on, and what its PNG is filled with. */
  readonly background: string;
  readonly ink: string;
  readonly secondary: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly wash: string;
  readonly sunken: string;
  readonly accent: string;
  readonly accentInk: string;
  readonly waiting: string;
  readonly fontFamily: string;
}

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const clamp = (n: number) => Math.min(255, Math.max(0, n));

/**
 * A computed colour as Chromium writes one back: `rgb()`/`rgba()`, or
 * `color(srgb …)` for a `color-mix()` in sRGB. Hex too, for the fallbacks.
 */
export function parseCssColor(value: string): Rgba | undefined {
  const text = value.trim().toLowerCase();
  let match = /^#([0-9a-f]{3,8})$/.exec(text);
  if (match) {
    let hex = match[1]!;
    if (hex.length === 3 || hex.length === 4) {
      hex = [...hex].map((c) => c + c).join("");
    }
    if (hex.length !== 6 && hex.length !== 8) return undefined;
    const n = (at: number) => parseInt(hex.slice(at, at + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  match = /^rgba?\(([^)]*)\)$/.exec(text);
  if (match) {
    const parts = match[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
      return undefined;
    }
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }
  match = /^color\(srgb\s+([^)]*)\)$/.exec(text);
  if (match) {
    const parts = match[1]!
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
      return undefined;
    }
    return {
      r: parts[0]! * 255,
      g: parts[1]! * 255,
      b: parts[2]! * 255,
      a: parts[3] ?? 1,
    };
  }
  return undefined;
}

/** `top` at `amount` over `under`, opaque. */
function over(top: Rgba, under: Rgba, amount = top.a): Rgba {
  const mixChannel = (a: number, b: number) => a * amount + b * (1 - amount);
  return {
    r: mixChannel(top.r, under.r),
    g: mixChannel(top.g, under.g),
    b: mixChannel(top.b, under.b),
    a: 1,
  };
}

function hex({ r, g, b }: Rgba): string {
  return `#${[r, g, b]
    .map((n) => Math.round(clamp(n)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** `top` mixed into `under` at `amount` (0–1), as hex. */
export function mixHex(top: string, under: string, amount: number): string {
  const a = parseCssColor(top);
  const b = parseCssColor(under);
  if (!a || !b) return top;
  return hex(over({ ...a, a: 1 }, b, amount));
}

const FALLBACK: Record<
  "light" | "dark",
  Omit<DiagramTheme, "scheme" | "fontFamily">
> = {
  light: {
    background: "#ffffff",
    ink: "#262626",
    secondary: "#6b6b6b",
    line: "#dbdbdb",
    lineStrong: "#c2c2c2",
    wash: "#f0f0f0",
    sunken: "#e3e3e3",
    accent: "#286486",
    accentInk: "#ffffff",
    waiting: "#b25000",
  },
  dark: {
    background: "#1e1e1e",
    ink: "#dadada",
    secondary: "#8f8f8f",
    line: "#3d3d3d",
    lineStrong: "#5a5a5a",
    wash: "#2b2b2b",
    sunken: "#1b1b1b",
    accent: "#82aeca",
    accentInk: "#12222c",
    waiting: "#ff9f0a",
  },
};

const TOKENS = {
  background: "--surface",
  ink: "--primary",
  secondary: "--secondary",
  line: "--line",
  lineStrong: "--line-strong",
  wash: "--wash",
  sunken: "--sunken",
  accent: "--accent",
  accentInk: "--accent-ink",
  waiting: "--waiting",
} as const;

/**
 * The theme as the page resolves it now. Each token is read as the computed
 * `color` of a probe in the document, so `light-dark()` and `color-mix()` are
 * the page's to resolve; a token that does not come back as a colour (a page
 * without the stylesheet, a test) is the fallback for the scheme.
 */
export function resolveDiagramTheme(view: Window = window): DiagramTheme {
  const scheme = documentColorScheme(view);
  const fallback = FALLBACK[scheme];
  const document = view.document;
  const probe = document.createElement("span");
  probe.style.display = "none";
  (document.body ?? document.documentElement).append(probe);
  try {
    const read = (token: string): Rgba | undefined => {
      probe.style.color = "";
      probe.style.color = `var(${token})`;
      return parseCssColor(view.getComputedStyle(probe).color);
    };
    const background =
      read(TOKENS.background) ?? parseCssColor(fallback.background)!;
    const opaque = { ...background, a: 1 };
    const entries = Object.entries(TOKENS).map(([key, token]) => {
      const name = key as keyof typeof TOKENS;
      const value = name === "background" ? opaque : read(token);
      return [name, value ? hex(over(value, opaque)) : fallback[name]] as const;
    });
    const fontFamily =
      view.getComputedStyle(document.documentElement).fontFamily ||
      "-apple-system, BlinkMacSystemFont, sans-serif";
    return {
      scheme,
      fontFamily,
      ...(Object.fromEntries(entries) as Record<keyof typeof TOKENS, string>),
    };
  } finally {
    probe.remove();
  }
}

/**
 * What the theme is right now, as a string that changes exactly when it can
 * have: the scheme, and the inline palette a Workbench's theme writes on the
 * root.
 */
function themeKey(): string {
  return `${documentColorScheme()}|${document.documentElement.getAttribute("style") ?? ""}`;
}

/** The diagram theme, followed: a new one whenever the page's theme changes. */
export function useDiagramTheme(): DiagramTheme {
  const key = useSyncExternalStore(
    (changed) => observeColorScheme(changed),
    themeKey,
    () => "light|",
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the theme
  return useMemo(() => resolveDiagramTheme(), [key]);
}
