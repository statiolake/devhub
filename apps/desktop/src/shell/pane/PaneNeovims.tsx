/**
 * The Neovims DevHub draws over this terminal's panes, drawn in this page.
 *
 * Main says which panes have one and which has the keys
 * (`PaneBridge.onTerminalNeovims`, `main/editor/terminalNeovims.ts`); this
 * mounts a `NeovimSurface` for each, in an element of its own that the
 * terminal surface places in its pane (`PaneNeovims`, read by
 * `ControlTerminalSurface` and `TerminalSurface`). The element is made
 * once per Neovim and never handed to React to place: the surface moves it
 * with its pane by transforms (docs/pane-motion.md), and it is never moved
 * from one parent to another, since a GUI window's iframe in it would load
 * again.
 *
 * # The keys
 *
 * One page holds the terminal and its Neovims, so which of them has the
 * page's focus is this page's to keep in line with main's word (`keys`):
 * the Neovim named, else the terminal. A press says where the person put
 * them (`reportNeovimPointer`), and is followed at once here. A keystroke
 * main took on its way in (`onTerminalNeovimKey`) is typed where it was
 * meant: a key that gives a Neovim the keys, or tmux's prefix typed in one.
 *
 * # Failure
 *
 * Each Neovim is under a boundary of its own: one that throws while
 * rendering shows its failure in its pane, with Retry, and the terminal
 * and the other Neovims go on. Its UI's own end is its surface's to show.
 */

import { Component, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  PaneBridge,
  TerminalNeovimKeyWire,
  TerminalNeovimWire,
  TerminalNeovimsWire,
} from "../../ipc/contract";
import type { AppAppearance } from "../../ipc/appShell";
import { NeovimSurface, type NeovimHandle } from "../neovim/NeovimApp";
import "../neovim/neovim.css";
import "../neovim/layers.css";
import "../neovim/framed.css";

/** One Neovim over one of the terminal's panes. */
export interface PaneNeovim {
  readonly key: string;
  /** Its tmux pane's number. */
  readonly pane: number;
  /** tmux shows its pane. */
  readonly shown: boolean;
  /** Polled: its pane's cells in the client's screen. */
  readonly cells: TerminalNeovimWire["cells"];
  /** What it is drawn in; the surface places it. */
  readonly element: HTMLDivElement;
  /** Its editor, once made. */
  readonly handle: NeovimHandle | undefined;
  /** The surface has put it on its pane at the pane's size. */
  readonly placed: boolean;
}

/** What the terminal surface lends the Neovims: its own keys. */
export interface PaneTerminalKeys {
  /** The terminal's input takes the page's focus. */
  focus(): void;
  /** A keystroke typed into the terminal (tmux's prefix, from a Neovim). */
  typeKey(key: TerminalNeovimKeyWire): void;
}

/** The attribute that marks a Neovim's element, for the surface's clicks. */
export const NEOVIM_PANE_ATTRIBUTE = "data-neovim-pane";

/** Whether an event's target is in one of the page's Neovims. */
export function inNeovim(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(`[${NEOVIM_PANE_ATTRIBUTE}]`) !== null
  );
}

interface Entry {
  key: string;
  pane: number;
  shown: boolean;
  cells: TerminalNeovimWire["cells"];
  readonly element: HTMLDivElement;
  handle: NeovimHandle | undefined;
  placed: boolean;
}

/**
 * The page's Neovims as the surfaces read them: plain state and a change
 * listener, so the surface can place them in its own frame, not React's.
 */
export class PaneNeovims {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private keysOf: string | undefined;
  private terminal: PaneTerminalKeys | undefined;

  /** Every Neovim, in main's order. */
  list(): readonly PaneNeovim[] {
    return [...this.entries.values()];
  }

  /** The Neovim on tmux pane `pane`, if there is one. */
  onPane(pane: number): PaneNeovim | undefined {
    for (const entry of this.entries.values())
      if (entry.pane === pane) return entry;
    return undefined;
  }

  /** The Neovim with the page's keys, by main's word (or the last press). */
  keys(): string | undefined {
    return this.keysOf;
  }

  /** Told when a Neovim comes, goes, moves panes, draws at a new size or ground. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The surface lending its keys, or taking them back (`undefined`). */
  lendTerminal(terminal: PaneTerminalKeys | undefined): void {
    this.terminal = terminal;
  }

