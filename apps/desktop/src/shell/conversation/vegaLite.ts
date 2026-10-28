/**
 * A Vega-Lite chart, drawn on demand as an SVG.
 *
 * Vega-Lite was chosen for charts because a spec is declarative JSON — data,
 * marks, encodings — with no callback an Agent could write: what is drawn is
 * what the spec says, and a spec is short enough to write inline.
 *
 * Vega and Vega-Lite are not in the page until the first chart asks: they
 * are chunks of their own, imported the first time and kept. A chart is drawn
 * headless — compiled to Vega, run in a `View` that renders nothing, and
 * written out as SVG — and that SVG is drawn like every other picture, as an
 * `<img>` of a `data:` URL (`diagramSvg.ts`). Nothing of Vega's is ever in
 * the page's DOM, so there is no tooltip and no actions menu.
 *
 * What a spec may do is narrowed further: its expressions are interpreted
 * (`vega-interpreter`), never compiled into functions, and its loader loads
 * nothing — a `url` for data or an image is refused with a line saying the
 * data belongs in the spec (`values`).
 *
 * A chart is drawn in DevHub's colours (`vegaConfig`), and again when the
 * theme changes; a copy is drawn in `COPY_THEME`, like a diagram's. The
 * spec's own `config` wins over both.
 */

import {
  MAX_SVG_OUTPUT,
  errorLine,
  prepareSvg,
  type SvgResult,
} from "./diagramSvg";
import { mixHex, type DiagramTheme } from "./diagramTheme";

/** A spec past this many characters is drawn as its source, with why. */
export const MAX_VEGA_SOURCE = 512 * 1024;

interface VegaLibraries {
  readonly vega: typeof import("vega");
  readonly vegaLite: typeof import("vega-lite");
  readonly interpreter: typeof import("vega-interpreter");
}

let libraries: Promise<VegaLibraries> | undefined;

function loadVega(): Promise<VegaLibraries> {
  if (libraries === undefined) {
    libraries = Promise.all([
      import("vega"),
      import("vega-lite"),
      import("vega-interpreter"),
    ]).then(([vega, vegaLite, interpreter]) => ({
      vega,
      vegaLite,
      interpreter,
    }));
    libraries.catch(() => {
      libraries = undefined;
    });
  }
  return libraries;
}

export const NO_LOADING =
  "DevHub draws a chart from the data in its spec and loads nothing: put the data in `values`.";

/** A loader that loads nothing: no data, no image, no file. */
export const refusingLoader = {
  load: () => Promise.reject(new Error(NO_LOADING)),
  sanitize: () => Promise.reject(new Error(NO_LOADING)),
  http: () => Promise.reject(new Error(NO_LOADING)),
  file: () => Promise.reject(new Error(NO_LOADING)),
};

/** Vega-Lite's config, in DevHub's colours. */
export function vegaConfig(theme: DiagramTheme): Record<string, unknown> {
  const font = theme.fontFamily;
  const label = {
    labelColor: theme.secondary,
    titleColor: theme.ink,
    labelFont: font,
    titleFont: font,
  };
  return {
    background: "transparent",
    font,
    view: { stroke: null },
    axis: {
      ...label,
      domainColor: theme.lineStrong,
      tickColor: theme.lineStrong,
      gridColor: theme.line,
    },
    legend: label,
    header: label,
    title: { color: theme.ink, subtitleColor: theme.secondary, font },
    mark: { color: theme.accent },
    rule: { color: theme.secondary },
    text: { color: theme.ink },
    range: {
      // Calm, distinct hues that read on either ground.
      category: [
        theme.accent,
        mixHex("#e8833a", theme.background, 0.9),
        mixHex("#3aa676", theme.background, 0.9),
        mixHex("#c2569a", theme.background, 0.9),
        mixHex("#8a6fd1", theme.background, 0.9),
        mixHex("#d4b23f", theme.background, 0.9),
        mixHex("#4bb3c4", theme.background, 0.9),
        mixHex("#9a7b5f", theme.background, 0.9),
      ],
    },
  };
}

/** `source` as a Vega-Lite spec, or why it is not one. */
export function parseSpec(
  source: string,
):
  | { readonly ok: true; readonly spec: object }
  | { readonly ok: false; readonly error: string } {
  let spec: unknown;
  try {
    spec = JSON.parse(source);
  } catch (error) {
    return {
      ok: false,
      error: `The spec is not JSON: ${errorLine(error)}`,
    };
  }
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, error: "The spec is not a JSON object." };
  }
  return { ok: true, spec };
}

async function draw(source: string, theme: DiagramTheme): Promise<SvgResult> {
  if (source.length > MAX_VEGA_SOURCE) {
    return {
      ok: false,
      error: `The chart is too large to draw (${Math.round(source.length / 1024)} KB).`,
    };
  }
  const parsed = parseSpec(source);
  if (!parsed.ok) return parsed;
  const { vega, vegaLite, interpreter } = await loadVega();
  let view: InstanceType<typeof vega.View> | undefined;
  try {
    const compiled = vegaLite.compile(parsed.spec as never, {
      config: vegaConfig(theme) as never,
    }).spec;
    const runtime = vega.parse(compiled, undefined, { ast: true });
    // Vega reports a load that failed to its logger and draws on without
    // the data; here it is the reason there is no chart.
    const errors: unknown[] = [];
    const logger = {
      level: () => logger,
      error: (...args: unknown[]) => {
        errors.push(args.at(-1));
        return logger;
      },
      warn: (...args: unknown[]) => {
        if (
          typeof args[0] === "string" &&
          /(?:Loading|Data ingestion) failed/u.test(args[0])
        )
          errors.push(args.at(-1));
        return logger;
      },
      info: () => logger,
      debug: () => logger,
    };
    view = new vega.View(runtime, {
      renderer: "none",
      loader: refusingLoader as never,
      expr: interpreter.expressionInterpreter,
      logger: logger as never,
    });
    await view.runAsync();
    if (errors.length > 0) return { ok: false, error: errorLine(errors[0]) };
    const svg = await view.toSVG();
    return prepareSvg(svg, { color: theme.ink, maxLength: MAX_SVG_OUTPUT });
  } catch (error) {
    return { ok: false, error: errorLine(error) };
  } finally {
    view?.finalize();
  }
}

const kept = new Map<string, Promise<SvgResult>>();
const arrived = new Map<string, SvgResult>();
const KEEP = 64;

function keyOf(source: string, theme: DiagramTheme): string {
  return `${JSON.stringify(theme)}\n${source}`;
}

/** The chart already drawn under `theme`, so a block drawn again starts as it. */
export function drawnVegaLite(
  source: string,
  theme: DiagramTheme,
): SvgResult | undefined {
  return arrived.get(keyOf(source, theme));
}

/** `source` drawn under `theme`, or the line that says why not. Never rejects. */
export function renderVegaLite(
  source: string,
  theme: DiagramTheme,
): Promise<SvgResult> {
  const key = keyOf(source, theme);
  const hit = kept.get(key);
  if (hit !== undefined) return hit;
  const result = draw(source, theme).catch(
    (error: unknown): SvgResult => ({ ok: false, error: errorLine(error) }),
  );
  kept.set(key, result);
  if (kept.size > KEEP) {
    const oldest = kept.keys().next().value!;
    kept.delete(oldest);
    arrived.delete(oldest);
  }
  void result.then((outcome) => {
    if (!outcome.ok && libraries === undefined) {
      kept.delete(key);
      return;
    }
    if (kept.has(key)) arrived.set(key, outcome);
  });
  return result;
}
