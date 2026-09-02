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
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./xtermSession.css";
import { devhub } from "../client";
import { editingSequence } from "./keys";
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

/** Two measurements of the same host that mean the same thing. */
function sameGeometry(a: SurfaceGeometry, b: SurfaceGeometry): boolean {
  return (
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.pixelWidth === b.pixelWidth &&
    a.pixelHeight === b.pixelHeight
  );
}

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
  /** Adopt a changed configuration — fonts and metrics — then refit. */
  applyAppearance(appearance: TerminalAppearance | undefined): void;
  /**
   * Adopt the colours in force now: a configured palette, or the ground the
   * pane is painted when there is none.
   *
   * Called for a changed palette *and* for a changed scheme, because with no
   * configured theme the palette stays undefined while the colours move.
   */
  applyTheme(palette: TerminalPalette | undefined): void;
  focus(): void;
  dispose(): void;
}

/**
 * The colours to hand xterm, from whichever source is actually in force.
 *
 * A configured palette is the answer when there is one. When there is not,
 * the pane is still painted — `--terminal-background` falls back to the app's
 * own `--surface`, which follows the scheme — and xterm has to be told what
 * that colour is rather than left on its built-in black.
 *
 * This is not only about how it looks. A program in the pane asks what it is
 * drawing on with OSC 11, and xterm answers from this theme; tmux forwards the
 * question out to DevHub and relays the answer back in, so the reply is what a
 * TUI uses to decide whether it is on a light or a dark terminal. Left
 * untold, xterm reported black on a light pane and Claude Code chose its dark
 * colours for a white background. The colour it names has to be the colour it
 * paints, so both are read from the one place that decides it.
 */
