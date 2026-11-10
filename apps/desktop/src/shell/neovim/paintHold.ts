/**
 * A Neovim's paints held while its pane waits to move (`docs/pane-motion.md`,
 * "What moves together"): a resize asked for a held tmux layout is taken in
 * as Neovim flushes it, and drawn only when the page says, in the first
 * frame its pane has moved. Drawn at once, the new picture would show at
 * the old place, in the old layout, for a frame before the motion.
 */
export class PaintHold {
  private held: { readonly flushed: () => void } | undefined;
  private waiting: { force: boolean } | undefined;

  get holding(): boolean {
    return this.held !== undefined;
  }

  /** Hold paints from now; `flushed` hears each flush taken in. */
  hold(flushed: () => void): void {
    this.held = { flushed };
  }

  /** A flush was taken in: told, while held. */
  flushed(): void {
    this.held?.flushed();
  }

  /** A paint asked: whether it waits (held), and whether it was full. */
  defer(force: boolean): boolean {
    if (this.held === undefined) return false;
    this.waiting = { force: force || this.waiting?.force === true };
    return true;
  }

  /** Let go: the paint that waited, if one did. */
  release(): { readonly force: boolean } | undefined {
    if (this.held === undefined) return undefined;
    const waiting = this.waiting;
    this.held = undefined;
    this.waiting = undefined;
    return waiting;
  }
}
