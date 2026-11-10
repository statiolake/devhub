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
  PART_Z,
  cssColor,
  mixColors,
  rgbOfCss,
  type FontSpec,
} from "../../neovim/painter";
import { terminalCellFont } from "../../neovim/cellFont";
import { emptyChanges, type GridBox } from "../../neovim/redraw";
import { GLIDE_MS } from "../../neovim/smoothScroll";
import { inkPlace, inkSpan, shiftedRows } from "../../neovim/cursorInk";
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
import type { TerminalPanesWire } from "../../../ipc/contract";
import { inNeovim, type PaneNeovim } from "../../pane/PaneNeovims";
import type { NeovimHandle } from "../../neovim/NeovimApp";
import { UnpaintedNeovims } from "./neovimPaints";
import type { MotionGroup } from "../../neovim/painter";
import type {
  ControlToPage,
  PageToControl,
  PaneBox,
  StatusColor,
  StatusLine,
} from "../../../ipc/terminalControl";
import { pasteBytes, sgrMouse, TerminalKeys } from "./controlKeys";
import { WheelLines } from "../../neovim/wheelLines";
import { surfaceBridge } from "../surfaceBridge";
import "./copyMode.css";
import {
  applyControl,
  borders,
  boundaryLine,
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
import {
  anchorOf,
  applyMotion,
  leaving,
  shiftsOf,
  changeOf,
  gridText,
  paneUnder,
  restPlace,
  waitingFor,
  windowOrder,
  zoomedOf,
  type Moving,
  type Shown,
} from "./controlMotion";
import {
  placeGroup,
  plan,
  reducedMotion,
  type Place,
  type Transition,
} from "../../neovim/paneMotion";
import type { TerminalSurfaceProps } from "../TerminalSurface";
import { WindowStrip } from "./WindowStrip";
import { ChooserSheet } from "./ChooserSheet";
import { createRoot } from "react-dom/client";
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
/**
 * How long a committed layout waits at most for its panes' new pictures
 * (`waitingFor`) before it is drawn with what has come.
 */
const COMMIT_WAIT_MS = 100;

/**
 * How long a Neovim main says is gone is kept on a pane tmux still shows:
 * its UI can end before tmux's word that its pane closed is here (`exec
 * nvim`, then `:q`: by some 20 ms), and that close moves with the Neovim's
 * last picture (`keepsGone`). A pane that stays (`:q` back to its shell)
 * shows its tty this much later.
 */
const GONE_WAIT_MS = 150;
/** Resize steps closer than this are a held key's: placed at once. */
const STEP_REPEAT_MS = 250;
const NOTICE_MS = 4_000;
/** Copy mode's bar starts this far down its pane: under the badge (18px at 4px) and a gap. */
const COPY_TRACK_TOP = 4 + 18 + 4;
/** A notice fades out over this long, in place (`control.css`). */
const NOTICE_LEAVE_MS = 600;

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
  neovims,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const boundClient = useMemo(() => client ?? createTerminalClient(), [client]);
  const dark = useColorScheme() === "dark";
  const palette = activePalette(appearance, dark);
  const colors = useMemo(() => colorsOf(palette), [palette]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [noticeLeaving, setNoticeLeaving] = useState(false);
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
  } | null>(null);
  const live = useRef({
    hidden,
    reattachOnExit,
    appearance,
    colors,
    onControlPanes,
    neovims,
  });
  live.current = {
    hidden,
    reattachOnExit,
    appearance,
    colors,
    onControlPanes,
    neovims,
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
    // The text under a block cursor, in its colours (`cursorInk.ts`, as
    // the Neovim editor's): the grid's cells painted as their rows paint
    // them, placed on the text inside the cursor, which cuts them.
    const ink = document.createElement("div");
    ink.className = "control-cursor-ink";
    const inkCanvas = document.createElement("canvas");
    ink.append(inkCanvas);
    cursor.append(ink);
    /** The grid the ink is of, whose scroll it follows (`followInk`). */
    let inkGrid: number | undefined;
    /**
     * The ink on the text while the grid's display is moved from it (copy
     * mode's or the output's glide, `smoothScroll.ts`): the cursor stays
     * on its cell, the text and its ink move under it.
     */
    const followInk = () => {
      const off = inkGrid === undefined ? 0 : painter.scrollOffset(inkGrid);
      const t = off === 0 ? "" : `translateY(${String(-off)}px)`;
      if (ink.style.transform !== t) ink.style.transform = t;
    };
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
    chooserEl.className = "control-chooser mac-sheet picker";
    chooserEl.setAttribute("role", "dialog");
    chooserEl.hidden = true;
    const chooserRoot = createRoot(chooserEl);
    const numbersEl = document.createElement("div");
    const copyEl = document.createElement("div");
    // An IME's preedit, drawn at the cursor as the Neovim editor draws it.
    const preedit = document.createElement("canvas");
    preedit.className = "control-preedit";
    preedit.hidden = true;
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
    // Pane motion (docs/pane-motion.md, `controlMotion.ts`). A layout tmux
    // commits is held with the messages after it until its panes' new
    // pictures are there (`gate`), then drawn as one commit (`commit`), from
    // which a transition runs (`motion`) from what was on screen.
    let gate:
      | {
          readonly messages: ControlToPage[];
          readonly before: Shown;
          readonly timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    let commit: Shown | undefined;
    let motion:
      | {
          readonly transition: Transition<number>;
          readonly moving: ReadonlyMap<number, Moving>;
          readonly size: { readonly width: number; readonly height: number };
          last: Map<number, Place>;
        }
      | undefined;
    let tickRequested = false;
    let lastStep = -Infinity;
    /** A boundary being dragged: steps follow the pointer at once. */
    let dragging = false;

    // What the panes are, for the Neovims DevHub draws in them
    // (`main/editor/terminalNeovims.ts`): said when it changes.
    const report = () => {
      const tell = live.current.onControlPanes;
      if (tell === undefined) return;
      const connected = receipt !== undefined;
      const panes: TerminalPanesWire = {
        client: connected ? view.client : "",
        prefixes: view.prefixes,
        shown: connected
          ? view.panes.map((p) => ({ pane: p.pane, active: p.active }))
          : [],
        panes: view.sessionPanes,
        // What DevHub draws over the panes (a popup, a prompt, a menu, the
        // chooser) has the keys while it is open, over a Neovim too.
        covered: connected && covered(),
      };
      const key = JSON.stringify(panes);
      if (key === reported) return;
      reported = key;
      tell(panes);
    };

    let wasCovered = false;
    const covered = () =>
      view.popup !== undefined ||
      view.prompt !== undefined ||
      view.menu !== undefined ||
      view.chooser !== undefined ||
      view.numbers !== undefined;

    // The Neovims drawn in the panes (`PaneNeovims`): each in a group of
    // its own among the panes' level, the shape of a pane's motion group
    // (`GridPainter.motionGroup`) and moved by the same transforms, so it
    // goes with its pane; at rest that group is its pane's ground (in
    // Neovim's own colour, out to the boundary) with the Neovim on the
    // pane's cells. Its element is never moved to another parent.
    const neovimGroups = new Map<string, MotionGroup>();
    const neovimGroup = (entry: PaneNeovim): MotionGroup => {
      let group = neovimGroups.get(entry.key);
      if (group === undefined) {
        const make = (className: string) => {
          const el = document.createElement("div");
          el.className = className;
          return el;
        };
        group = {
          outer: make("nvim-motion control-neovim"),
          clipA: make("nvim-motion-clip"),
          clipB: make("nvim-motion-clip"),
          content: make("nvim-motion-content"),
          edges: make("nvim-motion-edges"),
        };
        group.clipB.append(group.content);
        group.clipA.append(group.clipB);
        group.outer.append(group.clipA, group.edges);
        neovimGroups.set(entry.key, group);
      }
      const level = painter.levelElement(CONTROL_Z.panes);
      if (group.outer.parentElement !== level) level.append(group.outer);
      if (entry.element.parentElement !== group.content)
        group.content.append(entry.element);
      return group;
    };
    /** The Neovims shown in the window's panes, by tmux pane. */
    const neovimPanes = (): Map<number, PaneNeovim> => {
      const out = new Map<number, PaneNeovim>();
      const inMode = new Set(
        view.sessionPanes.filter((p) => p.inMode).map((p) => p.pane),
      );
      for (const entry of live.current.neovims?.list() ?? []) {
        if (inMode.has(entry.pane)) continue;
        if (!view.panes.some((p) => p.pane === entry.pane)) continue;
        // A gone one kept on its pane gives way to a new one there.
        if (entry.goneAt !== undefined && out.has(entry.pane)) continue;
        out.set(entry.pane, entry);
      }
      return out;
    };
    /**
     * Whether a Neovim main says is gone stays, as its pane's last picture
     * (`PaneNeovims.keepGone`): while its pane leaves in a transition, or
     * a close tmux said is held for its commit or about to start moving;
     * on a pane tmux still shows, a moment for tmux's word of its close.
     */
    let goneTimer: ReturnType<typeof setTimeout> | undefined;
    const keepsGone = (entry: PaneNeovim): boolean => {
      if (disposed) return false;
      if (motion?.transition.tracks.get(entry.pane)?.role === "gone")
        return true;
      const held = (gate?.messages ?? []).some(
        (m) =>
          m.kind === "layout" && !m.panes.some((p) => p.pane === entry.pane),
      );
      if (held || commit !== undefined) return true;
      if (!view.panes.some((p) => p.pane === entry.pane)) return false;
      const waited = performance.now() - (entry.goneAt ?? 0);
      if (waited >= GONE_WAIT_MS) return false;
      goneTimer ??= setTimeout(
        () => {
          goneTimer = undefined;
          live.current.neovims?.release();
        },
        GONE_WAIT_MS - waited + 1,
      );
      return true;
    };
    const neovimGround = (entry: PaneNeovim) =>
      cssColor(entry.handle?.background() ?? view.state.defaults.background);
    /** Asked for a committed layout, not drawn at it yet (`UnpaintedNeovims`). */
    const unpaintedNeovims = new UnpaintedNeovims<NeovimHandle>();
    /** Each moving pane's Neovim group, for `applyMotion`. */
    const neovimMotion = () => {
      const out = new Map<number, { group: MotionGroup; ground: string }>();
      for (const entry of live.current.neovims?.list() ?? []) {
        if (motion?.moving.has(entry.pane) !== true) continue;
        out.set(entry.pane, {
          group: neovimGroup(entry),
          ground: neovimGround(entry),
        });
      }
      return out;
    };
    /**
     * Every Neovim where its pane rests, or hidden (its pane in another
     * window, zoomed away, in a mode) at the size it last had: its pane
     * keeps its size in tmux, and Neovim its grid. One whose pane is moving
     * is the transition's (`applyMotion`).
     */
    const placeNeovims = () => {
      const registry = live.current.neovims;
      registry?.release();
      const list = registry?.list() ?? [];
      const keep = new Set(list.map((entry) => entry.key));
      for (const [key, group] of neovimGroups) {
        if (keep.has(key)) continue;
        group.outer.remove();
        neovimGroups.delete(key);
      }
      const shownNeovims = neovimPanes();
      const { width, height } = cell();
      const dpr = window.devicePixelRatio || 1;
      const size = { width: grids.clientWidth, height: grids.clientHeight };
      for (const entry of list) {
        const group = neovimGroup(entry);
        const moving =
          motion?.moving.has(entry.pane) === true &&
          motion.transition.tracks.has(entry.pane);
        const box =
          shownNeovims.get(entry.pane) === undefined
            ? undefined
            : view.panes.find((p) => p.pane === entry.pane);
        if (box === undefined && !moving) {
          group.outer.style.visibility = "hidden";
          continue;
        }
        group.outer.style.visibility = "";
        if (box === undefined) continue;
        const el = entry.element;
        el.style.position = "absolute";
        el.style.left = `${String(box.x * width)}px`;
        el.style.top = `${String(box.y * height)}px`;
        // At the pane's first cell, where its motion group puts the pane;
        // still at its old size while it shows its old picture, for the
        // motion's first frame (`unpaintedNeovims`).
        if (unpaintedNeovims.has(entry.key)) continue;
        el.style.width = `${String(box.width * width)}px`;
        el.style.height = `${String(box.height * height)}px`;
        // Its rows go on into the half border cells its ground takes, to
        // the hairline (docs/rendering-layers.md, "Panes and boundaries").
        const rest = restPlace(box, view.cols, view.rows, cell(), dpr).rect;
        entry.handle?.setReach({
          left: box.x * width - rest.left,
          right: rest.right - (box.x + box.width) * width,
          top: box.y * height - rest.top,
          bottom: rest.bottom - (box.y + box.height) * height,
        });
        if (!moving) {
          placeGroup(
            group,
            restPlace(box, view.cols, view.rows, cell(), dpr),
            PART_Z.grid,
            { x: box.x * width, y: box.y * height },
            size,
            neovimGround(entry),
          );
          group.edges.replaceChildren();
        }
        registry?.setPlaced(entry.key, true);
      }
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

    const paint = (stamp?: number) => {
      frameRequested = false;
      if (disposed) return;
      const changes = pendingChanges;
      pendingChanges = [];
      if (changes.length === 0) return;
      const now = stamp ?? performance.now();
      if (commit !== undefined) {
        const before = commit;
        commit = undefined;
        startMotion(before, now);
      }
      // A motion starting in this frame draws the old places: the held
      // Neovims keep their old picture for it (`unpaintedNeovims`).
      const startsHere = motion?.transition.t0 === now;
      const merged = changes.reduce((a, b) => {
        for (const g of b.grids) a.grids.add(g);
        a.layout ||= b.layout;
        a.cursor ||= b.cursor;
        if (a !== b)
          for (const [g, rows] of b.scrolled)
            a.scrolled.set(g, (a.scrolled.get(g) ?? 0) + rows);
        return a;
      });
      const { width, height } = cell();
      // A pane with a Neovim in it is the Neovim's (`placeNeovims`): its
      // tty's grid, ground and cursor are not drawn.
      const inNeovims = neovimPanes();
      const clear = new Set([...inNeovims.keys()].map((pane) => gridOf(pane)));
      // A gone pane that held a Neovim leaves as the Neovim's last picture
      // (`keepsGone`), not its tty's.
      const heldNeovims = new Set(
        (live.current.neovims?.list() ?? []).map((entry) => entry.pane),
      );
      const gone = [...(motion?.moving.values() ?? [])]
        .filter((m) => motion?.transition.tracks.get(m.pane)?.role === "gone")
        .filter((m) => !heldNeovims.has(m.pane))
        .filter((m) => view.state.grids.has(gridOf(m.pane)));
      const boxes = [
        ...paneBoxes(view).filter((box) => !clear.has(box.grid)),
        ...gone.map((m) => ({
          grid: gridOf(m.pane),
          row: m.box.y,
          col: m.box.x,
          width: m.box.width,
          height: m.box.height,
          z: CONTROL_Z.panes,
          float: false,
          win: undefined,
        })),
      ];
      // A pane's copy mode scrolled (`copyShift`): its new view slides in
      // from where the old one was, the old one's rows leaving at the
      // other edge (`smoothScroll.ts`, as a Neovim window's). Not while
      // panes move: their groups hold the grids.
      painter.setShiftedGrids(
        motion === undefined
          ? new Map(
              view.panes
                .filter((p) => !clear.has(gridOf(p.pane)))
                .map((p) => [gridOf(p.pane), GLIDE_MS] as const),
            )
          : new Map(),
      );
      // Each pane's rows go on sideways into the half border cells its
      // ground takes, to the hairline: a coloured row (a TUI's bar, a
      // prompt's band) meets the line, not a strip of the default ground.
      {
        const dpr = window.devicePixelRatio || 1;
        painter.setGridReach(
          new Map(
            view.panes.map((p) => {
              const r = restPlace(p, view.cols, view.rows, cell(), dpr).rect;
              return [
                gridOf(p.pane),
                {
                  l: p.x * width - r.left,
                  r: r.right - (p.x + p.width) * width,
                  t: 0,
                  b: 0,
                },
              ] as const;
            }),
          ),
        );
      }
      painter.paint(view.state, merged, boxes, merged.layout);
      shownBoxes = boxes;
      if (painter.scrolling) requestScrollTick();
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
      const ground = (p: PaneBox, cols: number, rows: number) => {
        const r = restPlace(p, cols, rows, cell(), dpr).rect;
        return {
          key: p.pane,
          grid: gridOf(p.pane),
          z: CONTROL_Z.panes,
          x: r.left,
          y: r.top,
          w: r.right - r.left,
          h: r.bottom - r.top,
          colour: view.state.defaults.background,
        };
      };
      painter.placeGrounds([
        ...view.panes
          .filter((p) => !clear.has(gridOf(p.pane)))
          .map((p) => ground(p, view.cols, view.rows)),
        ...gone.map((m) => ground(m.box, m.cols, m.rows)),
      ]);
      // The boundaries, and the active (and synchronized) panes' outlines
      // as stretches of them, recoloured and thicker (`paneOutlines`): a
      // 1px hairline and a 2px outline, each centred on the shared edge;
      // each outline piece runs on over the corner it shares with the
      // next, so the corners are square and filled.
      const outlines = motion === undefined ? paneOutlines(view.panes) : [];
      const thick = 2;
      const edge = (cells: number, size: number) => snap(cells * size);
      // While panes move, each draws the lines on its own edges, in its
      // group (`applyMotion`); the shared boundaries are placed again after.
      lines.replaceChildren(
        ...plainBorders(
          motion === undefined ? borders(view.panes) : [],
          outlines,
        ).map((line) => {
          const el = document.createElement("div");
          el.className = line.vertical
            ? "control-border-v"
            : "control-border-h";
          if (line.vertical) {
            const top = edge(line.y, height);
            el.style.left = `${String(boundaryLine(line.x, width, 1)[0])}px`;
            el.style.top = `${String(top)}px`;
            el.style.height = `${String(edge(line.y + line.length, height) - top)}px`;
          } else {
            const left = edge(line.x, width);
            el.style.left = `${String(left)}px`;
            el.style.top = `${String(boundaryLine(line.y, height, 1)[0])}px`;
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
            el.style.left = `${String(boundaryLine(line.x, width, thick)[0])}px`;
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
            el.style.top = `${String(boundaryLine(line.y, height, thick)[0])}px`;
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
        // tmux's border cells are the popup's padding: inline the whole
        // cell, and a title's band the whole top row; above and below the
        // text only the floats' block padding (`tokens.css`).
        const pad = "var(--float-pad-block)";
        const top =
          popup.border && popup.title === ""
            ? `calc(${String((popup.y + 1) * height)}px - ${pad})`
            : `${String(popup.y * height)}px`;
        const bottom = popup.border
          ? `calc(${String((popup.y + popup.height - 1) * height)}px + ${pad})`
          : `${String((popup.y + popup.height) * height)}px`;
        popupFrame.style.left = `${String(popup.x * width)}px`;
        popupFrame.style.top = top;
        popupFrame.style.width = `${String(popup.width * width)}px`;
        popupFrame.style.height = `calc(${bottom} - ${top})`;
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
      // A cell and a row, for what DevHub draws in CSS on the cells' grid
      // (a popup's title band, a menu's rows, the chooser's filter).
      host.style.setProperty("--control-cell", `${String(width)}px`);
      host.style.setProperty("--control-row", `${String(height)}px`);
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
        inNeovims.has(pane.pane) ||
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
        inkGrid = undefined;
        if (at.shape === 1 && grid !== undefined) {
          const gridId = popup !== undefined ? POPUP_GRID : gridOf(pane.pane);
          const origin = { row: pane.y, col: pane.x };
          const x = (pane.x + at.x) * width;
          const y = (pane.y + at.y) * height;
          const w = width * (wide ? 2 : 1);
          let span = inkSpan([{ x, y, w, h: height }], origin, grid, {
            width,
            height,
          });
          // The rows its text comes from while the display moves.
          if (span) {
            span = {
              ...span,
              ...shiftedRows(
                span.row0,
                span.row1,
                painter.scrollOffset(gridId),
                height,
                grid.height,
              ),
            };
            painter.paintCursorInk(
              inkCanvas,
              view.state,
              gridId,
              span,
              cursorText,
              color,
            );
            const place = inkPlace(span, origin, { x: 0, y: 0 }, cell());
            inkCanvas.style.left = `${String(place.left)}px`;
            inkCanvas.style.top = `${String(place.top)}px`;
            ink.style.left = `${String(-x)}px`;
            ink.style.top = `${String(-y)}px`;
            inkGrid = gridId;
          }
          inkCanvas.style.display = span ? "" : "none";
        }
        followInk();
        input.style.left = cursor.style.left;
        input.style.top = cursor.style.top;
      }
      // While its pane moves the cursor is in the pane's content, which
      // carries it; at rest it is over the panes, as ever.
      const home =
        motion !== undefined &&
        popup === undefined &&
        pane !== undefined &&
        !inNeovims.has(pane.pane)
          ? painter.motionGroup(gridOf(pane.pane), CONTROL_Z.panes).content
          : host;
      if (cursor.parentElement !== home) {
        if (home === host) host.insertBefore(cursor, preedit);
        else home.append(cursor);
      }
      if (motion !== undefined) {
        motion.last = applyMotion(
          painter,
          motion.transition,
          motion.moving,
          now,
          dpr,
          cell(),
          motion.size,
          cssColor(view.state.defaults.background),
          { width: view.cols * width, height: view.rows * height },
          neovimMotion(),
        );
        requestTick();
      }
      if (!unpaintedNeovims.painted(startsHere, placeNeovims)) placeNeovims();
      if (ime.preedit !== "") placePreedit();
      if (lastSeq > ackedSeq) {
        ackedSeq = lastSeq;
        send({ kind: "ack", seq: lastSeq });
      }
      // What covers the panes is said when it changes: it has the keys.
      const coveredNow = covered();
      if (merged.layout || coveredNow !== wasCovered) report();
      wasCovered = coveredNow;
    };

    /** What is on screen now, before a layout is committed. */
    const shownNow = (next: readonly PaneBox[]): Shown => {
      const text = new Map<number, string[]>();
      const pictures = new Map<number, HTMLCanvasElement>();
      const inNeovims = neovimPanes();
      for (const p of view.panes) {
        // A Neovim's content is glued to its pane's first cell: its tty's
        // text says nothing of it.
        if (inNeovims.has(p.pane)) continue;
        const to = next.find((n) => n.pane === p.pane);
        if (
          to === undefined ||
          (to.width === p.width && to.height === p.height)
        )
          continue;
        text.set(p.pane, gridText(view, p.pane));
        const picture = painter.picture(gridOf(p.pane));
        if (picture !== undefined) pictures.set(p.pane, picture);
      }
      return {
        pictures,
        cols: view.cols,
        rows: view.rows,
        window: view.window,
        order: windowOrder(view),
        zoomed: zoomedOf(view),
        panes: view.panes,
        text,
      };
    };
    /** The panes' places in the last frame drawn. */
    const placesOf = (before: Shown, now: number): Map<number, Place> => {
      if (motion !== undefined) {
        return motion.transition.at(now, window.devicePixelRatio || 1);
      }
      const dpr = window.devicePixelRatio || 1;
      return new Map(
        before.panes.map((p) => [
          p.pane,
          restPlace(p, before.cols, before.rows, cell(), dpr),
        ]),
      );
    };
    const motionAllowed = () =>
      !reducedMotion() && !live.current.hidden && receipt !== undefined;
    /** Panes at rest: the transition dropped, the resting path places them. */
    const stopMotion = () => {
      if (motion === undefined) return;
      motion = undefined;
      painter.endMotion();
      if (cursor.parentElement !== host) host.insertBefore(cursor, preedit);
    };
    /** A transition from what was shown before the commit to the view now. */
    const startMotion = (before: Shown, now: number) => {
      const { width, height } = cell();
      const sameSize = before.cols === view.cols && before.rows === view.rows;
      const change = sameSize ? changeOf(before, view) : undefined;
      // A boundary dragged, or a resize key held: at once, under the hand.
      const repeated =
        change?.kind === "step" &&
        (dragging || now - lastStep < STEP_REPEAT_MS);
      if (change?.kind === "step") lastStep = now;
      // Nothing moved (the active pane changed, a window was renamed): a
      // transition running goes on to the layout it was going to.
      if (change === undefined && sameSize) return;
      if (change === undefined || repeated || !motionAllowed()) {
        stopMotion();
        return;
      }
      const shown = placesOf(before, now);
      const dpr = window.devicePixelRatio || 1;
      const next = view.panes
        .filter((p) => view.state.grids.has(gridOf(p.pane)))
        .map((p) => ({
          key: p.pane,
          rest: restPlace(p, view.cols, view.rows, { width, height }, dpr),
          top: p.active,
        }));
      const shifts = shiftsOf(before, view);
      const transition = plan({
        now,
        change,
        shown,
        next,
        anchor: anchorOf(shifts, height),
        ...(change.kind === "zoom" ? { zoomed: change.pane } : {}),
      });
      const moving = new Map<number, Moving>();
      for (const track of transition.tracks.values()) {
        const box =
          view.panes.find((p) => p.pane === track.key) ??
          motion?.moving.get(track.key)?.box ??
          before.panes.find((p) => p.pane === track.key);
        if (box === undefined) continue;
        const old = motion?.moving.get(track.key);
        const inView = view.panes.some((p) => p.pane === track.key);
        moving.set(track.key, {
          pane: track.key,
          box,
          cols: inView ? view.cols : (old?.cols ?? before.cols),
          rows: inView ? view.rows : (old?.rows ?? before.rows),
          active: box.active && track.role !== "gone",
        });
      }
      // Groups again from this commit's panes, in this same frame; a copy
      // mode's glide ends where it was going.
      painter.setShiftedGrids(new Map());
      painter.endMotion();
      for (const [pane, picture] of before.pictures) {
        const box = view.panes.find((p) => p.pane === pane);
        const shift = shifts.get(pane) ?? 0;
        if (box === undefined || transition.tracks.get(pane)?.role !== "keep")
          continue;
        const rows = leaving(picture, box, shift, { width, height });
        if (rows !== undefined)
          painter
            .motionGroup(gridOf(pane), CONTROL_Z.panes)
            .content.append(rows);
      }
      motion = {
        transition,
        moving,
        size: { width: grids.clientWidth, height: grids.clientHeight },
        last: shown,
      };
    };
    // The panes' copy-mode glides, a frame at a time until they rest.
    let shownBoxes: readonly GridBox[] = [];
    let scrollTickRequested = false;
    const requestScrollTick = () => {
      if (scrollTickRequested) return;
      scrollTickRequested = true;
      requestAnimationFrame(() => {
        scrollTickRequested = false;
        if (disposed || motion !== undefined) return;
        const moving = painter.scrollFrame(
          view.state,
          shownBoxes,
          () => undefined,
        );
        followInk();
        if (moving) requestScrollTick();
      });
    };
    const requestTick = () => {
      if (tickRequested) return;
      tickRequested = true;
      requestAnimationFrame(tick);
    };
    const tick = (stamp: number) => {
      tickRequested = false;
      if (disposed || motion === undefined) return;
      // The first frame that has moved: the held Neovims' new pictures, at
      // their new sizes, with it.
      unpaintedNeovims.ticked(placeNeovims);
      if (motion.transition.done(stamp)) {
        // The last frame is the resting one, drawn by the resting path.
        stopMotion();
        pendingChanges.push({ ...emptyChanges(), cursor: true });
        paint(stamp);
        return;
      }
      motion.last = applyMotion(
        painter,
        motion.transition,
        motion.moving,
        stamp,
        window.devicePixelRatio || 1,
        cell(),
        motion.size,
        cssColor(view.state.defaults.background),
        { width: view.cols * cell().width, height: view.rows * cell().height },
        neovimMotion(),
      );
      requestTick();
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
          kbd("⇥"),
          kbd("↑"),
          kbd("↓"),
          " · put in ",
          kbd("↩"),
          " · close ",
          kbd("⎋"),
        );
      } else if (!prompt.confirm) {
        // What tmux's keys do here, the vi table's in its command mode.
        hint.append(
          "history ",
          kbd("↑"),
          kbd("↓"),
          " · run ",
          kbd("↩"),
          " · cancel ",
          ...(prompt.vi ? [kbd("⎋"), " ", kbd("q")] : [kbd("⎋")]),
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
    // The picker (`chooser.css`): the quick pick's look (`ChooserSheet`);
    // the painter draws the chosen pane's grid in its aside.
    let chooserShown = "";
    const drawChooser = (width: number, height: number) => {
      const chooser = view.chooser;
      chooserEl.hidden = chooser === undefined;
      if (chooser === undefined) {
        chooserShown = "";
        return;
      }
      const key = JSON.stringify([chooser, width, height]);
      if (key === chooserShown) return;
      chooserShown = key;
      Object.assign(chooserEl.style, {
        left: `${String(chooser.x * width)}px`,
        top: `${String(chooser.y * height)}px`,
        width: `${String(chooser.width * width)}px`,
        height: `${String(chooser.height * height)}px`,
      });
      chooserRoot.render(
        <ChooserSheet
          box={chooser}
          preview={chooser.preview}
          filter={chooser.filter}
          rows={chooser.rows}
          choice={chooser.choice}
          cell={{ width, height }}
        />,
      );
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
          // The bar is a picture of where the view is, and the badge says it
          // in numbers. A history shorter than the pane makes a thumb over
          // half its track, whose place does not read; then the badge alone.
          // The track starts under the badge, so the two never touch.
          if (copy.history >= box.height) {
            const whole = box.height * height - COPY_TRACK_TOP - 4;
            const bar = Math.max(
              12,
              (whole * box.height) / (copy.history + box.height),
            );
            const top =
              COPY_TRACK_TOP +
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
      setNoticeLeaving(false);
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      // It fades in place, then is gone (docs/motion.md).
      noticeTimer = setTimeout(() => {
        setNoticeLeaving(true);
        noticeTimer = setTimeout(() => setNotice(undefined), NOTICE_LEAVE_MS);
      }, NOTICE_MS);
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
        if (gate !== undefined) {
          clearTimeout(gate.timer);
          gate = undefined;
        }
        unpaintedNeovims.resume();
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
      if (gate !== undefined) {
        gate.messages.push(message);
        if (message.kind === "layout") askNeovims(gate.messages);
        if (gateOpen()) release();
        return;
      }
      if (
        message.kind === "layout" &&
        view.panes.length > 0 &&
        message.cols === view.cols &&
        message.rows === view.rows &&
        // A boundary under the hand waits for nothing.
        !dragging &&
        motionAllowed()
      ) {
        gate = {
          messages: [message],
          before: shownNow(message.panes),
          timer: setTimeout(release, COMMIT_WAIT_MS),
        };
        askNeovims(gate.messages);
        if (gateOpen()) release();
        return;
      }
      apply(message);
    };
    const apply = (message: ControlToPage) => {
      if (message.kind === "pane") lastSeq = Math.max(lastSeq, message.seq);
      if (message.kind === "layout") {
        setTabs(message.windows);
        setStatus(message.status);
      }
      schedule(applyControl(view, message));
    };
    /**
     * A Neovim in a pane the held layout resizes is asked for its new grid
     * now (`NeovimHandle.resizeFor`), and the commit waits for it as for a
     * tty's new picture: its content and its pane's edges start moving
     * together. What each was asked, by its key.
     */
    const askedNeovims = new Map<string, { cols: number; rows: number }>();
    const neovimFlushed = () => {
      if (!disposed && gate !== undefined && gateOpen()) release();
    };
    const askNeovims = (messages: readonly ControlToPage[]) => {
      let layout: Extract<ControlToPage, { kind: "layout" }> | undefined;
      for (const m of messages) if (m.kind === "layout") layout = m;
      if (layout === undefined) return;
      const { width, height } = cell();
      for (const p of layout.panes) {
        const entry = live.current.neovims?.onPane(p.pane);
        const handle = entry?.handle;
        const asked = handle?.resizeFor(
          p.width * width,
          p.height * height,
          neovimFlushed,
        );
        if (entry === undefined || handle === undefined || asked === undefined)
          continue;
        askedNeovims.set(entry.key, asked);
        unpaintedNeovims.add(entry.key, handle);
      }
    };
    const neovimsWaiting = () => {
      for (const [key, asked] of askedNeovims) {
        const drawn = live.current.neovims
          ?.list()
          .find((entry) => entry.key === key)
          ?.handle?.drawnSize();
        if (
          drawn !== undefined &&
          (drawn.cols !== asked.cols || drawn.rows !== asked.rows)
        )
          return true;
      }
      return false;
    };
    const gateOpen = () =>
      gate !== undefined &&
      waitingFor(view, gate.messages, gate.before.window).size === 0 &&
      !neovimsWaiting();
    /** The held layout and what came with it, drawn as one commit. */
    const release = () => {
      const held = gate;
      if (held === undefined) return;
      gate = undefined;
      askedNeovims.clear();
      clearTimeout(held.timer);
      for (const message of held.messages) apply(message);
      commit = held.before;
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
      // While panes move, the cell under the pointer is the one drawn there.
      const drawn =
        motion === undefined
          ? undefined
          : (() => {
              const rect = grids.getBoundingClientRect();
              return paneUnder(
                motion.transition,
                motion.last,
                view.panes,
                event.clientX - rect.left,
                event.clientY - rect.top,
                cell(),
              );
            })();
      const pane = drawn?.pane ?? paneAt(view, col, row);
      if (pane === undefined) return undefined;
      const modes = view.modes.get(pane.pane);
      const reports =
        modes !== undefined && modes.mouse >= 1000 && modes.sgrMouse;
      return {
        pane,
        x: drawn?.x ?? col - pane.x,
        y: drawn?.y ?? row - pane.y,
        reports,
      };
    };
    // A boundary dragged with the first button: the pane before it (left
    // of a vertical one, above a horizontal one) resized to the pointer's
    // cell, each cell as the pointer reaches it; placed at once, no motion
    // (`dragging`), so the boundary stays under the hand.
    const onBoundaryDrag = (event: MouseEvent): boolean => {
      if (event.button !== 0 || view.popup !== undefined) return false;
      const { col, row } = cellAt(event);
      const left = paneAt(view, col - 1, row);
      const above = paneAt(view, col, row - 1);
      const vertical =
        left !== undefined &&
        left.x + left.width === col &&
        paneAt(view, col + 1, row) !== undefined;
      const before = vertical
        ? left
        : above !== undefined &&
            above.y + above.height === row &&
            paneAt(view, col, row + 1) !== undefined
          ? above
          : undefined;
      if (before === undefined) return false;
      const id = before.pane;
      let last = vertical ? before.width : before.height;
      dragging = true;
      const onMove = (e: MouseEvent) => {
        const at = cellAt(e);
        const box = view.panes.find((p) => p.pane === id);
        if (box === undefined) return;
        const cells = Math.max(1, vertical ? at.col - box.x : at.row - box.y);
        if (cells === last) return;
        last = cells;
        send({ kind: "resize-pane", pane: id, vertical, cells });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // The last step's layout may still be on its way.
        setTimeout(() => {
          dragging = false;
        }, STEP_REPEAT_MS);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return true;
    };
    const onMouseDown = (event: MouseEvent) => {
      // A Neovim in a pane takes its own presses (`editor.ts`).
      if (inNeovim(event.target)) return;
      const hit = mouseFor(event);
      event.preventDefault();
      input.focus();
      if (hit === undefined) {
        onBoundaryDrag(event);
        return;
      }
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
      if (inNeovim(event.target)) return;
      const hit = mouseFor(event);
      if (hit?.reports)
        send({
          kind: "bytes",
          ...target(hit.pane.pane),
          bytes: sgrMouse(event.button, hit.x, hit.y, true),
        });
    };
    // The wheel in lines (`WheelLines`: a tick is at least one, no pixel
    // lost), one movement per pane.
    const wheelLines = new WheelLines();
    let wheelPane: number | undefined;
    const onWheel = (event: WheelEvent) => {
      if (inNeovim(event.target)) return;
      const hit = mouseFor(event);
      if (hit === undefined) return;
      event.preventDefault();
      if (event.deltaY === 0) return;
      if (wheelPane !== hit.pane.pane) wheelLines.reset();
      wheelPane = hit.pane.pane;
      const rows = hit.pane.height > 0 ? hit.pane.height : view.rows;
      const lines = wheelLines.lines(
        event.deltaY,
        event.deltaMode,
        cell().height,
        Math.max(1, rows),
        event.timeStamp,
      );
      // At most a screen's worth for one event: a flick is many events.
      const n = Math.min(Math.abs(lines), Math.max(1, rows));
      if (n === 0) return;
      const up = lines < 0;
      // The wheel over a program that does not take it is tmux's
      // (WheelUpPane: into copy mode, and scrolling in it), one binding's
      // turn per line.
      if (!hit.reports) {
        if (hit.pane.pane < 0) return;
        for (let i = 0; i < n; i += 1)
          send({
            kind: "mouse",
            key: up ? "WheelUpPane" : "WheelDownPane",
            pane: hit.pane.pane,
            x: hit.pane.x + hit.x,
            y: hit.pane.y + hit.y,
          });
        return;
      }
      // A program that takes the mouse gets a wheel report per line; it
      // scrolls by its own steps, in its own redraws.
      const one = sgrMouse(up ? 64 : 65, hit.x, hit.y, false);
      const bytes = new Uint8Array(one.length * n);
      for (let i = 0; i < n; i += 1) bytes.set(one, i * one.length);
      send({ kind: "bytes", ...target(hit.pane.pane), bytes });
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
    const focusInput = (event: MouseEvent) => {
      if (!inNeovim(event.target)) input.focus();
    };
    host.addEventListener("click", focusInput);
    const noContextMenu = (event: Event) => event.preventDefault();
    // The Neovims in the panes: placed again as they come, go or draw at a
    // new size or ground, and a held layout let go once they have drawn at
    // its sizes. They borrow the terminal's keys for tmux's prefix.
    const offNeovims = live.current.neovims?.subscribe(() => {
      if (disposed) return;
      if (gate !== undefined && gateOpen()) release();
      schedule({ ...emptyChanges(), cursor: true });
    });
    live.current.neovims?.keepGone(keepsGone);
    live.current.neovims?.lendTerminal({
      focus: () => {
        input.focus();
      },
      typeKey: (stroke) => {
        const setting =
          live.current.appearance?.terminalMacOptionIsMeta ?? false;
        const key = terminalKeys.keydown(
          new KeyboardEvent("keydown", {
            key: stroke.key,
            code: stroke.code,
            ctrlKey: stroke.control,
            altKey: stroke.alt,
            shiftKey: stroke.shift,
            metaKey: stroke.meta,
          }),
          setting,
        );
        if (key === undefined) return;
        markTyped();
        send({ kind: "keys", keys: [key] });
      },
    });
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
    };

    void attach();
    if (!live.current.hidden) input.focus();

    return () => {
      disposed = true;
      serial += 1;
      observer.disconnect();
      if (gate !== undefined) clearTimeout(gate.timer);
      unpaintedNeovims.resume();
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      host.removeEventListener("click", focusInput);
      offNeovims?.();
      live.current.neovims?.lendTerminal(undefined);
      clearTimeout(goneTimer);
      live.current.neovims?.keepGone(undefined);
      for (const group of neovimGroups.values()) group.outer.remove();
      neovimGroups.clear();
      host.removeEventListener("contextmenu", noContextMenu);
      host.removeEventListener("mousedown", onMenuMouseDown, true);
      host.removeEventListener("mousedown", onChooserMouseDown, true);
      // Not inside React's own commit: the root is let go once it is over.
      queueMicrotask(() => {
        chooserRoot.unmount();
      });
      host.removeEventListener("paste", markTyped, true);
      if (receipt !== undefined) void detach(receipt);
      receipt = undefined;
      live.current.onControlPanes?.(null);
      controllerRef.current = null;
      host.replaceChildren();
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
                // The active pane's outline: tmux's pane-active-border-style
                // where it says something, else the theme's accent.
                "--control-active-border":
                  status?.activeBorder !== undefined
                    ? cssOfStatusColor(status.activeBorder, colors.palette)
                    : "var(--accent)",
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
        <div
          key={notice}
          className="control-notice"
          data-leaving={noticeLeaving}
          role="status"
        >
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
