/**
 * The pointer's moves, at most one a frame (`docs/neovim-editor.md`, "The
 * pointer"): a mouse reports many moves a frame (a gaming mouse 1000 a
 * second), and each one sent to Neovim or tmux is a redraw it makes and
 * sends back — over a slow link, a queue of stale ones the screen works
 * through after the hand has stopped. The first move of a frame goes at
 * once, so a drag answers in the frame it starts in; the rest of that frame
 * wait, and only the newest goes, the next frame. `flush` sends a waiting
 * one now (before the button's release, which must come after it).
 */
export class PerFrame<T> {
  private latest: { readonly value: T } | undefined;
  private scheduled = false;

  constructor(
    private readonly send: (value: T) => void,
    private readonly schedule: (fn: () => void) => void = (fn) => {
      requestAnimationFrame(fn);
    },
  ) {}

  push(value: T): void {
    if (this.scheduled) {
      this.latest = { value };
      return;
    }
    this.send(value);
    this.scheduled = true;
    this.schedule(() => {
      this.tick();
    });
  }

  /** Send the move waiting, if one is. */
  flush(): void {
    const latest = this.latest;
    this.latest = undefined;
    if (latest !== undefined) this.send(latest.value);
  }

  private tick(): void {
    const latest = this.latest;
    this.latest = undefined;
    if (latest === undefined) {
      this.scheduled = false;
      return;
    }
    this.send(latest.value);
    this.schedule(() => {
      this.tick();
    });
  }
}
