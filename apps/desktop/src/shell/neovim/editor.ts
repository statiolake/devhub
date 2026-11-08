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
  currentModeInfo,
  emptyChanges,
  gridRowText,
  initialUiState,
  layoutGrids,
  placeUnplacedWindows,
  type GridBox,
  type NeovimUiState,
  type RedrawChanges,
} from "./redraw";
import {
  GridPainter,
  ICON_FAMILY,
  cssColor,
  fontOf,
  rgbOfCss,
  parseGuifont,
  resolveColors,
  type FontSpec,
} from "./painter";
import { escapeInputText, keyToNeovim } from "./keys";
import { floatLabelsOf } from "./frame";
import { THEME_GROUPS, THEME_LUA, themeOf, type Surface } from "./chrome";
import { cmdlineLayout, textCells } from "./cmdline";
import { cmdlinePlace } from "./place";
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
  type MouseTarget,
} from "./mouse";
import { OptionKeys } from "../surfaces/optionKey";
import type { MacOptionIsMeta } from "../../model/macOption";

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
  /** DevHub's own monospace, used unless `guifont` says otherwise. */
  readonly monoFamily: string;
  readonly fontSize: number;
  readonly macOptionIsMeta: MacOptionIsMeta;
}

/** How long the cursor's blink takes to fade out or in. */
const BLINK_FADE_MS = 120;

export class NeovimEditor {
  readonly state: NeovimUiState = initialUiState(themeColors());
  private pending: RedrawChanges = emptyChanges();
  private frame = 0;
  private readonly painter: GridPainter;
  private readonly gridLayer: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private readonly preedit: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  private ime: ImeState = IDLE;
  private readonly optionKeys = new OptionKeys();
  private readonly wheel = new WheelAccumulator();
  private settings: EditorSettings;
  private size = { cols: 0, rows: 0 };
  private boxes: GridBox[] = [];
  /** The border text each float's labels were last asked for, by window. */
  private readonly labelsAsked = new Map<number, string>();
  private readonly listeners = new Set<() => void>();
  private dragging: { button: string; target: MouseTarget } | undefined;
  private dropComposition = false;
  private readonly observer: ResizeObserver;
  private disposed = false;
  /** Each window's scrollbar, by grid. */
  private readonly scrollbars = new Map<
    number,
    {
      readonly track: HTMLDivElement;
      readonly thumb: HTMLDivElement;
      key: string;
      timer: number;
    }
  >();
  /** A pending ask for the colorscheme's groups (`askTheme`). */
  private themeTimer = 0;
  private blink: Animation | undefined;
  private blinkKey = "";
  private stopWatchingDpr: () => void = () => {};
  private stopWatchingFonts: () => void = () => {};

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
    this.gridLayer.append(this.cursor, this.preedit, this.input);
    host.append(this.gridLayer);
    this.painter = new GridPainter(this.gridLayer, this.fontSpec());
    this.gridLayer.style.font = fontOf(this.painter.fontSpec());
    this.input.style.font = this.gridLayer.style.font;
    this.bindInput();
    this.observer = new ResizeObserver(() => {
      this.resize();
    });
    this.observer.observe(host);
    this.watchDevicePixelRatio();
    this.watchFonts();
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

  /** The font the grids are painted in. */
  font(): FontSpec {
    return this.painter.fontSpec();
  }

  gridBoxes(): readonly GridBox[] {
    return this.boxes;
  }

  /**
   * The row messages scrolled up over the windows start at (`:ls`, a
   * hit-enter prompt), or `undefined` while they keep to their own rows.
   */
  messagePanelRow(): number | undefined {
    for (const box of this.boxes) {
      const p = this.state.windows.get(box.grid)?.placement;
      if (p?.kind === "message" && p.scrolled) return box.row;
    }
    return undefined;
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
    this.input.focus({ preventScroll: true });
  }

