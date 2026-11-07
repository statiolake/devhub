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
import { charOffsetOfByte, type Chunks, type NeovimUiState } from "./redraw";
import { cssColor, fontOf, resolveColors } from "./painter";
import { TerminalSurface } from "../terminal/TerminalSurface";
import { workspaceTerminalSurfaceKey } from "../../ipc/terminal";
import type {
  NeovimGuiWindowWire,
  NeovimGuiWindowsWire,
} from "../../ipc/neovim";
import type { AppAppearance } from "../../ipc/appShell";

type Connection =
  | { readonly kind: "connecting" }
  | { readonly kind: "attached"; readonly version: string }
  | { readonly kind: "failed"; readonly message: string };

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
  const frames = useRef(new Map<number, HTMLIFrameElement>());

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
    const editor = new NeovimEditor(host, { call }, settingsRef.current);
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
    const offEnded = bridge.neovim.onEnded((id, reason) => {
      if (id !== workspaceId) return;
      editor.reset();
      setConnection({ kind: "failed", message: reason });
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
    let cancelled = false;
    const size = editor.fit();
    void bridge.neovim
      .attach({ workspaceId, cols: size.cols, rows: size.rows })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setConnection({ kind: "failed", message: result.message });
          return;
        }
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
      editor.dispose();
      editorRef.current = null;
    };
  }, [bridge, workspaceId, generation]);

  useEffect(() => {
    editorRef.current?.updateSettings(settings);
  }, [settings]);

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
  useEffect(() => {
    if (!editor) return;
    if (currentGui === undefined) {
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
  }, [editor, currentGui, guiContent]);

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

  const tabs = nvim?.tabline;
  const showTabs = tabs !== undefined && tabs.tabs.length > 1;
  const boxes = editor?.gridBoxes() ?? [];

  return (
    <div className="neovim-surface">
      {showTabs ? (
        <div className="nvim-tabline" role="tablist">
          {tabs.tabs.map((tab) => (
            <button
              key={tab.tab}
              type="button"
              role="tab"
              aria-selected={tab.tab === tabs.current}
              className={
                tab.tab === tabs.current
                  ? "nvim-tab nvim-tab-current"
                  : "nvim-tab"
              }
              onMouseDown={(event) => {
                event.preventDefault();
                send("nvim_set_current_tabpage", [tab.tab]);
                editor?.focus();
              }}
            >
              {tabTitle(tab.name)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="nvim-host" ref={hostRef} aria-label={`${label} — Neovim`}>
        {nvim && cell
          ? guiWindows.windows.map(({ id, win }) => {
              const box = boxes.find((b) => b.win === win);
              const content = guiContent.get(id);
              if (!box || !content) return null;
              const style = {
                left: box.col * cell.width,
                top: box.row * cell.height,
                width: box.width * cell.width,
                height: box.height * cell.height,
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
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={style}
                  onMouseDownCapture={() => {
                    if (!current) send("nvim_set_current_win", [win]);
                  }}
                  onFocusCapture={() => {
                    // A terminal focuses itself as it connects: the keyboard
                    // stays where Neovim's cursor is until Neovim moves it.
                    if (!current) editor?.focus();
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
            })
          : null}
        {nvim && cell && editor ? (
          <>
            <Cmdline state={nvim} editor={editor} />
            <Popupmenu state={nvim} editor={editor} send={send} />
          </>
        ) : null}
      </div>
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
function tabTitle(name: string): string {
  const parts = name.split("/");
  return parts.at(-1) || name || "[No Name]";
}

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

function chunkText(chunks: Chunks): string {
  return chunks.map(([, text]) => text).join("");
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

/**
 * `ext_cmdline`: a palette-like bar near the top, the cursor in it. It sits
 * on whole cells in the grid's own font (`cmdlinePlace`), so what plugins
 * draw beside the command line — told where it is by `g:ui_cmdline_pos` —
 * lines up with its text.
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
  const text = line ? chunkText(line.content) : "";
  const cursorAt = line ? charOffsetOfByte(text, line.pos) : 0;
  const before = text.slice(0, cursorAt);
  const after = text.slice(cursorAt);
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
        <div className="nvim-cmdline-row">
          <span className="nvim-cmdline-firstc">
            {line.firstc || line.prompt || ""}
          </span>
          <span className="nvim-cmdline-text">
            {" ".repeat(line.indent)}
            {before}
            <span className="nvim-cmdline-cursor">
              {line.special?.char ?? ""}
            </span>
            {after}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The kind letter Vim's completion gives, as a word and a colour. */
function kindOf(kind: string): { label: string; tone: string } {
  const k = kind.trim().toLowerCase();
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
  return { label: kind.slice(0, 2), tone: "text" };
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
