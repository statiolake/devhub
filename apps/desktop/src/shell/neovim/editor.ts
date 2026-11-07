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
  initialUiState,
  layoutGrids,
  type GridBox,
  type NeovimUiState,
  type RedrawChanges,
} from "./redraw";
import {
  GridPainter,
  cssColor,
  rgbOfCss,
  parseGuifont,
  resolveColors,
  type FontSpec,
} from "./painter";
import { escapeInputText, keyToNeovim } from "./keys";
import { IDLE, imeStep, type ImeEvent, type ImeState } from "./ime";
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
}

export interface EditorSettings {
  /** DevHub's own monospace, used unless `guifont` says otherwise. */
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly macOptionIsMeta: MacOptionIsMeta;
}

export class NeovimEditor {
  readonly state: NeovimUiState = initialUiState(themeColors());
  private pending: RedrawChanges = emptyChanges();
  private frame = 0;
  private readonly painter: GridPainter;
  private readonly gridLayer: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private readonly preedit: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  private ime: ImeState = IDLE;
  private readonly optionKeys = new OptionKeys();
  private readonly wheel = new WheelAccumulator();
  private settings: EditorSettings;
  private size = { cols: 0, rows: 0 };
  private boxes: GridBox[] = [];
  private readonly listeners = new Set<() => void>();
  private dragging: { button: string; target: MouseTarget } | undefined;
  private dropComposition = false;
  private readonly observer: ResizeObserver;
  private disposed = false;

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
    this.preedit = document.createElement("div");
    this.preedit.className = "nvim-preedit";
    this.input = document.createElement("textarea");
    this.input.className = "nvim-input";
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "Neovim");
    this.gridLayer.append(this.cursor, this.preedit, this.input);
    host.append(this.gridLayer);
    this.painter = new GridPainter(this.gridLayer, this.fontSpec());
    this.bindInput();
    this.observer = new ResizeObserver(() => {
      this.resize();
    });
    this.observer.observe(host);
  }

  /** The grid size that fits the view now, for the attach. */
  fit(): { cols: number; rows: number } {
    const rect = this.host.getBoundingClientRect();
    return gridSizeFor(rect.width, rect.height, this.painter.cell());
  }

  attached(size: { cols: number; rows: number }): void {
    this.size = size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cellMetrics() {
    return this.painter.cell();
  }

  gridBoxes(): readonly GridBox[] {
    return this.boxes;
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

  /** Neovim went away: what is drawn stays, nothing is sent. */
  reset(): void {
    this.wheel.reset();
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.gridLayer.remove();
  }

  private fontSpec(): FontSpec {
    const guifont = parseGuifont(this.state?.options.get("guifont"));
    const linespace = this.state?.options.get("linespace");
    return {
      family: guifont?.family ?? this.settings.fontFamily,
      size: guifont?.size ?? this.settings.fontSize,
      linespace: typeof linespace === "number" ? linespace : 2,
    };
  }

  private applyFont(): void {
    if (this.painter.setFont(this.fontSpec())) {
      this.gridLayer.style.font = `${String(this.painter.fontSpec().size)}px ${this.painter.fontSpec().family}`;
      this.paint(true);
      this.resize();
    }
  }

  private paint(forceAll = false): void {
    if (this.disposed) return;
    const changes = this.pending;
    this.pending = emptyChanges();
    if (changes.options) this.applyFont();
    this.boxes = layoutGrids(this.state);
    this.host.style.background = cssColor(this.state.defaults.background);
    this.painter.paint(this.state, changes, this.boxes, forceAll);
    this.placeCursor();
    for (const listener of this.listeners) listener();
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
    const hidden =
      at === undefined || this.state.busy || this.state.cmdline.length > 0;
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
    this.cursor.style.zIndex = String(
      (this.boxes.find((b) => b.grid === grid)?.z ?? 0) + 1,
    );
    // The IME's candidate window opens at the textarea: keep it on the cursor.
    this.input.style.left = `${String(at.x)}px`;
    this.input.style.top = `${String(at.y)}px`;
    this.input.style.height = `${String(cell.height)}px`;
    this.placePreedit();
  }

  private placePreedit(): void {
    const at = this.cursorBox();
    const text = this.ime.preedit;
    this.preedit.style.display =
      text.length === 0 || at === undefined ? "none" : "";
    if (text.length === 0 || at === undefined) return;
    const cell = this.painter.cell();
    this.preedit.textContent = text;
    this.preedit.style.left = `${String(at.x)}px`;
    this.preedit.style.top = `${String(at.y)}px`;
    this.preedit.style.height = `${String(cell.height)}px`;
    this.preedit.style.lineHeight = `${String(cell.height)}px`;
    this.preedit.style.background = cssColor(this.state.defaults.background);
    this.preedit.style.color = cssColor(this.state.defaults.foreground);
    this.preedit.style.font = `${String(this.painter.fontSpec().size)}px ${this.painter.fontSpec().family}`;
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
    this.placePreedit();
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
    layer.addEventListener("mousedown", (event) => {
      if ((event.target as HTMLElement).closest(".nvim-gui-window")) return;
      event.preventDefault();
      this.focus();
      const button = mouseButton(event.button);
      if (!button || !this.state.mouse) return;
      const at = target(event);
      this.dragging = { button, target: at };
      mouse(button, "press", event, at);
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
        if ((event.target as HTMLElement).closest(".nvim-gui-window")) return;
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
