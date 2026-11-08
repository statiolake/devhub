import { useEffect, useMemo, useRef, useState } from "react";
import "../../neovim/neovim.css";
import "../../surfaces/xtermSession.css";
import "../terminal.css";
import "./control.css";
import { useColorScheme } from "../../appearance";
import { Failure, Waiting } from "../../components/shell/SurfaceState";
import { GridPainter, rgbOfCss } from "../../neovim/painter";
import { OptionKeys } from "../../surfaces/optionKey";
import {
  activePalette,
  terminalFontStack,
  terminalSurfaceStyle,
  type TerminalPalette,
} from "../theme";
import {
  createTerminalClient,
  terminalErrorSummary,
  type TerminalReceipt,
} from "../client";
import { TERMINAL_PROTOCOL_VERSION } from "../../../ipc/terminal";
import type {
  ControlToPage,
  PageToControl,
  PaneBox,
} from "../../../ipc/terminalControl";
import { pasteBytes, sgrMouse, tmuxKey } from "./controlKeys";
import {
  applyControl,
  borders,
  newControlView,
  paneAt,
  paneBoxes,
  type ControlView,
} from "./paneGrids";
import type { TerminalSurfaceProps } from "../TerminalSurface";

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

function colorsOf(palette: TerminalPalette | undefined) {
  const foreground = rgbOfCss(palette?.foreground ?? "") ?? 0xd0d0d0;
  const background = rgbOfCss(palette?.background ?? "") ?? 0x1e1e1e;
  const ansi = (palette?.ansi ?? []).map((c) => rgbOfCss(c) ?? 0);
  return {
    foreground,
    background,
    cursor: palette?.cursor ?? palette?.foreground ?? "#d0d0d0",
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
  const [shown, setShown] = useState(!hidden);
  if (!hidden && !shown) setShown(true);
  const controllerRef = useRef<{
    retry(): void;
    visible(on: boolean): void;
    colors(c: ReturnType<typeof colorsOf>): void;
    selectWindow(id: number): void;
    focus(): void;
  } | null>(null);
  const live = useRef({ hidden, reattachOnExit, appearance, colors });
  live.current = { hidden, reattachOnExit, appearance, colors };

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
    const input = document.createElement("textarea");
    input.className = "control-input";
    input.setAttribute("aria-label", `${surfaceLabel} terminal input`);
    input.autocapitalize = "off";
    input.spellcheck = false;
    host.append(grids, lines, cursor, input);

    const appearanceNow = live.current.appearance;
    const fontSize = appearanceNow?.terminalFontSize ?? 13;
    const lineHeight = appearanceNow?.terminalLineHeight ?? 1.2;
    const painter = new GridPainter(grids, {
      family: terminalFontStack(appearanceNow?.terminalFontFamily),
      size: fontSize,
      linespace: Math.max(0, Math.round(fontSize * (lineHeight - 1))),
    });
    const view = newControlView(live.current.colors);
    const optionKeys = new OptionKeys();

    let disposed = false;
    let receipt: TerminalReceipt | undefined;
    let serial = 0;
    let connectedAt = 0;
    let typed = false;
    let reattachedOnExit = false;
    /** Messages for a client being attached: the person's keys meanwhile. */
    let held: PageToControl[] | undefined;
    let pendingChanges: ReturnType<typeof applyControl>[] = [];
    let frameRequested = false;
    let lastSeq = 0;
    let ackedSeq = 0;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    let size = { cols: 0, rows: 0 };

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
      const boxes = paneBoxes(view);
      painter.paint(view.state, merged, boxes, merged.layout);
      lines.replaceChildren(
        ...borders(view.panes).map((line) => {
          const el = document.createElement("div");
          el.className = line.vertical
            ? "control-border-v"
            : "control-border-h";
          el.style.left = `${String((line.x + (line.vertical ? 0.5 : 0)) * width)}px`;
          el.style.top = `${String((line.y + (line.vertical ? 0 : 0.5)) * height)}px`;
          if (line.vertical)
            el.style.height = `${String(line.length * height)}px`;
          else el.style.width = `${String(line.length * width)}px`;
          return el;
        }),
      );
      const pane = activePane();
      const at = pane === undefined ? undefined : view.cursors.get(pane.pane);
      if (pane === undefined || at === undefined || !at.visible) {
        cursor.style.display = "none";
      } else {
        cursor.style.display = "";
        cursor.dataset.shape = String(at.shape);
        cursor.style.left = `${String((pane.x + at.x) * width)}px`;
        cursor.style.top = `${String((pane.y + at.y) * height)}px`;
        cursor.style.width = `${String(width)}px`;
        cursor.style.height = `${String(height)}px`;
        input.style.left = cursor.style.left;
        input.style.top = cursor.style.top;
      }
      if (lastSeq > ackedSeq) {
        ackedSeq = lastSeq;
        send({ kind: "ack", seq: lastSeq });
      }
    };

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
      if (message.kind === "ended") {
        const ended = receipt;
        receipt = undefined;
        const lived = typed || Date.now() - connectedAt >= REATTACH_ON_EXIT_MS;
        if (ended !== undefined) void detach(ended);
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
      if (message.kind === "layout") setTabs(message.windows);
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
        setError(terminalErrorSummary(failure));
        setConnection("disconnected");
      }
    };

    // Keys: by name, through tmux's tables.
    const markTyped = () => {
      typed = true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const setting = live.current.appearance?.terminalMacOptionIsMeta ?? false;
      const meta = optionKeys.isMeta(setting, event);
      const key = tmuxKey(event, meta);
      if (key === undefined) return;
      event.preventDefault();
      markTyped();
      send({ kind: "keys", keys: [key] });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      optionKeys.isMeta(
        live.current.appearance?.terminalMacOptionIsMeta ?? false,
        event,
      );
    };
    const sendText = (text: string) => {
      if (text.length === 0) return;
      markTyped();
      send({ kind: "bytes", bytes: new TextEncoder().encode(text) });
    };
    // Text the keydown did not take: an IME's commit, a dead key's character.
    const onCompositionEnd = (event: CompositionEvent) => {
      sendText(event.data);
      input.value = "";
    };
    const onInput = (event: Event) => {
      const e = event as InputEvent;
      if (e.isComposing) return;
      sendText(input.value);
      input.value = "";
    };
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
      if (!hit.pane.active) send({ kind: "select-pane", pane: hit.pane.pane });
      if (hit.reports)
        send({
          kind: "bytes",
          pane: hit.pane.pane,
          bytes: sgrMouse(event.button, hit.x, hit.y, false),
        });
    };
    const onMouseUp = (event: MouseEvent) => {
      const hit = mouseFor(event);
      if (hit?.reports)
        send({
          kind: "bytes",
          pane: hit.pane.pane,
          bytes: sgrMouse(event.button, hit.x, hit.y, true),
        });
    };
    const onWheel = (event: WheelEvent) => {
      const hit = mouseFor(event);
      if (hit === undefined || !hit.reports) return;
      event.preventDefault();
      send({
        kind: "bytes",
        pane: hit.pane.pane,
        bytes: sgrMouse(event.deltaY < 0 ? 64 : 65, hit.x, hit.y, false),
      });
    };

    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("keyup", onKeyUp);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("input", onInput);
    input.addEventListener("paste", onPaste);
    host.addEventListener("paste", markTyped, true);
    grids.addEventListener("mousedown", onMouseDown);
    grids.addEventListener("mouseup", onMouseUp);
    grids.addEventListener("wheel", onWheel, { passive: false });
    const focusInput = () => input.focus();
    host.addEventListener("click", focusInput);

    const observer = new ResizeObserver(() => {
      if (live.current.hidden) return;
      const next = measure();
      if (next.cols === size.cols && next.rows === size.rows) return;
      size = next;
      send({ kind: "resize", cols: next.cols, rows: next.rows });
    });
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
      selectWindow(id) {
        send({ kind: "select-window", window: id });
        input.focus();
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
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      host.removeEventListener("click", focusInput);
      host.removeEventListener("paste", markTyped, true);
      if (receipt !== undefined) void detach(receipt);
      receipt = undefined;
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

  return (
    <div
      className="terminal-surface-shell control-terminal-shell"
      data-connection={connection}
      style={
        {
          ...terminalSurfaceStyle(palette, appearance?.terminalMargin),
          "--control-cursor": colors.cursor,
          ...(palette
            ? {
                "--terminal-foreground": palette.foreground,
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
      {tabs.length > 0 && (
        <nav className="control-windows" aria-label="tmux windows">
          {tabs.map((w) => (
            <button
              key={w.id}
              type="button"
              className="control-window"
              aria-current={w.active ? "true" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => controllerRef.current?.selectWindow(w.id)}
            >
              <span className="control-window-index">{w.index}</span>
              {w.name}
            </button>
          ))}
        </nav>
      )}
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
