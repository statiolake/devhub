/**
 * The Neovims DevHub draws over this terminal's panes, drawn in this page.
 *
 * Main says which panes have one and which has the keys
 * (`PaneBridge.onTerminalNeovims`, `main/editor/terminalNeovims.ts`); this
 * mounts a `NeovimSurface` for each, in an element of its own that the
 * terminal surface places in its pane (`PaneNeovims`, read by
 * `ControlTerminalSurface`). The element is made
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
 * tmux's prefix is never dropped. Main has kept it from the Neovim already,
 * so the page that cannot type it into its terminal surface — none has lent
 * its keys yet (the first keys after a restart, a pane switch, a Neovim
 * attaching again), or the one there is not attached — holds it, and the
 * key after it, which would otherwise be the Neovim's, for at most
 * `PREFIX_WAIT_MS`. A surface lending its keys in that time is typed them;
 * otherwise they are main's to send to tmux through DevHub's control client
 * (`untyped`, `TerminalNeovims.untyped`), which says so if it cannot.
 *
 * # A Neovim whose pane closes
 *
 * Main says a Neovim is gone once its pane has gone (or its UI ended),
 * which can be while the pane's close is still moving, or just before tmux's
 * word of the close is drawn. A surface that moves panes keeps it as its
 * pane's last picture until then (`keepGone`): it stays mounted and drawn,
 * takes no keys, and is let go when the surface no longer keeps it
 * (`release`), as a gone tty pane's last picture is (docs/pane-motion.md,
 * "Close").
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
  TerminalNeovimsWire,
} from "../../ipc/contract";
import type { AppAppearance } from "../../ipc/appShell";
import { NeovimSurface, type NeovimHandle } from "../neovim/NeovimApp";
import { tmuxKey } from "../terminal/control/controlKeys";
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
  /** What it is drawn in; the surface places it. */
  readonly element: HTMLDivElement;
  /** Its editor, once made. */
  readonly handle: NeovimHandle | undefined;
  /** The surface has put it on its pane at the pane's size. */
  readonly placed: boolean;
  /**
   * When main said it was gone (`performance.now()`), if it did: kept as
   * its pane's last picture while its surface keeps it (`keepGone`).
   */
  readonly goneAt: number | undefined;
}

/** What the terminal surface lends the Neovims: its own keys. */
export interface PaneTerminalKeys {
  /** The terminal's input takes the page's focus. */
  focus(): void;
  /**
   * A keystroke typed into the terminal (tmux's prefix, from a Neovim):
   * `false` when the surface cannot send it (not attached, nor attaching).
   */
  typeKey(key: TerminalNeovimKeyWire): boolean;
}

/**
 * How long tmux's prefix, handed to a page whose terminal surface cannot
 * type it, waits for one that can before it goes to tmux another way.
 */
export const PREFIX_WAIT_MS = 300;

export interface PaneNeovimsOptions {
  /**
   * Keys handed to the terminal that its surface could not type, as tmux
   * names them: main sends them through DevHub's control client.
   */
  readonly untyped?: (keys: readonly string[]) => void;
  readonly waitMs?: number;
  /** Where the key after the prefix is caught (the page's window). */
  readonly keys?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

/** tmux's prefix, handed to the terminal before its surface could type it. */
interface Waiting {
  /** The keys not typed yet: the prefix, and the key after it once caught. */
  strokes: TerminalNeovimKeyWire[];
  /** The key after the prefix came: the binding's keys are all here. */
  complete: boolean;
  /** Gone to main already (no surface came): the key after it goes so too. */
  diverted: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Keys that are only modifiers: no key of tmux's by themselves. */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "Fn",
]);

