/**
 * The `title` and `footer` of floats whose border holds text, asked of
 * Neovim (`nvim_win_get_config`): what lets that text be drawn as a label
 * on the float's one line (`frame.ts`). Until they are known such a border
 * is drawn cell for cell, a frame of another shape. So a float that opens
 * with one is not drawn until its first answer has come: the frame drawn
 * first is its final one, and the panel it belongs to opens whole. After
 * that, a change of its border text is asked again and drawn as it comes,
 * so a float never waits on itself twice.
 */

/** A float as laid out: its window and whether its border needs labels. */
export interface LabelBox {
  readonly grid: number;
  readonly win: number | undefined;
  readonly float: boolean;
  readonly lined?: boolean;
  readonly wantsLabels?: boolean;
}

export class LabelAsks {
  /** The border text each float's labels were last asked for, by window. */
  private readonly asked = new Map<number, string>();
  /** The floats that have had an answer, by window. */
  private readonly answered = new Set<number>();

  /**
   * The floats to ask about now (`textOf`: their border's text), and
   * whether a paint waits: a float that needs labels has never had them
   * answered. The floats gone are forgotten.
   */
  need(
    boxes: readonly LabelBox[],
    textOf: (box: LabelBox) => string | undefined,
  ): { ask: { win: number; text: string }[]; waiting: boolean } {
    const ask: { win: number; text: string }[] = [];
    let waiting = false;
    const open = new Set<number>();
    for (const box of boxes) {
      if (!box.float || box.win === undefined || box.lined !== true) continue;
      open.add(box.win);
      if (box.wantsLabels !== true) continue;
      const text = textOf(box);
      if (text === undefined) continue;
      if (this.asked.get(box.win) !== text) {
        this.asked.set(box.win, text);
        ask.push({ win: box.win, text });
      }
      if (!this.answered.has(box.win)) waiting = true;
    }
    for (const win of this.asked.keys()) {
      if (open.has(win)) continue;
      this.asked.delete(win);
      this.answered.delete(win);
    }
    return { ask, waiting };
  }

  /** Neovim answered for this float (or could not: drawn cell for cell). */
  answer(win: number): void {
    if (this.asked.has(win)) this.answered.add(win);
  }
}
