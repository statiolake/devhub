import { useEffect, useMemo, useRef, useState } from "react";
import "../../neovim/neovim.css";
import "../../surfaces/xtermSession.css";
import "../terminal.css";
import "./control.css";
import "./popup.css";
import "./prompt.css";
import "./menu.css";
import "./chooser.css";
import { useColorScheme } from "../../appearance";
import { Failure, Waiting } from "../../components/shell/SurfaceState";
import {
  GridPainter,
  cssColor,
  mixColors,
  rgbOfCss,
  type FontSpec,
} from "../../neovim/painter";
import { terminalCellFont } from "../../neovim/cellFont";
import { emptyChanges } from "../../neovim/redraw";
import {
  IDLE,
  imeStep,
  preeditLayout,
  type ImeEvent,
  type ImeState,
} from "../../neovim/ime";
import { layoutMapSource } from "../../surfaces/baseKeys";
import {
  activePalette,
  terminalSurfaceStyle,
  type TerminalPalette,
} from "../theme";
import {
  createTerminalClient,
  retriesAttach,
  terminalErrorSummary,
  type TerminalReceipt,
} from "../client";
import { TERMINAL_PROTOCOL_VERSION } from "../../../ipc/terminal";
import type {
  TerminalOverlaidWire,
  TerminalPanesWire,
} from "../../../ipc/contract";
import type {
  ControlToPage,
  PageToControl,
  PaneBox,
  StatusColor,
  StatusLine,
} from "../../../ipc/terminalControl";
import { pasteBytes, sgrMouse, TerminalKeys } from "./controlKeys";
import { surfaceBridge } from "../surfaceBridge";
import "./copyMode.css";
import {
  applyControl,
  borders,
  gridOf,
  POPUP_GRID,
  paneOutlines,
  plainBorders,
  newControlView,
  paneAt,
  paneBoxes,
  type ControlView,
} from "./paneGrids";
import { CONTROL_Z, controlZStyle } from "./stacking";
import type { TerminalSurfaceProps } from "../TerminalSurface";
import { WindowStrip } from "./WindowStrip";
import { CompletionMenu } from "../../completion/CompletionMenu";
import type { Kind } from "../../neovim/kinds";

/**
 * A terminal surface in tmux control mode (`[terminal] tmux_control_mode`,
 * `docs/terminal-mode.md`): one control client for the surface's session,
 * in the pty host, and every pane of the shown window drawn here by the
 * Neovim editor's painter, at the rectangle tmux gives it, with hairlines
 * between panes instead of border characters. Keys go to tmux by name, so
 * the prefix and the bindings are tmux's (`controlKeys.ts`); what tmux does
 * not draw for a control client is not let wait on it (`keyGuard.ts`).
 *
 * The connection follows the xterm.js surface's rules (`TerminalSurface`):
 * a session that ended is made again every time (`reattachOnExit`), and said
 * to be disconnected only when one made again ends within
 * `REATTACH_ON_EXIT_MS` with nothing typed into it — a shell that cannot
 * start; "typed" is a key or a paste on the surface, never the stream. Retry
 * and every connect put the keys in the terminal when the surface is on
 * screen and nothing outside it has them; keys typed during a Retry or a
 * reattach are held for the new client.
 */

const REATTACH_ON_EXIT_MS = 3_000;
const NOTICE_MS = 4_000;

type Connection = "connecting" | "connected" | "disconnected";

/** xterm's 256 colours past the theme's 16: the cube and the greys. */
function palette256(ansi: readonly number[]): number[] {
  const out = [...ansi];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    out.push(
      (steps[Math.floor(i / 36)] << 16) |
        (steps[Math.floor(i / 6) % 6] << 8) |
        steps[i % 6],
    );
  }
  for (let i = 0; i < 24; i++) {
    const g = 8 + i * 10;
    out.push((g << 16) | (g << 8) | g);
  }
  return out;
}

/**
 * tmux's kinds of completion (`ptyHost/control/prompt.ts`) as the shared
 * menu's marks, each in a colour of the theme's 16.
 */
const TMUX_KINDS: Record<
  "command" | "option" | "layout" | "session" | "window",
  { readonly mark: Kind; readonly ansi: number }
> = {
  command: { mark: "Function", ansi: 4 },
  option: { mark: "Property", ansi: 6 },
  layout: { mark: "EnumMember", ansi: 3 },
  session: { mark: "Module", ansi: 5 },
  window: { mark: "Folder", ansi: 2 },
};

/** Where the prompt's completion menu is drawn, and what it holds. */
interface PromptMenu {
  readonly items: NonNullable<
    Extract<ControlToPage, { kind: "prompt" }>["completion"]
  >["items"];
  readonly choice: number;
  /** In the shell: the completed word's left edge, the prompt line's top. */
  readonly x: number;
  readonly bottom: number;
  readonly cell: number;
  readonly row: number;
  readonly fontSize: number;
  readonly font: string;
}

/** A colour tmux names, in the theme's palette: its 16 first, then xterm's. */
function cssOfStatusColor(
  color: StatusColor,
  palette: readonly number[] | undefined,
): string {
  const rgb =
    "rgb" in color ? color.rgb : (palette?.[color.index] ?? undefined);
  return rgb === undefined
    ? "currentColor"
    : `#${rgb.toString(16).padStart(6, "0")}`;
}

function colorsOf(palette: TerminalPalette | undefined) {
  const foreground = rgbOfCss(palette?.foreground ?? "") ?? 0xd0d0d0;
  const background = rgbOfCss(palette?.background ?? "") ?? 0x1e1e1e;
  const ansi = (palette?.ansi ?? []).map((c) => rgbOfCss(c) ?? 0);
  return {
    foreground,
    background,
    // The selection's colour, Neovim's Visual: copy mode's selection.
    selection:
      rgbOfCss(palette?.selectionBackground ?? "") ??
      mixColors(foreground, background, 25),
    // The block cursor is the theme's `cursor`, the character in it its
    // `cursor_text` (as Ghostty and the old terminal draw them).
    cursor: rgbOfCss(palette?.cursor ?? "") ?? foreground,
    cursorText: rgbOfCss(palette?.cursorText ?? "") ?? background,
    palette: ansi.length === 16 ? palette256(ansi) : undefined,
  };
}