  redraw(batches: readonly unknown[]): void {
    applyRedraw(this.state, batches, this.pending);
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

  /** The pointer is over another grid: its fold column's chevrons show. */
  private hoverGrid(grid: number | undefined): void {
    const dirty = this.painter.setHover(grid);
    if (dirty.length === 0) return;
    for (const id of dirty) {
      const g = this.state.grids.get(id);
      if (!g) continue;
      for (let row = 0; row < g.height; row += 1) g.dirty.add(row);
    }
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
    for (const bar of this.scrollbars.values()) window.clearTimeout(bar.timer);
    window.clearTimeout(this.themeTimer);
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.gridLayer.remove();
  }

  private fontSpec(): FontSpec {
    const guifont = parseGuifont(this.state?.options.get("guifont"));
    const linespace = this.state?.options.get("linespace");
    return {
      family: guifont?.family ?? this.settings.monoFamily,
      size: guifont?.size ?? this.settings.fontSize,
      linespace: typeof linespace === "number" ? linespace : 2,
    };
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
    const changes = this.pending;
    this.pending = emptyChanges();
    if (changes.options) this.applyFont();
    // `cmdheight` is asked with them: it moves when the layout does.
    if (changes.colors || changes.layout) this.askTheme();
    this.boxes = layoutGrids(this.state);
    this.host.style.background = cssColor(this.state.defaults.background);
    this.painter.paint(this.state, changes, this.boxes, forceAll);
    this.askFloatLabels();
    this.placeScrollbars();
    this.placeCursor();
    for (const listener of this.listeners) listener();
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
   * when the border's text changes.
   */
  private askFloatLabels(): void {
    const request = this.port.request?.bind(this.port);
    if (!request) return;
    const open = new Set<number>();
    for (const box of this.boxes) {
      if (!box.float || box.win === undefined || box.lined !== true) continue;
      open.add(box.win);
      if (box.wantsLabels !== true) continue;
      const grid = this.state.grids.get(box.grid);
      if (!grid) continue;
      const text = `${gridRowText(grid, 0)}\n${gridRowText(grid, grid.height - 1)}`;
      if (this.labelsAsked.get(box.win) === text) continue;
      this.labelsAsked.set(box.win, text);
      const win = box.win;
      request("nvim_win_get_config", [win]).then(
        (config) => {
          if (this.disposed) return;
          this.state.floatLabels.set(win, floatLabelsOf(config));
          this.pending.layout = true;
          if (this.frame === 0) {
            this.frame = requestAnimationFrame(() => {
              this.frame = 0;
              this.paint();
            });
          }
        },
        () => {
          // Closed meanwhile, or no such window: drawn cell for cell.
        },
      );
    }
    for (const win of this.labelsAsked.keys()) {
      if (!open.has(win)) this.labelsAsked.delete(win);
    }
  }

  /**
   * A thin scrollbar at each window's right edge, from `win_viewport`: shown
   * while the view moves, gone a moment after, like an overlay scrollbar.
   * Not for a window whose whole buffer is on screen, nor for floats.
   */
  private placeScrollbars(): void {
    const cell = this.painter.cell();
    const seen = new Set<number>();
    for (const box of this.boxes) {
      if (box.float || box.win === undefined) continue;
      const viewport = this.state.windows.get(box.grid)?.viewport;
      if (!viewport || viewport.lineCount <= 0) continue;
      const shown = Math.max(1, viewport.botline - viewport.topline);
      if (shown >= viewport.lineCount && viewport.topline === 0) continue;
      seen.add(box.grid);
      let bar = this.scrollbars.get(box.grid);
      if (!bar) {
        const track = document.createElement("div");
        track.className = "nvim-scrollbar";
        const thumb = document.createElement("div");
        thumb.className = "nvim-scrollbar-thumb";
        track.append(thumb);
        this.gridLayer.append(track);
        bar = { track, thumb, key: "", timer: 0 };
        this.scrollbars.set(box.grid, bar);
      }
      // The window's text rows: its grid without the statusline, which
      // Neovim draws on the grid only when the window has one of its own.
      const height = box.height * cell.height;
      const top = Math.min(1, viewport.topline / viewport.lineCount);
      const size = Math.max(
        Math.min(1, shown / viewport.lineCount),
        24 / Math.max(1, height),
      );
      const t = bar.track.style;
      t.left = `${String((box.col + box.width) * cell.width - 8)}px`;
      t.top = `${String(box.row * cell.height)}px`;
      t.height = `${String(height)}px`;
      t.zIndex = String(box.z + 1);
      bar.thumb.style.top = `${String(Math.min(1 - size, top) * 100)}%`;
      bar.thumb.style.height = `${String(size * 100)}%`;
      const key = `${String(viewport.topline)}:${String(viewport.lineCount)}`;
      if (key !== bar.key) {
        const first = bar.key === "";
        bar.key = key;
        if (!first) {
          bar.track.classList.add("nvim-scrollbar-active");
          window.clearTimeout(bar.timer);
          const track = bar.track;
          bar.timer = window.setTimeout(() => {
            track.classList.remove("nvim-scrollbar-active");
          }, 900);
        }
      }
    }
    for (const [grid, bar] of this.scrollbars) {
      if (seen.has(grid)) continue;
      window.clearTimeout(bar.timer);
      bar.track.remove();
      this.scrollbars.delete(grid);
    }
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

  private placeCursor(): void {
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
    const g = this.state.grids.get(grid);
    const index = g ? row * g.width + col : -1;
    const char = g && index >= 0 ? (g.chars[index] ?? " ") : " ";
    const wide = g !== undefined && g.chars[index + 1] === "";
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
    // Softened corners, as a GUI editor's caret: a block's a little
    // rounded, a bar's ends round.
    s.borderRadius =
      shape === "block"
        ? `${String(Math.min(3, cell.width / 4))}px`
        : `${String(Math.min(1, cell.width / 8))}px`;
    s.background = cssColor(colors.bg);
    s.color = cssColor(colors.fg);
    s.lineHeight = `${String(cell.height)}px`;
    const focused = document.activeElement === this.input;
    this.cursor.classList.toggle(
      "nvim-cursor-unfocused",
      !focused && shape === "block",
    );
    if (shape === "vertical") {
      s.top = `${String(at.y)}px`;
      s.width = `${String(Math.max(1, Math.round(cell.width * pct)))}px`;
      s.height = `${String(cell.height)}px`;
      this.cursor.textContent = "";
    } else if (shape === "horizontal") {
      const h = Math.max(1, Math.round(cell.height * pct));
      s.top = `${String(at.y + cell.height - h)}px`;
      s.width = `${String(width)}px`;
      s.height = `${String(h)}px`;
      this.cursor.textContent = "";
    } else {
      s.top = `${String(at.y)}px`;
      s.width = `${String(width)}px`;
      s.height = `${String(cell.height)}px`;
      this.cursor.textContent = char === "" ? " " : char;
    }
    this.placeBlink(
      focused ? (mode?.blinkon ?? 0) : 0,
      mode?.blinkoff ?? 0,
      mode?.blinkwait ?? 0,
      `${String(at.x)},${String(at.y)},${this.state.mode.name},${String(focused)}`,
    );
    // Moves glide, briefly — not in Insert mode, where it would trail the
    // typing — and the stylesheet drops it for reduced motion.
    this.cursor.classList.toggle(
      "nvim-cursor-glide",
      !this.state.mode.name.startsWith("insert"),
    );
    this.cursor.style.zIndex = String(
      (this.boxes.find((b) => b.grid === grid)?.z ?? 0) + 1,
    );
    // The IME's candidate window opens at the textarea: keep it on the
    // cursor — the command line's, while the bar is up.
    const ime = this.cmdlineCaret() ?? at;
    this.input.style.left = `${String(ime.x)}px`;
    this.input.style.top = `${String(ime.y)}px`;
    this.input.style.height = `${String(cell.height)}px`;
    this.placePreedit();
  }

  /**
   * Where the command line's cursor is, in the page's pixels, while the bar
   * is up: the cell `cmdlineLayout` puts it on, as the bar draws it.
   */
  private cmdlineCaret(): { x: number; y: number } | undefined {
    const line = this.state.cmdline.at(-1);
    if (!line) return undefined;
    const cell = this.painter.cell();
    const place = cmdlinePlace(this.gridSize().cols, cell.width);
    const lead = Math.min(
      place.cols - 1,
      Math.max(1, textCells(line.firstc || line.prompt || "")),
    );
    const { caret } = cmdlineLayout(line, place.cols - lead);
    const above = this.state.cmdlineBlock?.length ?? 0;
    return {
      x: (place.col + lead + caret.col) * cell.width,
      y: (place.row + above + caret.row) * cell.height,
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
    // In the bar, in the bar's colours and over it.
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
    this.preedit.style.zIndex = bar ? "401" : "";
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
    const step = imeStep(this.ime, event);
    this.ime = step.state;
    if (step.commit !== undefined) {
      if (this.dropComposition) {
        this.dropComposition = false;
      } else if (
        event.type === "input" &&
        event.inputType === "insertFromPaste"
      ) {
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
    input.addEventListener("keydown", (event) => {
      const meta = this.optionKeys.isMeta(this.settings.macOptionIsMeta, event);
      if (event.isComposing || this.ime.composing) return;
      // Cmd+V is the menu's Paste, which arrives as an `input` and is
      // handed to `nvim_paste`; Cmd+Q and the chords never get here.
      if (event.metaKey && (event.key === "v" || event.key === "V")) return;
      const keys = keyToNeovim(event, meta);
      if (keys === undefined) {
        // A Meta key whose Option is also a dead key starts a composition
        // macOS cannot be told not to start: its text is dropped.
        if (meta && event.altKey) this.dropComposition = true;
        return;
      }
      event.preventDefault();
      if (meta) this.dropComposition = true;
      this.send(keys);
    });
    input.addEventListener("keyup", (event) => {
      this.optionKeys.isMeta(this.settings.macOptionIsMeta, event);
      if (!event.altKey) this.dropComposition = false;
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
      this.port.call("nvim_ui_set_focus", [true]);
      this.placeCursor();
    });
    input.addEventListener("blur", () => {
      this.imeEvent({ type: "reset" });
      this.port.call("nvim_ui_set_focus", [false]);
      this.placeCursor();
    });

    const layer = this.gridLayer;
    const target = (event: MouseEvent): MouseTarget => {
      const rect = layer.getBoundingClientRect();
      return hitTest(
        this.boxes,
        this.painter.cell(),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
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
    // A GUI window and a popup are DevHub's: their own clicks and wheel.
    const ownedByGui = (event: Event) =>
      (event.target as HTMLElement).closest(".nvim-gui-window, .nvim-popup") !==
      null;
    layer.addEventListener("mousedown", (event) => {
      if (ownedByGui(event)) return;
      event.preventDefault();
      this.focus();
      const button = mouseButton(event.button);
      if (!button || !this.state.mouse) return;
      const at = target(event);
      this.dragging = { button, target: at };
      mouse(button, "press", event, at);
    });
    layer.addEventListener("mousemove", (event) => {
      this.hoverGrid(ownedByGui(event) ? undefined : target(event).grid);
    });
    layer.addEventListener("mouseleave", () => {
      this.hoverGrid(undefined);
    });
    window.addEventListener("mousemove", (event) => {
      const drag = this.dragging;
      if (!drag) return;
      const at = target(event);
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
      mouse(drag.button, "release", event, target(event));
    });
    layer.addEventListener(
      "wheel",
      (event) => {
        if (ownedByGui(event)) return;
        event.preventDefault();
        const at = target(event);
        for (const step of this.wheel.steps(
          event.deltaX,
          event.deltaY,
          event.deltaMode,
          this.painter.cell(),
        )) {
          mouse("wheel", step, event, at);
        }
      },
      { passive: false },
    );
  }
}
