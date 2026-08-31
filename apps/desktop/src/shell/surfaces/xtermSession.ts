/**
 * One xterm.js setup, for every surface that shows a terminal.
 *
 * A terminal surface and an Agent surface differ in what they are attached to
 * and in nothing else: both draw a byte stream into an emulator that has to
 * look like the user's configured terminal, fit its host exactly, and say so
 * whenever the host changes size. Written twice, the two drifted — the Agent
 * side had no font stack, no line height, no theme and no fitted host, which
 * is precisely what a letter-spaced terminal in the top third of an empty pane
 * looks like.
 *
 * So the emulator, the fit, the appearance and the resize reporting live here,
 * and a surface supplies only what is genuinely its own: what to do with the
 * geometry, and whether it is currently on screen.
 */

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./xtermSession.css";
import { devhub } from "../client";
import {
  terminalFontStack,
  xtermTheme,
  type TerminalAppearance,
  type TerminalPalette,
} from "../terminal/theme";

export interface SurfaceGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

/**
 * What a host with no layout yet reports.
 *
 * A pane that has never been on screen, and jsdom, both measure as nothing.
 * Main validates whatever arrives, so the answer has to be a legal size rather
 * than an absent one.
 */
export const FALLBACK_GEOMETRY: SurfaceGeometry = {
  cols: 80,
  rows: 24,
  pixelWidth: 0,
  pixelHeight: 0,
};

/** The largest grid main will accept, and the largest one worth drawing. */
const MAX_AXIS = 500;

/**
 * Which of xterm's renderers is drawing.
 *
 * `"dom"` is not a configuration — it is what is left when the GPU one cannot
 * run, and it draws visibly worse (see `attachRenderer`), so a surface running
 * on it is running degraded and says so rather than looking merely blurry.
 */
export type SurfaceRenderer = "webgl" | "dom";

/**
 * Draw through the GPU renderer, and say whether that succeeded.
 *
 * xterm without a renderer addon falls back to its DOM renderer, which lays a
 * row out as runs of text in `<span>`s and stretches each run onto the cell
 * grid with a single `letter-spacing`. One spacing value can only fit a run
 * whose glyphs all have the same natural advance, and a Japanese line does
 * not: the punctuation comes from the chosen monospace face and the kana from
 * the CJK fallback behind it. Measured in Chromium at 13px, dpr 2, on
 * `、。「あ漢」ABCdef`, `。` and `」` drew 2.83 cells wide instead of 2 and
 * pushed everything after them 1.6 cells to the right — while the buffer had
 * every one of those cells at the correct width 2. The emulator's model was
 * right the whole time; only the drawing was wrong.
 *
 * That is impossible for the GPU renderer, which positions and clips every
 * cell on its own, and it also puts the grid on whole device pixels (a 7.5 css
 * px cell rather than the DOM renderer's measured 7.6136). So the DOM renderer
 * is the fallback, never the choice.
 *
 * What this does *not* change is how heavy the text looks: measured ink mass
 * moves by 0.6% between the two. That weight is decided by
 * `-webkit-font-smoothing`, which reaches the GPU atlas as surely as it reaches
 * the DOM renderer — the atlas rasterises its glyphs onto a scratch canvas it
 * appends into this very element. `xtermSession.css` is where that is settled,
 * once, for both renderers.
 */
function attachRenderer(
  terminal: Terminal,
  degraded: () => void,
): SurfaceRenderer {
  let addon: WebglAddon;
  try {
    addon = new WebglAddon();
    terminal.loadAddon(addon);
  } catch {
    // Not a swallow: a machine with no WebGL context to give has no GPU
    // renderer to attach, and the answer to "which renderer is drawing" is
    // the DOM one. The caller is told, and that is the whole recovery.
    return "dom";
  }
  // A context can be taken away later — a browser hands out a bounded number of
  // them, and a page with enough surfaces loses the oldest. A lost context
  // leaves the addon drawing nothing at all, so disposing it puts xterm back on
  // the DOM renderer: worse, but a picture. The surface is told, because a
  // `renderer` that still said "webgl" would be the same silent lie as having
  // never reported it.
  addon.onContextLoss(() => {
    addon.dispose();
    degraded();
  });
  return "webgl";
}

/**
 * What a hyperlink in a terminal does: it opens in the browser.
 *
 * xterm ships a default for OSC 8 links and it is wrong for a desktop app in
 * two ways at once. It asks "Do you want to navigate to {uri}? WARNING: This
 * link could potentially be dangerous" — a browser's question, in a browser's
 * `confirm()`, about a link the person just deliberately clicked — and then it
 * answers "yes" with `window.open()`. In a page inside Electron that mints a
 * window: DevHub's preload, DevHub's title, somebody else's document, and no
 * address bar, back button or reload to work it with. That is the small broken
 * DevHub window the click produced.
 *
 * Neither half is a decision a surface should be making, so neither half is
 * configurable: every terminal DevHub draws — a shell, an Agent — sends a link
 * to the system browser on a plain left click, with nothing in between. The
 * refusal path is the same as every other request to main: the rejection is
 * left unhandled on purpose so the page's root failure handler draws it, in
 * the one place the shell draws every other failure.
 *
 * `sendLinksToTheBrowser` in main is the backstop under this, for anything
 * that reaches `window.open` without coming through here.
 */
