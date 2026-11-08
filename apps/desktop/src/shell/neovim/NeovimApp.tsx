/**
 * The Neovim editor: one Workspace's headless Neovim, drawn by DevHub.
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
 * **GUI windows** follow the same rule. `require('devhub_gui').open{…}`
 * opens an ordinary Neovim window on a scratch buffer, and this page paints
 * web content exactly over that window's grid: `:vsplit`, `<C-w>` moves,
 * `:close`, `:only` and tab pages move it, because they move the window.
 * When the cursor enters it, the keyboard goes into it; `<C-w>` gives the
 * keyboard back to Neovim, which reads the rest of the window command.
 * `:DevhubTerminal` is one of them, filled with the Workspace's terminal.
 *
 * # Its contract with main
 *
 * - **reads**: the snapshot (that its Workspace exists, its name), the
 *   appearance (the monospace font and the Option key).
 * - **asks**: `neovim.attach` once mounted, then `neovim.call` for every
 *   key, click, scroll and resize; the terminal transport for a terminal
 *   GUI window.
 * - **is pushed**: `redraw`, `ended`, GUI windows and their messages.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { devhub } from "./client";
import {
  useAppearance,
  useProjection,
  useRaiseFailure,
} from "../model/pageModel";
import { NeovimEditor } from "./editor";
import { cmdlinePlace, cmdlineUiPos, popupmenuPlace } from "./place";
import {
  currentModeInfo,
  type Chunks,
  type GridBox,
  type NeovimUiState,
} from "./redraw";
import { cmdlineLayout, textCells } from "./cmdline";
import { ICON_FAMILY, cssColor, fontOf, resolveColors } from "./painter";
import { glyphKind } from "./glyphs";
import { TerminalSurface } from "../terminal/TerminalSurface";
import { TabStrip } from "./TabStrip";
import { InlineImages, Toasts } from "./DecorationViews";
import {
  GuiViews,
  InlineCards,
  LineDecorations,
  Popups,
  type LayerHost,
} from "./LayerViews";
import {
  LAYER_EVENTS,
  NO_LAYERS,
  applyLayerEvent,
  type Layers,
} from "./layers";
import {
  NO_DECORATIONS,
  applyGuiEvent,
  dismissToast,
  type Decorations,
} from "./decorations";
import { workspaceTerminalSurfaceKey } from "../../ipc/terminal";
import type {
  NeovimGuiWindowWire,
  NeovimGuiWindowsWire,
} from "../../ipc/neovim";
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
  readonly terminal?: boolean;
  readonly hiddenRows?: { readonly top: number; readonly bottom: number };
}

export function NeovimApp({ workspaceId }: { readonly workspaceId: string }) {
  const bridge = useMemo(() => devhub(), []);
  const reportFailure = useRaiseFailure(bridge);
  const { state, attempt } = useProjection(bridge, reportFailure, () => {});
  const appearance = useAppearance(bridge, reportFailure, attempt);
  const workspace =
    state.status === "ready"
      ? state.snapshot.workspaces.find((one) => one.id === workspaceId)
      : undefined;
  if (state.status !== "ready" || !workspace) return null;
  return (
    <div className="app-shell neovim-page">
      <NeovimSurface
        workspaceId={workspaceId}
        label={workspace.label}
        appearance={appearance}
      />
    </div>
  );
}

function NeovimSurface({
  workspaceId,
  label,
  appearance,
}: {
  readonly workspaceId: string;
  readonly label: string;
  readonly appearance: AppAppearance | undefined;
}) {
  const bridge = useMemo(() => devhub(), []);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<NeovimEditor | null>(null);
  const [connection, setConnection] = useState<Connection>({
    kind: "connecting",
  });
  const [generation, setGeneration] = useState(0);
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
  const reconnectAttempt = useRef(0);

  const settings = useMemo(
    () => ({
      monoFamily: appearance?.terminalFontFamily ?? "",
      fontSize: appearance?.terminalFontSize ?? 13,
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
    // For DevTools: the state the page is drawing.
    (window as unknown as { neovimEditor?: NeovimEditor }).neovimEditor =
      editor;
    const unsubscribe = editor.subscribe(() => {
      setTick((tick) => tick + 1);
    });
    const offRedraw = bridge.neovim.onRedraw((id, batches) => {
      if (id === workspaceId) editor.redraw(batches);
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
              ...(wire.content.kind === "html"
                ? { html: wire.content.html }
                : {}),
              ...(wire.content.kind === "url" ? { url: wire.content.url } : {}),
              ...(wire.content.kind === "terminal"
                ? {
                    terminal: true,
                    ...(wire.content.hiddenRows
                      ? { hiddenRows: wire.content.hiddenRows }
                      : {}),
                  }
                : {}),
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
      if (event.kind === "terminal_insert") {
        setTerminalNormal(undefined);
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
    return () => {
      cancelled = true;
      unsubscribe();
      offRedraw();
      offEnded();
      offGui();
      offWindows();
      offSend();
      offEvent();
      editor.dispose();
      editorRef.current = null;
    };
  }, [bridge, workspaceId, generation]);

  useEffect(() => {
    editorRef.current?.updateSettings(settings);
  }, [settings]);

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
        const data = event.data as {
          devhubSend?: unknown;
          devhubKey?: string;
          devhubFocus?: boolean;
        };
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

  const editor = editorRef.current;
  const nvim = editor?.state;

  // Keyboard into the GUI window Neovim's cursor is in; back out otherwise.
  const currentGui = guiWindows.windows.find(
    (w) => w.win === guiWindows.current,
  );
  // A terminal window in terminal-normal mode: the cursor is in it, the
  // keyboard is Neovim's (<C-w>k, :q, …) until i/a give it back.
  const [terminalNormal, setTerminalNormal] = useState<number | undefined>();
  const escapeRef = useRef<{ id: number; replaying: boolean } | undefined>(
    undefined,
  );
  const normalHere =
    currentGui !== undefined && terminalNormal === currentGui.id;
  useEffect(() => {
    if (terminalNormal !== undefined && currentGui?.id !== terminalNormal) {
      setTerminalNormal(undefined);
    }
  }, [currentGui, terminalNormal]);
  useEffect(() => {
    if (!editor) return;
    if (currentGui === undefined || normalHere) {
      if (document.activeElement !== editor.input) editor.focus();
      return;
    }
    const content = guiContent.get(currentGui.id);
    if (content?.terminal === true) {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        `[data-gui-id="${String(currentGui.id)}"] .xterm-helper-textarea`,
      );
      textarea?.focus();
    } else {
      frames.current.get(currentGui.id)?.focus();
    }
  }, [editor, currentGui, guiContent, normalHere]);

  const send = useCallback(
    (method: string, params: readonly unknown[]) => {
      bridge.neovim.call({ workspaceId, method, params });
    },
    [bridge, workspaceId],
  );

  // A terminal in a Neovim window wears Neovim's ground, not the terminal
  // theme's: it is part of the editor, under Neovim's statusline.
  const nvimBackground = nvim?.defaults.background;
  const nvimForeground = nvim?.defaults.foreground;
  const terminalAppearance = useMemo(
    () =>
      appearance && nvimBackground !== undefined && nvimForeground !== undefined
        ? withGround(appearance, nvimBackground, nvimForeground)
        : appearance,
    [appearance, nvimBackground, nvimForeground],
  );

  const cell = editor?.cellMetrics();
  // Where the command line bar is, for plugins that draw beside it.
  const [posRow, posCol] =
    editor && cell
      ? cmdlineUiPos(cmdlinePlace(editor.gridSize().cols, cell.width))
      : [0, 0];
  const attached = connection.kind === "attached";
  useEffect(() => {
    if (!attached || posRow === 0) return;
    send("nvim_set_var", ["ui_cmdline_pos", [posRow, posCol]]);
  }, [attached, send, posRow, posCol]);

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
  const ride = useCallback(() => {
    editorRef.current?.placeRiders();
  }, []);
  const layerHost: LayerHost | undefined =
    nvim && cell
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
      <div className="nvim-host" ref={hostRef} aria-label={`${label} — Neovim`}>
        {nvim && cell
          ? guiWindowsInPaintOrder(guiWindows.windows, primaryWindow).map(
              ({ id, win }) => {
                const box = boxes.find((b) => b.win === win);
                const content = guiContent.get(id);
                if (!box || !content) return null;
                if (primaryWindow.get(id) !== win) {
                  // The same GUI buffer in a second window: its content lives
                  // in one place (one page, one terminal client), so this one
                  // says where, and a click takes the cursor there.
                  return (
                    <div
                      key={`${String(id)}:${String(win)}`}
                      className="nvim-gui-window nvim-gui-elsewhere"
                      style={{
                        left: box.col * cell.width,
                        top: box.row * cell.height,
                        width: box.width * cell.width,
                        height: box.height * cell.height,
                        zIndex: box.z + 1,
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
                    </div>
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
                  zIndex: box.z + 1,
                  background: cssColor(nvim.defaults.background),
                };
                const current = win === guiWindows.current;
                return (
                  <div
                    key={id}
                    data-gui-id={id}
                    className={[
                      "nvim-gui-window",
                      current ? "nvim-gui-current" : "",
                      content.terminal === true ? "nvim-gui-terminal" : "",
                      current && terminalNormal === id
                        ? "nvim-gui-terminal-normal"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={style}
                    onMouseDownCapture={() => {
                      if (!current) send("nvim_set_current_win", [win]);
                      // A click into a terminal is typing into it again.
                      if (terminalNormal === id) setTerminalNormal(undefined);
                    }}
                    onFocusCapture={() => {
                      // A terminal focuses itself as it connects: the keyboard
                      // stays where Neovim's cursor is until Neovim moves it.
                      if (!current) editor?.focus();
                    }}
                    onKeyDownCapture={(event) => {
                      if (content.terminal === true) {
                        // Neovim's :terminal model: keys go to the shell
                        // (<C-w> deletes a word there); <C-\><C-n> leaves
                        // for terminal-normal mode, i/a come back.
                        if (terminalEscape(event, escapeRef, id)) {
                          setTerminalNormal(id);
                          editor?.focus();
                          return;
                        }
                        // Cmd+C copies the terminal's selection: DevHub's
                        // menu leaves the editing keys to this page, and the
                        // emulator answers the copy command, not the key.
                        if (
                          event.metaKey &&
                          !event.shiftKey &&
                          (event.key === "c" || event.key === "C")
                        ) {
                          event.preventDefault();
                          document.execCommand("copy");
                        }
                        return;
                      }
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
                    {content.terminal === true ? (
                      <TerminalSurface
                        surfaceKey={workspaceTerminalSurfaceKey(workspaceId)}
                        surfaceLabel={`${label} terminal`}
                        appearance={terminalAppearance}
                        hideTitle
                        {...(content.hiddenRows
                          ? { hiddenRows: content.hiddenRows }
                          : {})}
                      />
                    ) : (
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
                              srcDoc: guiDocument(content.html ?? "", nvim),
                            })}
                      />
                    )}
                  </div>
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
            />
            {layerHost ? (
              <>
                <LineDecorations layers={layers} host={layerHost} />
                <InlineCards layers={layers} host={layerHost} />
                <GuiViews layers={layers} host={layerHost} />
                <Popups
                  layers={layers}
                  host={layerHost}
                  area={editor.areaSize()}
                />
              </>
            ) : null}
            <Cmdline state={nvim} editor={editor} />
            <Popupmenu state={nvim} editor={editor} send={send} />
          </>
        ) : null}
      </div>
      <Toasts
        toasts={decorations.toasts}
        dismiss={dismiss}
        bottom={toastBottom(editor, boxes)}
        surface={editor?.surface()}
      />
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

/**
 * <C-\\><C-n> in a terminal window, Neovim's own way out of a terminal: true
 * when this key completes it. A <C-\\> followed by anything else reaches the
 * shell after all, ahead of that key (replayed into the emulator).
 */
