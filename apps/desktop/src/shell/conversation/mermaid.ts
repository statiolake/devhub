/**
 * Mermaid, drawn on demand.
 *
 * Nothing of Mermaid is in the page until the first ```mermaid block of a
 * session has closed: the library is its own chunk (and its diagram types
 * chunks of their own), imported here the first time a block asks, and kept.
 * A person who never sees a diagram never loads it, and the page's start is
 * not slowed by it.
 *
 * `securityLevel: "strict"`: Mermaid encodes the text it is given, runs its
 * output through DOMPurify and binds no click handlers. Labels are SVG text
 * (`htmlLabels: false`), so the picture needs no HTML to draw. What comes
 * back is drawn as an image (`diagramSvg.ts`), never put in the page as
 * markup.
 *
 * Mermaid's configuration is one global, so drawings are made one at a time,
 * each under the theme it asked for. A drawing is kept by its source and its
 * theme: the same block drawn again — the answer settling, the transcript
 * scrolled back — is the same promise.
 */

import type { Mermaid, MermaidConfig } from "mermaid";
import {
  MAX_MERMAID_SOURCE,
  MAX_SVG_OUTPUT,
  errorLine,
  prepareSvg,
  type SvgResult,
} from "./diagramSvg";
import { mixHex, type DiagramTheme } from "./diagramTheme";

let library: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  if (library === undefined) {
    library = import("mermaid").then((module) => module.default);
    // A chunk that would not load is not kept: the next block tries again.
    library.catch(() => {
      library = undefined;
    });
  }
  return library;
}

/** Mermaid's `base` theme, in DevHub's colours. */
export function mermaidConfig(theme: DiagramTheme): MermaidConfig {
  const node = mixHex(theme.accent, theme.background, 0.14);
  const nodeBorder = mixHex(theme.accent, theme.background, 0.6);
  const note = mixHex(theme.waiting, theme.background, 0.14);
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: MAX_MERMAID_SOURCE,
    maxEdges: 500,
    theme: "base",
    fontFamily: theme.fontFamily,
    themeVariables: {
      darkMode: theme.scheme === "dark",
      background: theme.background,
      fontFamily: theme.fontFamily,
      fontSize: "14px",
      primaryColor: node,
      primaryTextColor: theme.ink,
      primaryBorderColor: nodeBorder,
      secondaryColor: theme.wash,
      secondaryTextColor: theme.ink,
      secondaryBorderColor: theme.lineStrong,
      tertiaryColor: theme.sunken,
      tertiaryTextColor: theme.ink,
      tertiaryBorderColor: theme.line,
      lineColor: theme.secondary,
      textColor: theme.ink,
      titleColor: theme.ink,
      mainBkg: node,
      nodeBorder,
      nodeTextColor: theme.ink,
      clusterBkg: theme.wash,
      clusterBorder: theme.lineStrong,
      edgeLabelBackground: theme.background,
      noteBkgColor: note,
      noteTextColor: theme.ink,
      noteBorderColor: mixHex(theme.waiting, theme.background, 0.5),
      actorBkg: node,
      actorBorder: nodeBorder,
      actorTextColor: theme.ink,
      actorLineColor: theme.lineStrong,
      signalColor: theme.ink,
      signalTextColor: theme.ink,
      labelBoxBkgColor: node,
      labelBoxBorderColor: nodeBorder,
      labelTextColor: theme.ink,
      loopTextColor: theme.ink,
      activationBkgColor: theme.wash,
      activationBorderColor: theme.lineStrong,
      sequenceNumberColor: theme.accentInk,
    },
  };
}

let queue: Promise<unknown> = Promise.resolve();
let configured: string | undefined;
let drawn = 0;

const kept = new Map<string, Promise<SvgResult>>();
/** The same drawings, once they have arrived: what a block drawn again starts from. */
const arrived = new Map<string, SvgResult>();
const KEEP = 64;

function keyOf(source: string, theme: DiagramTheme): string {
  return `${JSON.stringify(theme)}\n${source}`;
}

/**
 * The drawing of `source` under `theme` if it has already been made, so a
 * block drawn again — the answer settling into one document — starts as the
 * picture rather than as its code for a frame.
 */
export function drawnMermaid(
  source: string,
  theme: DiagramTheme,
): SvgResult | undefined {
  return arrived.get(keyOf(source, theme));
}

async function draw(source: string, theme: DiagramTheme): Promise<SvgResult> {
  if (source.length > MAX_MERMAID_SOURCE) {
    return {
      ok: false,
      error: `The diagram is too large to draw (${source.length} characters).`,
    };
  }
  const mermaid = await loadMermaid();
  const config = mermaidConfig(theme);
  const key = JSON.stringify(config);
  if (configured !== key) {
    mermaid.initialize(config);
    configured = key;
  }
  const id = `devhub-mermaid-${++drawn}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return prepareSvg(svg, {
      fromMermaid: true,
      color: theme.ink,
      maxLength: MAX_SVG_OUTPUT,
    });
  } catch (error) {
    return { ok: false, error: errorLine(error) };
  } finally {
    // What Mermaid measured in, should it have left it.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/**
 * `source` drawn under `theme`: the picture, or the line that says
 * why there is none. Never rejects.
 */
export function renderMermaid(
  source: string,
  theme: DiagramTheme,
): Promise<SvgResult> {
  const key = keyOf(source, theme);
  const hit = kept.get(key);
  if (hit !== undefined) {
    kept.delete(key);
    kept.set(key, hit);
    return hit;
  }
  const result = queue.then(
    () => draw(source, theme),
    () => draw(source, theme),
  );
  const settled = result.catch(
    (error: unknown): SvgResult => ({ ok: false, error: errorLine(error) }),
  );
  queue = settled;
  kept.set(key, settled);
  if (kept.size > KEEP) {
    const oldest = kept.keys().next().value!;
    kept.delete(oldest);
    arrived.delete(oldest);
  }
  void settled.then((outcome) => {
    // A library that would not load is tried again for the next drawing.
    if (!outcome.ok && library === undefined) {
      kept.delete(key);
      return;
    }
    if (kept.has(key)) arrived.set(key, outcome);
  });
  return settled;
}