function themeInForce(
  host: HTMLElement,
  palette: TerminalPalette | undefined,
): ITheme {
  if (palette) return xtermTheme(palette);
  const painted = getComputedStyle(host);
  // A window that has never had layout can answer with the empty string;
  // xterm keeps its own default for a colour it is not given, which is the
  // same place it would have been without this.
  const background = painted.backgroundColor;
  const foreground = painted.color;
  return {
    ...(background ? { background } : {}),
    ...(foreground ? { foreground } : {}),
  };
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
    theme: themeInForce(host, options.palette),
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
  /**
   * Give xterm a theme only when the colours have actually changed.
   *
   * `options.theme` takes an object, and xterm cannot tell two equal ones
   * apart: assigning it rebuilds the colour set and repaints the screen, cursor
   * included, every single time. Measured against a real emulator, an
   * assignment of an identical theme costs a repaint while assigning an
   * unchanged `fontSize`, an unchanged `fontFamily`, a `fit()` that does not
   * change the grid, and a `focus()` all cost nothing — xterm compares those by
   * value and does nothing.
   *
   * A repaint under a cursor that has been told not to blink looks exactly like
   * a cursor that blinked, which is why an idempotent call has to actually be
   * idempotent here rather than merely harmless.
   */
  let appliedTheme = JSON.stringify(themeInForce(host, options.palette));
  const setTheme = (next: ITheme): void => {
    const serialised = JSON.stringify(next);
    if (serialised === appliedTheme) return;
    appliedTheme = serialised;
    terminal.options.theme = next;
  };

  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  if (input) {
    input.setAttribute("aria-label", options.inputLabel);
    if (options.describedBy !== undefined) {
      input.setAttribute("aria-describedby", options.describedBy);
    }
  }

  /**
   * Leave nothing in the IME's scratch pad once it has been read.
   *
   * That textarea is where the IME assembles a composition, and xterm decides
   * what to send from *where the caret is in it*: at `compositionstart` it
   * records the length of the value, and when the composition finishes it
   * sends everything from that offset on. The assumption is that a composition
   * is appended to the end — true only while nothing else moves the caret.
   *
   * Nothing stopped that. xterm sends what a composition produced but does not
   * empty the textarea, so the text of the last Japanese input stayed in it,
   * and Cmd+Left is a key xterm has no binding for: it is not turned into
   * terminal input and its default action is not prevented, so the browser
   * did what it does to a focused textarea and moved the caret to the front.
   * The next composition was then inserted at the front, and the offset — the
   * length of what was left behind — sliced from the wrong place. Typing あ
   * after 日本語 sent 語: the tail of the previous input, one character for one
   * character, which is exactly what the pane appeared to garble.
   *
   * Clearing it is the general repair rather than a rule about one key. The
   * scratch pad holds nothing between compositions, so no caret position in it
   * is meaningful and no later gesture — Cmd+Left, Cmd+A, any of their
   * siblings — has stale text to make xterm slice from. The clear is deferred
   * so it lands after xterm's own deferred read of the value, and it is
   * skipped while a composition is in flight, which is the one time the
   * content is still being used.
   */
  let composing = false;
  const clearWhenIdle = (): void => {
    setTimeout(() => {
      if (composing || disposed || !input) return;
      input.value = "";
      input.selectionStart = 0;
      input.selectionEnd = 0;
    }, 0);
  };
  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    clearWhenIdle();
  };
  const onInput = (): void => {
    if (composing) return;
    clearWhenIdle();
  };
  input?.addEventListener("compositionstart", onCompositionStart);
  input?.addEventListener("compositionend", onCompositionEnd);
  input?.addEventListener("input", onInput);
  /**
   * Answer the Mac editing chords the way Ghostty does; leave everything else.
   *
   * The handler used to say yes to every key, and xterm's own encoder bails out
   * of its arrow cases the moment Command is held. So Cmd+Left was neither
   * turned into terminal input nor stopped, and the browser did what it does to
   * a focused textarea: it moved a caret in xterm's hidden IME scratch pad.
   * Now the byte Ghostty's own keybind would have sent goes to the pane, and
   * the browser never sees the key at all.
   *
   * Returning false is what tells xterm to keep its hands off a key this has
   * already dealt with — including Option with an arrow, which xterm would
   * otherwise encode as `CSI 1;3D` rather than the byte Ghostty binds it to.
   * Everything else still returns true, so Cmd+C, Cmd+V and the rest reach the
   * browser and DevHub's menus exactly as before.
   */
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const sequence = editingSequence(event);
    if (sequence === undefined) return true;
    event.preventDefault();
    terminal.input(sequence, true);
    return false;
  });

  let geometry = FALLBACK_GEOMETRY;
  let pending: SurfaceGeometry | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /**
   * The last geometry this session actually told the surface about.
   *
   * `onGeometry` means "the host changed size", so it has to be said only when
   * the host has. Several things ask for a measurement that turns out to be the
   * same one — mounting takes it once for the attach request and the surface
   * asks again the moment it is on screen; a ResizeObserver fires for a layout
   * pass that moved nothing; an appearance change refits to the identical grid.
   * Each of those used to become a resize request for a size the other end
   * already had. Redundant traffic is the mild half of that. The sharp half is
   * that it arrives on a timer, so whether a surface has sent one resize or two
   * depends on when the clock lands, which is a test that fails once in three
   * runs and a bug you cannot reproduce.
   */
  let reported: SurfaceGeometry | undefined;

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
      // Decided here rather than at each `remeasure`, so a burst that ends
      // where it started — A to B and back to A within one frame — says
      // nothing, instead of announcing the B nobody ever saw.
      if (reported && sameGeometry(next, reported)) return;
      reported = next;
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
  // attached to anything yet, and it is the attach request that carries it. It
  // still counts as said — the other end has it — so it is what a later
  // measurement is compared against.
  geometry = options.isHidden() ? FALLBACK_GEOMETRY : measure();
  reported = geometry;

  return {
    terminal,
    get renderer() {
      return renderer;
    },
    get geometry() {
      return geometry;
    },
    remeasure,
    applyAppearance(appearance) {
      if (appearance) {
        terminal.options.fontFamily = terminalFontStack(
          appearance.terminalFontFamily,
        );
        terminal.options.fontSize = appearance.terminalFontSize;
        terminal.options.lineHeight = appearance.terminalLineHeight;
      }
      remeasure();
    },
    applyTheme(palette) {
      setTheme(themeInForce(host, palette));
      remeasure();
    },
    focus() {
      terminal.focus();
    },
    dispose() {
      disposed = true;
      input?.removeEventListener("compositionstart", onCompositionStart);
      input?.removeEventListener("compositionend", onCompositionEnd);
      input?.removeEventListener("input", onInput);
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      terminal.dispose();
    },
  };
}