function terminalEscape(
  event: React.KeyboardEvent,
  pending: { current: { id: number; replaying: boolean } | undefined },
  id: number,
): boolean {
  const state = pending.current;
  if (state?.replaying === true) return false;
  const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
  if (state !== undefined && state.id === id) {
    if (["Control", "Shift"].includes(event.key)) return false;
    pending.current = undefined;
    if (ctrlOnly && (event.key === "n" || event.key === "N")) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    const target = event.target as HTMLElement;
    pending.current = { id, replaying: true };
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "\\",
        code: "Backslash",
        keyCode: 220,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    pending.current = undefined;
    return false;
  }
  if (ctrlOnly && (event.code === "Backslash" || event.key === "\\")) {
    event.preventDefault();
    event.stopPropagation();
    pending.current = { id, replaying: false };
  }
  return false;
}

/** `appearance` with both terminal palettes on Neovim's default colours. */
function withGround(
  appearance: AppAppearance,
  background: number,
  foreground: number,
): AppAppearance {
  const bg = hexColor(background);
  const fg = hexColor(foreground);
  const theme = appearance.terminalTheme;
  const ground = (palette: typeof theme.dark) => ({
    ...palette,
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorText: bg,
  });
  return {
    ...appearance,
    terminalTheme: { light: ground(theme.light), dark: ground(theme.dark) },
  };
}

