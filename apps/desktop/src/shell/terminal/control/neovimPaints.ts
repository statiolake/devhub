/**
 * The Neovims a committed tmux layout resized whose new picture is not
 * drawn yet (`docs/pane-motion.md`, "What moves together"). A motion's
 * first frame draws every pane at its old place, so they keep their old
 * picture, at their old size, through it; they are placed at their new
 * size and draw the new picture in the first frame that has moved. With
 * no motion, they draw it in the frame that places the layout.
 */
export interface ResumablePaint {
  /** Draw what came while held, now (`NeovimHandle.resumePaint`). */
  resumePaint(): void;
}

export class UnpaintedNeovims<H extends ResumablePaint = ResumablePaint> {
  private readonly held = new Map<string, H>();

  get size(): number {
    return this.held.size;
  }

  /** A Neovim asked for a held layout's size. */
  add(key: string, handle: H): void {
    this.held.set(key, handle);
  }

  /** Still showing its old picture, at its old size. */
  has(key: string): boolean {
    return this.held.has(key);
  }

  /**
   * A frame that draws a committed layout: when no motion starts in it,
   * they are placed and draw at once. Whether they were.
   */
  painted(motionStarts: boolean, place: () => void): boolean {
    if (motionStarts || this.held.size === 0) return false;
    this.resume(place);
    return true;
  }

  /** A frame of a running motion: the first one has moved. */
  ticked(place: () => void): void {
    if (this.held.size > 0) this.resume(place);
  }

  /**
   * Placed (at their new sizes, so what is laid out from their size is
   * laid out at it) and then drawn. `place` undefined: drawn where they
   * are, the page going away.
   */
  resume(place?: () => void): void {
    const held = [...this.held.values()];
    this.held.clear();
    place?.();
    for (const handle of held) handle.resumePaint();
  }
}
