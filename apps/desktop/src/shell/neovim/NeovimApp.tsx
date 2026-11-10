/**
 * A Neovim drawn by DevHub in its terminal pane: one surface per overlay
 * (`tnv:<n>`, `main/editor/terminalNeovims.ts`), whether the Neovim was
 * typed in a pane or is a Workspace's `devhub-nvim` one, mounted by the
 * terminal's own page (`shell/pane/PaneNeovims.tsx`) in the pane's place
 * among the panes' layers — so it moves with its pane, and tmux's popups,
 * prompts and menus stack over it (docs/rendering-layers.md). The page
 * may hold several; each is its own UI, by its key.
 *
 * # What is Neovim's and what is DevHub's
 *
 * Neovim owns the buffers, the windows and their layout, the modes, the
 * plugins and the language servers; this page is its only UI, attached
 * through the UI protocol (`docs/neovim-editor.md`). The grids are canvases
 * (`editor.ts`, `painter.ts`); what Neovim hands a GUI to draw natively —
 * the completion menu, the command line, the tab line — are widgets here,
 * in DevHub's own chrome.
 *
 * **GUI windows** follow the same rule. `require('devhub_gui').webview{…}`
 * opens an ordinary Neovim window on a scratch buffer, and this page paints
 * web content exactly over that window's grid: `:vsplit`, `<C-w>` moves,
 * `:close`, `:only` and tab pages move it, because they move the window.
 * Its keys are Neovim's, as in normal mode, until a field in it takes them
 * in insert mode (`guiFrame.ts`); a `keyboard = "content"` page has them
 * whenever its window is current, and `<C-w>` gives them back.
 *
 * # Its contract with main
 *
 * - **reads**: the appearance (the monospace font and the Option key),
 *   handed down by the terminal's page.
 * - **asks**: `neovim.attach` once its pane has placed it, then
 *   `neovim.call` for every key, click, scroll and resize.
 * - **is pushed**: `redraw`, `ended`, GUI windows and their messages.
 *
 * # Its failures are its own
 *
 * It shares its page with the terminal and the other Neovims. Its UI's end
 * (Neovim gone, the host restarted) is shown in its pane, with Retry; a
 * redraw it cannot apply resets it and attaches again; a render that throws
 * is caught by its pane's boundary (`PaneNeovims`). None of them reaches the
 * terminal or another Neovim.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { decorOf } from "./decor";
import { NeovimEditor } from "./editor";
import { terminalCellFont } from "./cellFont";
import { cmdlineMenuPlace, cmdlineUiPos, popupmenuPlace } from "./place";
import {
  currentModeInfo,
  msgText,
  type Chunks,
  type CmdlineLevel,
  type GridBox,
  type MsgChunk,
  type NeovimUiState,
} from "./redraw";
import { cmdlineLayout, cmdlineLead, textCells } from "./cmdline";
import { routeMessages } from "./messages";
import {
  ICON_FAMILY,
  cssColor,
  fontOf,
  resolveColors,
  uiTypeScale,
} from "./painter";
import { CompletionMenu } from "../completion/CompletionMenu";
import { TabStrip } from "./TabStrip";
import { InlineImages, Toasts } from "./DecorationViews";
import { GuiViews, InlineCards, Popups, type LayerHost } from "./LayerViews";
import { GuiFrames } from "./FramedView";
import {
  LAYER_EVENTS,
  NO_LAYERS,
  applyLayerEvent,
  type Layers,
} from "./layers";
import {
  guiControlOf,
  guiDocument,
  guiItemsOf,
  keysIntoFrame,
  strayKeys,
  type GuiKeyboard,
} from "./guiFrame";
import {
  NO_DECORATIONS,
  applyGuiEvent,
  dismissToast,
  type Decorations,
} from "./decorations";
import type {
  DevhubNeovimApi,
  NeovimGuiWindowWire,
  NeovimGuiWindowsWire,
} from "../../ipc/neovim";
import type { TerminalNeovimKeyWire } from "../../ipc/contract";
import type { AppAppearance } from "../../ipc/appShell";

type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "attached"; readonly version: string }
  | {
      readonly kind: "failed";
      readonly message: string;
      /** Attach again by itself: the Neovim is still there (an SSH drop). */
      readonly reconnect?: boolean;
    };

/** How long the page waits before each attempt to reconnect by itself. */
const RECONNECT_DELAYS_MS = [800, 2000, 5000, 10000];

/** The GUI-window content Lua asked for, by id; where it is is Neovim's. */
interface GuiContent {
  readonly id: number;
  readonly title: string;
  readonly html?: string;
  readonly url?: string;
  readonly keyboard: GuiKeyboard;
}

/** What a Neovim surface needs of its page's bridge. */
export interface NeovimSurfaceBridge {
  readonly neovim: DevhubNeovimApi;
  openExternalUrl(url: string): Promise<void>;
}

/** What the page that places a Neovim asks of it (`PaneNeovims`). */
export interface NeovimHandle {
  /**
   * Ask for the grid a view this size holds, for a held layout: what it
   * flushes is drawn only at `resumePaint`, and `flushed` hears each flush
   * (`NeovimEditor.resizeFor`).
   */
  resizeFor(
    width: number,
    height: number,
    flushed: () => void,
  ): { cols: number; rows: number } | undefined;
  /** Its pane has moved off the old place: draw what came, now. */
  resumePaint(): void;
  /** Grid 1 as Neovim last drew it. */
  drawnSize(): { cols: number; rows: number } | undefined;
  /** Neovim's default background: its pane's ground. */
  background(): number | undefined;
  /** A keystroke main took for it (`TerminalNeovimKeyWire`). */
  typeKey(key: TerminalNeovimKeyWire): void;
  /** Whether the page's focus is in it (its textarea or a GUI window). */
  focused(): boolean;
}

/**
 * One Neovim, drawn. `workspaceId` is the overlay's key, the id every
 * Neovim call names. `placed`: its element is on its pane at the pane's
 * size (shown there, or hidden where it last was) — until then the size
 * it has is no pane's, and a UI attached at it would make Neovim reshape
 * its windows to fit, which growing back does not undo (a split's upper
 * window left one row tall). `keys`: it has the page's keys.
 */
