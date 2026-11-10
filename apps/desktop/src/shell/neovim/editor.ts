/**
 * One Workspace's Neovim, drawn: the reducer, the painter, the cursor, and
 * every way the person reaches Neovim — keys, text and IME, the pointer,
 * the size of the view.
 *
 * Imperative, because a grid repaint per keystroke is no place for a React
 * render. The widgets Neovim hands the GUI (popupmenu, command line, tab
 * line, GUI windows) are React's (`NeovimApp.tsx`), told when they changed
 * through `subscribe`.
 */

import {
  applyRedraw,
  claimFloats,
  currentModeInfo,
  emptyChanges,
  gridRowText,
  initialUiState,
  layoutGrids,
  msgText,
  placeUnplacedWindows,
  type GridBox,
  type MessageEvent,
  type NeovimUiState,
  type RedrawChanges,
} from "./redraw";
import { clearCursorRow, clearEdges } from "./floats";
import {
  GridPainter,
  type Reach,
  ICON_FAMILY,
  cssColor,
  floatLook,
  fontOf,
  rgbOfCss,
  resolveColors,
  type FontSpec,
  type OverPart,
} from "./painter";
import { neovimCellFont } from "./cellFont";
import { escapeInputText, keyToNeovim } from "./keys";
import { floatLabelsOf } from "./frame";
import {
  THEME_GROUPS,
  THEME_LUA,
  themeOf,
  type PaintTheme,
  type Surface,
} from "./chrome";
import { cmdlineLayout, cmdlineLead, wrappedRows } from "./cmdline";
import type { Decor } from "./decor";
import { cmdlinePlace, type CmdlinePlace } from "./place";
import { SCROLL_LUA, replied, type ScrollRequest } from "./smoothScroll";
import { rideAnchor, rideArea, rideStyle, type BufposAnchor } from "./riders";
import { PaintHold } from "./paintHold";
import { LabelAsks } from "./labelAsks";

import {
  IDLE,
  imeStep,
  preeditLayout,
  type ImeEvent,
  type ImeState,
} from "./ime";
import {
  WheelAccumulator,
  gridSizeFor,
  hitTest,
  mouseButton,
  mouseModifiers,
  sashAt,
  type MouseTarget,
  type Sash,
  GUI_OWNED,
} from "./mouse";
import { MetaComposition, OptionKeys } from "../surfaces/optionKey";
import { BaseKeys, layoutMapSource } from "../surfaces/baseKeys";
import type { MacOptionIsMeta } from "../../model/macOption";
import { WindowMotion } from "./windowMotion";
import type { Footer, Statusline } from "./statusline";
import {
  glideFrames,
  inkPlace,
  inkSpan,
  slideSpan,
  type CellSpan,
} from "./cursorInk";

/** DevHub's theme, for a Neovim that sets no colours of its own. */
function themeColors(): {
  foreground: number;
  background: number;
  special: number;
} {
  const style = getComputedStyle(document.documentElement);
  const fg = rgbOfCss(style.getPropertyValue("--primary")) ?? 0xd4d4d4;
  const bg = rgbOfCss(style.getPropertyValue("--surface")) ?? 0x1e1e1e;
  const sp = rgbOfCss(style.getPropertyValue("--danger")) ?? 0xf14c4c;
  return { foreground: fg, background: bg, special: sp };
}

/** What the editor needs from the page: Neovim API calls. */
export interface NeovimPort {
  call(method: string, params: readonly unknown[]): void;
  /** A call whose answer is wanted; rejects when Neovim answers an error. */
  request?(method: string, params: readonly unknown[]): Promise<unknown>;
}

export interface EditorSettings {
  /**
   * The terminal panes' font (`cellFont.ts`), used unless `guifont` or
   * `linespace` say otherwise.
   */
  readonly font: FontSpec;
  readonly macOptionIsMeta: MacOptionIsMeta;
}

/** How long the cursor's blink takes to fade out or in. */
const BLINK_FADE_MS = 120;
/** A cursor's glide from cell to cell (`glideCursor`). */
const CURSOR_GLIDE_MS = 70;

/**
 * The stacking order of ambient status (notifications) among the grids':
 * a float's is 100 + its zindex and a window's 1, so this is a float at
 * zindex 45 — fidget's — over every window and under every float at
 * Neovim's default zindex (50) or above: a picker, a hover, a plugin's
 * window covers a notification, never the other way round.
 */
export const AMBIENT_Z = 100 + 45;

