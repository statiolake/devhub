/**
 * A Marp deck, drawn on demand as one picture a slide.
 *
 * Marp Core is not in the page until the first deck of a session asks for it:
 * it is its own chunk, imported the first time and kept, the way Mermaid is
 * (`mermaid.ts`). Only its lightweight core is used — no math, no syntax
 * colouring, no Mermaid inside a slide — so that chunk stays small.
 *
 * Marp turns Markdown into HTML and CSS, and neither is trusted: the Markdown
 * was written by an Agent, and a theme may ask for fonts from the network.
 * Neither ever becomes markup in this page. Marp runs with `html: false` (raw
 * HTML in the deck is text), no script of its own, emoji as the characters
 * they are rather than images fetched from a CDN, and the CSS loses its
 * `@import`s. Each slide is then wrapped, with the deck's CSS, in a
 * standalone SVG drawn as an `<img>` of a `data:` URL (`slideSvg`) — where,
 * as for a diagram, no script runs and nothing is fetched, so an image in a
 * slide that points at the network is simply not drawn. The PDF is printed
 * by main, from the same markup, in a window that runs no script and loads
 * nothing (`main/shell/slideExport.ts`).
 */

import type { SvgSize } from "./diagramSvg";
import { errorLine } from "./diagramSvg";

/** A deck past this many characters is drawn as its source, with why. */
export const MAX_MARP_SOURCE = 200_000;

export interface MarpDeck {
  /** Each slide, as one standalone SVG to draw as an image. */
  readonly slides: readonly string[];
  /** A slide's size in CSS pixels: 1280×720 unless the deck says `size:`. */
  readonly size: SvgSize;
  /** The deck as one document, a slide a page, for `saveSlidesPdf`. */
  readonly printHtml: string;
}

export type MarpResult =
  | { readonly ok: true; readonly deck: MarpDeck }
  | { readonly ok: false; readonly error: string };

/** The options Marp renders with: no HTML, no script, nothing fetched. */
export const MARP_OPTIONS = {
  html: false,
  script: false,
  emoji: { shortcode: true, unicode: false },
  minifyCSS: true,
  inlineSVG: true,
} as const;

type MarpModule = typeof import("@marp-team/marp-core");

let library: Promise<MarpModule> | undefined;

function loadMarp(): Promise<MarpModule> {
  if (library === undefined) {
    library = import("@marp-team/marp-core");
    // A chunk that would not load is not kept: the next deck tries again.
    library.catch(() => {
      library = undefined;
    });
  }
  return library;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** `css` without the rules that would fetch: `@import` of a theme's fonts. */
export function offlineCss(css: string): string {
  return css.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/giu, "");
}

function sizeOf(slide: Element): SvgSize {
  const parts = slide
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (parts?.length === 4 && parts[2]! > 0 && parts[3]! > 0) {
    return { width: parts[2]!, height: parts[3]! };
  }
  return { width: 1280, height: 720 };
}

/**
 * One slide of Marp's inline-SVG output as a picture of its own: the deck's
 * container (`div.marpit`, which every rule of its CSS is scoped to) holding
 * the CSS and that one slide, inside an SVG of the slide's size.
 */
export function slideSvg(slide: Element, css: string, size: SvgSize): string {
  const document = slide.ownerDocument;
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("width", String(size.width));
  root.setAttribute("height", String(size.height));
  root.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  const object = document.createElementNS(SVG_NS, "foreignObject");
  object.setAttribute("width", String(size.width));
  object.setAttribute("height", String(size.height));
  const container = document.createElementNS(XHTML_NS, "div");
  container.setAttribute("class", "marpit");
  const style = document.createElementNS(XHTML_NS, "style");
  style.textContent = css;
  container.append(style, slide.cloneNode(true));
  object.append(container);
  root.append(object);
  return new XMLSerializer().serializeToString(root);
}

/** The deck as one document to print, a slide a page of the slide's size. */
export function printHtmlOf(html: string, css: string, size: SvgSize): string {
  const page = `${size.width}px ${size.height}px`;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<style>@page{size:${page};margin:0}html,body{margin:0;padding:0;background:transparent}`,
    `div.marpit>svg[data-marpit-svg]{display:block;width:${size.width}px;height:${size.height}px;break-after:page}`,
    "div.marpit>svg[data-marpit-svg]:last-child{break-after:auto}</style>",
    `<style>${css.replace(/<\/style/giu, "<\\/style")}</style>`,
    `</head><body>${html}</body></html>`,
  ].join("");
}

/** What Marp made of a deck, as slides: the step after rendering, testable alone. */
export function deckOf(html: string, rawCss: string): MarpResult {
  const css = offlineCss(rawCss);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const slides = [
    ...parsed.querySelectorAll("div.marpit > svg[data-marpit-svg]"),
  ];
  if (slides.length === 0) {
    return { ok: false, error: "The deck has no slides." };
  }
  const size = sizeOf(slides[0]!);
  return {
    ok: true,
    deck: {
      slides: slides.map((slide) => slideSvg(slide, css, sizeOf(slide))),
      size,
      printHtml: printHtmlOf(html, css, size),
    },
  };
}

const kept = new Map<string, Promise<MarpResult>>();
const KEEP = 16;

async function draw(source: string): Promise<MarpResult> {
  if (source.length > MAX_MARP_SOURCE) {
    return {
      ok: false,
      error: `The deck is too large to draw (${source.length} characters).`,
    };
  }
  const { Marp } = await loadMarp();
  try {
    const { html, css } = new Marp(MARP_OPTIONS).render(source);
    return deckOf(html, css);
  } catch (error) {
    return { ok: false, error: errorLine(error) };
  }
}

/** `source` drawn as slides, or the line that says why not. Never rejects. */
export function renderMarp(source: string): Promise<MarpResult> {
  const hit = kept.get(source);
  if (hit !== undefined) return hit;
  const result = draw(source).catch(
    (error: unknown): MarpResult => ({ ok: false, error: errorLine(error) }),
  );
  kept.set(source, result);
  if (kept.size > KEEP) kept.delete(kept.keys().next().value!);
  void result.then((outcome) => {
    // A library that would not load is tried again for the next deck.
    if (!outcome.ok && library === undefined) kept.delete(source);
  });
  return result;
}

/** The same deck, if it has already been drawn: what a block drawn again starts from. */
const arrived = new Map<string, MarpResult>();

export function drawnMarp(source: string): MarpResult | undefined {
  return arrived.get(source);
}

export function rememberMarp(source: string, result: MarpResult): void {
  arrived.set(source, result);
  if (arrived.size > KEEP) arrived.delete(arrived.keys().next().value!);
}
