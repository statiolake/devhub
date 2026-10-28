/**
 * Which fenced blocks of an answer are pictures, and how a picture is
 * prepared to be drawn.
 *
 * Two kinds: a ```mermaid block, drawn by Mermaid (`mermaid.ts`), and a
 * ```svg block — or an ```xml one whose whole content is one `<svg>` — drawn
 * as the image it is.
 *
 * What an Agent writes is not trusted, and neither is what Mermaid makes of
 * it. Both are drawn the same way: as an `<img>` of a `data:` URL, never as
 * markup in this document — and the PNG a copy makes is painted from the same
 * image. An SVG loaded as an image is in Chromium's secure static mode: no
 * script runs, no event handler fires, nothing outside it is fetched. The
 * image is the boundary, so the markup is not rewritten for safety here; it
 * is only checked to be one `<svg>`, given its namespace and a size, and told
 * what `currentColor` is.
 */

/** The kinds drawn as a picture by `Diagram.tsx`. */
export type DiagramKind = "mermaid" | "svg" | "vega-lite";

/** A source past these is drawn as its code, with a line saying why. */
export const MAX_MERMAID_SOURCE = 20_000;
export const MAX_SVG_SOURCE = 512 * 1024;
/** Mermaid's output, after drawing: past it the drawing is not kept. */
export const MAX_SVG_OUTPUT = 2 * 1024 * 1024;

const SVG_ROOT =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i;

/**
 * The kind of picture a fenced block is, from its info string and contents,
 * or `undefined` for code.
 */
export function diagramKindOf(
  info: string | undefined,
  code: string,
): DiagramKind | undefined {
  const word = info?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (word === "mermaid") return code.trim() === "" ? undefined : "mermaid";
  if (word === "svg" || word === "xml") {
    return SVG_ROOT.test(code) && /<\/svg>\s*$/i.test(code) ? "svg" : undefined;
  }
  return undefined;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export interface SvgSize {
  readonly width: number;
  readonly height: number;
}

export interface PreparedSvg {
  readonly svg: string;
  /** The size it is drawn at, in CSS pixels. */
  readonly size: SvgSize;
}

export type SvgResult =
  | ({ readonly ok: true } & PreparedSvg)
  | { readonly ok: false; readonly error: string };

export interface PrepareOptions {
  /**
   * Mermaid's output: the root's style — a `max-width` for a page — is not
   * kept.
   */
  readonly fromMermaid?: boolean;
  /**
   * The ink `currentColor` means in the picture, when the picture does not
   * say: an image does not inherit the page's colour.
   */
  readonly color?: string;
  readonly maxLength?: number;
}

/** The longest side a picture is drawn at; past it, it is scaled down. */
const MAX_SIDE = 4096;
const DEFAULT_SIZE: SvgSize = { width: 300, height: 150 };

function length(value: string | null): number | undefined {
  if (value === null) return undefined;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(value);
  if (!match) return undefined;
  const number = Number(match[1]);
  return number > 0 ? number : undefined;
}

function viewBoxOf(root: Element): SvgSize | undefined {
  const parts = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts?.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return undefined;
  }
  const [, , width, height] = parts as [number, number, number, number];
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * The size a picture says it is: its own `width` and `height` in pixels,
 * else its `viewBox` (Mermaid writes `width="100%"` and a `viewBox`), else
 * the size an image with neither is drawn at.
 */
export function svgSizeOf(root: Element): SvgSize {
  const box = viewBoxOf(root);
  let width = length(root.getAttribute("width"));
  let height = length(root.getAttribute("height"));
  if (width === undefined && height === undefined) {
    ({ width, height } = box ?? DEFAULT_SIZE);
  } else if (width === undefined) {
    width = box ? (height! * box.width) / box.height : DEFAULT_SIZE.width;
  } else if (height === undefined) {
    height = box ? (width * box.height) / box.width : DEFAULT_SIZE.height;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height!));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height! * scale)),
  };
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0]!.trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * `markup` with the SVG namespace on its root, which an `<svg>` written for
 * an HTML page leaves out and an image cannot do without.
 */
function withSvgNamespace(markup: string): string {
  const root = /<svg(?=[\s>/])([^>]*)>/i.exec(markup);
  if (root === null || /\sxmlns\s*=/.test(root[1]!)) return markup;
  const at = root.index + "<svg".length;
  return `${markup.slice(0, at)} xmlns="${SVG_NS}"${markup.slice(at)}`;
}

/**
 * `markup` as one `<svg>` ready to be drawn as an image, with the size it is
 * drawn at — or why it cannot be one.
 */
export function prepareSvg(
  markup: string,
  options: PrepareOptions = {},
): SvgResult {
  const max = options.maxLength ?? MAX_SVG_SOURCE;
  if (markup.length > max) {
    return {
      ok: false,
      error: `The SVG is too large to draw (${Math.round(markup.length / 1024)} KB).`,
    };
  }
  let document: Document;
  try {
    document = new DOMParser().parseFromString(
      withSvgNamespace(markup),
      "image/svg+xml",
    );
  } catch (error) {
    return {
      ok: false,
      error: `The SVG does not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const failure = document.getElementsByTagName("parsererror")[0];
  if (failure !== undefined) {
    return {
      ok: false,
      error: `The SVG does not parse: ${firstLine(failure.textContent ?? "") || "malformed XML"}`,
    };
  }
  const root = document.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== SVG_NS) {
    return {
      ok: false,
      error:
        root.localName === "svg"
          ? 'The SVG has no xmlns="http://www.w3.org/2000/svg".'
          : "The block is not one <svg>.",
    };
  }
  for (const node of [...document.childNodes]) {
    if (node !== root) node.remove();
  }
  const size = svgSizeOf(root);
  root.setAttribute("width", String(size.width));
  root.setAttribute("height", String(size.height));
  // Mermaid sizes its picture to its container (`max-width` in a style); an
  // image is its own container, at its own size.
  if (options.fromMermaid === true) root.removeAttribute("style");
  if (options.color !== undefined && !root.hasAttribute("color")) {
    root.setAttribute("color", options.color);
  }
  return {
    ok: true,
    svg: new XMLSerializer().serializeToString(root),
    size,
  };
}

/** A picture as a URL an `<img>` loads without fetching anything. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** What an error says, on one line, for the line under a source drawn instead. */
export function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // Mermaid's parse error is a heading, the line with a caret under it, and
  // what it expected: the heading and the expectation say it.
  const said =
    lines.length > 1 && lines[0]!.endsWith(":")
      ? `${lines[0]} ${lines.at(-1)}`
      : (lines[0] ?? "");
  return firstLine(said) || "Unknown error.";
}