export function ControlTerminalSurface({
  surfaceKey,
  surfaceLabel,
  appearance,
  client,
  hideTitle = false,
  hidden = false,
  reattachOnExit = false,
  onControlPanes,
  overlaid,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const boundClient = useMemo(() => client ?? createTerminalClient(), [client]);
  const dark = useColorScheme() === "dark";
  const palette = activePalette(appearance, dark);
  const colors = useMemo(() => colorsOf(palette), [palette]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [tabs, setTabs] = useState<ControlView["windows"]>([]);
  const [status, setStatus] = useState<StatusLine | undefined>();
  const [promptMenu, setPromptMenu] = useState<PromptMenu | undefined>();
  const [shown, setShown] = useState(!hidden);
  if (!hidden && !shown) setShown(true);
  const controllerRef = useRef<{
    retry(): void;
    visible(on: boolean): void;
    colors(c: ReturnType<typeof colorsOf>): void;
    font(spec: FontSpec): void;
    selectWindow(id: number): void;
    completePrompt(index: number): void;
    windowMenu(id: number, x: number): void;
    focus(): void;
    overlaid(o: TerminalOverlaidWire | undefined): void;
  } | null>(null);
  const live = useRef({
    hidden,
    reattachOnExit,
    appearance,
    colors,
    onControlPanes,
    overlaid,
  });
  live.current = {
    hidden,
    reattachOnExit,
    appearance,
    colors,
    onControlPanes,
    overlaid,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !shown) return;
    const shell = host.parentElement;
    const grids = document.createElement("div");
    grids.className = "nvim-grids control-grids";
    const lines = document.createElement("div");
    lines.className = "control-borders";
    const cursor = document.createElement("div");
    cursor.className = "control-cursor";
    // The character under a block cursor, painted as its row paints it
    // (`paintCursorCell`, as the Neovim editor's cursor).
    const cursorCell = document.createElement("canvas");
    cursor.append(cursorCell);
    const popupFrame = document.createElement("div");
    popupFrame.className = "control-popup";
    popupFrame.hidden = true;
    const promptLine = document.createElement("div");
    promptLine.className = "control-prompt";
    promptLine.hidden = true;
    const menuEl = document.createElement("div");
    menuEl.className = "control-menu";
    menuEl.setAttribute("role", "menu");
    menuEl.hidden = true;
    const chooserEl = document.createElement("div");
    chooserEl.className = "control-chooser";
    chooserEl.setAttribute("role", "dialog");
    chooserEl.hidden = true;
    const numbersEl = document.createElement("div");
    const copyEl = document.createElement("div");
    // An IME's preedit, drawn at the cursor as the Neovim editor draws it.
    const preedit = document.createElement("canvas");
    preedit.className = "control-preedit";
    preedit.hidden = true;
    // The terminal's ground, drawn here rather than by the page's boxes so
    // that it can leave a Neovim's pane clear (`drawHoles`).
    const backdrop = document.createElement("div");
    backdrop.className = "control-backdrop";
    shell?.prepend(backdrop);
    const input = document.createElement("textarea");
    input.className = "control-input";
    input.setAttribute("aria-label", `${surfaceLabel} terminal input`);
    input.autocapitalize = "off";
    input.spellcheck = false;
    host.append(
      grids,
      lines,
      popupFrame,
      promptLine,
      menuEl,
      chooserEl,
      numbersEl,
      copyEl,
      cursor,
      preedit,
      input,
    );

    // The cell is the Neovim editor's (`cellFont.ts`), so a Neovim drawn
    // over a pane lines up with it.
    const painter = new GridPainter(
      grids,
      terminalCellFont(live.current.appearance),
    );
    const font = () => painter.fontSpec();
    const view = newControlView(live.current.colors);
    view.selection = live.current.colors.selection;
    const terminalKeys = new TerminalKeys();
    void terminalKeys.layout.loadLayout(layoutMapSource());

    let disposed = false;
    let receipt: TerminalReceipt | undefined;
    let serial = 0;
    let connectedAt = 0;
    let typed = false;
    let reattachedOnExit = false;
    /** Attaches refused as stale in a row (`retriesAttach`). */
    let staleRetries = 0;
    /** Messages for a client being attached: the person's keys meanwhile. */
    let held: PageToControl[] | undefined;
    let pendingChanges: ReturnType<typeof applyControl>[] = [];
    let frameRequested = false;
    let lastSeq = 0;
    let ackedSeq = 0;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    let size = { cols: 0, rows: 0 };
    let reported = "";

    // Where the panes are drawn and what each is, for a Neovim DevHub draws
    // over one (`main/editor/terminalNeovims.ts`): said when it changes.
    const report = () => {
      const tell = live.current.onControlPanes;
      if (tell === undefined) return;
      const at = grids.getBoundingClientRect();
      const { width, height } = cell();
      const connected = receipt !== undefined;
      const panes: TerminalPanesWire = {
        x: at.x,
        y: at.y,
        cellWidth: width,
        cellHeight: height,
        cols: view.cols,
        rows: view.rows,
        client: connected ? view.client : "",
        prefixes: view.prefixes,
        shown: connected ? view.panes : [],
        panes: view.sessionPanes,
        // What DevHub draws over the panes (a popup, a prompt, a menu, the
        // picker) is to be over a Neovim drawn over one too: main puts this
        // page above the Neovims while it is open. Said once the frame
        // that leaves their panes clear has been drawn (`paint`).
        covered: connected && coverSaid,
      };
      const key = JSON.stringify(panes);
      if (key === reported) return;
      reported = key;
      tell(panes);
    };

    let wasCovered = false;
    let coverSaid = false;
    let coverWaits = false;
    const covered = () =>
      view.popup !== undefined ||
      view.prompt !== undefined ||
      view.menu !== undefined ||
      view.chooser !== undefined ||
      view.numbers !== undefined;
    /**
     * The panes a Neovim is drawn over (main's word, `TerminalOverlaidWire`)
     * that are left clear, so that it shows through this page while the page
     * is above it: while something covers the panes, and until main has put
     * the page back under the Neovims. Under them, a clear pane is never
     * seen; a pane in a mode is tmux's to draw (copy mode), not Neovim's.
     */
    const holes = (): PaneBox[] => {
      const o = live.current.overlaid;
      if (o === undefined || o.panes.length === 0) return [];
      if (!covered() && !o.raised) return [];
      const inMode = new Set(
        view.sessionPanes.filter((p) => p.inMode).map((p) => p.pane),
      );
      return view.panes.filter(
        (box) => o.panes.includes(box.pane) && !inMode.has(box.pane),
      );
    };
    let holesDrawn = "";
    /**
     * The terminal's ground with the holes cut out, and the page's own
     * boxes clear (`overlaid-holes` in `control.css`), in whole pixels inside
     * the Neovim's view (main rounds its edges to the nearest pixel).
     */
    const drawHoles = (cut: readonly PaneBox[]) => {
      const { width, height } = cell();
      const at = grids.getBoundingClientRect();
      const base = shell?.getBoundingClientRect() ?? at;
      const rects = cut.map((box) => {
        const left = Math.ceil(at.x + box.x * width - base.x);
        const top = Math.ceil(at.y + box.y * height - base.y);
        const right = Math.floor(at.x + (box.x + box.width) * width - base.x);
        const bottom = Math.floor(
          at.y + (box.y + box.height) * height - base.y,
        );
        return `M${String(left)} ${String(top)}H${String(right)}V${String(bottom)}H${String(left)}Z`;
      });
      const key = rects.join("");
      if (key === holesDrawn) return;
      holesDrawn = key;
      if (rects.length === 0) {
        backdrop.style.clipPath = "";
        delete document.documentElement.dataset.overlaidHoles;
        return;
      }
      backdrop.style.clipPath = `path(evenodd, "M-99999 -99999H99999V99999H-99999Z${key}")`;
      document.documentElement.dataset.overlaidHoles = "true";
    };
    const cell = () => painter.cell();
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const { width, height } = cell();
      // The window strip is beside the host, not in it: the host is the panes'.
      return {
        cols: Math.max(2, Math.floor(rect.width / width)),
        rows: Math.max(2, Math.floor(rect.height / height)),
        pixelWidth: Math.round(rect.width),
        pixelHeight: Math.round(rect.height),
      };
    };

    const send = (message: PageToControl) => {
      const r = receipt;
      if (r === undefined) {
        if (
          held !== undefined &&
          (message.kind === "keys" || message.kind === "bytes")
        ) {
          held.push(message);
        }
        return;
      }
      boundClient
        .control({
          surfaceKey: r.surfaceKey,
          attachmentId: r.attachmentId,
          targetGeneration: r.targetGeneration,
          message,
        })
        .catch(() => undefined);
    };

    const activePane = (): PaneBox | undefined =>
      view.panes.find((p) => p.active);

    const paint = () => {
      frameRequested = false;
      if (disposed) return;
      const changes = pendingChanges;
      pendingChanges = [];
      const merged = changes.reduce((a, b) => {
        for (const g of b.grids) a.grids.add(g);
        a.layout ||= b.layout;
        a.cursor ||= b.cursor;
        return a;
      });
      const { width, height } = cell();
      const cut = holes();
      const clear = new Set(cut.map((box) => gridOf(box.pane)));
      const boxes = paneBoxes(view).filter((box) => !clear.has(box.grid));
      painter.paint(view.state, merged, boxes, merged.layout);
      drawHoles(cut);
      // tmux's panes as panes with a boundary between them, as the Neovim
      // editor's windows are (docs/rendering-layers.md, "Panes and
      // boundaries"): each pane's ground reaches exactly half into the
      // border cell beside it, so panes split across and down line up, and
      // the boundary is a hairline on the shared edge. tmux's border cells
      // are not drawn. All on whole device pixels.
      const dpr = window.devicePixelRatio || 1;
      const snap = (v: number) => Math.round(v * dpr) / dpr;
      const totalWidth = view.cols * width;
      const totalHeight = view.rows * height;
      painter.placeGrounds(
        view.panes
          .filter((p) => !clear.has(gridOf(p.pane)))
          .map((p) => {
            const x0 = p.x > 0 ? snap((p.x - 0.5) * width) : p.x * width;
            const x1 =
              p.x + p.width < view.cols
                ? snap((p.x + p.width + 0.5) * width)
                : (p.x + p.width) * width;
            const y0 = p.y > 0 ? snap((p.y - 0.5) * height) : p.y * height;
            const y1 =
              p.y + p.height < view.rows
                ? snap((p.y + p.height + 0.5) * height)
                : (p.y + p.height) * height;
            return {
              key: p.pane,
              z: CONTROL_Z.panes,
              x: x0,
              y: y0,
              w: x1 - x0,
              h: y1 - y0,
              colour: view.state.defaults.background,
            };
          }),
      );
      // The boundaries, and the active (and synchronized) panes' outlines
      // as stretches of them, recoloured and thicker (`paneOutlines`): a
      // 1px hairline and a 2px outline, each centred on the shared edge;
      // each outline piece runs on over the corner it shares with the
      // next, so the corners are square and filled.
      const outlines = paneOutlines(view.panes);
      const thick = 2;
      const edge = (cells: number, size: number) => snap(cells * size);
      lines.replaceChildren(
        ...plainBorders(borders(view.panes), outlines).map((line) => {
          const el = document.createElement("div");
          el.className = line.vertical
            ? "control-border-v"
            : "control-border-h";
          if (line.vertical) {
            const top = edge(line.y, height);
            el.style.left = `${String(snap(edge(line.x + 0.5, width) - 0.5))}px`;
            el.style.top = `${String(top)}px`;
            el.style.height = `${String(edge(line.y + line.length, height) - top)}px`;
          } else {
            const left = edge(line.x, width);
            el.style.left = `${String(left)}px`;
            el.style.top = `${String(snap(edge(line.y + 0.5, height) - 0.5))}px`;
            el.style.width = `${String(edge(line.x + line.length, width) - left)}px`;
          }
          return el;
        }),
        ...outlines.map((line) => {
          const el = document.createElement("div");
          el.className = "control-outline";
          if (line.active) el.dataset.active = "true";
          el.dataset.vertical = String(line.vertical);
          const along = (from: number, to: number, total: number) => {
            const a = from > 0 ? from - thick / 2 : 0;
            const b = to < total ? to + thick / 2 : total;
            return [a, b - a] as const;
          };
          if (line.vertical) {
            const [top, length] = along(
              edge(line.y, height),
              edge(line.y + line.length, height),
              totalHeight,
            );
            el.style.left = `${String(edge(line.x + 0.5, width) - thick / 2)}px`;
            el.style.top = `${String(top)}px`;
            el.style.width = `${String(thick)}px`;
            el.style.height = `${String(length)}px`;
          } else {
            const [left, length] = along(
              edge(line.x, width),
              edge(line.x + line.length, width),
              totalWidth,
            );
            el.style.left = `${String(left)}px`;
            el.style.top = `${String(edge(line.y + 0.5, height) - thick / 2)}px`;
            el.style.width = `${String(length)}px`;
            el.style.height = `${String(thick)}px`;
          }
          return el;
        }),
      );
      const popup = view.popup;
      popupFrame.hidden = popup === undefined;
      if (popup !== undefined) {
        popupFrame.dataset.border = String(popup.border);
        popupFrame.style.left = `${String(popup.x * width)}px`;
        popupFrame.style.top = `${String(popup.y * height)}px`;
        popupFrame.style.width = `${String(popup.width * width)}px`;
        popupFrame.style.height = `${String(popup.height * height)}px`;
        if (popupFrame.dataset.title !== popup.title) {
          popupFrame.dataset.title = popup.title;
          popupFrame.replaceChildren(
            ...(popup.title === ""
              ? []
              : [
                  Object.assign(document.createElement("span"), {
                    className: "control-popup-title",
                    textContent: popup.title,
                  }),
                ]),
          );
        }
      }
      drawPrompt(width, height);
      drawMenu(width, height);
      drawChooser(width, height);
      drawNumbers(width, height);
      drawCopy(width, height);
      // While a popup is open its cursor is the one shown, over it.
      const inset = popup?.border === true ? 1 : 0;
      const pane =
        popup !== undefined
          ? {
              pane: -1,
              x: popup.x + inset,
              y: popup.y + inset,
              width: 0,
              height: 0,
              active: true,
            }
          : activePane();
      const at =
        popup !== undefined
          ? popup.cursor
          : pane === undefined
            ? undefined
            : view.cursors.get(pane.pane);
      cursor.style.zIndex =
        popup === undefined ? "" : String(CONTROL_Z.popupCursor);
      if (
        pane === undefined ||
        at === undefined ||
        !at.visible ||
        cut.some((box) => box.pane === pane.pane) ||
        view.prompt !== undefined ||
        view.menu !== undefined ||
        view.chooser !== undefined
      ) {
        cursor.style.display = "none";
      } else {
        cursor.style.display = "";
        cursor.dataset.shape = String(at.shape);
        const grid = view.state.grids.get(
          popup !== undefined ? POPUP_GRID : gridOf(pane.pane),
        );
        const wide =
          grid !== undefined &&
          at.y < grid.height &&
          grid.chars[at.y * grid.width + at.x + 1] === "";
        // The program's colour (OSC 12) or the theme's; the character in a
        // block in the theme's `cursor_text`.
        const { cursor: themeCursor, cursorText } = live.current.colors;
        const color = at.color ?? themeCursor;
        cursor.style.setProperty("--control-cursor", cssColor(color));
        cursor.style.left = `${String((pane.x + at.x) * width)}px`;
        cursor.style.top = `${String((pane.y + at.y) * height)}px`;
        cursor.style.width = `${String(width * (wide ? 2 : 1))}px`;
        cursor.style.height = `${String(height)}px`;
        if (at.shape === 1 && grid !== undefined) {
          painter.paintCursorCell(
            cursorCell,
            view.state,
            {
              grid: popup !== undefined ? POPUP_GRID : gridOf(pane.pane),
              row: at.y,
              col: at.x,
            },
            cursorText,
            color,
          );
        }
        input.style.left = cursor.style.left;
        input.style.top = cursor.style.top;
      }
      if (ime.preedit !== "") placePreedit();
      if (lastSeq > ackedSeq) {
        ackedSeq = lastSeq;
        send({ kind: "ack", seq: lastSeq });
      }
      // What covers the panes is said when it changes: an opening once this
      // frame, which leaves the Neovims' panes clear, has been drawn, so
      // that main never puts the page above them before; a closing at once
      // (the panes stay clear until main has put the page back under them).
      const now = covered();
      if (!now) coverSaid = false;
      else if (!coverSaid && !coverWaits) {
        coverWaits = true;
        requestAnimationFrame(() => {
          coverWaits = false;
          if (disposed) return;
          coverSaid = covered();
          report();
        });
      }
      if (merged.layout || now !== wasCovered) report();
      wasCovered = now;
    };

    // The prompt's line (`prompt.css`): the panes' last row, in their font.
    let promptShown = "";
    const drawPrompt = (width: number, height: number) => {
      const prompt = view.prompt;
      promptLine.hidden = prompt === undefined;
      if (prompt === undefined) {
        promptShown = "";
        setPromptMenu(undefined);
        return;
      }
      // A search from copy mode is asked at the foot of its pane, as wide.
      const pane = activePane();
      const inPane =
        prompt.search && pane !== undefined && view.copy.has(pane.pane);
      const box = inPane
        ? pane
        : { x: 0, y: 0, width: view.cols, height: Math.max(1, view.rows) };
      promptLine.style.left = `${String(box.x * width)}px`;
      promptLine.style.top = `${String((box.y + box.height - 1) * height)}px`;
      promptLine.style.height = `${String(height)}px`;
      promptLine.style.width = `${String(Math.max(1, box.width) * width)}px`;
      promptLine.style.right = "auto";
      promptLine.style.font = `${String(font().size)}px/${String(height)}px ${font().family}`;
      const key = JSON.stringify(prompt);
      if (key === promptShown) return;
      promptShown = key;
      promptLine.dataset.command = String(prompt.command);
      const chars = [...prompt.input];
      const at = Math.min(prompt.cursor, chars.length);
      const span = (className: string, text: string) =>
        Object.assign(document.createElement("span"), {
          className,
          textContent: text,
        });
      const caret = span("control-prompt-cursor", chars[at] ?? " ");
      const line = document.createElement("span");
      line.className = "control-prompt-line";
      line.append(
        span("control-prompt-label", prompt.prompt),
        chars.slice(0, at).join(""),
        // A confirm-before takes one key: no cursor in a line, as tmux.
        ...(prompt.confirm ? [] : [caret]),
        chars.slice(at + 1).join(""),
      );
      const hint = document.createElement("span");
      hint.className = "control-prompt-hint";
      const kbd = (text: string) =>
        Object.assign(document.createElement("kbd"), { textContent: text });
      if (prompt.completion !== undefined) {
        // Tab's menu takes the keys, as tmux's does.
        hint.append(
          "choose ",
          kbd("Tab"),
          kbd("↑"),
          kbd("↓"),
          " · put in ",
          kbd("Enter"),
          " · close ",
          kbd("Esc"),
        );
      } else if (!prompt.confirm) {
        // What tmux's keys do here, the vi table's in its command mode.
        hint.append(
          "history ",
          kbd("↑"),
          kbd("↓"),
          " · run ",
          kbd("Enter"),
          " · cancel ",
          ...(prompt.vi ? [kbd("Esc"), " ", kbd("q")] : [kbd("Esc")]),
        );
      }
      promptLine.replaceChildren(line, hint);
      // The cursor in view, as tmux scrolls a long line to keep it there.
      const left = caret.offsetLeft - line.offsetLeft;
      line.scrollLeft = Math.max(0, left - line.clientWidth + 2 * width);
      // Tab's menu over the line, its words over the word they complete
      // (`CompletionMenu`, the Neovim editor's look).
      const completion = prompt.completion;
      if (completion === undefined) setPromptMenu(undefined);
      else {
        const label = line.firstElementChild as HTMLElement | null;
        const x =
          host.offsetLeft +
          promptLine.offsetLeft +
          line.offsetLeft +
          (label?.offsetWidth ?? 0) +
          completion.column * width -
          line.scrollLeft;
        setPromptMenu({
          items: completion.items,
          choice: completion.choice,
          x,
          bottom:
            (shell?.clientHeight ?? 0) -
            (host.offsetTop + promptLine.offsetTop),
          cell: width,
          row: height,
          fontSize: font().size,
          font: font().family,
        });
      }
    };

    // A menu (`menu.css`): where tmux would put it, kept inside the panes.
    let menuShown = "";
    const drawMenu = (width: number, height: number) => {
      const menu = view.menu;
      menuEl.hidden = menu === undefined;
      if (menu === undefined) {
        menuShown = "";
        return;
      }
      const key = JSON.stringify(menu);
      if (key !== menuShown) {
        menuShown = key;
        const rows: HTMLElement[] = [];
        if (menu.title !== "")
          rows.push(
            Object.assign(document.createElement("div"), {
              className: "control-menu-title",
              textContent: menu.title,
            }),
          );
        menu.items.forEach((item, index) => {
          if (item.name === undefined) {
            rows.push(
              Object.assign(document.createElement("div"), {
                className: "control-menu-rule",
              }),
            );
            return;
          }
          const row = document.createElement("div");
          row.className = "control-menu-item";
          row.setAttribute("role", "menuitem");
          row.dataset.index = String(index);
          row.setAttribute("aria-selected", String(index === menu.choice));
          if (item.disabled === true) row.setAttribute("aria-disabled", "true");
          row.append(
            Object.assign(document.createElement("span"), {
              className: "control-menu-name",
              textContent: item.name,
            }),
          );
          if (item.key !== undefined)
            row.append(
              Object.assign(document.createElement("span"), {
                className: "control-menu-key",
                textContent: item.key,
              }),
            );
          rows.push(row);
        });
        menuEl.replaceChildren(...rows);
        menuEl.style.minWidth = `${String(menu.width * width)}px`;
      }
      // `-x W`: over the window's tab, which is DevHub's status line.
      let left = 0;
      if (menu.x === "W") {
        const id = menu.window ?? view.window;
        const tab = shell?.querySelector<HTMLElement>(
          `.control-window[data-window="${String(id)}"]`,
        );
        if (tab !== null && tab !== undefined)
          left =
            tab.getBoundingClientRect().left -
            host.getBoundingClientRect().left;
      } else left = menu.x * width;
      const room = host.clientHeight;
      const tall = menuEl.offsetHeight;
      const top = Math.max(0, Math.min(menu.y * height, room - tall));
      menuEl.style.left = `${String(Math.max(0, Math.min(left, host.clientWidth - menuEl.offsetWidth)))}px`;
      menuEl.style.top = `${String(top)}px`;
      menuEl
        .querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    };
    // The picker (`chooser.css`): its frame and tree; the painter draws the
    // preview's grid over it.
    let chooserShown = "";
    const drawChooser = (width: number, height: number) => {
      const chooser = view.chooser;
      chooserEl.hidden = chooser === undefined;
      if (chooser === undefined) {
        chooserShown = "";
        return;
      }
      const key = JSON.stringify(chooser);
      if (key === chooserShown) return;
      chooserShown = key;
      Object.assign(chooserEl.style, {
        left: `${String(chooser.x * width)}px`,
        top: `${String(chooser.y * height)}px`,
        width: `${String(chooser.width * width)}px`,
        height: `${String(chooser.height * height)}px`,
      });
      const filter = document.createElement("div");
      filter.className = "control-chooser-filter";
      filter.style.height = `${String(1.5 * height)}px`;
      filter.style.lineHeight = `${String(1.5 * height)}px`;
      const typed = document.createElement("b");
      typed.textContent = chooser.filter;
      const caret = Object.assign(document.createElement("span"), {
        className: "control-prompt-cursor",
        textContent: " ",
      });
      filter.append(
        chooser.filter === "" ? "Type to filter · " : "Filter: ",
        typed,
        caret,
      );
      const tree = document.createElement("div");
      tree.className = "control-chooser-tree";
      const treeTop = 2 * height;
      tree.style.top = `${String(treeTop)}px`;
      tree.style.width = `${String((chooser.preview.x - chooser.x) * width)}px`;
      tree.style.font = `${String(font().size)}px/${String(height)}px ${font().family}`;
      const visible = Math.max(1, chooser.height - 2);
      const first = Math.max(
        0,
        Math.min(
          chooser.choice - Math.floor(visible / 2),
          chooser.rows.length - visible,
        ),
      );
      chooser.rows.slice(first, first + visible).forEach((row, i) => {
        const index = first + i;
        const el = document.createElement("div");
        el.className = "control-chooser-row";
        el.dataset.index = String(index);
        el.dataset.current = String(row.current);
        el.setAttribute("aria-selected", String(index === chooser.choice));
        const mark =
          row.expanded === undefined ? "  " : row.expanded ? "▾ " : "▸ ";
        el.textContent = `${"  ".repeat(row.depth)}${mark}${row.text}`;
        el.style.paddingLeft = `${String(width)}px`;
        tree.append(el);
      });
      chooserEl.replaceChildren(filter, tree);
    };
    // Copy mode (`copyMode.css`): tmux's position as a badge at the pane's
    // top right, and where the view is in the history as a thin bar.
    const drawCopy = (width: number, height: number) => {
      copyEl.replaceChildren(
        ...view.panes.flatMap((box) => {
          const copy = view.copy.get(box.pane);
          if (copy === undefined) return [];
          const badge = Object.assign(document.createElement("div"), {
            className: "control-copy-badge",
            textContent: copy.badge,
          });
          badge.style.right = `${String((view.cols - box.x - box.width) * width + 4)}px`;
          badge.style.top = `${String(box.y * height + 4)}px`;
          const out: HTMLElement[] = [badge];
          if (copy.history > 0) {
            const whole = box.height * height;
            const bar = Math.max(
              12,
              (whole * box.height) / (copy.history + box.height),
            );
            const top =
              ((copy.history - copy.scroll) / copy.history) * (whole - bar);
            const thumb = document.createElement("div");
            thumb.className = "control-copy-scroll";
            thumb.style.left = `${String((box.x + box.width) * width - 4)}px`;
            thumb.style.top = `${String(box.y * height + top)}px`;
            thumb.style.height = `${String(bar)}px`;
            out.push(thumb);
          }
          return out;
        }),
      );
    };
    // `display-panes`: each pane's index in its middle.
    const drawNumbers = (width: number, height: number) => {
      const numbers = view.numbers;
      if (numbers === undefined) {
        numbersEl.replaceChildren();
        return;
      }
      numbersEl.replaceChildren(
        ...view.panes.flatMap((box) => {
          const index = numbers.panes.find((p) => p.pane === box.pane)?.index;
          if (index === undefined) return [];
          return [
            Object.assign(document.createElement("div"), {
              className: "control-number",
              textContent: String(index),
              style: `left:${String(box.x * width)}px;top:${String(box.y * height)}px;width:${String(box.width * width)}px;height:${String(box.height * height)}px`,
            }),
          ];
        }),
      );
    };
    // The mouse on the picker: a row chooses, outside it closes it.
    const onChooserMouseDown = (event: MouseEvent) => {
      if (view.chooser === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      input.focus();
      const row = (event.target as HTMLElement).closest<HTMLElement>(
        ".control-chooser-row",
      );
      if (row !== null && event.button === 0)
        send({
          kind: "chooser",
          action: "choose",
          index: Number(row.dataset.index),
        });
      else if (!chooserEl.contains(event.target as Node))
        send({ kind: "chooser", action: "close" });
    };
    host.addEventListener("mousedown", onChooserMouseDown, true);
    // The mouse on a menu: an item chooses, anywhere else closes it.
    const onMenuMouseDown = (event: MouseEvent) => {
      if (view.menu === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      input.focus();
      const row = (event.target as HTMLElement).closest<HTMLElement>(
        ".control-menu-item",
      );
      if (row !== null && menuEl.contains(row) && event.button === 0)
        send({
          kind: "menu",
          action: "choose",
          index: Number(row.dataset.index),
        });
      else if (!menuEl.contains(event.target as Node))
        send({ kind: "menu", action: "close" });
    };
    host.addEventListener("mousedown", onMenuMouseDown, true);

    const schedule = (changes: ReturnType<typeof applyControl>) => {
      pendingChanges.push(changes);
      if (frameRequested) return;
      frameRequested = true;
      requestAnimationFrame(paint);
    };

    const say = (text: string) => {
      setNotice(text);
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    };

    const focusIfUnclaimed = () => {
      if (live.current.hidden) return;
      const active = document.activeElement;
      if (
        active === null ||
        active === document.body ||
        (shell?.contains(active) ?? false)
      ) {
        input.focus();
      }
    };

    const onMessage = (attachSerial: number) => (value: unknown) => {
      if (disposed || attachSerial !== serial) return;
      const message = value as ControlToPage;
      if (message.kind === "notice") {
        say(message.text);
        return;
      }
      if (message.kind === "clipboard") {
        void surfaceBridge().writeClipboard(message.text);
        return;
      }
      if (message.kind === "ended") {
        const ended = receipt;
        receipt = undefined;
        const lived = typed || Date.now() - connectedAt >= REATTACH_ON_EXIT_MS;
        if (ended !== undefined) void detach(ended);
        report();
        if (live.current.reattachOnExit && (!reattachedOnExit || lived)) {
          setConnection("connecting");
          queueMicrotask(() => {
            if (!disposed && attachSerial === serial)
              void attach({ onExit: true });
          });
          return;
        }
        setError(undefined);
        setConnection("disconnected");
        return;
      }
      if (message.kind === "pane") lastSeq = Math.max(lastSeq, message.seq);
      if (message.kind === "layout") {
        setTabs(message.windows);
        setStatus(message.status);
      }
      schedule(applyControl(view, message));
    };

    const detach = async (r: TerminalReceipt) => {
      await boundClient
        .detach({
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          surfaceKey: r.surfaceKey,
          attachmentId: r.attachmentId,
          targetGeneration: r.targetGeneration,
        })
        .catch(() => undefined);
    };

    const attach = async ({ onExit = false } = {}) => {
      const mine = ++serial;
      reattachedOnExit = onExit;
      typed = false;
      // Whatever is typed while a client is being attached is the person's
      // and goes to it: at the first show, a Retry, a reattach on exit.
      held = [];
      const previous = receipt;
      receipt = undefined;
      if (previous !== undefined) void detach(previous);
      setConnection("connecting");
      size = measure();
      try {
        const answer = await boundClient.attach(
          {
            schemaVersion: TERMINAL_PROTOCOL_VERSION,
            surfaceKey,
            targetGeneration: 0,
            cols: size.cols,
            rows: size.rows,
            pixelWidth: Math.round(size.cols * cell().width),
            pixelHeight: Math.round(size.rows * cell().height),
            mode: "control",
          },
          onMessage(mine),
        );
        if (disposed || mine !== serial) {
          void detach(answer);
          return;
        }
        receipt = answer;
        staleRetries = 0;
        connectedAt = Date.now();
        setConnection("connected");
        setError(undefined);
        const now = live.current.colors;
        send({
          kind: "colors",
          foreground: now.foreground,
          background: now.background,
          ...(now.palette ? { palette: now.palette } : {}),
        });
        if (live.current.hidden) send({ kind: "visible", visible: false });
        const waiting = held ?? [];
        held = undefined;
        for (const message of waiting) send(message);
        focusIfUnclaimed();
      } catch (failure: unknown) {
        if (disposed || mine !== serial) return;
        if (retriesAttach(failure, staleRetries)) {
          staleRetries += 1;
          window.setTimeout(() => {
            if (!disposed && mine === serial) void attach({ onExit });
          }, 150 * staleRetries);
          return;
        }
        staleRetries = 0;
        setError(terminalErrorSummary(failure));
        setConnection("disconnected");
      }
    };

    // Keys: by name, through tmux's tables.
    const markTyped = () => {
      typed = true;
    };
    // Option as Meta, by the physical key; a Meta dead key's composition
    // kept from the pane (`TerminalKeys`).
    const onKeyDown = (event: KeyboardEvent) => {
      const setting = live.current.appearance?.terminalMacOptionIsMeta ?? false;
      const key = terminalKeys.keydown(event, setting);
      if (key === undefined) return;
      event.preventDefault();
      markTyped();
      send({ kind: "keys", keys: [key] });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      terminalKeys.keyup(
        event,
        live.current.appearance?.terminalMacOptionIsMeta ?? false,
      );
    };
    const sendText = (text: string) => {
      if (text.length === 0) return;
      markTyped();
      send({ kind: "bytes", bytes: new TextEncoder().encode(text) });
    };
    // Text the keydown did not take: an IME's commit, a dead key's
    // character. While an IME composes, its preedit is drawn at the cursor,
    // cell by cell as the pane will hold it, and nothing reaches the pane;
    // the commit is sent once (`neovim/ime.ts`, the Neovim editor's rule).
    let ime: ImeState = IDLE;
    let preeditAt = { left: "", top: "" };
    const placePreedit = () => {
      const text = ime.preedit;
      preedit.hidden = text === "";
      if (text === "") return;
      // Where the textarea is put for the cursor; it then moves past the
      // preedit, so the IME's candidates open after it.
      if (!input.dataset.preedit) {
        preeditAt = { left: input.style.left, top: input.style.top };
        input.dataset.preedit = "true";
      }
      const layout = preeditLayout(text);
      painter.paintPreedit(
        preedit,
        layout,
        view.state.defaults.foreground,
        view.state.defaults.background,
      );
      preedit.style.left = preeditAt.left;
      preedit.style.top = preeditAt.top;
      input.style.left = `${String(
        parseFloat(preeditAt.left || "0") + layout.cells * cell().width,
      )}px`;
    };
    const onIme = (event: ImeEvent) => {
      if (event.type !== "reset" && terminalKeys.drops(event.type)) {
        // A Meta key's composition: nothing of it is drawn or sent, and the
        // textarea is emptied once it is over, which drops the mark.
        if (event.type === "compositionend") {
          setTimeout(() => {
            if (!terminalKeys.dropping) input.value = "";
          }, 0);
        }
        return;
      }
      if (event.type === "reset") terminalKeys.reset();
      const step = imeStep(ime, event);
      ime = step.state;
      if (step.commit !== undefined) sendText(step.commit);
      if (step.clear) input.value = "";
      if (ime.preedit === "" && input.dataset.preedit) {
        delete input.dataset.preedit;
        input.style.left = preeditAt.left;
        input.style.top = preeditAt.top;
      }
      placePreedit();
    };
    const onCompositionStart = () => onIme({ type: "compositionstart" });
    const onCompositionUpdate = (event: CompositionEvent) =>
      onIme({ type: "compositionupdate", data: event.data });
    const onCompositionEnd = (event: CompositionEvent) =>
      onIme({ type: "compositionend", data: event.data });
    const onInput = (event: Event) => {
      const e = event as InputEvent;
      onIme({
        type: "input",
        inputType: e.inputType,
        data: e.data,
        isComposing: e.isComposing,
      });
    };
    const onBlur = () => onIme({ type: "reset" });
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      if (text.length === 0) return;
      markTyped();
      const pane = activePane();
      const bracketed =
        pane !== undefined &&
        view.modes.get(pane.pane)?.bracketedPaste === true;
      send({ kind: "bytes", bytes: pasteBytes(text, bracketed) });
    };

    // The mouse: a click selects its pane; a pane whose program asked for the
    // mouse (SGR reports) gets its presses, releases and wheel.
    const cellAt = (event: MouseEvent) => {
      const rect = grids.getBoundingClientRect();
      const { width, height } = cell();
      return {
        col: Math.floor((event.clientX - rect.left) / width),
        row: Math.floor((event.clientY - rect.top) / height),
      };
    };
    const mouseFor = (event: MouseEvent) => {
      const { col, row } = cellAt(event);
      // While a popup is open the mouse is its, as the keys are: reported
      // to its program when it asked, as a pane's (pane -1: the popup).
      const popup = view.popup;
      if (popup !== undefined) {
        const inset = popup.border ? 1 : 0;
        const x = col - popup.x - inset;
        const y = row - popup.y - inset;
        const inside =
          x >= 0 &&
          y >= 0 &&
          x < popup.width - 2 * inset &&
          y < popup.height - 2 * inset;
        if (!inside) return undefined;
        const reports = popup.modes.mouse >= 1000 && popup.modes.sgrMouse;
        return {
          pane: {
            pane: -1,
            x: popup.x + inset,
            y: popup.y + inset,
            width: 0,
            height: 0,
            active: true,
          },
          x,
          y,
          reports,
        };
      }
      const pane = paneAt(view, col, row);
      if (pane === undefined) return undefined;
      const modes = view.modes.get(pane.pane);
      const reports =
        modes !== undefined && modes.mouse >= 1000 && modes.sgrMouse;
      return { pane, x: col - pane.x, y: row - pane.y, reports };
    };
    const onMouseDown = (event: MouseEvent) => {
      const hit = mouseFor(event);
      event.preventDefault();
      input.focus();
      if (hit === undefined) return;
      // A right-click the program does not take is tmux's MouseDown3Pane.
      if (event.button === 2 && !hit.reports) {
        if (hit.pane.pane < 0) return;
        send({
          kind: "mouse",
          key: `${event.altKey ? "M-" : ""}MouseDown3Pane`,
          pane: hit.pane.pane,
          x: hit.pane.x + hit.x,
          y: hit.pane.y + hit.y,
        });
        return;
      }
      if (!hit.pane.active && hit.pane.pane >= 0)
        send({ kind: "select-pane", pane: hit.pane.pane });
      if (hit.reports)
        send({
          kind: "bytes",
          ...target(hit.pane.pane),
          bytes: sgrMouse(event.button, hit.x, hit.y, false),
        });
    };
    // Bytes for a pane; the popup's (pane -1) go with none, which is its.
    const target = (pane: number) => (pane < 0 ? {} : { pane });
    const onMouseUp = (event: MouseEvent) => {
      const hit = mouseFor(event);
      if (hit?.reports)
        send({
          kind: "bytes",
          ...target(hit.pane.pane),
          bytes: sgrMouse(event.button, hit.x, hit.y, true),
        });
    };
    const onWheel = (event: WheelEvent) => {
      const hit = mouseFor(event);
      if (hit === undefined) return;
      event.preventDefault();
      // The wheel over a program that does not take it is tmux's
      // (WheelUpPane: into copy mode, and scrolling in it).
      if (!hit.reports) {
        if (event.deltaY === 0 || hit.pane.pane < 0) return;
        send({
          kind: "mouse",
          key: event.deltaY < 0 ? "WheelUpPane" : "WheelDownPane",
          pane: hit.pane.pane,
          x: hit.pane.x + hit.x,
          y: hit.pane.y + hit.y,
        });
        return;
      }
      send({
        kind: "bytes",
        ...target(hit.pane.pane),
        bytes: sgrMouse(event.deltaY < 0 ? 64 : 65, hit.x, hit.y, false),
      });
    };

    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("keyup", onKeyUp);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionupdate", onCompositionUpdate);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("blur", onBlur);
    // The input source may have changed while the keys were elsewhere.
    input.addEventListener("focus", () => {
      void terminalKeys.layout.loadLayout(layoutMapSource());
    });
    input.addEventListener("input", onInput);
    input.addEventListener("paste", onPaste);
    host.addEventListener("paste", markTyped, true);
    grids.addEventListener("mousedown", onMouseDown);
    grids.addEventListener("mouseup", onMouseUp);
    grids.addEventListener("wheel", onWheel, { passive: false });
    const focusInput = () => input.focus();
    host.addEventListener("click", focusInput);
    const noContextMenu = (event: Event) => event.preventDefault();
    host.addEventListener("contextmenu", noContextMenu);

    const refit = () => {
      if (live.current.hidden) return;
      report();
      const next = measure();
      if (next.cols === size.cols && next.rows === size.rows) return;
      size = next;
      send({ kind: "resize", cols: next.cols, rows: next.rows });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);

    controllerRef.current = {
      retry() {
        void attach();
      },
      visible(on) {
        send({ kind: "visible", visible: on });
        if (on) focusIfUnclaimed();
      },
      colors(c) {
        view.selection = c.selection;
        view.state.defaults.foreground = c.foreground;
        view.state.defaults.background = c.background;
        view.state.defaults.special = c.foreground;
        send({
          kind: "colors",
          foreground: c.foreground,
          background: c.background,
          ...(c.palette ? { palette: c.palette } : {}),
        });
      },
      font(spec) {
        // An edited setting or a zoom: every pane again at the new cell.
        if (!painter.setFont(spec)) return;
        schedule({
          ...emptyChanges(),
          grids: new Set(view.state.grids.keys()),
          layout: true,
          cursor: true,
        });
        refit();
      },
      selectWindow(id) {
        send({ kind: "select-window", window: id });
        input.focus();
      },
      completePrompt(index) {
        send({ kind: "prompt-complete", index });
        input.focus();
      },
      windowMenu(id, x) {
        input.focus();
        const at = grids.getBoundingClientRect();
        send({
          kind: "mouse",
          key: "MouseDown3Status",
          window: id,
          x: Math.max(0, Math.floor((x - at.left) / cell().width)),
          y: Math.max(0, view.rows - 1),
        });
      },
      focus() {
        input.focus();
      },
      overlaid() {
        // Read through `live`; the panes are drawn again with it.
        schedule({ ...emptyChanges(), layout: true, cursor: true });
      },
    };

    void attach();
    if (!live.current.hidden) input.focus();

    return () => {
      disposed = true;
      serial += 1;
      observer.disconnect();
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      host.removeEventListener("click", focusInput);
      host.removeEventListener("contextmenu", noContextMenu);
      host.removeEventListener("mousedown", onMenuMouseDown, true);
      host.removeEventListener("mousedown", onChooserMouseDown, true);
      host.removeEventListener("paste", markTyped, true);
      if (receipt !== undefined) void detach(receipt);
      receipt = undefined;
      live.current.onControlPanes?.(null);
      controllerRef.current = null;
      host.replaceChildren();
      backdrop.remove();
      delete document.documentElement.dataset.overlaidHoles;
    };
    // The surface key and the client are the mount's identity; the rest is
    // read through `live`.
  }, [boundClient, surfaceKey, surfaceLabel, shown]);

  useEffect(() => {
    controllerRef.current?.visible(!hidden);
  }, [hidden]);

  useEffect(() => {
    controllerRef.current?.colors(colors);
  }, [colors]);

  useEffect(() => {
    controllerRef.current?.overlaid(overlaid);
  }, [overlaid]);

  const fontFamily = appearance?.terminalFontFamily;
  const fontSize = appearance?.terminalFontSize;
  const lineHeight = appearance?.terminalLineHeight;
  const cellFont = useMemo(
    () =>
      terminalCellFont({
        terminalFontFamily: fontFamily,
        terminalFontSize: fontSize,
        terminalLineHeight: lineHeight,
      }),
    [fontFamily, fontSize, lineHeight],
  );
  useEffect(() => {
    controllerRef.current?.font(cellFont);
  }, [cellFont]);

  return (
    <div
      className="terminal-surface-shell control-terminal-shell"
      data-connection={connection}
      style={
        {
          ...terminalSurfaceStyle(palette, appearance?.terminalMargin),
          ...controlZStyle(),
          ...(palette
            ? {
                "--terminal-foreground": palette.foreground,
                // A bell is said in the theme's red (ANSI 1).
                "--terminal-ansi-red": palette.ansi[1],
                // The active pane's outline: tmux's pane-active-border-style.
                "--control-active-border": cssOfStatusColor(
                  status?.activeBorder ?? { index: 2 },
                  colors.palette,
                ),
                "--terminal-selection": palette.selectionBackground,
                color: palette.foreground,
              }
            : {}),
        } as React.CSSProperties
      }
    >
      {!hideTitle && (
        <h1
          id={`${surfaceKey}-terminal-title`}
          className="terminal-surface-title"
        >
          {surfaceLabel}
        </h1>
      )}
      <div
        ref={hostRef}
        className="terminal-surface control-terminal"
        role="application"
        aria-label={`${surfaceLabel} terminal`}
      />
      {promptMenu !== undefined && (
        <CompletionMenu
          items={promptMenu.items.map((item) => ({
            word: item.word,
            kind: item.kind,
            mark: TMUX_KINDS[item.kind].mark,
            ...(item.extra === undefined ? {} : { extra: item.extra }),
          }))}
          selected={promptMenu.choice}
          style={
            {
              // The words start three cells in (padding, mark, gap).
              left: Math.max(0, promptMenu.x - 3 * promptMenu.cell),
              bottom: promptMenu.bottom + 2,
              font: `${String(promptMenu.fontSize)}px/${String(promptMenu.row)}px ${promptMenu.font}`,
              "--completion-cell": `${String(promptMenu.cell)}px`,
              "--completion-row": `${String(promptMenu.row)}px`,
              "--completion-label-size": `${String(promptMenu.fontSize - 1)}px`,
            } as React.CSSProperties
          }
          kindColour={(kind) => {
            const ansi = Object.values(TMUX_KINDS).find(
              (k) => k.mark === kind,
            )?.ansi;
            return ansi === undefined ? undefined : palette?.ansi[ansi];
          }}
          onChoose={(index) => controllerRef.current?.completePrompt(index)}
        />
      )}
      <WindowStrip
        windows={tabs}
        status={status}
        color={(c) => cssOfStatusColor(c, colors.palette)}
        onSelect={(id) => controllerRef.current?.selectWindow(id)}
        onMenu={(id, x) => controllerRef.current?.windowMenu(id, x)}
      />
      {notice !== undefined && (
        <div className="control-notice" role="status">
          {notice}
        </div>
      )}
      {connection === "connecting" && <Waiting label="Connecting…" />}
      {connection === "disconnected" && (
        <Failure
          summary="The terminal session is not connected."
          {...(error === undefined ? {} : { detail: error })}
          actions={[
            {
              label: "Retry",
              primary: true,
              run: () => {
                controllerRef.current?.retry();
                // The keys leave the button now, not once the client is there.
                controllerRef.current?.focus();
              },
            },
          ]}
        />
      )}
    </div>
  );
}
