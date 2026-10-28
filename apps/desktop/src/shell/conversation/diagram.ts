/**
 * Which fenced blocks of an answer are pictures, and how a picture an Agent
 * wrote is made safe to show.
 *
 * Two kinds: a ```mermaid block, drawn by Mermaid (`mermaid.ts`), and a
 * ```svg block — or an ```xml one whose whole content is one `<svg>` — drawn
 * as the image it is.
 *
 * What an Agent writes is not trusted, and neither is what Mermaid makes of
 * it. Both are drawn the same way: as an `<img>` of a `data:` URL, never as
 * markup in this document. An SVG loaded as an image is in Chromium's secure
 * static mode — no script runs, no event handler fires, nothing outside it is
 * fetched — so the image is the boundary. `sanitizeSvg` is a second one,
 * because the same markup is also put on the clipboard ("Copy SVG") and
 * pasted into whatever the person pastes it into: scripts, event handlers,
 * animation (which can rewrite an `href`), embedded documents, and every
 * reference to anything outside the picture are taken out before the markup
 * is used at all. `foreignObject` is kept only in Mermaid's own output, which
 * DOMPurify has already cleaned under `securityLevel: "strict"`, and then only
 * with text-level HTML in it.
 */

export type DiagramKind = "mermaid" | "svg";

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
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** The SVG elements a picture may have. Anything else goes, with what is in it. */
const SVG_ELEMENTS = new Set(
  [
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "switch",
    "title",
    "desc",
    "style",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textPath",
    "image",
    "marker",
    "pattern",
    "clipPath",
    "mask",
    "linearGradient",
    "radialGradient",
    "stop",
    "filter",
    "feBlend",
    "feColorMatrix",
    "feComponentTransfer",
    "feComposite",
    "feConvolveMatrix",
    "feDiffuseLighting",
    "feDisplacementMap",
    "feDistantLight",
    "feDropShadow",
    "feFlood",
    "feFuncA",
    "feFuncB",
    "feFuncG",
    "feFuncR",
    "feGaussianBlur",
    "feMerge",
    "feMergeNode",
    "feMorphology",
    "feOffset",
    "fePointLight",
    "feSpecularLighting",
    "feSpotLight",
    "feTile",
    "feTurbulence",
  ].map((name) => name.toLowerCase()),
);

/** What may be inside one of Mermaid's `foreignObject` labels. */
const LABEL_ELEMENTS = new Set([
  "div",
  "span",
  "p",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "code",
  "sub",
  "sup",
  "u",
  "s",
]);

/** An `<a>` is inert in an image, and is drawn as the group it wraps. */
const UNWRAPPED = new Set(["a"]);

/** A raster image an `<image>` may carry inline. Nothing is fetched. */
const INLINE_IMAGE =
  /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;

/** A `url(…)` in a style or a presentation attribute that leaves the picture. */
const OUTSIDE_URL = /url\(\s*(?!['"]?\s*#)/i;
const IMPORT = /@import/i;

export interface SvgSize {
  readonly width: number;
  readonly height: number;
}

export interface SanitizedSvg {
  readonly svg: string;
  /** The size it is drawn at, in CSS pixels. */
  readonly size: SvgSize;
}

export type SvgResult =
  | ({ readonly ok: true } & SanitizedSvg)
  | { readonly ok: false; readonly error: string };

export interface SanitizeOptions {
  /**
   * Mermaid's output, never an Agent's SVG: its `foreignObject` labels are
   * kept, and the root's style — a `max-width` for a page — is not.
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

function isHref(attribute: Attr): boolean {
  return (
    attribute.localName === "href" &&
    (attribute.namespaceURI === null || attribute.namespaceURI === XLINK_NS)
  );
}

function cleanAttributes(element: Element, inLabel: boolean): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    const keep = (() => {
      if (name.startsWith("on")) return false;
      if (name === "xml:base" || attribute.localName === "base") return false;
      if (isHref(attribute)) {
        const target = value.trim();
        // Inside the picture: a `<use>`, a gradient's template, a text path.
        if (target.startsWith("#")) return true;
        return element.localName === "image" && INLINE_IMAGE.test(target);
      }
      if (inLabel && name !== "class" && name !== "style") return false;
      return !OUTSIDE_URL.test(value) && !IMPORT.test(value);
    })();
    if (!keep) element.removeAttributeNode(attribute);
  }
}

function clean(element: Element, options: SanitizeOptions, inLabel: boolean) {
  for (const child of [...element.childNodes]) {
    if (child.nodeType === 3 /* text */ || child.nodeType === 4 /* CDATA */) {
      if (
        element.localName === "style" &&
        (IMPORT.test(child.nodeValue ?? "") ||
          OUTSIDE_URL.test(child.nodeValue ?? ""))
      ) {
        child.remove();
      }
      continue;
    }
    if (child.nodeType !== 1 /* element */) {
      child.remove();
      continue;
    }
    const el = child as Element;
    const name = el.localName.toLowerCase();
    if (inLabel) {
      if (el.namespaceURI !== XHTML_NS || !LABEL_ELEMENTS.has(name)) {
        el.remove();
        continue;
      }
      cleanAttributes(el, true);
      clean(el, options, true);
      continue;
    }
    if (el.namespaceURI !== SVG_NS) {
      el.remove();
      continue;
    }
    if (name === "foreignobject") {
      if (options.fromMermaid !== true) {
        el.remove();
        continue;
      }
      cleanAttributes(el, false);
      clean(el, options, true);
      continue;
    }
    if (UNWRAPPED.has(name)) {
      clean(el, options, false);
      el.replaceWith(...el.childNodes);
      continue;
    }
    if (!SVG_ELEMENTS.has(name)) {
      el.remove();
      continue;
    }
    cleanAttributes(el, false);
    clean(el, options, false);
  }
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
 * `markup` as a picture that is safe to draw and to hand to another
 * application, with the size it is drawn at — or why it cannot be one.
 */
export function sanitizeSvg(
  markup: string,
  options: SanitizeOptions = {},
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
  cleanAttributes(root, false);
  clean(root, options, false);
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
