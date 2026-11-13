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
 */

/** A window as laid out: its id (none: grid 1), and whether the page claims it. */
export interface ClaimBox {
  readonly win: number | undefined;
  readonly float: boolean;
  readonly bare?: boolean;
}

export class ClaimAsks {
  /** The seq each open float was asked about with, by window. */
  private readonly asked = new Map<number, number>();
  /** The highest seq the page has taken the placements of. */
  private settled = 0;

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
    for (const win of this.asked.keys())
      if (!open.has(win)) this.asked.delete(win);
    return { ask, waiting };
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
