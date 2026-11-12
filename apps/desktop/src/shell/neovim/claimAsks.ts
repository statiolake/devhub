/**
 * Floats not drawn until Lua has said whose they are. A framed view's
 * windows are claimed by the page (`claimFloats`): drawn bare, the page's
 * frame round them. But a plugin shows its windows before it makes them a
 * view, and may flush them first (a forced redraw), so the redraw that
 * shows a float can come before any word of its view. Drawn then, it
 * would wear the painter's frame for a while and the page's after: two
 * owners, one after the other.
 *
 * So a float the page has not drawn yet waits: the page asks Lua to settle
 * (`_settle`), which Neovim runs once it is done with the tick that showed
 * the float. Lua sends where everything is (the frames and the windows
 * they claim), then `settled` with the ask's seq, on the stream the
 * redraws come on. When the page has taken in the placements up to that
 * seq, the float is drawn: bare if it is claimed, framed by the painter if
 * not, each from its first frame.
 */

/** A float as laid out: its window, and whether the page claims it. */
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
   * The floats to ask about now (never asked: new since the last paint),
   * and whether a paint waits: an open float whose ask is not settled and
   * that no page claims yet (a claimed one's owner is known). The floats
   * gone are forgotten.
   */
  need(boxes: readonly ClaimBox[]): { ask: number[]; waiting: boolean } {
    const ask: number[] = [];
    const open = new Set<number>();
    let waiting = false;
    for (const box of boxes) {
      if (!box.float || box.win === undefined) continue;
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

  /** These floats were asked about with `seq`. */
  asking(wins: readonly number[], seq: number): void {
    for (const win of wins) this.asked.set(win, seq);
  }

  /** The placements up to `seq` are taken in. Whether a float waited on it. */
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
