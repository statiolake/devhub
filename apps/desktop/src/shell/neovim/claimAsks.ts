/**
 * Windows not drawn until Lua has said whose they are. A framed view's
 * windows are claimed by the page (`claimFloats`): drawn bare, the page's
 * frame round them; a view's window is covered by the view (`gui.view`:
 * native rows over its cells). But a plugin shows its windows before it
 * makes them a view, and may flush them first (a forced redraw), so the
 * redraw that shows a window can come before any word of its view. Drawn
 * then, a float would wear the painter's frame for a while and the page's
 * after, and a split would show the plugin's own text in cells, then the
 * view's rows over it: two owners, one after the other.
 *
 * So a window the page has not drawn yet waits — a float or a split alike:
 * the page asks Lua to settle (`_settle`), which Neovim runs once it is
 * done with the tick that showed the window. Lua sends where everything is
 * (the views, the frames and the windows they claim), then `settled` with
 * the ask's seq, on the stream the redraws come on. When the page has
 * taken in the placements up to that seq, the window is drawn: covered by
 * its view, bare in its frame, or as Neovim drew it, each from its first
 * frame.
 *
 * A frame whose windows change — one of them closes or moves, as a
 * picker's preview does when it is toggled — is asked about again the same
 * way: the plugin lays the frame out anew in a tick of its own (snacks-ui
 * from a scheduled WinResized), after Neovim has flushed the windows, so
 * drawn at once the frame showed the preview's column empty for a frame.
 * Its windows wait for Lua to settle, and the new frame and its windows
 * are drawn together.
 */

/** A window as laid out: its id (none: grid 1), and whether the page claims it. */
export interface ClaimBox {
  readonly win: number | undefined;
  readonly float: boolean;
  readonly bare?: boolean;
  /** The window of the float a page's frame is round, for a framed view's windows. */
  readonly framedBy?: number;
  readonly row?: number;
  readonly col?: number;
  readonly width?: number;
  readonly height?: number;
}

export class ClaimAsks {
  /** The seq each open float was asked about with, by window. */
  private readonly asked = new Map<number, number>();
  /** The highest seq the page has taken the placements of. */
  private settled = 0;
  /** Each frame's windows and where they were, as last seen. */
  private readonly frames = new Map<number, string>();
  /** Claimed windows asked about again because their frame changed: they wait too. */
  private readonly again = new Set<number>();

  /**
   * The windows to ask about now (never asked: new since the last paint),
   * and whether a paint waits: an open window whose ask is not settled and
   * that no page claims yet (a claimed one's owner is known). The windows
   * gone are forgotten.
   */
  need(boxes: readonly ClaimBox[]): { ask: number[]; waiting: boolean } {
    const ask: number[] = [];
    const open = new Set<number>();
    let waiting = false;
    for (const box of boxes) {
      if (box.win === undefined) continue;
      open.add(box.win);
      const seq = this.asked.get(box.win);
      if (seq === undefined) {
        ask.push(box.win);
        if (box.bare !== true) waiting = true;
      } else if (seq > this.settled && box.bare !== true) {
        waiting = true;
      }
    }
    // A frame whose windows changed: its windows still open, asked again.
    const frames = new Map<number, ClaimBox[]>();
    for (const box of boxes) {
      if (box.win === undefined || box.framedBy === undefined) continue;
      frames.set(box.framedBy, [...(frames.get(box.framedBy) ?? []), box]);
    }
    for (const [frame, members] of frames) {
      const key = members
        .map(
          (b) =>
            `${String(b.win)}@${String(b.row)},${String(b.col)},${String(b.width)}x${String(b.height)}`,
        )
        .sort()
        .join(" ");
      const before = this.frames.get(frame);
      this.frames.set(frame, key);
      if (before === undefined || before === key) continue;
      for (const box of members) {
        const win = box.win as number;
        if (!ask.includes(win)) ask.push(win);
        this.again.add(win);
        waiting = true;
      }
    }
    for (const frame of [...this.frames.keys()])
      if (!frames.has(frame)) this.frames.delete(frame);
    for (const win of this.again) {
      const seq = this.asked.get(win);
      if (!open.has(win)) this.again.delete(win);
      else if (seq !== undefined && seq > this.settled) waiting = true;
    }
    for (const win of this.asked.keys())
      if (!open.has(win)) this.asked.delete(win);
    return { ask, waiting };
  }

  /**
   * Whether an ask is out — a window not drawn yet, or a framed view whose
   * windows changed: the page holds what Lua places meanwhile, so its
   * frames and the windows they claim land in one frame when Lua has
   * settled (a picker's preview toggled: the list's new width and the
   * preview's window together).
   */
  regathering(): boolean {
    for (const seq of this.asked.values()) if (seq > this.settled) return true;
    for (const win of this.again) if (!this.asked.has(win)) return true;
    return false;
  }

  /** These windows were asked about with `seq`. */
  asking(wins: readonly number[], seq: number): void {
    for (const win of wins) this.asked.set(win, seq);
  }

  /** The placements up to `seq` are taken in. Whether a window waited on it. */
  settle(seq: number): boolean {
    if (seq <= this.settled) return false;
    const before = this.settled;
    this.settled = seq;
    for (const win of [...this.again])
      if ((this.asked.get(win) ?? 0) <= seq) this.again.delete(win);
    return [...this.asked.values()].some((s) => s > before && s <= seq);
  }
}

let lastSeq = 0;

/**
 * A seq for an ask: increasing across every editor of the page, so a
 * `settled` answered to one editor never settles another's asks.
 */
export function nextSettleSeq(): number {
  lastSeq += 1;
  return lastSeq;
}