const linkHandler = {
  activate(_event: MouseEvent, uri: string): void {
    void devhub().openExternalUrl(uri);
  },
};

export interface XtermSessionOptions {
  readonly appearance?: TerminalAppearance;
  readonly palette?: TerminalPalette;
  /** For the hidden textarea xterm uses as its keyboard and IME responder. */
  readonly inputLabel: string;
  readonly describedBy?: string;
  readonly scrollback?: number;
  /** True while the surface is mounted but off screen. */
  isHidden(): boolean;
  /** The host changed size, at most once per frame. */
  onGeometry(geometry: SurfaceGeometry): void;
}

export interface XtermSession {
  readonly terminal: Terminal;
  /** Which renderer this surface got. `"dom"` means it is drawing degraded. */
  readonly renderer: SurfaceRenderer;
  /** The last measurement. Legal even before the host has ever had layout. */
  readonly geometry: SurfaceGeometry;
  /** Fit to the host now, and report the result unless the surface is hidden. */
  remeasure(): void;
  /** Adopt a changed configuration or system appearance, then refit. */
  applyAppearance(
    appearance: TerminalAppearance | undefined,
    palette: TerminalPalette | undefined,
  ): void;
  focus(): void;
  dispose(): void;
}

/**
 * Build a terminal in `host` and keep it fitted to it.
 *
 * Throws if the emulator cannot be constructed: there is no terminal to
 * recover into, and a surface that pretends to have one is worse than a
 * surface that says it has none.
 */
export function openXtermSession(
  host: HTMLElement,
  options: XtermSessionOptions,
): XtermSession {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: terminalFontStack(options.appearance?.terminalFontFamily),
    fontSize: options.appearance?.terminalFontSize ?? 13,
    linkHandler,
    lineHeight: options.appearance?.terminalLineHeight ?? 1.2,
    scrollback: options.scrollback ?? 10_000,
    theme: options.palette ? xtermTheme(options.palette) : undefined,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  // After `open`: the GPU renderer needs the element it will draw into.
  let renderer = attachRenderer(terminal, () => {
    renderer = "dom";
  });

  // xterm owns a hidden native textarea for keyboard and IME input. Keep that
  // responder discoverable to VoiceOver without adding a second visible
  // control or intercepting composition events in React.
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  if (input) {
    input.setAttribute("aria-label", options.inputLabel);
    if (options.describedBy !== undefined) {
      input.setAttribute("aria-describedby", options.describedBy);
    }
  }
  terminal.attachCustomKeyEventHandler(() => true);

  let geometry = FALLBACK_GEOMETRY;
  let pending: SurfaceGeometry | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const measure = (): SurfaceGeometry => {
    try {
      fit.fit();
      const dimensions = fit.proposeDimensions();
      if (dimensions && dimensions.cols > 0 && dimensions.rows > 0) {
        return {
          cols: Math.min(MAX_AXIS, Math.max(1, dimensions.cols)),
          rows: Math.min(MAX_AXIS, Math.max(1, dimensions.rows)),
          pixelWidth: 0,
          pixelHeight: 0,
        };
      }
    } catch {
      // Not a swallow: a host with no layout metrics has no size to report,
      // and the bounded fallback is that answer. The next resize corrects it.
    }
    return FALLBACK_GEOMETRY;
  };

  const remeasure = (): void => {
    if (disposed || options.isHidden()) return;
    geometry = measure();
    // A ResizeObserver delivers a burst while layout settles. Keep the latest
    // and report at most once per frame; main coalesces again as a backstop.
    pending = geometry;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const next = pending;
      pending = undefined;
      if (disposed || next === undefined) return;
      options.onGeometry(next);
    }, 16);
  };

  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          remeasure();
        });
  observer?.observe(host);
  // The first measurement is taken without reporting: the surface has not
  // attached to anything yet, and it is the attach request that carries it.
  geometry = options.isHidden() ? FALLBACK_GEOMETRY : measure();

  return {
    terminal,
    get renderer() {
      return renderer;
    },
    get geometry() {
      return geometry;
    },
    remeasure,
    applyAppearance(appearance, palette) {
      if (appearance) {
        terminal.options.fontFamily = terminalFontStack(
          appearance.terminalFontFamily,
        );
        terminal.options.fontSize = appearance.terminalFontSize;
        terminal.options.lineHeight = appearance.terminalLineHeight;
      }
      if (palette) terminal.options.theme = xtermTheme(palette);
      remeasure();
    },
    focus() {
      terminal.focus();
    },
    dispose() {
      disposed = true;
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      terminal.dispose();
    },
  };
}
