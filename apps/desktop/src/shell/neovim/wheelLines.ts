/**
 * A wheel's deltas as whole lines (`docs/motion.md`, "Scrolling"), for the
 * surfaces where a program scrolls by lines it is asked for: tmux (a
 * WheelUpPane per line, or a mouse report to a program that takes the
 * mouse) and Neovim's own wheel steps.
 *
 * The rule: **every tick is at least a line, and no pixel is lost.**
 *
 * - A wheel event that starts a movement — the first after a pause of
 *   `TICK_GAP_MS`, or the first the other way — is a tick: it moves at
 *   least one line however small its delta. A mouse's notch on a Mac is a
 *   few pixels (4 for a slow turn, more as it accelerates), a Linux one 120
 *   and a trackpad's first event of a swipe one or two: each is at least a
 *   line.
 * - Within a movement, pixels add up and every whole line is given as it
 *   is reached. The line a tick took ahead of its pixels is paid back by
 *   the pixels after it (`carry` goes negative), so a swipe moves by the
 *   lines its pixels make, not one more per event.
 * - What a tick carries over its last whole line stays for the next one
 *   the same way; a pause forgives only what is owed (the next tick is a
 *   line again), never what was moved.
 *
 * `deltaMode` 1 is lines and 2 pages (Firefox, some mice), counted in
 * the same pixels.
 */

/**
 * The longest pause inside one movement. A trackpad's events, momentum
 * included, come every frame (8–17 ms); a mouse wheel turned slowly sends
 * its notches 60 ms or more apart, each one a tick.
 */
export const TICK_GAP_MS = 50;

export class WheelLines {
  /** Pixels not given as lines yet (negative: a tick's line paid ahead). */
  private carry = 0;
  private dir = 0;
  private at = -Infinity;

  /**
   * The lines (down positive) a wheel event of `delta` moves, `line` pixels
   * a line (`page` lines a page).
   */
  lines(
    delta: number,
    deltaMode: number,
    line: number,
    page: number,
    now: number,
  ): number {
    if (delta === 0 || !(line > 0)) return 0;
    const px =
      deltaMode === 1
        ? delta * line
        : deltaMode === 2
          ? delta * page * line
          : delta;
    const dir = Math.sign(px);
    const tick = dir !== this.dir || now - this.at > TICK_GAP_MS;
    this.at = now;
    if (dir !== this.dir) this.carry = 0;
    else if (tick) this.carry = dir * Math.max(0, dir * this.carry);
    this.dir = dir;
    this.carry += px;
    let n = Math.trunc(this.carry / line);
    if (tick && n === 0) n = dir;
    this.carry -= n * line;
    return n;
  }

  /** Forget the movement (another pane, another window). */
  reset(): void {
    this.carry = 0;
    this.dir = 0;
    this.at = -Infinity;
  }
}