export class NeovimEditor {
  readonly state: NeovimUiState = initialUiState(themeColors());
  private pending: RedrawChanges = emptyChanges();
  private frame = 0;
  private readonly painter: GridPainter;
  /** The windows moving as their layout changes (docs/pane-motion.md). */
  private readonly windowMotion: WindowMotion;
  private readonly gridLayer: HTMLDivElement;
  private readonly band: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  /** Where the cursor was last placed, shown (`glideCursor`). */
  private cursorAt: { x: number; y: number } | undefined;
  /** Its glide under way, if any. */
  private cursorGlide: Animation | undefined;
  /**
   * The text under the cursor, in its colours (`cursorInk.ts`): the
   * grid's cells near it painted again, placed on the text inside the
   * cursor and cut by its shape. The cursor holds nothing else.
   */
  private readonly ink: HTMLDivElement;
  private readonly inkCanvas: HTMLCanvasElement;
  /** The ink's counter-glide, with the cursor's (`glideFrames`). */
  private inkGlide: Animation | undefined;
  /** Where the cursor was seen as its glide began, while it glides. */
  private glideFrom: { x: number; y: number } | undefined;
  /** The ink of lines sliding under the cursor (`GridPainter.slideOf`). */
  private inkSlide:
    | {
        readonly clip: HTMLDivElement;
        readonly canvas: HTMLCanvasElement;
        readonly animation: Animation;
        readonly of: Animation;
      }
    | undefined;
  private readonly preedit: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  private ime: ImeState = IDLE;
  private readonly optionKeys = new OptionKeys();
  private readonly wheel = new WheelAccumulator();
  private settings: EditorSettings;
  private size = { cols: 0, rows: 0 };
  private boxes: GridBox[] = [];
  /**
   * Floats anchored in a window, by window: where in the buffer, when at a
   * buffer position (`false`: not, or not known yet).
   */
  private readonly anchorsAsked = new Map<number, BufposAnchor | false>();
  /** The labels asked for floats whose border holds text (`LabelAsks`). */
  private readonly labelAsks = new LabelAsks();
  /** A paint waits for a new float's labels: whether it was a full one. */
  private labelsPaint: { force: boolean } | undefined;
  private readonly listeners = new Set<() => void>();
  private dragging: { button: string; target: MouseTarget } | undefined;
  /** A Meta dead key's composition, dropped (`surfaces/optionKey.ts`). */
  private readonly metaComposition = new MetaComposition();
  /** What each physical key types without Option, for Meta chords. */
  private readonly baseKeys = new BaseKeys();
  private readonly observer: ResizeObserver;
  private disposed = false;
  /**
   * The window border under the pointer that a drag resizes (Neovim does,
   * `sashAt`): the pointer says so; kept while dragged.
   */
  private sashOn: Sash | undefined;
  private sashDragged = false;
  /** A pending ask for the colorscheme's groups (`askTheme`). */
  private themeTimer = 0;
  private blink: Animation | undefined;
  /** The frame that moves windows scrolling in pixels (`smoothScroll.ts`). */
  private scrollTick = 0;
  /** Where the last wheel event was, for a request Neovim's wheel answers. */
  private wheelAt: MouseTarget | undefined;
  private blinkKey = "";
  private stopWatchingDpr: () => void = () => {};
  private stopWatchingFonts: () => void = () => {};
  private stopWatchingViewFocus: () => void = () => {};
  /** What Neovim was last told of the focus (`nvim_ui_set_focus`). */
  private toldFocus: boolean | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly port: NeovimPort,
    settings: EditorSettings,
  ) {
    this.settings = settings;
    this.gridLayer = document.createElement("div");
    this.gridLayer.className = "nvim-grids";
    this.cursor = document.createElement("div");
    this.cursor.className = "nvim-cursor";
    this.ink = document.createElement("div");
    this.ink.className = "nvim-cursor-ink";
    this.inkCanvas = document.createElement("canvas");
    this.ink.append(this.inkCanvas);
    this.cursor.append(this.ink);
    this.preedit = document.createElement("canvas");
    this.preedit.className = "nvim-preedit";
    this.input = document.createElement("textarea");
    this.input.className = "nvim-input";
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.spellcheck = false;
    // One line, in the grid's font: the caret the IME's candidate window
    // follows then sits at the end of the preedit, as the overlay draws it.
    this.input.setAttribute("wrap", "off");
    this.input.setAttribute("aria-label", "Neovim");
    this.gridLayer.append(this.cursor, this.input);
    // The editor's band holds the grids and what the page lays over them;
    // the preedit is a band of its own over DevHub's command line
    // (`neovim.css`, the bands).
    this.band = document.createElement("div");
    this.band.className = "nvim-editor";
    this.band.append(this.gridLayer);
    host.append(this.band, this.preedit);
    this.painter = new GridPainter(this.gridLayer, this.fontSpec());
    this.windowMotion = new WindowMotion(this.painter, this.gridLayer);
    this.gridLayer.style.font = fontOf(this.painter.fontSpec());
    this.input.style.font = this.gridLayer.style.font;
    this.bindInput();
    this.observer = new ResizeObserver(() => {
      this.resize();
    });
    this.observer.observe(host);
    this.watchDevicePixelRatio();
    this.watchFonts();
    this.watchViewFocus();
  }

  /**
   * The element ambient status is drawn in (the notifications, `Toasts`):
   * a level of the editor's band at `AMBIENT_Z`, over the windows and under
   * the floats — what the person is working in covers it, as fidget's own
   * window (zindex 45) is under a picker's (docs/rendering-layers.md,
   * "Bands").
   */
  ambient(): HTMLElement {
    if (!this.ambientLevel) {
      const el = document.createElement("div");
      el.className = "nvim-level nvim-ambient";
      el.style.zIndex = String(AMBIENT_Z);
      el.dataset.z = String(AMBIENT_Z);
      this.gridLayer.append(el);
      this.ambientLevel = el;
    }
    return this.ambientLevel;
  }

  private ambientLevel: HTMLDivElement | undefined;

  /**
   * Where what the page lays over `grid` as `part` goes (`GridPainter.over`):
   * in the editor's band, in the grid's own clip, at the grid's stacking
   * order.
   */
  over(grid: number, part: OverPart): HTMLElement {
    return this.painter.over(grid, part);
  }

  /**
   * Whether the keyboard is Neovim's: the page's textarea focused *and* the
   * page's view the one DevHub gave the keyboard to. Each DevHub view is
   * its own page, and a page keeps its focused element while another view
   * (the Sidebar, an Agent, a terminal) has the keys — only
   * `document.hasFocus()` says it has gone (`docs/window-and-pages.md`, The
   * keyboard).
   */
  hasKeyboard(): boolean {
    return document.activeElement === this.input && document.hasFocus();
  }

  /**
   * The view gaining or losing the keyboard: the cursor turns hollow or
   * solid again and Neovim hears of it (FocusLost/FocusGained), as when
   * the textarea itself is blurred.
   */
  private watchViewFocus(): void {
    const changed = () => {
      if (this.disposed) return;
      this.syncFocus();
    };
    window.addEventListener("focus", changed);
    window.addEventListener("blur", changed);
    this.stopWatchingViewFocus = () => {
      window.removeEventListener("focus", changed);
      window.removeEventListener("blur", changed);
    };
  }

  /** The cursor and Neovim's focus, in line with `hasKeyboard`. */
  private syncFocus(): void {
    const focused = this.hasKeyboard();
    if (focused !== this.toldFocus) {
      this.toldFocus = focused;
      this.port.call("nvim_ui_set_focus", [focused]);
    }
    this.placeCursor();
    for (const listener of this.listeners) listener();
  }

  /**
   * The bundled icon font is fetched on first use, so a canvas that drew an
   * icon before it arrived drew a fallback's box: it is asked for at once,
   * and every grid is drawn again when it (or any font) has loaded.
   */
  private watchFonts(): void {
    const fonts = (document as { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const loaded = () => {
      if (this.disposed) return;
      this.painter.fontsLoaded();
      this.paint(true);
    };
    fonts.addEventListener("loadingdone", loaded);
    this.stopWatchingFonts = () => {
      fonts.removeEventListener("loadingdone", loaded);
    };
    fonts.load(`12px ${ICON_FAMILY}`, "\uf015").then(loaded, () => {});
  }

  /** A move to a screen of another density re-measures and redraws. */
  private watchDevicePixelRatio(): void {
    const query = matchMedia(
      `(resolution: ${String(window.devicePixelRatio || 1)}dppx)`,
    );
    const changed = () => {
      if (this.disposed) return;
      if (this.painter.syncDevicePixelRatio()) {
        this.paint(true);
        this.resize();
      }
      this.watchDevicePixelRatio();
    };
    query.addEventListener("change", changed, { once: true });
    this.stopWatchingDpr = () => {
      query.removeEventListener("change", changed);
    };
  }

  /** The grid size that fits the view now, for the attach. */
  fit(): { cols: number; rows: number } {
    const rect = this.host.getBoundingClientRect();
    return gridSizeFor(rect.width, rect.height, this.painter.cell());
  }

  attached(size: { cols: number; rows: number }): void {
    this.size = size;
    // The view may have been laid out while the attach was in flight.
    this.resize();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cellMetrics() {
    return this.painter.cell();
  }

  /** The editor's own size, in the page's pixels. */
  areaSize(): { width: number; height: number } {
    const rect = this.host.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  /** The grid size Neovim was last asked for. */
  gridSize(): { cols: number; rows: number } {
    return this.size.cols > 0 ? this.size : this.fit();
  }

  /**
   * Where the command line is now (`cmdlinePlace`): its box at the bottom,
   * as tall as what it holds — a prompt's question, a block, the text.
   */
  cmdlinePlace(): CmdlinePlace {
    const size = this.gridSize();
    const screen = this.state.grids.get(1);
    const gridCols = screen?.width ?? size.cols;
    const gridRows = screen?.height ?? size.rows;
    const cmdheight = this.paintTheme().cmdheight;
    const line = this.state.cmdline.at(-1);
    const room = {
      gridCols,
      gridRows,
      cell: this.painter.cell(),
      cmdheight,
      statusRow: this.statusRow(gridRows, cmdheight),
      lead: line ? cmdlineLead(line, gridCols) : 1,
    };
    const first = cmdlinePlace(room);
    return cmdlinePlace({ ...room, rows: this.cmdlineRows(first.cols).total });
  }

  /**
   * The command line box's rows: a prompt's question (`confirm`), wrapped
   * at the box's width; a `cmdline_block`'s lines; the text, wrapped.
   */
  cmdlineRows(cols: number): {
    prompt: number;
    block: number;
    text: number;
    total: number;
  } {
    const gridCols = this.state.grids.get(1)?.width ?? this.gridSize().cols;
    const prompt = (this.state.prompt ?? []).reduce(
      (n, line) => n + wrappedRows(msgText(line), gridCols - 3),
      0,
    );
    const block = this.state.cmdlineBlock?.length ?? 0;
    const line = this.state.cmdline.at(-1);
    const text = line ? cmdlineLayout(line, cols).rows : 1;
    return { prompt, block, text, total: prompt + block + text };
  }

  /**
   * The row under the lowest window (its status line, or the band under
   * it): where a box with no rows of its own (`cmdheight=0`) sits.
   */
  private statusRow(gridRows: number, cmdheight: number): number {
    let lowest = 0;
    for (const box of this.boxes) {
      if (!box.float && box.win !== undefined)
        lowest = Math.max(lowest, box.row + box.height);
    }
    return lowest > 0 ? lowest : Math.max(1, gridRows - cmdheight - 1);
  }

  /** Messages for the page to route (`messages.ts`): taken, once. */
  takeMessages(): MessageEvent[] {
    const taken = this.state.messages;
    this.state.messages = [];
    return taken;
  }

  /** The font the grids are painted in. */
  font(): FontSpec {
    return this.painter.fontSpec();
  }

  gridBoxes(): readonly GridBox[] {
    return this.boxes;
  }

  /** The windows a page draws the chrome of (`claimFloats`). */
  private claimed: ReadonlySet<number> = new Set();

  /**
   * Claim the floats of these windows for the page (a framed view's): the
   * painter draws them bare, as their cells, from the next paint.
   */
  claimWindows(wins: ReadonlySet<number>): void {
    const same =
      wins.size === this.claimed.size &&
      [...wins].every((w) => this.claimed.has(w));
    if (same) return;
    this.claimed = new Set(wins);
    this.pending.layout = true;
    if (this.frame === 0) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    }
  }

  /** What the colorscheme says beyond the grid (`chrome.ts`). */
  paintTheme(): PaintTheme {
    return this.painter.paintTheme();
  }

  /** The colours a GUI surface over the editor wears (`chrome.ts`). */
  surface(): Surface | undefined {
    return this.painter.paintTheme().surface;
  }

  updateSettings(settings: EditorSettings): void {
    this.settings = settings;
    this.applyFont();
  }

  focus(): void {
    if (!this.keys) return;
    this.input.focus({ preventScroll: true });
  }

  /**
   * Whether this Neovim has its terminal page's keys (main's word,
   * `TerminalNeovimsWire.keys`): the page holds the terminal and every
   * Neovim over its panes, so a Neovim that focuses itself — an attach, an
   * answered question — must not take them from the terminal or another
   * Neovim. A press into it is the person's word, and gives them to it.
   */
  setKeys(keys: boolean): void {
    this.keys = keys;
  }

  private keys = true;

  /**
   * Ask Neovim for the grid a view `width` by `height` holds, before the
   * view is that size: its pane is about to be, and moves to it with the
   * picture Neovim draws at it (docs/pane-motion.md). The size asked, or
   * nothing before the attach.
   */
  resizeFor(
    width: number,
    height: number,
    flushed: () => void,
  ): { cols: number; rows: number } | undefined {
    if (this.size.cols === 0) return undefined;
    const next = gridSizeFor(width, height, this.painter.cell());
    if (next.cols !== this.size.cols || next.rows !== this.size.rows) {
      this.size = next;
      this.hold.hold(flushed);
      this.port.call("nvim_ui_try_resize", [next.cols, next.rows]);
    } else if (this.hold.holding) {
      this.hold.hold(flushed);
    }
    return next;
  }

  /**
   * What Neovim flushes for a resize asked for a held layout (`resizeFor`)
   * is drawn only when the page says (`resumePaint`), in the first frame
   * its pane has moved (`PaintHold`).
   */
  private readonly hold = new PaintHold();

  /**
   * Draw now what came while held (`resizeFor`): called in the frame the
   * page shows it in, with its pane's place and size for that frame.
   */
  resumePaint(): void {
    const waiting = this.hold.release();
    if (waiting === undefined || this.disposed) return;
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.paint(waiting.force);
  }

  /** Grid 1 as Neovim last drew it, or nothing yet. */
  drawnSize(): { cols: number; rows: number } | undefined {
    const grid = this.state.grids.get(1);
    return grid === undefined
      ? undefined
      : { cols: grid.width, rows: grid.height };
  }

  /**
   * A keystroke the page's terminal had, typed here: the key that gives
   * this Neovim the keys, which tmux would have handed to its pane. As the
   * textarea would read it, with plain text as text; `leftOption`, the left
   * Option is held, which this one never saw go down.
   */
  typeKey(stroke: {
    readonly key: string;
    readonly code: string;
    readonly control: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
    readonly meta: boolean;
    readonly leftOption: boolean;
  }): void {
    const setting = this.settings.macOptionIsMeta;
    if (stroke.alt && stroke.leftOption) {
      this.optionKeys.isMeta(setting, {
        type: "keydown",
        code: "AltLeft",
        altKey: true,
      });
    }
    const event = {
      type: "keydown",
      key: stroke.key,
      code: stroke.code,
      ctrlKey: stroke.control,
      altKey: stroke.alt,
      shiftKey: stroke.shift,
      metaKey: stroke.meta,
      isComposing: false,
    };
    const meta = this.optionKeys.isMeta(setting, event);
    const keys =
      keyToNeovim(event, meta, this.baseKeys) ??
      ([...stroke.key].length === 1 ? escapeInputText(stroke.key) : undefined);
    if (keys !== undefined) this.send(keys);
  }

  redraw(batches: readonly unknown[]): void {
    applyRedraw(this.state, batches, this.pending);
    if (this.pending.flushed) this.hold.flushed();
    if (this.pending.flushed && this.frame === 0) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    }
  }

  /** Where Lua says the windows are: places grids Neovim did not. */
  placeWindows(layout: Parameters<typeof placeUnplacedWindows>[1]): void {
    if (!placeUnplacedWindows(this.state, layout)) return;
    this.pending.layout = true;
    if (this.frame === 0) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    }
  }

  /** Neovim went away: what is drawn stays, nothing is sent. */
  reset(): void {
    this.wheel.reset();
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    this.stopWatchingDpr();
    this.stopWatchingFonts();
    this.stopWatchingViewFocus();
    window.clearTimeout(this.themeTimer);
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    if (this.scrollTick !== 0) cancelAnimationFrame(this.scrollTick);
    this.windowMotion.dispose();
    this.band.remove();
    this.preedit.remove();
  }

  /**
   * How far past grid 1 its ground reaches, in CSS pixels (a tmux pane's
   * half border cells: `GridPainter.setReach`).
   */
  setReach(reach: Reach): void {
    if (this.painter.setReach(reach)) this.paint(true);
  }

  private fontSpec(): FontSpec {
    return neovimCellFont(this.settings.font, {
      guifont: this.state?.options.get("guifont"),
      linespace: this.state?.options.get("linespace"),
    });
  }

  private applyFont(): void {
    if (this.painter.setFont(this.fontSpec())) {
      this.gridLayer.style.font = fontOf(this.painter.fontSpec());
      this.input.style.font = this.gridLayer.style.font;
      this.paint(true);
      this.resize();
    }
  }

  private paint(forceAll = false): void {
    if (this.disposed) return;
    if (this.hold.defer(forceAll)) return;
    const laid = claimFloats(layoutGrids(this.state), this.claimed);
    // A float opening with text in its border is drawn once its labels
    // are known, its final frame from its first frame (`LabelAsks`).
    if (this.askFloatLabels(laid)) {
      this.labelsPaint = {
        force: forceAll || this.labelsPaint?.force === true,
      };
      return;
    }
    if (this.labelsPaint !== undefined) {
      forceAll ||= this.labelsPaint.force;
      this.labelsPaint = undefined;
    }
    const changes = this.pending;
    this.pending = emptyChanges();
    if (changes.options) this.applyFont();
    // `cmdheight` is asked with them: it moves when the layout does.
    if (changes.colors || changes.layout) this.askTheme();
    // A panel next to the cursor's row is moved half a row off it, so a
    // borderless float's padding never covers what is typed
    // (`clearCursorRow`).
    // And a cell in from the editor's edge, where its padding would
    // be cut (`clearEdges`).
    const at = laid.find((b) => b.grid === this.state.cursor.grid);
    const grid1 = this.state.grids.get(1);
    const offRow = clearCursorRow(
      laid,
      at === undefined ? undefined : at.row + this.state.cursor.row,
    );
    this.boxes = grid1
      ? clearEdges(offRow, grid1, this.painter.edgeRoom())
      : offRow;
    this.host.style.background = cssColor(this.state.defaults.background);
    const theme = this.paintTheme();
    // The floating surfaces' colours (`tokens.css`), for what DevHub draws
    // over the editor in them: the command line's box, `gui.popup`, the
    // completion menu.
    const look = floatLook(theme, this.state.defaults);
    this.host.style.setProperty("--float-ground", cssColor(look.ground));
    this.host.style.setProperty("--float-ink", cssColor(look.ink));
    this.host.style.setProperty("--float-line", cssColor(look.line));
    this.host.style.setProperty("--float-band", cssColor(look.band));
    this.host.style.setProperty(
      "--float-cell",
      `${String(this.painter.cell().width)}px`,
    );
    this.windowMotion.paint(this.state, this.boxes, {
      now: performance.now(),
      cmdheight: theme.cmdheight,
      // A border dragged follows the pointer at once.
      immediate: this.sashDragged,
      separator: cssColor(theme.separator ?? this.state.defaults.foreground),
      draw: () => {
        this.painter.paint(this.state, changes, this.boxes, forceAll);
      },
    });
    this.askFloatAnchors();
    this.placeCursor(changes.scrolled.has(this.state.cursor.grid));
    this.scrollFrame();
    for (const listener of this.listeners) listener();
  }

  /**
   * One frame of pixel scrolling: each window's display moved, Neovim asked
   * for the lines it needs ahead (or back, to rest), the cursor moved with
   * its text; again next frame while anything still moves.
   */
  private scrollFrame(): void {
    if (this.disposed) return;
    const moving = this.painter.scrollFrame(
      this.state,
      this.boxes,
      (grid, request) => {
        this.askScroll(grid, request);
      },
    );
    this.placeCursorScroll();
    this.placeRiders();
    if (moving && this.scrollTick === 0) {
      this.scrollTick = requestAnimationFrame(() => {
        this.scrollTick = 0;
        this.scrollFrame();
      });
    }
  }

  /** Ask Neovim to scroll a window (`SCROLL_LUA`) and hear how it went. */
  private askScroll(grid: number, request: ScrollRequest): void {
    const view = this.painter.scrollView(grid);
    const win = this.state.gridWins.get(grid);
    const ask = this.port.request?.bind(this.port);
    if (!view || win === undefined || !ask) {
      if (view) replied(view, 0, performance.now());
      return;
    }
    const at =
      this.wheelAt?.grid === grid ? this.wheelAt : { grid, row: 0, col: 0 };
    ask("nvim_exec_lua", [
      SCROLL_LUA,
      [
        win,
        request.rows,
        grid,
        at.row,
        at.col,
        request.exact,
        view.reach.lo / this.painter.cell().height,
        view.reach.hi / this.painter.cell().height,
      ],
    ]).then(
      (answer) => {
        const [code, bound] = Array.isArray(answer) ? answer : [];
        replied(view, typeof code === "number" ? code : 0, performance.now());
        // The windows `scrollbind` moves with it follow its display.
        const wins = new Set(Array.isArray(bound) ? bound : []);
        this.painter.setFollowers(
          grid,
          [...this.state.gridWins]
            .filter(([, w]) => wins.has(w))
            .map(([g]) => g),
        );
        this.scrollFrame();
      },
      () => {
        replied(view, 0, performance.now());
        this.scrollFrame();
      },
    );
  }

  /**
   * The cursor rides with its window's text while that scrolls in pixels
   * (a transform, so it does not glide behind it); its grid's clip cuts it
   * where the text area ends.
   */
  private placeCursorScroll(): void {
    const { grid } = this.state.cursor;
    const off = this.painter.scrollOffset(grid);
    const ride = off === 0 ? this.painter.floatShift(grid) : -off;
    this.cursor.style.transform =
      ride === 0 ? "" : `translateY(${String(ride)}px)`;
  }

  /**
   * What rides the windows' text (`riders.ts`: inline images and cards,
   * decorations, popups) where that text is shown: every frame a window
   * scrolls, and when the page lays them out again (a layout effect, so
   * before the frame is drawn).
   */
  /**
   * The rows each window (by window) has scrolled as the page has heard
   * it: what Lua placed is counted from there (Lua's placements come after
   * the redraw that shows the state they were taken in).
   */
  scrolledRows(): Map<number, number> {
    const rows = new Map<number, number>();
    for (const [grid, win] of this.state.gridWins) {
      rows.set(win, this.state.windows.get(grid)?.scrolledRows ?? 0);
    }
    return rows;
  }

  placeRiders(): void {
    if (this.disposed) return;
    const ch = this.painter.cell().height;
    for (const el of this.host.querySelectorAll<HTMLElement>(
      "[data-ride-win]",
    )) {
      const win = Number(el.dataset["rideWin"]);
      const box = this.boxes.find((b) => b.win === win);
      if (!box) continue;
      const m = this.state.margins.get(box.grid);
      const area = {
        top: (box.row + (m?.top ?? 0)) * ch,
        bottom: (box.row + box.height - (m?.bottom ?? 0)) * ch,
      };
      const rows =
        this.painter.paintedRows(box.grid) - Number(el.dataset["rideBase"]);
      const off = this.painter.scrollOffset(box.grid);
      const cut = el.dataset["rideCut"] ?? "area";
      const ride = cut.startsWith("anchor:")
        ? rideAnchor(
            parseFloat(el.style.top) + Number(cut.slice(7)),
            rows,
            off,
            ch,
            area,
          )
        : rideArea(rows, off, ch);
      Object.assign(el.style, rideStyle(ride));
    }
  }

  /**
   * The colorscheme's selection and match colours, by group name, and
   * `cmdheight` (`chrome.ts`): asked a moment after highlights or the
   * layout change (a colorscheme defines hundreds at once), and everything
   * repainted when they differ.
   */
  refreshTheme(): void {
    this.askTheme();
  }

  /**
   * What Lua says each status line row shows (its `statusline` event):
   * grid 1 is drawn no more, each row is a footer (`placeFooters`).
   */
  setStatusline(statusline: Statusline): void {
    if (!this.painter.setStatusline(statusline)) return;
    if (this.frame === 0) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    }
  }

  /** The status line rows as last painted, and where a tree goes in one. */
  footers(): readonly Footer[] {
    return this.painter.footers();
  }

  footerTree(key: string): HTMLElement {
    return this.painter.footerTree(key);
  }

  /**
   * Where each window's decorations are (Lua's `decor` event): the rows of
   * the windows whose changed are painted again on the next frame.
   */
  setDecor(decor: Decor): void {
    const changed = new Set(this.painter.setDecor(decor));
    if (changed.size === 0) return;
    for (const box of this.boxes) {
      if (box.win === undefined || !changed.has(box.win)) continue;
      const grid = this.state.grids.get(box.grid);
      if (!grid) continue;
      for (let row = 0; row < grid.height; row += 1) grid.dirty.add(row);
      this.pending.grids.add(box.grid);
    }
    if (this.frame === 0) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    }
  }

  private askTheme(): void {
    const request = this.port.request?.bind(this.port);
    if (!request) return;
    window.clearTimeout(this.themeTimer);
    this.themeTimer = window.setTimeout(() => {
      request("nvim_exec_lua", [THEME_LUA, [THEME_GROUPS]]).then(
        (answer) => {
          if (this.disposed || !this.painter.setTheme(themeOf(answer))) return;
          this.paint(true);
        },
        () => {
          // Not answered: drawn as cells, as before.
        },
      );
    }, 120);
  }

  /**
   * A float with a border of lines whose border holds text: its `title` and
   * `footer`, from `nvim_win_get_config`, are what let that text be drawn
   * as a label on the line (`frame.ts`); until they are known, or when the
   * text is not theirs, the border is drawn cell for cell. Asked again only
   * when the border's text changes. Whether the paint of `boxes` waits: a
   * float among them has never had its answer (`LabelAsks`), and is drawn
   * with it, when it comes.
   */
  private askFloatLabels(boxes: readonly GridBox[]): boolean {
    const request = this.port.request?.bind(this.port);
    if (!request) return false;
    const { ask, waiting } = this.labelAsks.need(boxes, (box) => {
      const grid = this.state.grids.get(box.grid);
      return grid === undefined
        ? undefined
        : `${gridRowText(grid, 0)}\n${gridRowText(grid, grid.height - 1)}`;
    });
    const repaint = () => {
      this.pending.layout = true;
      if (this.frame === 0) {
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.paint();
        });
      }
    };
    for (const { win } of ask) {
      request("nvim_win_get_config", [win]).then(
        (config) => {
          if (this.disposed) return;
          this.state.floatLabels.set(win, floatLabelsOf(config));
          this.labelAsks.answer(win);
          repaint();
        },
        () => {
          // Closed meanwhile, or no such window: drawn cell for cell.
          if (this.disposed) return;
          this.labelAsks.answer(win);
          repaint();
        },
      );
    }
    return waiting;
  }

  /**
   * Whether each float anchored in a window (`relative='win'`) is at a
   * buffer position (`bufpos`): those ride the window's text while it
   * scrolls in pixels (`GridPainter.rideFloats`); a float at a fixed cell
   * of the window (`relative='cursor'` is one) stays put, as in Neovim.
   * Asked once per float, from `nvim_win_get_config`.
   */
  private askFloatAnchors(): void {
    const request = this.port.request?.bind(this.port);
    if (!request) return;
    const open = new Set<number>();
    for (const box of this.boxes) {
      if (!box.float || box.win === undefined) continue;
      const p = this.state.windows.get(box.grid)?.placement;
      if (p?.kind !== "float" || p.anchorGrid === 1) continue;
      open.add(box.win);
      if (this.anchorsAsked.has(box.win)) continue;
      const win = box.win;
      this.anchorsAsked.set(win, false);
      request("nvim_win_get_config", [win]).then(
        (config) => {
          if (this.disposed || !this.anchorsAsked.has(win)) return;
          const { bufpos, row } = (config ?? {}) as {
            bufpos?: unknown;
            row?: unknown;
          };
          this.anchorsAsked.set(
            win,
            Array.isArray(bufpos) && typeof bufpos[0] === "number"
              ? { line: bufpos[0], row: typeof row === "number" ? row : 0 }
              : false,
          );
          this.syncBufposFloats();
          this.scrollFrame();
        },
        () => {
          // Closed meanwhile: nothing rides.
        },
      );
    }
    for (const win of this.anchorsAsked.keys()) {
      if (!open.has(win)) this.anchorsAsked.delete(win);
    }
    this.syncBufposFloats();
  }

  private syncBufposFloats(): void {
    const anchors = new Map<number, BufposAnchor>();
    for (const [win, at] of this.anchorsAsked) if (at) anchors.set(win, at);
    this.painter.setBufposFloats(anchors);
  }

  /** The pointer over a border a drag at grid 1's `at` would resize. */
  private placeSash(at: MouseTarget | undefined): void {
    const sash =
      at && at.grid === 1 && this.state.mouse
        ? sashAt(this.boxes, at.row, at.col)
        : undefined;
    if (!sash && this.sashDragged) return;
    this.sashOn = sash;
    const cursor = sash
      ? sash.dir === "col"
        ? "col-resize"
        : "row-resize"
      : "";
    if (this.gridLayer.style.cursor !== cursor)
      this.gridLayer.style.cursor = cursor;
  }

  /**
   * The cursor blinks as `guicursor` says (`blinkwait`, `blinkon`,
   * `blinkoff`; Neovim's default blinks only in a terminal), starting over
   * whenever it moves.
   */
  private placeBlink(on: number, off: number, wait: number, key: string): void {
    if (key === this.blinkKey) return;
    this.blinkKey = key;
    this.blink?.cancel();
    this.blink = undefined;
    if (on <= 0 || off <= 0 || typeof this.cursor.animate !== "function") {
      return;
    }
    const period = on + off;
    // A soft blink, as VS Code's "smooth" one: each edge fades over a
    // moment of its phase (none with reduced motion), still on for `on`.
    const fade = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : Math.min(BLINK_FADE_MS, on / 2, off / 2);
    this.blink = this.cursor.animate(
      [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: on / period },
        { opacity: 0, offset: (on + fade) / period },
        { opacity: 0, offset: (period - fade) / period },
        { opacity: 1, offset: 1 },
      ],
      { duration: period, delay: wait, iterations: Infinity },
    );
  }

  private cursorBox(): { x: number; y: number } | undefined {
    const { grid, row, col } = this.state.cursor;
    const box = this.boxes.find((b) => b.grid === grid);
    if (!box) return undefined;
    const cell = this.painter.cell();
    return {
      x: (box.col + col) * cell.width,
      y: (box.row + row) * cell.height,
    };
  }

  /** Where on screen the cursor is, in the page's pixels (for widgets). */
  cursorPoint(): { x: number; y: number } | undefined {
    return this.cursorBox();
  }

  /** `scrolled`: Neovim scrolled the cursor's window in this redraw. */
  private placeCursor(scrolled = false): void {
    const at = this.cursorBox();
    const cell = this.painter.cell();
    const mode = currentModeInfo(this.state);
    // While the IME composes, the preedit overlay carries the caret.
    const hidden =
      at === undefined ||
      this.state.busy ||
      this.state.cmdline.length > 0 ||
      this.ime.preedit.length > 0;
    this.cursor.style.display = hidden ? "none" : "";
    if (at === undefined) return;
    const { grid, row, col } = this.state.cursor;
    // Moves glide, briefly — not in Insert mode, where it would trail the
    // typing, nor under reduced motion. Never across a scroll: the text
    // moves at once (or rides the display's offset, a transform), and a
    // cursor gliding to its new row meanwhile would be rows off its cell,
    // so it goes with the text instead; a glide under way stops where it
    // is going (`glideCursor`).
    const scrolling = scrolled || this.painter.scrollView(grid) !== undefined;
    const glides = !this.state.mode.name.startsWith("insert") && !scrolling;
    const g = this.state.grids.get(grid);
    const wide = g !== undefined && g.chars[row * g.width + col + 1] === "";
    const attr =
      mode && mode.attrId > 0 ? this.state.hl.get(mode.attrId) : undefined;
    const colors =
      attr === undefined
        ? {
            bg: this.state.defaults.foreground,
            fg: this.state.defaults.background,
          }
        : (() => {
            const c = resolveColors(attr, this.state.defaults);
            return { bg: c.bg, fg: c.fg };
          })();
    const shape = mode?.cursorShape ?? "block";
    const pct = (mode?.cellPercentage ?? 100) / 100;
    const width = cell.width * (wide ? 2 : 1);
    const s = this.cursor.style;
    s.left = `${String(at.x)}px`;
    s.background = cssColor(colors.bg);
    const focused = this.hasKeyboard();
    // Without the keyboard: a block is hollow, a bar or an underline faint.
    this.cursor.classList.toggle(
      "nvim-cursor-unfocused",
      !focused && shape === "block",
    );
    this.cursor.classList.toggle(
      "nvim-cursor-unfocused-thin",
      !focused && shape !== "block",
    );
    if (shape === "vertical") {
      s.top = `${String(at.y)}px`;
      s.width = `${String(Math.max(1, Math.round(cell.width * pct)))}px`;
      s.height = `${String(cell.height)}px`;
    } else if (shape === "horizontal") {
      const h = Math.max(1, Math.round(cell.height * pct));
      s.top = `${String(at.y + cell.height - h)}px`;
      s.width = `${String(width)}px`;
      s.height = `${String(h)}px`;
    } else {
      s.top = `${String(at.y)}px`;
      s.width = `${String(width)}px`;
      s.height = `${String(cell.height)}px`;
    }
    this.placeBlink(
      focused ? (mode?.blinkon ?? 0) : 0,
      mode?.blinkoff ?? 0,
      mode?.blinkwait ?? 0,
      `${String(at.x)},${String(at.y)},${this.state.mode.name},${String(focused)}`,
    );
    // In its grid's own clip: over what rides the text and under what
    // covers the cells (`PART_Z`), cut by the grid's text area as the
    // text is, also while that scrolls in pixels.
    const parent = this.boxes.some((b) => b.grid === grid)
      ? this.painter.over(grid, "cursor")
      : this.gridLayer;
    if (this.cursor.parentElement !== parent) parent.append(this.cursor);
    this.glideCursor(glides);
    // The text under it, in its colours, on the text: as the grid draws
    // it, not as text in the page (whose line box rounds the font's ascent
    // its own way, half a pixel off the painter's baseline, and knows
    // nothing of bold or italic, wide cells or box drawing), and not
    // carried by the cursor (`cursorInk.ts`).
    this.paintInk(colors);
    // The IME's candidate window opens at the textarea: keep it on the
    // cursor — the command line's, while the bar is up.
    const ime = this.cmdlineCaret() ?? at;
    this.input.style.left = `${String(ime.x)}px`;
    this.input.style.top = `${String(ime.y)}px`;
    this.input.style.height = `${String(cell.height)}px`;
    this.placePreedit();
  }

  /**
   * The cursor is placed at its cell at once (`left`/`top`, the layout at
   * rest) and shown gliding there from where it was seen: a `translate`
   * from that difference to nothing, so it ends on its cell to the pixel
   * and nothing is laid out frame by frame (docs/motion.md). Where it was
   * seen is its last place plus how far a glide under way still had it;
   * `glides` false stops one under way where it is going. The scroll's
   * ride is the `transform`, apart (`placeCursorScroll`).
   */
  private glideCursor(glides: boolean): void {
    const s = this.cursor.style;
    const to = { x: parseFloat(s.left) || 0, y: parseFloat(s.top) || 0 };
    // Hidden (busy, the command line up), it is seen nowhere: it comes
    // back at its cell.
    const from =
      this.cursor.style.display === "none" ? undefined : this.cursorAt;
    this.cursorAt = this.cursor.style.display === "none" ? undefined : to;
    const running = this.cursorGlide;
    // Placed again where it is going (a redraw, a blink): the glide goes on.
    // (Its ink's too: `glideFrom` stays.)
    if (
      glides &&
      running !== undefined &&
      from !== undefined &&
      from.x === to.x &&
      from.y === to.y
    )
      return;
    let seen = from;
    if (running !== undefined && from !== undefined) {
      const [dx = 0, dy = 0] = getComputedStyle(this.cursor)
        .translate.split(" ")
        .map((v) => parseFloat(v) || 0);
      seen = { x: from.x + dx, y: from.y + dy };
    }
    running?.cancel();
    this.inkGlide?.cancel();
    this.cursorGlide = undefined;
    this.inkGlide = undefined;
    this.glideFrom = undefined;
    if (
      !glides ||
      seen === undefined ||
      typeof this.cursor.animate !== "function" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const dx = seen.x - to.x;
    const dy = seen.y - to.y;
    if (dx === 0 && dy === 0) return;
    // The shape glides; its ink glides back as far on the same clock, so
    // it stays on the text the shape goes over (`glideFrames`).
    const frames = glideFrames(dx, dy);
    const timing = {
      duration: CURSOR_GLIDE_MS,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    };
    const glide = this.cursor.animate(frames.cursor, timing);
    const inkGlide = this.ink.animate(frames.ink, timing);
    this.cursorGlide = glide;
    this.inkGlide = inkGlide;
    this.glideFrom = seen;
    glide.onfinish = () => {
      if (this.cursorGlide !== glide) return;
      this.cursorGlide = undefined;
      this.inkGlide = undefined;
      this.glideFrom = undefined;
    };
  }

  /**
   * The cursor's ink (`cursorInk.ts`): the cells of its grid under it —
   * and, while it glides, under the way it goes — painted in its colours
   * and placed on them inside it, so the shape cuts the text where it is
   * and the text stays where the grid has it. Lines sliding under it
   * (`GridPainter.slideOf`) slide in its ink too, on the slide's clock.
   */
  private paintInk(colors: { readonly fg: number; readonly bg: number }): void {
    const s = this.cursor.style;
    const { grid: gridId } = this.state.cursor;
    const box = this.boxes.find((b) => b.grid === gridId);
    const grid = this.state.grids.get(gridId);
    const cell = this.painter.cell();
    const at = { x: parseFloat(s.left) || 0, y: parseFloat(s.top) || 0 };
    const w = parseFloat(s.width) || 0;
    const h = parseFloat(s.height) || 0;
    const rects = [{ x: at.x, y: at.y, w, h }];
    if (this.glideFrom) rects.push({ ...this.glideFrom, w, h });
    let span =
      box && grid && s.display !== "none"
        ? inkSpan(rects, box, grid, cell)
        : undefined;
    const slide = span ? this.painter.slideOf(gridId) : undefined;
    if (span && slide) span = slideSpan(span, slide);
    this.ink.style.left = `${String(-at.x)}px`;
    this.ink.style.top = `${String(-at.y)}px`;
    if (!span || !box) {
      this.inkCanvas.style.display = "none";
      this.dropInkSlide();
      return;
    }
    this.inkCanvas.style.display = "";
    this.painter.paintCursorInk(
      this.inkCanvas,
      this.state,
      gridId,
      span,
      colors.fg,
      colors.bg,
    );
    // In the ink, the editor's pixels: the cells' own place.
    const origin = inkPlace(span, box, { x: 0, y: 0 }, cell);
    this.inkCanvas.style.left = `${String(origin.left)}px`;
    this.inkCanvas.style.top = `${String(origin.top)}px`;
    this.placeInkSlide(slide, span, box, colors.bg);
  }

  /**
   * Lines sliding under the cursor: the slide's rows of the ink, moved as
   * the slide moves the grid's (the same keyframes, at the same time) in a
   * clip of its region in the cursor's ground, as the slide's clip is in
   * the window's.
   */
  private placeInkSlide(
    slide: ReturnType<GridPainter["slideOf"]>,
    span: CellSpan,
    box: GridBox,
    bg: number,
  ): void {
    const top = slide ? Math.max(slide.top, span.row0) : 0;
    const bot = slide ? Math.min(slide.bot, span.row1) : 0;
    const effect = slide?.animation.effect;
    if (
      !slide ||
      bot <= top ||
      !(effect instanceof KeyframeEffect) ||
      slide.animation.playState === "finished"
    ) {
      this.dropInkSlide();
      return;
    }
    const cell = this.painter.cell();
    let ink = this.inkSlide;
    if (ink?.of !== slide.animation) {
      this.dropInkSlide();
      const clip = document.createElement("div");
      clip.className = "nvim-cursor-ink-slide";
      const canvas = document.createElement("canvas");
      clip.append(canvas);
      this.ink.append(clip);
      const animation = canvas.animate(
        effect.getKeyframes(),
        effect.getTiming(),
      );
      ink = { clip, canvas, animation, of: slide.animation };
      this.inkSlide = ink;
    }
    // On the slide's clock, whenever it was laid.
    if (slide.animation.startTime !== null) {
      ink.animation.startTime = slide.animation.startTime;
    } else if (slide.animation.currentTime !== null) {
      ink.animation.currentTime = slide.animation.currentTime;
    }
    const left = (box.col + slide.left) * cell.width;
    const y = (box.row + slide.top) * cell.height;
    const { clip, canvas } = ink;
    clip.style.left = `${String(left)}px`;
    clip.style.top = `${String(y)}px`;
    clip.style.width = `${String((slide.right - slide.left) * cell.width)}px`;
    clip.style.height = `${String((slide.bot - slide.top) * cell.height)}px`;
    clip.style.background = cssColor(bg);
    // The ink's rows inside the region, where they are in it.
    const perRow = this.inkCanvas.height / (span.row1 - span.row0);
    const sy = Math.round((top - span.row0) * perRow);
    const sh = Math.round((bot - top) * perRow);
    canvas.width = this.inkCanvas.width;
    canvas.height = Math.max(1, sh);
    canvas.style.width = this.inkCanvas.style.width;
    canvas.style.height = `${String((bot - top) * cell.height)}px`;
    canvas.style.left = `${String((box.col + span.col0) * cell.width - left)}px`;
    canvas.style.top = `${String((top - slide.top) * cell.height)}px`;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx?.drawImage(
      this.inkCanvas,
      0,
      sy,
      canvas.width,
      sh,
      0,
      0,
      canvas.width,
      sh,
    );
  }

  private dropInkSlide(): void {
    if (!this.inkSlide) return;
    this.inkSlide.animation.cancel();
    this.inkSlide.clip.remove();
    this.inkSlide = undefined;
  }

  /**
   * Where the command line's cursor is, in the page's pixels, while the bar
   * is up: the cell `cmdlineLayout` puts it on, as the bar draws it.
   */
  private cmdlineCaret(): { x: number; y: number } | undefined {
    const line = this.state.cmdline.at(-1);
    if (!line) return undefined;
    const cell = this.painter.cell();
    const place = this.cmdlinePlace();
    const { caret } = cmdlineLayout(line, place.cols);
    const rows = this.cmdlineRows(place.cols);
    // What does not fit is cut from the top: the text stays in view.
    const above = rows.prompt + rows.block - (rows.total - place.rows);
    return {
      x: (place.col + caret.col) * cell.width,
      y: place.textTop + (above + caret.row) * cell.height,
    };
  }

  private placePreedit(): void {
    const bar = this.cmdlineCaret();
    const at = bar ?? this.cursorBox();
    const text = this.ime.preedit;
    this.host.classList.toggle("nvim-composing", text.length > 0);
    this.preedit.style.display =
      text.length === 0 || at === undefined ? "none" : "";
    if (text.length === 0 || at === undefined) return;
    const cell = this.painter.cell();
    // Cell by cell, as the grid will hold it once committed.
    const layout = preeditLayout(text);
    // In the command line's box, in its colours and over it.
    const style = bar ? getComputedStyle(document.documentElement) : undefined;
    const fg = style
      ? rgbOfCss(style.getPropertyValue("--primary"))
      : undefined;
    const bg = style
      ? (rgbOfCss(style.getPropertyValue("--raised")) ??
        rgbOfCss(style.getPropertyValue("--surface")))
      : undefined;
    this.painter.paintPreedit(
      this.preedit,
      layout,
      fg ?? this.state.defaults.foreground,
      bg ?? this.state.defaults.background,
    );
    this.preedit.style.left = `${String(at.x)}px`;
    this.preedit.style.top = `${String(at.y)}px`;
    // The textarea's caret — where the IME opens its candidates — after the
    // preedit's last cell. The textarea is a pixel wide and scrolls its text
    // to keep the caret in view, so its caret is at its own left edge.
    this.input.style.left = `${String(at.x + layout.cells * cell.width)}px`;
  }

  private resize(): void {
    if (this.size.cols === 0) return;
    const next = this.fit();
    if (next.cols === this.size.cols && next.rows === this.size.rows) return;
    this.size = next;
    this.port.call("nvim_ui_try_resize", [next.cols, next.rows]);
  }

  private send(keys: string): void {
    this.port.call("nvim_input", [keys]);
  }

  private imeEvent(event: ImeEvent): void {
    if (event.type === "reset") {
      this.metaComposition.reset();
    } else if (this.metaComposition.drops(event.type)) {
      // A Meta key's composition: nothing of it is drawn or sent, and the
      // textarea is emptied once it is over, which drops the mark.
      if (event.type === "compositionend") {
        setTimeout(() => {
          if (!this.metaComposition.active) this.input.value = "";
        }, 0);
      }
      return;
    }
    const step = imeStep(this.ime, event);
    this.ime = step.state;
    if (step.commit !== undefined) {
      if (event.type === "input" && event.inputType === "insertFromPaste") {
        this.port.call("nvim_paste", [step.commit, true, -1]);
      } else {
        this.send(escapeInputText(step.commit));
      }
    }
    if (step.clear) this.input.value = "";
    this.placeCursor();
  }

  private bindInput(): void {
    const input = this.input;
    void this.baseKeys.loadLayout(layoutMapSource());
    // Option as Meta is by the physical key (`surfaces/baseKeys.ts`) and is
    // decided before the composition check: Chromium may hand an Option
    // chord to the input method (a dead key: `key` "Dead", keyCode 229) and
    // it is still Meta. A composition such a key starts is dropped, and the
    // keys typed during it are sent here by their physical key.
    input.addEventListener("keydown", (event) => {
      const meta = this.optionKeys.isMeta(this.settings.macOptionIsMeta, event);
      const optionMeta = meta && event.altKey;
      const dropping = this.metaComposition.active;
      if (!optionMeta && !dropping) {
        this.baseKeys.learn(event);
        if (event.isComposing || this.ime.composing || event.keyCode === 229) {
          this.metaComposition.keydown(false);
          return;
        }
      }
      // An IME's composition in flight keeps every key, Option's too.
      if (
        optionMeta &&
        !dropping &&
        (event.isComposing || this.ime.composing)
      ) {
        return;
      }
      this.metaComposition.keydown(optionMeta);
      // Cmd+V is the menu's Paste, which arrives as an `input` and is
      // handed to `nvim_paste`; Cmd+Q and the chords never get here.
      if (event.metaKey && (event.key === "v" || event.key === "V")) return;
      let keys = keyToNeovim(event, meta, this.baseKeys);
      if (keys === undefined && dropping && !optionMeta) {
        // A plain key while a Meta dead key's mark is dropped: macOS has
        // composed it (`ñ`), so it is the physical key's own character.
        const text = this.baseKeys.base(event.code, event.shiftKey);
        if (text !== undefined) keys = escapeInputText(text);
      }
      if (keys === undefined) return;
      event.preventDefault();
      this.send(keys);
    });
    input.addEventListener("keyup", (event) => {
      this.optionKeys.isMeta(this.settings.macOptionIsMeta, event);
    });
    input.addEventListener("compositionstart", () => {
      this.imeEvent({ type: "compositionstart" });
    });
    input.addEventListener("compositionupdate", (event) => {
      this.imeEvent({ type: "compositionupdate", data: event.data });
    });
    input.addEventListener("compositionend", (event) => {
      this.imeEvent({ type: "compositionend", data: event.data });
    });
    input.addEventListener("input", (event) => {
      const e = event as InputEvent;
      this.imeEvent({
        type: "input",
        inputType: e.inputType,
        data:
          e.data ?? (e.inputType === "insertFromPaste" ? input.value : null),
        isComposing: e.isComposing,
      });
    });
    // The Edit menu clicked with the mouse: its roles are editing commands
    // aimed at this textarea, which has nothing to copy. They mean what
    // Cmd+C/X/Z/Shift+Z mean here (SETUP_LUA's <D-…> maps); Paste is above.
    const menuKey = (event: Event, keys: string) => {
      event.preventDefault();
      this.send(keys);
    };
    input.addEventListener("copy", (event) => {
      menuKey(event, "<D-c>");
    });
    input.addEventListener("cut", (event) => {
      menuKey(event, "<D-x>");
    });
    input.addEventListener("beforeinput", (event) => {
      if (event.inputType === "historyUndo") menuKey(event, "<D-z>");
      else if (event.inputType === "historyRedo") menuKey(event, "<D-Z>");
    });
    input.addEventListener("focus", () => {
      // The input source may have changed while the keys were elsewhere.
      void this.baseKeys.loadLayout(layoutMapSource());
      this.syncFocus();
    });
    input.addEventListener("blur", () => {
      this.imeEvent({ type: "reset" });
      this.syncFocus();
    });

    const layer = this.gridLayer;
    const target = (event: MouseEvent): MouseTarget => {
      const rect = layer.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const at = hitTest(
        this.boxes,
        this.painter.cell(),
        event.clientX - rect.left,
        y,
      );
      // A window moved by pixel scrolling: the row whose text is under the
      // pointer (the nearest of Neovim's, over a line only the ghost has).
      const off = this.painter.scrollOffset(at.grid);
      const box = this.boxes.find((b) => b.grid === at.grid);
      if (off === 0 || !box) return at;
      const ch = this.painter.cell().height;
      const m = this.state.margins.get(at.grid);
      const top = m?.top ?? 0;
      const bottom = box.height - (m?.bottom ?? 0);
      if (at.row < top || at.row >= bottom) return at;
      const row = Math.floor((y - box.row * ch + off) / ch);
      return { ...at, row: Math.min(bottom - 1, Math.max(top, row)) };
    };
    const screenCell = (event: MouseEvent): MouseTarget => {
      const rect = layer.getBoundingClientRect();
      const cell = this.painter.cell();
      return {
        grid: 1,
        row: Math.max(0, Math.floor((event.clientY - rect.top) / cell.height)),
        col: Math.max(0, Math.floor((event.clientX - rect.left) / cell.width)),
      };
    };
    const mouse = (
      button: string,
      action: string,
      event: MouseEvent,
      at: MouseTarget,
    ) => {
      this.port.call("nvim_input_mouse", [
        button,
        action,
        mouseModifiers(event),
        at.grid,
        at.row,
        at.col,
      ]);
    };
    // A GUI window, a view (framed or not), a card, a popup and the
    // notifications are DevHub's: their own clicks and wheel (all but the
    // popup are in the grids' layer).
    const ownedByGui = (event: Event) =>
      (event.target as HTMLElement).closest(GUI_OWNED) !== null ||
      forwardedToFrame(event);
    // A framed view (gui.view{ frame }) lies over its float, under the levels
    // of the floats above it (its preview's): a level takes the event, so it
    // is handed to the frame's element under the pointer, unless a grid is
    // drawn there first (the preview's cells are Neovim's).
    const forwardedToFrame = (event: Event): boolean => {
      if (!(event instanceof MouseEvent) || event.isTrusted === false)
        return false;
      for (const el of document.elementsFromPoint(
        event.clientX,
        event.clientY,
      )) {
        if (el instanceof HTMLCanvasElement) return false;
        if (el.closest(".nvim-view-frame")) {
          const copy =
            event instanceof WheelEvent
              ? new WheelEvent(event.type, event)
              : new MouseEvent(event.type, event);
          el.dispatchEvent(copy);
          event.preventDefault();
          return true;
        }
      }
      return false;
    };
    layer.addEventListener("mousedown", (event) => {
      if (ownedByGui(event)) return;
      event.preventDefault();
      this.focus();
      const button = mouseButton(event.button);
      if (!button || !this.state.mouse) return;
      const at = target(event);
      this.dragging = { button, target: at };
      this.sashDragged = this.sashOn !== undefined;
      mouse(button, "press", event, at);
    });
    layer.addEventListener("mousemove", (event) => {
      const at = ownedByGui(event) ? undefined : target(event);
      if (!this.dragging) this.placeSash(at);
    });
    layer.addEventListener("mouseleave", () => {
      if (!this.sashDragged) this.placeSash(undefined);
    });
    window.addEventListener("mousemove", (event) => {
      const drag = this.dragging;
      if (!drag) return;
      // A press on grid 1 (a window border, a status line: Neovim resizes)
      // drags in grid 1's cells, over the windows too.
      const at = drag.target.grid === 1 ? screenCell(event) : target(event);
      // Neovim wants drags on the grid the press was on.
      const same = at.grid === drag.target.grid ? at : drag.target;
      if (same.row === drag.target.row && same.col === drag.target.col) return;
      drag.target = same;
      mouse(drag.button, "drag", event, same);
    });
    window.addEventListener("mouseup", (event) => {
      const drag = this.dragging;
      if (!drag) return;
      this.dragging = undefined;
      if (this.sashDragged) {
        this.sashDragged = false;
        this.placeSash(target(event));
      }
      mouse(
        drag.button,
        "release",
        event,
        drag.target.grid === 1 ? screenCell(event) : target(event),
      );
    });
    layer.addEventListener(
      "wheel",
      (event) => {
        if (ownedByGui(event)) return;
        event.preventDefault();
        const at = target(event);
        // A window's vertical scrolling follows the trackpad in pixels
        // (`smoothScroll.ts`); with a modifier, sideways or anywhere else
        // the wheel is Neovim's, in line steps.
        const box = this.boxes.find((b) => b.grid === at.grid);
        const plain =
          !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
        const cell = this.painter.cell();
        const dy =
          event.deltaMode === 1
            ? event.deltaY * cell.height
            : event.deltaMode === 2
              ? event.deltaY * (box?.height ?? 1) * cell.height
              : event.deltaY;
        const pixels =
          plain &&
          dy !== 0 &&
          box !== undefined &&
          this.painter.wheel(this.state, box, dy);
        if (pixels) {
          this.wheelAt = at;
          this.scrollFrame();
        }
        for (const step of this.wheel.steps(
          event.deltaX,
          pixels ? 0 : event.deltaY,
          event.deltaMode,
          cell,
        )) {
          mouse("wheel", step, event, at);
        }
      },
      { passive: false },
    );
  }
}