/** A handed keystroke as tmux names it (`C-q`, `z`), for main to send. */
export function strokeName(stroke: TerminalNeovimKeyWire): string | undefined {
  return tmuxKey(
    {
      key: stroke.key,
      code: stroke.code,
      ctrlKey: stroke.control,
      altKey: stroke.alt,
      shiftKey: stroke.shift,
      metaKey: stroke.meta,
    },
    stroke.alt,
  );
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
  readonly element: HTMLDivElement;
  handle: NeovimHandle | undefined;
  placed: boolean;
  goneAt: number | undefined;
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
  private keeper: ((entry: PaneNeovim) => boolean) | undefined;
  private waiting: Waiting | undefined;

  constructor(private readonly options: PaneNeovimsOptions = {}) {}

  /** Every Neovim, in main's order. */
  list(): readonly PaneNeovim[] {
    return [...this.entries.values()];
  }

  /** The Neovim on tmux pane `pane`, if there is one (not a gone one). */
  onPane(pane: number): PaneNeovim | undefined {
    for (const entry of this.entries.values())
      if (entry.pane === pane && entry.goneAt === undefined) return entry;
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
    const waiting = this.waiting;
    if (terminal === undefined || waiting === undefined || waiting.diverted)
      return;
    // The prefix waited for this surface: typed now, with what came after.
    clearTimeout(waiting.timer);
    terminal.focus();
    while (waiting.strokes.length > 0) {
      const stroke = waiting.strokes[0];
      if (stroke === undefined || !terminal.typeKey(stroke)) {
        this.divert();
        return;
      }
      waiting.strokes.shift();
    }
    this.endWaiting();
  }

  /**
   * The surface that moves its panes says which gone Neovims it keeps as
   * their panes' last pictures (`undefined`: none, each goes at once).
   */
  keepGone(keeper: ((entry: PaneNeovim) => boolean) | undefined): void {
    this.keeper = keeper;
    this.release();
  }

  /** The gone Neovims the surface no longer keeps, let go of. */
  release(): void {
    let dropped = false;
    for (const [key, entry] of [...this.entries]) {
      if (entry.goneAt === undefined || this.keeper?.(entry) === true) continue;
      this.entries.delete(key);
      entry.element.remove();
      dropped = true;
    }
    if (dropped) this.changed();
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
    const now = performance.now();
    for (const [key, entry] of [...this.entries]) {
      if (wanted.has(key)) continue;
      entry.goneAt ??= now;
      if (this.keeper?.(entry) === true) continue;
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
          element,
          handle: undefined,
          placed: false,
          goneAt: undefined,
        };
        this.entries.set(overlay.key, entry);
      }
      entry.goneAt = undefined;
      entry.pane = overlay.pane;
      entry.shown = overlay.shown;
    }
    this.setKeys(wire.keys);
    this.changed();
  }

  /** Whose the page's keys are now; the focus follows. */
  setKeys(keys: string | undefined): void {
    this.keysOf = keys;
    if (keys !== undefined) {
      // Main gave the keys back (the prefix's binding ran, or it could not
      // be sent): a prefix still waiting goes now, and nothing more is held.
      if (this.waiting !== undefined) {
        if (!this.waiting.diverted) this.divert();
        this.endWaiting();
      }
      return;
    }
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
      const waiting = this.waiting;
      if (waiting !== undefined) {
        // The prefix again, before the first was typed: after it, in order.
        waiting.complete = false;
        if (waiting.diverted) this.send([key]);
        else waiting.strokes.push(key);
        return;
      }
      const terminal = this.terminal;
      terminal?.focus();
      if (terminal?.typeKey(key) === true) return;
      this.wait(key, terminal !== undefined);
      return;
    }
    this.entries.get(key.to)?.handle?.typeKey(key);
  }

  /**
   * tmux's prefix the surface could not type: held, with the key after it
   * (caught before the Neovim, which still has the page's focus, reads it),
   * until a surface lends its keys or `waitMs` is over. A surface that is
   * there and not attached is not waited for.
   */
  private wait(key: TerminalNeovimKeyWire, now: boolean): void {
    const waiting: Waiting = {
      strokes: [key],
      complete: false,
      diverted: false,
      timer: undefined,
    };
    this.waiting = waiting;
    this.keyTarget()?.addEventListener("keydown", this.caught, true);
    if (now) {
      this.divert();
      return;
    }
    waiting.timer = setTimeout(() => {
      if (this.waiting === waiting) this.divert();
    }, this.options.waitMs ?? PREFIX_WAIT_MS);
  }

  /** The key after a waiting prefix, kept from whatever has the focus. */
  private readonly caught = (event: Event) => {
    const waiting = this.waiting;
    if (waiting === undefined || !(event instanceof KeyboardEvent)) return;
    if (MODIFIER_KEYS.has(event.key) || event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const stroke: TerminalNeovimKeyWire = {
      to: "",
      key: event.key,
      code: event.code,
      control: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
      leftOption: false,
    };
    waiting.complete = true;
    // What comes after it is the Neovim's again, or the surface's.
    this.keyTarget()?.removeEventListener("keydown", this.caught, true);
    if (!waiting.diverted) {
      waiting.strokes.push(stroke);
      return;
    }
    const terminal = this.terminal;
    if (terminal?.typeKey(stroke) !== true) this.send([stroke]);
    this.endWaiting();
  };

  /** No surface typed them: main's, to send through the control client. */
  private divert(): void {
    const waiting = this.waiting;
    if (waiting === undefined) return;
    clearTimeout(waiting.timer);
    waiting.timer = undefined;
    waiting.diverted = true;
    const strokes = waiting.strokes;
    waiting.strokes = [];
    this.send(strokes);
    if (waiting.complete) this.endWaiting();
  }

  private send(strokes: readonly TerminalNeovimKeyWire[]): void {
    const keys = strokes.flatMap((stroke) => {
      const name = strokeName(stroke);
      return name === undefined ? [] : [name];
    });
    if (keys.length === 0) return;
    const untyped = this.options.untyped;
    if (untyped === undefined) {
      console.warn(
        `[devhub] tmux's prefix (${keys.join(" ")}) from a Neovim was lost: this terminal's surface could not type it, and nothing else could`,
      );
      return;
    }
    console.warn(
      `[devhub] this terminal's surface could not type tmux's prefix (${keys.join(" ")}): sent through DevHub's tmux client instead`,
    );
    untyped(keys);
  }

  private endWaiting(): void {
    const waiting = this.waiting;
    if (waiting === undefined) return;
    clearTimeout(waiting.timer);
    this.waiting = undefined;
    this.keyTarget()?.removeEventListener("keydown", this.caught, true);
  }

  private keyTarget():
    | Pick<EventTarget, "addEventListener" | "removeEventListener">
    | undefined {
    return (
      this.options.keys ?? (typeof window === "undefined" ? undefined : window)
    );
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
              keys={
                keys === entry.key && entry.shown && entry.goneAt === undefined
              }
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