export function NeovimSurface({
  workspaceId,
  appearance,
  bridge,
  placed: onPane,
  keys,
  handle,
  changed,
}: {
  readonly workspaceId: string;
  readonly appearance: AppAppearance | undefined;
  readonly bridge: NeovimSurfaceBridge;
  readonly placed: boolean;
  readonly keys: boolean;
  /** Told its handle once its editor is made, and `null` when it goes. */
  readonly handle: (handle: NeovimHandle | null) => void;
  /** Told when what its handle answers may have changed. */
  readonly changed: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<NeovimEditor | null>(null);
  const [connection, setConnection] = useState<Connection>({
    kind: "connecting",
  });
  const [generation, setGeneration] = useState(0);
  // Whether the element is on its pane (`placed`) and the grid's cell is
  // the person's font's (`appearance`): until both, a UI attached at the
  // grid it holds would have Neovim reshape its windows. What waits to
  // attach until then.
  const placed = useRef({
    view: false,
    font: false,
    ready: false,
    waiting: new Set<() => void>(),
  });
  const release = useCallback(() => {
    const p = placed.current;
    if (p.ready || !p.view || !p.font) return;
    p.ready = true;
    const waiting = [...p.waiting];
    p.waiting.clear();
    for (const go of waiting) go();
  }, []);
  useEffect(() => {
    if (!onPane) return;
    placed.current.view = true;
    release();
  }, [onPane, release]);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const [, setTick] = useState(0);
  const [guiContent, setGuiContent] = useState<ReadonlyMap<number, GuiContent>>(
    new Map(),
  );
  const [guiWindows, setGuiWindows] = useState<NeovimGuiWindowsWire>({
    windows: [],
    current: 0,
  });
  const [decorations, setDecorations] = useState<Decorations>(NO_DECORATIONS);
  const [layers, setLayers] = useState<Layers>(NO_LAYERS);
  const frames = useRef(new Map<number, HTMLIFrameElement>());
  /** The GUI window whose field has the keys (Lua's `edit`, until `leave`). */
  const [editing, setEditing] = useState<number | undefined>(undefined);
  const reconnectAttempt = useRef(0);

  const settings = useMemo(
    () => ({
      font: terminalCellFont(appearance),
      macOptionIsMeta: appearance?.terminalMacOptionIsMeta ?? false,
    }),
    [appearance],
  );
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const call = (method: string, params: readonly unknown[]) => {
      bridge.neovim.call({ workspaceId, method, params });
    };
    const request = async (method: string, params: readonly unknown[]) => {
      const answer = await bridge.neovim.request({
        workspaceId,
        method,
        params,
      });
      if (!answer.ok) throw new Error(answer.message);
      return answer.value;
    };
    const editor = new NeovimEditor(
      host,
      { call, request },
      settingsRef.current,
    );
    editorRef.current = editor;
    editor.setKeys(keysRef.current);
    // For DevTools: the state each Neovim on the page is drawing, by key.
    const debug = window as unknown as {
      neovimEditors?: Record<string, NeovimEditor>;
    };
    (debug.neovimEditors ??= {})[workspaceId] = editor;
    handleRef.current({
      resizeFor: (width, height, flushed) =>
        editor.resizeFor(width, height, flushed),
      // What React draws from the paint (the corner's notifications, the
      // command line, menus) is committed with it, in the same frame.
      resumePaint: () => {
        flushSync(() => {
          editor.resumePaint();
        });
      },
      drawnSize: () => editor.drawnSize(),
      background: () =>
        editor.state.grids.has(1)
          ? editor.state.defaults.background
          : undefined,
      typeKey: (key) => {
        editor.typeKey(key);
      },
      focused: () => {
        const active = document.activeElement;
        return (
          active !== null &&
          (active === editor.input ||
            [...frames.current.values()].includes(active as HTMLIFrameElement))
        );
      },
    });
    // What the pane is placed from: grid 1's size and Neovim's ground.
    let told = "";
    const unsubscribe = editor.subscribe(() => {
      setTick((tick) => tick + 1);
      const size = editor.drawnSize();
      const now = `${String(size?.cols)}x${String(size?.rows)}:${String(
        editor.state.grids.has(1) ? editor.state.defaults.background : "",
      )}`;
      if (now !== told) {
        told = now;
        changedRef.current();
      }
      // Neovim's messages: to the corner, or the pager (`messages.ts`).
      const events = editor.takeMessages();
      if (events.length === 0) return;
      const routed = routeMessages(events, editor.state.lastCommand, (attr) =>
        editor.state.hl.get(attr),
      );
      if (routed.toasts.length > 0) {
        setDecorations((before) =>
          routed.toasts.reduce(
            (state, toast) =>
              applyGuiEvent(state, "notify", {
                group: "Neovim",
                msg: toast.msg,
                level: toast.level,
                key: toast.key,
              }),
            before,
          ),
        );
      }
      if (routed.pager) {
        const { source, title, lines } = routed.pager;
        call("nvim_exec_lua", [
          "local M = package.loaded['devhub_gui']; if M and M._pager_show then M._pager_show(...) end",
          [
            {
              source,
              title,
              lines: lines.map((line) => line.map((c) => [c.text, c.hl])),
            },
          ],
        ]);
      }
    });
    const offRedraw = bridge.neovim.onRedraw((id, batches) => {
      if (id !== workspaceId) return;
      try {
        editor.redraw(batches);
      } catch (error) {
        // A redraw this page cannot apply: this Neovim starts over (its
        // screen from a new attach), and nothing else on the page is
        // touched.
        console.error(
          `[devhub] the Neovim ${workspaceId} could not draw`,
          error,
        );
        editor.reset();
        setConnection({
          kind: "failed",
          message: "DevHub could not draw this Neovim. Reconnecting…",
          reconnect: true,
        });
      }
    });
    const offEnded = bridge.neovim.onEnded((id, reason, reconnect) => {
      if (id !== workspaceId) return;
      editor.reset();
      setConnection({ kind: "failed", message: reason, reconnect });
    });
    const offGui = bridge.neovim.onGuiWindow(
      (id, wire: NeovimGuiWindowWire) => {
        if (id !== workspaceId) return;
        setGuiContent((before) => {
          const next = new Map(before);
          if (!wire.open) next.delete(wire.id);
          else
            next.set(wire.id, {
              id: wire.id,
              title: wire.title,
              keyboard: wire.keyboard,
              ...(wire.content.kind === "html"
                ? { html: wire.content.html }
                : {}),
              ...(wire.content.kind === "url" ? { url: wire.content.url } : {}),
            });
          return next;
        });
      },
    );
    const offWindows = bridge.neovim.onGuiWindows((id, windows) => {
      if (id !== workspaceId) return;
      setGuiWindows(windows);
      if (windows.layout) editor.placeWindows(windows.layout);
    });
    const offSend = bridge.neovim.onGuiSend((message) => {
      if (message.workspaceId !== workspaceId) return;
      frames.current
        .get(message.id)
        ?.contentWindow?.postMessage({ devhubGui: message.message }, "*");
    });
    const offEvent = bridge.neovim.onGuiEvent((event) => {
      if (event.workspaceId !== workspaceId) return;
      // Where Lua placed something is counted from the rows its window had
      // scrolled when the placement came, not when it is drawn.
      const scrolled = editor.scrolledRows();
      const rowsOf = (win: number) => scrolled.get(win) ?? 0;
      if (event.kind === "quick_pick") {
        // vim.ui.select / vim.ui.input: put to the person in DevHub's quick
        // pick; Lua's callback runs with the answer (docs/native-picker.md).
        const asked = event.payload as { id?: unknown } | null;
        const id = asked?.id;
        if (typeof id !== "number") return;
        void bridge.neovim
          .quickPick(asked as never)
          .catch(() => -1)
          .then((answer) => {
            call("nvim_exec_lua", [
              "local M = package.loaded['devhub_gui']; if M and M._quick_pick_done then M._quick_pick_done(...) end",
              [id, answer],
            ]);
            editor.focus();
          });
        return;
      }
      if (event.kind === "decor") {
        // Where Neovim's own virtual text is: set in the UI face.
        editor.setDecor(decorOf(event.payload));
        return;
      }
      if (event.kind === "gui_keys") {
        // Lua's word on a GUI window's focus: the page rings, presses or
        // enters the element; a field entered takes the keys, and gives
        // them back when Neovim leaves insert mode.
        const control = guiControlOf(event.payload);
        if (!control) return;
        const frame = frames.current.get(control.id);
        if (control.action === "edit") {
          setEditing(control.id);
          if (keysRef.current) frame?.focus();
        } else if (control.action === "leave") {
          setEditing((before) => (before === control.id ? undefined : before));
          editor.focus();
        }
        frame?.contentWindow?.postMessage({ devhubControl: control }, "*");
        return;
      }
      if (event.kind === "theme") {
        // A window's fillchars changed: what the painter keeps is asked again.
        editor.refreshTheme();
        return;
      }
      if (LAYER_EVENTS.has(event.kind)) {
        setLayers((before) =>
          applyLayerEvent(before, event.kind, event.payload, rowsOf),
        );
        return;
      }
      setDecorations((before) =>
        applyGuiEvent(before, event.kind, event.payload, rowsOf),
      );
    });
    setDecorations(NO_DECORATIONS);
    setLayers(NO_LAYERS);
    let cancelled = false;
    const attach = () => {
      if (cancelled) return;
      const size = editor.fit();
      void bridge.neovim
        .attach({ workspaceId, cols: size.cols, rows: size.rows })
        .then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            // While reconnecting by itself, a refused attach (the host still
            // unreachable) is one more attempt, until they run out.
            const again = reconnectAttempt.current > 0;
            setConnection({
              kind: "failed",
              message: result.message,
              reconnect: again,
            });
            return;
          }
          reconnectAttempt.current = 0;
          editor.attached(size);
          setConnection({ kind: "attached", version: result.version });
          editor.focus();
        });
    };
    // Once its element is on its pane, at the pane's size (`placed`).
    const place = placed.current;
    if (place.ready) attach();
    else place.waiting.add(attach);
    return () => {
      cancelled = true;
      place.waiting.delete(attach);
      unsubscribe();
      offRedraw();
      offEnded();
      offGui();
      offWindows();
      offSend();
      offEvent();
      editor.dispose();
      editorRef.current = null;
      if (debug.neovimEditors?.[workspaceId] === editor)
        delete debug.neovimEditors[workspaceId];
      handleRef.current(null);
    };
  }, [bridge, workspaceId, generation]);

  useEffect(() => {
    editorRef.current?.updateSettings(settings);
    // The person's font is the grid's now: a waiting attach may go.
    if (appearance === undefined) return;
    placed.current.font = true;
    release();
  }, [settings, appearance, release]);

  // A framed view's windows are drawn bare: the frame is the view's chrome.
  useEffect(() => {
    editorRef.current?.claimWindows(
      new Set(layers.placedFrames.flatMap((frame) => frame.wins)),
    );
  }, [layers.placedFrames]);

  // An SSH drop: attach again by itself, a few times, further apart.
  const autoReconnect =
    connection.kind === "failed" && connection.reconnect === true;
  useEffect(() => {
    if (!autoReconnect) return undefined;
    const delay = RECONNECT_DELAYS_MS[reconnectAttempt.current];
    if (delay === undefined) {
      reconnectAttempt.current = 0;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      reconnectAttempt.current += 1;
      setConnection({ kind: "connecting" });
      setGeneration((g) => g + 1);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [autoReconnect, generation]);

  // A GUI window's page talks to its Lua side, and gives the keyboard back.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      for (const [id, frame] of frames.current) {
        if (frame.contentWindow !== event.source) continue;
        if (event.data === null || typeof event.data !== "object") return;
        const data = event.data as {
          devhubSend?: unknown;
          devhubKey?: string;
          devhubFocus?: boolean;
          index?: unknown;
          editable?: unknown;
          devhubFocused?: unknown;
          devhubItems?: unknown;
          devhubDeclare?: unknown;
          devhubStray?: unknown;
        };
        const lua = (fn: string, ...args: unknown[]) => {
          bridge.neovim.call({
            workspaceId,
            method: "nvim_exec_lua",
            params: [
              "local M = package.loaded['devhub_gui']; local fn = ...; if M and M[fn] then M[fn](select(2, ...)) end",
              [fn, id, ...args],
            ],
          });
        };
        const items = guiItemsOf(data.devhubItems);
        if (items) {
          lua("_gui_items", items);
          const current = guiWindowsRef.current;
          frame.contentWindow?.postMessage(
            {
              devhubCurrent: current.windows.some(
                (w) => w.id === id && w.win === current.current,
              ),
            },
            "*",
          );
        }
        if (Array.isArray(data.devhubDeclare)) {
          lua(
            "_gui_declare",
            data.devhubDeclare.filter((k) => typeof k === "string"),
          );
        }
        if (typeof data.devhubFocused === "number") {
          lua("_gui_focused", data.devhubFocused);
        }
        if ("devhubStray" in data) {
          const keys = strayKeys(
            data.devhubStray,
            settingsRef.current.macOptionIsMeta === true,
          );
          if (keys !== undefined) {
            bridge.neovim.call({
              workspaceId,
              method: "nvim_input",
              params: [keys],
            });
          }
          editorRef.current?.focus();
        }
        if ("devhubSend" in data) {
          bridge.neovim.guiMessage({
            workspaceId,
            id,
            message: data.devhubSend,
          });
        }
        if (typeof data.devhubKey === "string") {
          bridge.neovim.call({
            workspaceId,
            method: "nvim_input",
            params: [data.devhubKey],
          });
          editorRef.current?.focus();
        }
        if (data.devhubFocus === true) {
          const win = guiWindowsRef.current.windows.find(
            (w) => w.id === id,
          )?.win;
          if (win !== undefined) {
            bridge.neovim.call({
              workspaceId,
              method: "nvim_set_current_win",
              params: [win],
            });
          }
          // A click is the focus moving too: on a field, into it (insert
          // mode); elsewhere the keys stay, or come back, Neovim's.
          if (guiContentRef.current.get(id)?.keyboard === "neovim") {
            if (typeof data.index === "number" && data.index >= 0) {
              lua("_gui_focused", data.index);
            }
            if (data.editable !== true) editorRef.current?.focus();
          }
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [bridge, workspaceId]);
  const guiWindowsRef = useRef(guiWindows);
  guiWindowsRef.current = guiWindows;
  const guiContentRef = useRef(guiContent);
  guiContentRef.current = guiContent;

  // A page with no bridge (a url) says nothing of a click: its frame taking
  // the focus says it, and its window becomes Neovim's current one.
  useEffect(() => {
    const onBlur = () => {
      window.setTimeout(() => {
        for (const [id, frame] of frames.current) {
          if (document.activeElement !== frame) continue;
          const { windows, current } = guiWindowsRef.current;
          const win = windows.find((w) => w.id === id)?.win;
          if (win !== undefined && win !== current) {
            bridge.neovim.call({
              workspaceId,
              method: "nvim_set_current_win",
              params: [win],
            });
          }
        }
      }, 0);
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
    };
  }, [bridge, workspaceId]);

  const editor = editorRef.current;
  const nvim = editor?.state;

  // Keyboard into the current GUI window's frame only while it is the
  // frame's (a "content" page, or a field Lua entered); Neovim's otherwise.
  const currentGui = guiWindows.windows.find(
    (w) => w.win === guiWindows.current,
  );
  const currentKeyboard = currentGui && guiContent.get(currentGui.id)?.keyboard;
  const intoFrame =
    currentGui !== undefined &&
    keysIntoFrame(currentKeyboard, editing === currentGui.id);
  useEffect(() => {
    if (!editor) return;
    editor.setKeys(keys);
    // Without the keys it leaves the page's focus alone: the terminal or
    // another Neovim has it (`PaneNeovims` moves it).
    if (!keys) return;
    if (!intoFrame || currentGui === undefined) {
      if (document.activeElement !== editor.input) editor.focus();
      return;
    }
    frames.current.get(currentGui.id)?.focus();
  }, [editor, currentGui, intoFrame, keys]);
  // A field whose window is no longer current has lost the keys (Lua
  // stopped insert mode); the ring shows only in the current window.
  useEffect(() => {
    if (editing !== undefined && currentGui?.id !== editing) {
      setEditing(undefined);
    }
    for (const [id, frame] of frames.current) {
      frame.contentWindow?.postMessage(
        { devhubCurrent: currentGui?.id === id },
        "*",
      );
    }
  }, [currentGui, editing]);

  const send = useCallback(
    (method: string, params: readonly unknown[]) => {
      bridge.neovim.call({ workspaceId, method, params });
    },
    [bridge, workspaceId],
  );

  const cell = editor?.cellMetrics();
  // Where the command line is, for plugins that draw beside it.
  const [posRow, posCol] = editor
    ? cmdlineUiPos(editor.cmdlinePlace())
    : [0, 0];
  const attached = connection.kind === "attached";
  const screen = editor?.state.grids.has(1) === true;
  useEffect(() => {
    // Not before grid 1 is there: the rows are counted from it.
    if (!attached || posRow === 0 || !screen) return;
    send("nvim_set_var", ["ui_cmdline_pos", [posRow, posCol]]);
  }, [attached, send, posRow, posCol, screen]);

  // Where each GUI buffer's content is drawn when it is in several windows:
  // the current window if it is one of them, else the first.
  const primaryWindow = new Map<number, number>();
  for (const { id, win } of guiWindows.windows) {
    if (!primaryWindow.has(id) || win === guiWindows.current) {
      primaryWindow.set(id, win);
    }
  }

  const dismiss = useCallback((key: number) => {
    setDecorations((before) => dismissToast(before, key));
  }, []);
  const openLink = useCallback(
    (url: string) => {
      void bridge.openExternalUrl(url);
    },
    [bridge],
  );

  const tabs = nvim?.tabline;
  const showTabs = tabs !== undefined && tabs.tabs.length > 1;
  const boxes = editor?.gridBoxes() ?? [];
  const fontFamily = editor?.font().family;
  const fontSize = editor?.font().size;
  const ride = useCallback(() => {
    editorRef.current?.placeRiders();
  }, []);
  const layerHost: LayerHost | undefined =
    nvim && cell && editor
      ? {
          cell,
          boxes,
          mono: `${ICON_FAMILY}, ${fontFamily ? `${fontFamily}, ` : ""}monospace`,
          defaults: nvim.defaults,
          lua: (fn, args) => {
            send("nvim_exec_lua", [
              "local M = package.loaded['devhub_gui']; local fn = ...; if M and M[fn] then M[fn](select(2, ...)) end",
              [fn, ...args],
            ]);
          },
          openLink,
          refocus: () => {
            editor?.focus();
          },
          ride,
          over: (grid, part) => editor.over(grid, part),
        }
      : undefined;

  return (
    <div
      className="neovim-surface"
      style={
        nvim
          ? {
              ["--nvim-editor-ground" as string]: cssColor(
                nvim.defaults.background,
              ),
              // The type scale of everything DevHub sets in the UI face
              // (`neovim.css`): from the grid's size, so a larger terminal
              // font makes the hovers, toasts, labels and code larger too.
              ...(fontSize !== undefined ? uiTypeScale(fontSize) : {}),
            }
          : undefined
      }
    >
      {showTabs ? (
        <TabStrip
          tabs={tabs.tabs}
          current={tabs.current}
          select={(tab) => {
            send("nvim_set_current_tabpage", [tab]);
            editor?.focus();
          }}
        />
      ) : null}
      <div className="nvim-host" ref={hostRef} aria-label="Neovim">
        {nvim && cell && editor
          ? guiWindowsInPaintOrder(guiWindows.windows, primaryWindow).map(
              ({ id, win }) => {
                const box = boxes.find((b) => b.win === win);
                const content = guiContent.get(id);
                if (!box || !content) return null;
                if (primaryWindow.get(id) !== win) {
                  // The same GUI buffer in a second window: its content lives
                  // in one place (one page), so this one
                  // says where, and a click takes the cursor there.
                  return createPortal(
                    <div
                      className="nvim-gui-window nvim-gui-elsewhere"
                      style={{
                        left: box.col * cell.width,
                        top: box.row * cell.height,
                        width: box.width * cell.width,
                        height: box.height * cell.height,
                        background: cssColor(nvim.defaults.background),
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        send("nvim_set_current_win", [win]);
                      }}
                    >
                      <span>
                        {content.title || "GUI window"} is shown in another
                        window
                      </span>
                    </div>,
                    editor.over(box.grid, "covers"),
                    `${String(id)}:${String(win)}`,
                  );
                }
                // Inside a float's border: those cells are Neovim's to draw.
                const inset = guiWindows.windows.some(
                  (w) => w.id === id && w.win === win && w.border === true,
                )
                  ? 1
                  : 0;
                const style = {
                  left: (box.col + inset) * cell.width,
                  top: (box.row + inset) * cell.height,
                  width: (box.width - 2 * inset) * cell.width,
                  height: (box.height - 2 * inset) * cell.height,
                  background: cssColor(nvim.defaults.background),
                };
                const current = win === guiWindows.current;
                // In its window's clip: a cover, over the cursor
                // (`PART_Z`). The clip stays while the grid does, so
                // the iframe is never moved (which would load it again).
                return createPortal(
                  <div
                    data-gui-id={id}
                    className={[
                      "nvim-gui-window",
                      current ? "nvim-gui-current" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={style}
                    onMouseDownCapture={() => {
                      if (!current) send("nvim_set_current_win", [win]);
                    }}
                    onKeyDownCapture={(event) => {
                      if (
                        event.ctrlKey &&
                        (event.key === "w" || event.key === "W")
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        send("nvim_input", ["<C-w>"]);
                        editor?.focus();
                        return;
                      }
                    }}
                  >
                    <iframe
                      title={content.title}
                      ref={(frame) => {
                        if (frame) frames.current.set(id, frame);
                        else frames.current.delete(id);
                      }}
                      sandbox="allow-scripts allow-forms allow-popups"
                      {...(content.url !== undefined
                        ? { src: content.url }
                        : {
                            srcDoc: guiDocument(
                              content.html ?? "",
                              {
                                fg: cssColor(nvim.defaults.foreground),
                                bg: cssColor(nvim.defaults.background),
                              },
                              content.keyboard,
                            ),
                          })}
                    />
                  </div>,
                  editor.over(box.grid, "covers"),
                  String(id),
                );
              },
            )
          : null}
        {nvim && cell && editor ? (
          <>
            <InlineImages
              decorations={decorations}
              boxes={boxes}
              cell={cell}
              ride={ride}
              over={(grid, part) => editor.over(grid, part)}
            />
            {layerHost ? (
              <>
                <InlineCards layers={layers} host={layerHost} />
                <GuiViews layers={layers} host={layerHost} />
                <GuiFrames layers={layers} host={layerHost} />
                <Popups
                  layers={layers}
                  host={layerHost}
                  area={editor.areaSize()}
                />
              </>
            ) : null}
            <CmdwinFrame editor={editor} cmdwin={decorations.cmdwin} />
            <CmdlineBand state={nvim} editor={editor} />
            <Cmdline
              state={nvim}
              editor={editor}
              typingCount={decorations.typingCount}
            />
            <Popupmenu state={nvim} editor={editor} send={send} />
          </>
        ) : null}
      </div>
      {editor
        ? // Ambient status: over the windows, under every float
          // (`NeovimEditor.ambient`).
          createPortal(
            <Toasts
              toasts={decorations.toasts}
              dismiss={dismiss}
              bottom={toastBottom(editor, boxes, decorations.pager)}
              right={toastRight(editor, boxes)}
              surface={editor.surface()}
              cell={editor.cellMetrics()}
              fontSize={editor.font().size}
            />,
            editor.ambient(),
          )
        : null}
      {connection.kind === "connecting" ? (
        <div className="nvim-status">Starting Neovim…</div>
      ) : null}
      {connection.kind === "failed" ? (
        <div className="nvim-status nvim-status-failed" role="alert">
          <p>{connection.message}</p>
          <button
            type="button"
            onClick={() => {
              setConnection({ kind: "connecting" });
              setGeneration((g) => g + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Each GUI buffer's own window first, one per buffer and in a stable order,
 * then its other windows: the element that holds a page keeps its place in
 * the DOM when the buffer's current window changes, since moving an iframe
 * reloads it.
 */
function guiWindowsInPaintOrder(
  windows: readonly { readonly id: number; readonly win: number }[],
  primary: ReadonlyMap<number, number>,
): { readonly id: number; readonly win: number }[] {
  const ids = [...new Set(windows.map((w) => w.id))];
  const first = ids.flatMap((id) => {
    const win = primary.get(id);
    return win === undefined ? [] : [{ id, win }];
  });
  const rest = windows.filter((w) => primary.get(w.id) !== w.win);
  return [...first, ...rest];
}

function ChunkSpans({
  chunks,
  state,
}: {
  readonly chunks: Chunks;
  readonly state: NeovimUiState;
}) {
  return (
    <>
      {chunks.map(([hl, text], index) => {
        const attr = hl === 0 ? undefined : state.hl.get(hl);
        const colors = attr ? resolveColors(attr, state.defaults) : undefined;
        return (
          <span
            key={index}
            style={
              colors && attr?.foreground !== undefined
                ? { color: cssColor(colors.fg) }
                : undefined
            }
          >
            {text}
          </span>
        );
      })}
    </>
  );
}

/** A message's chunks as a command line's (`[attr, text]`). */
function chunksOfMsg(line: readonly MsgChunk[]): Chunks {
  return line.map((c) => [c.attr, c.text] as const);
}

/**
 * The mark before the text: `:` for a command, `/` `?` for a search, `=`
 * for an expression — the one mark that says what is typed, in a box that
 * is otherwise the same for all; plain text, no chip around it, at the
 * box's inset (`neovim.css`) — or a prompt's own words.
 */
function CmdlineLead({
  line,
  cell,
  x,
}: {
  readonly line: CmdlineLevel | undefined;
  readonly cell: { readonly width: number; readonly height: number };
  readonly x: number;
}) {
  if (!line) return null;
  if (line.firstc !== "") {
    return (
      <span
        className="nvim-cmdline-badge"
        style={{ left: x, width: textCells(line.firstc) * cell.width }}
      >
        {line.firstc}
      </span>
    );
  }
  // On cells, as the typed text: page text in the grid's face still runs
  // wider than Neovim's cells, and a prompt is read with its answer.
  const layout = cmdlineLayout(
    { content: [[0, line.prompt]], pos: 0, indent: 0 },
    cmdlineLead(line, 1000),
  );
  return (
    <>
      {layout.cells.map((c, index) => (
        <span
          key={index}
          className="nvim-cmdline-cell nvim-cmdline-prompt"
          style={{
            left: x + c.col * cell.width,
            top: c.row * cell.height,
            width: c.cells * cell.width,
          }}
        >
          {c.ch}
        </span>
      ))}
    </>
  );
}

/**
 * `ext_cmdline` and its prompts, in one bordered box at the bottom
 * (`cmdlinePlace`; the person's pick, mock 2): `:` and `/` share the box,
 * the search count at its right edge; a prompt (`confirm()`, `inputlist()`,
 * the swap file's question, `:s///c`) shows its question over its line,
 * answered with the keys as Neovim reads them. Its text sits on whole
 * cells in the grid's own font, laid out as Neovim's own command line
 * would hold it (`cmdlineLayout`), so what plugins draw beside it — told
 * where it is by `g:ui_cmdline_pos` — lines up with its text, and the
 * caret and an IME's preedit sit on the cell `cmdline_pos` names.
 */
function Cmdline({
  state,
  editor,
  typingCount,
}: {
  readonly state: NeovimUiState;
  readonly editor: NeovimEditor;
  readonly typingCount: string;
}) {
  const line = state.cmdline.at(-1);
  if (!line && !state.cmdlineBlock && !state.prompt) return null;
  const cell = editor.cellMetrics();
  const font = editor.font();
  const place = editor.cmdlinePlace();
  const rows = editor.cmdlineRows(place.cols);
  const inside = place.left + 1;
  const searching = line?.firstc === "/" || line?.firstc === "?";
  const label =
    line?.firstc === ":"
      ? "Command"
      : line?.firstc === "/"
        ? "Search forward"
        : line?.firstc === "?"
          ? "Search backward"
          : line?.firstc === "="
            ? "Expression"
            : state.prompt || line?.prompt
              ? "Prompt"
              : "Command";
  const gridCols = editor.gridSize().cols;
  return (
    <div
      className={
        editor.paintTheme().cmdheight === 0
          ? "nvim-cmdline nvim-cmdline-floating"
          : "nvim-cmdline"
      }
      role="dialog"
      aria-label={label}
      style={{
        left: place.left,
        top: place.top,
        width: place.width,
        height: place.height,
        font: fontOf(font),
        lineHeight: `${String(cell.height)}px`,
        ["--nvim-cell" as string]: `${String(cell.width)}px`,
        ["--nvim-label-size" as string]: `${String(font.size - 1)}px`,
      }}
    >
      <div
        className="nvim-cmdline-content"
        style={{ top: place.padY, height: place.rows * cell.height }}
      >
        <div className="nvim-cmdline-stack">
          {(state.prompt ?? []).map((msg, index) => (
            <div
              key={`p${String(index)}`}
              className="nvim-cmdline-message"
              style={{
                marginLeft: cell.width - inside,
                width: (gridCols - 3) * cell.width,
                // A blank line of the question is a row, as Neovim shows it.
                minHeight: cell.height,
              }}
            >
              <ChunkSpans chunks={chunksOfMsg(msg)} state={state} />
            </div>
          ))}
          {(state.cmdlineBlock ?? []).map((chunks, index) => (
            <div
              key={`b${String(index)}`}
              className="nvim-cmdline-block"
              style={{ marginLeft: place.col * cell.width - inside }}
            >
              <ChunkSpans chunks={chunks} state={state} />
            </div>
          ))}
          {line ? (
            <div
              className="nvim-cmdline-row"
              style={{ height: rows.text * cell.height }}
            >
              <CmdlineLead line={line} cell={cell} x={cell.width - inside} />
              <CmdlineRow
                line={line}
                state={state}
                cell={cell}
                cols={place.cols}
                x={place.col * cell.width - inside}
                focused={editor.hasKeyboard()}
              />
            </div>
          ) : null}
        </div>
      </div>
      {searching && typingCount !== "" ? (
        <span className="nvim-cmdline-count">{countLabel(typingCount)}</span>
      ) : null}
    </div>
  );
}

/** `3/12` as the box shows it: `3 / 12`. */
function countLabel(count: string): string {
  return count.replace(/^\[|\]$/g, "").replace("/", " / ");
}

/**
 * The rows `cmdheight` keeps, while nothing is typed: Neovim's own line
 * there, quietly. Left, the mode (`-- INSERT --`, recording) or, with no
 * mode to say, the search just entered, where it was typed (the person's
 * pick: the echo in the same place); right, the search count, `showcmd`
 * and the ruler, dimmer — counts and keys being typed, glanced at. No
 * box: it is not being typed into. With `cmdheight=0` there are no rows:
 * only the search echo is shown, in the box over the status line, for a
 * few seconds (Neovim draws nothing there either).
 */
function CmdlineBand({
  state,
  editor,
}: {
  readonly state: NeovimUiState;
  readonly editor: NeovimEditor;
}) {
  const echo = state.searchEcho;
  const [shownEcho, setShownEcho] = useState(echo);
  const cmdheight = editor.paintTheme().cmdheight;
  useEffect(() => {
    setShownEcho(echo);
    if (!echo || cmdheight > 0) return;
    const timer = window.setTimeout(() => {
      setShownEcho(undefined);
    }, ECHO_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [echo, cmdheight]);
  if (state.cmdline.length > 0 || state.prompt || state.cmdlineBlock)
    return null;
  const mode = state.showmode;
  const right = [...state.showcmd, ...state.ruler];
  const searchShown = cmdheight > 0 ? echo : shownEcho;
  const showEcho = searchShown !== undefined && msgText(mode).trim() === "";
  if (cmdheight === 0 && !showEcho) return null;
  if (!showEcho && mode.length === 0 && right.length === 0) return null;
  const cell = editor.cellMetrics();
  const font = editor.font();
  const place = editor.cmdlinePlace();
  const inside = place.left + 1;
  const firstc = showEcho ? searchShown.text.slice(0, 1) : "";
  return (
    <div
      className={
        cmdheight > 0
          ? "nvim-cmdline nvim-cmdline-band"
          : "nvim-cmdline nvim-cmdline-floating"
      }
      aria-live="polite"
      style={{
        left: place.left,
        top: place.top,
        width: place.width,
        height: place.height,
        font: fontOf(font),
        lineHeight: `${String(cell.height)}px`,
        ["--nvim-cell" as string]: `${String(cell.width)}px`,
        ["--nvim-label-size" as string]: `${String(font.size - 1)}px`,
      }}
    >
      <div
        className="nvim-cmdline-content"
        style={{ top: place.padY, height: cell.height }}
      >
        {showEcho ? (
          <>
            <span
              className="nvim-cmdline-badge"
              style={{ left: cell.width - inside, width: cell.width }}
            >
              {firstc}
            </span>
            <span
              className="nvim-cmdline-echo"
              style={{ left: place.col * cell.width - inside }}
            >
              {searchShown.text.slice(1)}
            </span>
          </>
        ) : (
          <span
            className="nvim-cmdline-echo"
            style={{ left: cell.width - inside }}
          >
            <ChunkSpans chunks={chunksOfMsg(mode)} state={state} />
          </span>
        )}
      </div>
      <span className="nvim-cmdline-count">
        {showEcho && searchShown.count !== ""
          ? countLabel(searchShown.count)
          : ""}
        {right.length > 0 && cmdheight > 0 ? (
          <span className="nvim-cmdline-status">{msgText(right).trim()}</span>
        ) : null}
      </span>
    </div>
  );
}

/** How long the search echo stays with `cmdheight=0`, where no row keeps it. */
const ECHO_MS = 4000;

/**
 * The command-line window (`q:`, `q/`) as the command line's box grown
 * upward (mock 2): the same edges and hairline, a header naming it where
 * the status line above it was, and its own status line and the rows
 * under it covered by the box. The lines inside are Neovim's window,
 * untouched: where it is, its cursor and its clicks stay Neovim's; only a
 * frame is added round it.
 */
function CmdwinFrame({
  editor,
  cmdwin,
}: {
  readonly editor: NeovimEditor;
  readonly cmdwin: { readonly win: number; readonly type: string } | undefined;
}) {
  if (!cmdwin) return null;
  const box = editor.gridBoxes().find((b) => !b.float && b.win === cmdwin.win);
  if (!box) return null;
  const cell = editor.cellMetrics();
  const font = editor.font();
  const place = editor.cmdlinePlace();
  const top = Math.max(0, box.row - 1) * cell.height;
  const textBottom = (box.row + box.height) * cell.height;
  const bottom = Math.max(textBottom + cell.height, place.top + place.height);
  const name =
    cmdwin.type === ":"
      ? "Command history"
      : cmdwin.type === "/" || cmdwin.type === "?"
        ? "Search history"
        : "History";
  return (
    <div
      className="nvim-cmdwin"
      aria-label={name}
      style={{
        left: place.left,
        top,
        width: place.width,
        height: bottom - top,
        ["--nvim-label-size" as string]: `${String(font.size - 1)}px`,
      }}
    >
      <div className="nvim-cmdwin-header" style={{ height: cell.height }}>
        <span className="nvim-cmdline-badge nvim-cmdwin-badge">
          {cmdwin.type}
        </span>
        <span className="nvim-cmdwin-title">
          {name} (q{cmdwin.type})
        </span>
        <span className="nvim-cmdwin-keys">
          <kbd>Enter</kbd> run <kbd>Ctrl-C</kbd> close
        </span>
      </div>
      <div
        className="nvim-cmdwin-foot"
        style={{ top: textBottom - top, bottom: 0 }}
      />
    </div>
  );
}

function CmdlineRow({
  line,
  state,
  focused,
  cell,
  cols,
  x,
}: {
  readonly line: NeovimUiState["cmdline"][number];
  readonly state: NeovimUiState;
  /** Whether this view has the keyboard (`NeovimEditor.hasKeyboard`). */
  readonly focused: boolean;
  readonly cell: { readonly width: number; readonly height: number };
  readonly cols: number;
  /** Where the text's first cell is, from the box's inside left edge. */
  readonly x: number;
}) {
  const layout = cmdlineLayout(line, cols);
  const mode = currentModeInfo(state);
  const caretRef = useRef<HTMLSpanElement>(null);
  // Another view has the keyboard: a steady, faint caret, as the grid's.
  const on = focused ? (mode?.blinkon ?? 0) : 0;
  const off = mode?.blinkoff ?? 0;
  const wait = mode?.blinkwait ?? 0;
  const moved = `${String(layout.caret.row)},${String(layout.caret.col)},${state.mode.name}`;
  // `guicursor`'s blink, restarted on every move, as the grid's cursor.
  useEffect(() => {
    const caret = caretRef.current;
    if (!caret || on <= 0 || off <= 0 || typeof caret.animate !== "function")
      return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const split = on / (on + off);
    const blink = caret.animate(
      [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: split },
        { opacity: 0, offset: split },
        { opacity: 0, offset: 1 },
      ],
      { duration: on + off, delay: wait, iterations: Infinity },
    );
    return () => {
      blink.cancel();
    };
  }, [moved, on, off, wait]);
  const attr = mode && mode.attrId > 0 ? state.hl.get(mode.attrId) : undefined;
  const colors =
    attr && (attr.background !== undefined || attr.foreground !== undefined)
      ? resolveColors(attr, state.defaults)
      : undefined;
  const shape = mode?.cursorShape ?? "vertical";
  const pct = (mode?.cellPercentage ?? 25) / 100;
  const under = layout.cells.find(
    (c) => c.row === layout.caret.row && c.col === layout.caret.col,
  );
  const caretStyle: React.CSSProperties = {
    left: layout.caret.col * cell.width,
    top: layout.caret.row * cell.height,
    height: cell.height,
    ...(colors ? { background: cssColor(colors.bg) } : {}),
  };
  if (shape === "vertical") {
    caretStyle.width = Math.max(2, Math.round(cell.width * pct));
  } else if (shape === "horizontal") {
    const h = Math.max(2, Math.round(cell.height * pct));
    caretStyle.top = layout.caret.row * cell.height + cell.height - h;
    caretStyle.height = h;
    caretStyle.width = (under?.cells ?? 1) * cell.width;
  } else {
    caretStyle.width = (under?.cells ?? 1) * cell.width;
    if (colors) caretStyle.color = cssColor(colors.fg);
  }
  const textColor = (hl: number) => {
    const a = hl === 0 ? undefined : state.hl.get(hl);
    return a?.foreground !== undefined
      ? cssColor(resolveColors(a, state.defaults).fg)
      : undefined;
  };
  return (
    <>
      {layout.cells.map((c, index) => (
        <span
          key={index}
          className={
            c.special
              ? "nvim-cmdline-cell nvim-cmdline-special"
              : "nvim-cmdline-cell"
          }
          style={{
            left: x + c.col * cell.width,
            top: c.row * cell.height,
            width: c.cells * cell.width,
            color: textColor(c.hl),
          }}
        >
          {c.ch}
        </span>
      ))}
      <span
        ref={caretRef}
        className={`nvim-cmdline-caret nvim-cmdline-caret-${shape}${focused ? "" : " nvim-cmdline-caret-unfocused"}`}
        style={{ ...caretStyle, left: x + layout.caret.col * cell.width }}
        aria-hidden="true"
      >
        {shape === "block" ? (under?.ch ?? "") : ""}
      </span>
    </>
  );
}

/**
 * `ext_popupmenu`: the completion list, at its anchor cell, in the
 * person's `Pmenu` colours. Words in the editor's face on its rows, so a
 * candidate looks as it will in the buffer and lines up with the word it
 * completes; the kind as a mark in the kind's own colour; the kind's name
 * and the item's source in the UI face, labels about the word. The
 * selection is a band rounded concentrically with the menu (the floats'
 * radius less the inset), as a float's selected row is (`painter.ts`).
 */
function Popupmenu({
  state,
  editor,
  send,
}: {
  readonly state: NeovimUiState;
  readonly editor: NeovimEditor;
  readonly send: (method: string, params: readonly unknown[]) => void;
}) {
  const menu = state.popupmenu;
  if (!menu || menu.items.length === 0) return null;
  const cell = editor.cellMetrics();
  const font = editor.font();
  const theme = editor.paintTheme();
  const colours = theme.menu;
  const css = (v: number | undefined) =>
    v === undefined ? undefined : cssColor(v);
  const command = menu.grid === -1;
  const box = editor.gridBoxes().find((b) => b.grid === menu.grid);
  const bar = editor.cmdlinePlace();
  // The words start three cells in (padding, mark, gap): the menu goes
  // that far left of its anchor, so a candidate sits over the word it
  // completes.
  const lead = 3 * cell.width;
  const style: React.CSSProperties = {
    ...(command
      ? // Against the command line's box, never over it, its candidates
        // over the word they complete (`menu.col` counts `firstc`, a cell
        // before the text).
        cmdlineMenuPlace(
          editor.areaSize(),
          bar,
          (bar.col - 1 + menu.col) * cell.width - lead,
          cell.height,
          menu.items.length,
        )
      : popupmenuPlace(
          editor.areaSize(),
          ((box?.row ?? 0) + menu.row) * cell.height,
          ((box?.col ?? 0) + menu.col) * cell.width - lead,
          cell.height,
          menu.items.length,
        )),
    font: fontOf(font),
    lineHeight: `${String(cell.height)}px`,
    ["--completion-cell" as string]: `${String(cell.width)}px`,
    ["--completion-row" as string]: `${String(cell.height)}px`,
    ["--completion-label-size" as string]: `${String(font.size - 1)}px`,
    ...(colours?.bg !== undefined ? { background: css(colours.bg) } : {}),
    ...(colours?.fg !== undefined ? { color: css(colours.fg) } : {}),
    ...(colours?.selBg !== undefined
      ? { ["--completion-sel-bg" as string]: css(colours.selBg) }
      : {}),
    ...(colours?.selFg !== undefined
      ? { ["--completion-sel-fg" as string]: css(colours.selFg) }
      : {}),
    ...(colours?.kind !== undefined
      ? { ["--completion-kind" as string]: css(colours.kind) }
      : {}),
    ...(colours?.extra !== undefined
      ? { ["--completion-extra" as string]: css(colours.extra) }
      : {}),
    ...(colours?.kindSel !== undefined
      ? { ["--completion-kind-sel" as string]: css(colours.kindSel) }
      : {}),
    ...(colours?.extraSel !== undefined
      ? { ["--completion-extra-sel" as string]: css(colours.extraSel) }
      : {}),
    ...(theme.surface?.muted !== undefined
      ? { ["--completion-muted" as string]: css(theme.surface.muted) }
      : {}),
  };
  return (
    <CompletionMenu
      items={menu.items.map((item) => ({
        word: item.word,
        kind: item.kind,
        extra: item.menu,
      }))}
      selected={menu.selected}
      style={style}
      kindColour={(kind) => css(theme.kinds?.colours.get(kind))}
      onChoose={(index) => {
        send("nvim_select_popupmenu_item", [index, true, false, {}]);
      }}
    />
  );
}

/**
 * Where notifications sit: the lowest line on the row over the lowest
 * window's status line, so the status line and the command line stay
 * readable and the lines stand on the editor's rows.
 */
function toastBottom(
  editor: NeovimEditor | null,
  boxes: readonly GridBox[],
  pager: number | undefined,
): number {
  if (!editor) return 12;
  const cell = editor.cellMetrics();
  const windows = boxes.filter((b) => !b.float && b.win !== undefined);
  if (windows.length === 0) return 12;
  // The status line is the row under the lowest window: clear of its top,
  // and of the command line's box when it rises over the windows (a
  // prompt is never under a notification).
  const status =
    Math.max(...windows.map((b) => b.row + b.height)) * cell.height;
  const state = editor.state;
  const box =
    state.cmdline.length > 0 || state.prompt !== undefined
      ? editor.cmdlinePlace().top
      : Number.POSITIVE_INFINITY;
  // And of the pager, which covers the windows' bottom while it is open.
  const paged = boxes.find((b) => b.float && b.win === pager);
  const above = paged ? paged.row * cell.height : Number.POSITIVE_INFINITY;
  return Math.max(0, editor.areaSize().height - Math.min(status, box, above));
}

/**
 * Where notifications end on the right: a cell in from the rightmost
 * window's edge, the edge the status line's right-hand text keeps.
 */
function toastRight(
  editor: NeovimEditor | null,
  boxes: readonly GridBox[],
): number {
  if (!editor) return 12;
  const cell = editor.cellMetrics();
  const windows = boxes.filter((b) => !b.float && b.win !== undefined);
  if (windows.length === 0) return cell.width;
  const edge = Math.max(...windows.map((b) => b.col + b.width));
  return Math.max(0, editor.areaSize().width - edge * cell.width) + cell.width;
}