  /** The surface put a Neovim on its pane at the pane's size. */
  setPlaced(key: string, placed: boolean): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.placed === placed) return;
    entry.placed = placed;
    this.changed();
  }

  /** Main's word: answers whether anything changed. */
  update(wire: TerminalNeovimsWire): void {
    const wanted = new Set(wire.overlays.map((o) => o.key));
    for (const [key, entry] of [...this.entries]) {
      if (wanted.has(key)) continue;
      this.entries.delete(key);
      entry.element.remove();
    }
    for (const overlay of wire.overlays) {
      let entry = this.entries.get(overlay.key);
      if (entry === undefined) {
        const element = document.createElement("div");
        element.className = "neovim-page pane-neovim";
        element.setAttribute(NEOVIM_PANE_ATTRIBUTE, overlay.key);
        entry = {
          key: overlay.key,
          pane: overlay.pane,
          shown: overlay.shown,
          cells: overlay.cells,
          element,
          handle: undefined,
          placed: false,
        };
        this.entries.set(overlay.key, entry);
      }
      entry.pane = overlay.pane;
      entry.shown = overlay.shown;
      entry.cells = overlay.cells;
    }
    this.setKeys(wire.keys);
    this.changed();
  }

  /** Whose the page's keys are now; the focus follows. */
  setKeys(keys: string | undefined): void {
    this.keysOf = keys;
    if (keys !== undefined) return;
    // The terminal's: out of a Neovim that has the focus.
    for (const entry of this.entries.values())
      if (entry.handle?.focused() === true) {
        this.terminal?.focus();
        return;
      }
  }

  /** Its editor made, or gone. */
  setHandle(key: string, handle: NeovimHandle | null): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.handle = handle ?? undefined;
    this.changed();
  }

  /** A keystroke main took for one of them, or for the terminal (`""`). */
  typeKey(key: TerminalNeovimKeyWire): void {
    if (key.to === "") {
      this.setKeys(undefined);
      this.terminal?.focus();
      this.terminal?.typeKey(key);
      return;
    }
    this.entries.get(key.to)?.handle?.typeKey(key);
  }

  changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The Neovims, rendered: each into its own element (`PaneNeovims`), under
 * a boundary of its own.
 */
export function PaneNeovimViews({
  terminalId,
  bridge,
  appearance,
  neovims,
}: {
  readonly terminalId: string;
  readonly bridge: PaneBridge;
  readonly appearance: AppAppearance | undefined;
  readonly neovims: PaneNeovims;
}) {
  const [, setTick] = useState(0);
  useEffect(
    () =>
      neovims.subscribe(() => {
        setTick((tick) => tick + 1);
      }),
    [neovims],
  );
  useEffect(
    () =>
      bridge.onTerminalNeovims(terminalId, (wire) => {
        neovims.update(wire);
      }),
    [bridge, neovims, terminalId],
  );
  useEffect(
    () =>
      bridge.onTerminalNeovimKey((key) => {
        neovims.typeKey(key);
      }),
    [bridge, neovims],
  );
  // A press says where the person put the keys: into a Neovim, or the
  // terminal beside it. Followed here at once, and told to main.
  useEffect(() => {
    const pressed = (event: PointerEvent) => {
      const target = event.target;
      const key =
        target instanceof Element
          ? (target
              .closest(`[${NEOVIM_PANE_ATTRIBUTE}]`)
              ?.getAttribute(NEOVIM_PANE_ATTRIBUTE) ?? null)
          : null;
      if (key === (neovims.keys() ?? null)) return;
      neovims.setKeys(key ?? undefined);
      neovims.changed();
      bridge.reportNeovimPointer(terminalId, key);
    };
    document.addEventListener("pointerdown", pressed, true);
    return () => {
      document.removeEventListener("pointerdown", pressed, true);
    };
  }, [bridge, neovims, terminalId]);
  const keys = neovims.keys();
  return (
    <>
      {neovims.list().map((entry) =>
        createPortal(
          <NeovimBoundary>
            <NeovimSurface
              workspaceId={entry.key}
              appearance={appearance}
              bridge={bridge}
              placed={entry.placed}
              keys={keys === entry.key && entry.shown}
              handle={(handle) => {
                neovims.setHandle(entry.key, handle);
              }}
              changed={() => {
                neovims.changed();
              }}
            />
          </NeovimBoundary>,
          entry.element,
          entry.key,
        ),
      )}
    </>
  );
}

/** One Neovim's failure, in its pane: the page and the others go on. */
class NeovimBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: string | undefined; readonly attempt: number }
> {
  override state = { failed: undefined as string | undefined, attempt: 0 };

  static getDerivedStateFromError(error: unknown) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    console.error("[devhub] a Neovim in this terminal failed", error);
  }

  override render(): ReactNode {
    if (this.state.failed === undefined) {
      return (
        <ChildAttempt key={this.state.attempt}>
          {this.props.children}
        </ChildAttempt>
      );
    }
    return (
      <div className="neovim-surface">
        <div className="nvim-status nvim-status-failed" role="alert">
          <p>DevHub could not draw this Neovim: {this.state.failed}</p>
          <button
            type="button"
            onClick={() => {
              this.setState((s) => ({
                failed: undefined,
                attempt: s.attempt + 1,
              }));
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}

/** Its children, made again for each attempt (the boundary's `key`). */
function ChildAttempt({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}