function hexColor(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

/** A tab's name as Neovim gives it (a path): its last part. */
/** The GUI window's page: the person's HTML, with `devhub` to talk to Lua. */
function guiDocument(html: string, state: NeovimUiState): string {
  const fg = cssColor(state.defaults.foreground);
  const bg = cssColor(state.defaults.background);
  const prelude = `<style>:root{--fg:${fg};--bg:${bg};color-scheme:dark light}html,body{color:var(--fg);background:var(--bg)}</style><script>
(() => {
  const listeners = [];
  window.devhub = {
    send: (message) => parent.postMessage({ devhubSend: message }, "*"),
    onMessage: (fn) => listeners.push(fn),
  };
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || !("devhubGui" in event.data)) return;
    for (const fn of listeners) fn(event.data.devhubGui);
  });
  addEventListener("keydown", (event) => {
    if (event.ctrlKey && (event.key === "w" || event.key === "W")) {
      event.preventDefault();
      parent.postMessage({ devhubKey: "<C-w>" }, "*");
      return;
    }
    // The Mac's editing keys reach this page as keys (DevHub's menu leaves
    // them to the Neovim editor): answered here, on this page's selection.
    if (event.metaKey && !event.ctrlKey && !event.altKey) {
      const k = event.key.toLowerCase();
      const command = k === "c" ? "copy" : k === "x" ? "cut" : k === "a" ? "selectAll"
        : k === "z" ? (event.shiftKey ? "redo" : "undo") : undefined;
      if (command) {
        event.preventDefault();
        document.execCommand(command);
      }
    }
  }, true);
  addEventListener("pointerdown", () => parent.postMessage({ devhubFocus: true }, "*"), true);
})();
</script>`;
  return prelude + html;
}

/** The command line bar's padding around its cells, as `neovim.css` rounds it. */
const CMDLINE_PAD_X = 12;
const CMDLINE_PAD_Y = 8;

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

/**
 * `ext_cmdline`: a palette-like bar near the top, the cursor in it. It sits
 * on whole cells in the grid's own font (`cmdlinePlace`), its text laid out
 * cell by cell as Neovim's own command line would hold it (`cmdlineLayout`),
 * so what plugins draw beside the command line — told where it is by
 * `g:ui_cmdline_pos` — lines up with its text, and the caret and an IME's
 * preedit sit on the cell `cmdline_pos` names.
 */
function Cmdline({
  state,
  editor,
}: {
  readonly state: NeovimUiState;
  readonly editor: NeovimEditor;
}) {
  const line = state.cmdline.at(-1);
  if (!line && !state.cmdlineBlock) return null;
  const block = state.cmdlineBlock ?? [];
  const cell = editor.cellMetrics();
  const font = editor.font();
  const place = cmdlinePlace(editor.gridSize().cols, cell.width);
  const style: React.CSSProperties = {
    left: place.col * cell.width - CMDLINE_PAD_X,
    top: place.row * cell.height - CMDLINE_PAD_Y,
    width: place.cols * cell.width + 2 * CMDLINE_PAD_X,
    padding: `${String(CMDLINE_PAD_Y)}px ${String(CMDLINE_PAD_X)}px`,
    font: fontOf(font),
    lineHeight: `${String(cell.height)}px`,
    ["--nvim-cell" as string]: `${String(cell.width)}px`,
  };
  const label =
    line?.firstc === ":"
      ? "Command"
      : line?.firstc === "/"
        ? "Search forward"
        : line?.firstc === "?"
          ? "Search backward"
          : line?.firstc === "="
            ? "Expression"
            : line?.prompt
              ? "Input"
              : "Command";
  return (
    <div
      className="nvim-cmdline"
      role="dialog"
      aria-label={label}
      style={style}
    >
      {block.map((chunks, index) => (
        <div key={index} className="nvim-cmdline-block">
          <ChunkSpans chunks={chunks} state={state} />
        </div>
      ))}
      {line ? (
        <CmdlineRow
          line={line}
          state={state}
          cell={cell}
          cols={place.cols}
          focused={editor.hasKeyboard()}
        />
      ) : null}
    </div>
  );
}

function CmdlineRow({
  line,
  state,
  focused,
  cell,
  cols,
}: {
  readonly line: NeovimUiState["cmdline"][number];
  readonly state: NeovimUiState;
  /** Whether this view has the keyboard (`NeovimEditor.hasKeyboard`). */
  readonly focused: boolean;
  readonly cell: { readonly width: number; readonly height: number };
  readonly cols: number;
}) {
  const lead = line.firstc || line.prompt || "";
  const leadCells = Math.min(cols - 1, Math.max(1, textCells(lead)));
  const layout = cmdlineLayout(line, cols - leadCells);
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
    <div className="nvim-cmdline-row">
      <span
        className="nvim-cmdline-firstc"
        style={{ width: leadCells * cell.width }}
      >
        {lead}
      </span>
      <span
        className="nvim-cmdline-text"
        style={{ height: layout.rows * cell.height }}
      >
        {layout.cells.map((c, index) => (
          <span
            key={index}
            className={
              c.special
                ? "nvim-cmdline-cell nvim-cmdline-special"
                : "nvim-cmdline-cell"
            }
            style={{
              left: c.col * cell.width,
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
          style={caretStyle}
          aria-hidden="true"
        >
          {shape === "block" ? (under?.ch ?? "") : ""}
        </span>
      </span>
    </div>
  );
}

/**
 * The kind letter Vim's completion gives, as a word and a colour. A kind
 * that starts with a Nerd Font icon (lspkind's `" Function"`, a config's
 * own symbols) shows that icon, in the bundled symbols font.
 */
function kindOf(kind: string): { label: string; tone: string } {
  const trimmed = kind.trim();
  const first = String.fromCodePoint(trimmed.codePointAt(0) ?? 0x20);
  if (glyphKind(first) === "icon") {
    const rest = trimmed.slice(first.length).trim();
    return { label: first, tone: rest ? kindOf(rest).tone : "text" };
  }
  const k = trimmed.toLowerCase();
  const table: Record<string, [string, string]> = {
    f: ["ƒ", "function"],
    function: ["ƒ", "function"],
    method: ["ƒ", "function"],
    m: ["◆", "member"],
    field: ["◆", "member"],
    property: ["◆", "member"],
    v: ["𝑥", "variable"],
    variable: ["𝑥", "variable"],
    t: ["T", "type"],
    class: ["C", "type"],
    interface: ["I", "type"],
    struct: ["S", "type"],
    enum: ["E", "type"],
    keyword: ["K", "keyword"],
    snippet: ["✂", "snippet"],
    text: ["≡", "text"],
    module: ["{}", "module"],
    constant: ["π", "constant"],
    d: ["#", "constant"],
  };
  const hit = table[k];
  if (hit) return { label: hit[0], tone: hit[1] };
  return { label: Array.from(trimmed).slice(0, 2).join(""), tone: "text" };
}

/** `ext_popupmenu`: the completion list, at its anchor cell. */
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
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>(".nvim-pum-selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, [menu?.selected, menu]);
  if (!menu || menu.items.length === 0) return null;
  const cell = editor.cellMetrics();
  const command = menu.grid === -1;
  const box = editor.gridBoxes().find((b) => b.grid === menu.grid);
  const bar = cmdlinePlace(editor.gridSize().cols, cell.width);
  const style: React.CSSProperties = command
    ? {
        left: (bar.col + menu.col) * cell.width - 6,
        top: (bar.row + 1) * cell.height + CMDLINE_PAD_Y + 4,
      }
    : popupmenuPlace(
        editor.areaSize(),
        ((box?.row ?? 0) + menu.row) * cell.height,
        ((box?.col ?? 0) + menu.col) * cell.width - 6,
        cell.height,
        menu.items.length,
      );
  return (
    <div
      className="nvim-pum"
      style={style}
      role="listbox"
      ref={listRef}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
    >
      {menu.items.map((item, index) => {
        const kind = kindOf(item.kind);
        return (
          <div
            key={index}
            role="option"
            aria-selected={index === menu.selected}
            className={
              index === menu.selected
                ? "nvim-pum-item nvim-pum-selected"
                : "nvim-pum-item"
            }
            onMouseDown={() => {
              send("nvim_select_popupmenu_item", [index, true, false, {}]);
            }}
          >
            {item.kind ? (
              <span className={`nvim-pum-kind nvim-kind-${kind.tone}`}>
                {kind.label}
              </span>
            ) : null}
            <span className="nvim-pum-word">{item.word}</span>
            {item.menu ? (
              <span className="nvim-pum-menu">{item.menu}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Where notifications sit: just above the lowest window's status line, so
 * the status line and the command line stay readable.
 */
function toastBottom(
  editor: NeovimEditor | null,
  boxes: readonly GridBox[],
): number {
  if (!editor) return 12;
  const cell = editor.cellMetrics();
  const windows = boxes.filter((b) => !b.float && b.win !== undefined);
  if (windows.length === 0) return 12;
  // The status line is the row under the lowest window: clear of its top,
  // and of messages risen over the windows (a prompt stays readable).
  const lowest = Math.min(
    Math.max(...windows.map((b) => b.row + b.height)),
    editor.messagePanelRow() ?? Number.POSITIVE_INFINITY,
  );
  return Math.max(6, editor.areaSize().height - lowest * cell.height + 6);
}
