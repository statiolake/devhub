/**
 * How big the Agent panes' text is, as one number the person can change.
 *
 * The size itself is a setting (`[appearance] terminal_font_size`), and
 * `settings.toml` is the person's own file: DevHub reads it and never writes
 * it. So the zoom is not a second way to spell that setting. It is an
 * **offset** in whole pixels from whatever the setting says, kept in DevHub's
 * own state file, and the size the terminals are actually drawn at is the sum:
 *
 *     effective = clamp(setting + offset)
 *
 * Two things fall out of that, and both are the reason it is an offset rather
 * than a size. Editing `terminal_font_size` moves the zoomed size with it,
 * because the person changed what "normal" means and not what "two steps up
 * from normal" means. And reset is `offset = 0` — there is nothing to remember
 * about where the base was, because the base was never copied anywhere.
 *
 * The bounds are the ones the setting already has. A terminal font size is
 * between 9 and 24 everywhere in DevHub — `model/config.ts` refuses a
 * `settings.toml` outside it and `model/wire.ts` refuses a projection outside
 * it — and a zoom that could leave that range would be a second opinion about
 * what sizes exist, reaching the pages as a projection the wire has to refuse.
 * One range, stated here, read by all three.
 *
 * The offset has a bound of its own, and it is not a second rule: it is the
 * widest the two ends of that one range are apart. An offset further out than
 * that cannot describe any size, so it is not a zoom at all.
 */

/** The smallest the Agent panes' text may be drawn. */
export const MIN_TERMINAL_FONT_SIZE = 9;
/** The largest. */
export const MAX_TERMINAL_FONT_SIZE = 24;
/** The furthest an offset can be from the base and still name a size. */
export const MAX_TERMINAL_ZOOM_OFFSET =
  MAX_TERMINAL_FONT_SIZE - MIN_TERMINAL_FONT_SIZE;

/**
 * What the person asked for.
 *
 * `reset` is not "zoom to the base size" — it is "forget the zoom", which is
 * the same thing said in the one place the base is not needed to say it.
 */
export type TerminalZoomDirection = "in" | "out" | "reset";

/** Whether a number is an offset at all: whole, finite, and in range. */
export function isTerminalZoomOffset(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= MAX_TERMINAL_ZOOM_OFFSET;
}

/**
 * The size the panes are drawn at, for a base and an offset.
 *
 * Clamped rather than refused: the base comes from a file the person edits and
 * the offset from a gesture they made against a different base, so a sum
 * outside the range is an ordinary state of affairs and not a mistake anybody
 * made. What it must never be is a size nothing can draw.
 */
export function zoomedTerminalFontSize(base: number, offset: number): number {
  return clampFontSize(Math.round(base) + offset);
}

function clampFontSize(size: number): number {
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, size),
  );
}

/**
 * The offset one step from here, in whole pixels.
 *
 * Worked out from the *size* rather than from the offset, so that a zoom that
 * has run into an end of the range comes straight back on the first step in
 * the other direction. Stepping the offset instead would let it wander out
 * past the end — press zoom-in ten times at the ceiling and the first ten
 * zoom-outs would do nothing, which reads as a broken key.
 */
export function nextTerminalZoomOffset(
  base: number,
  offset: number,
  direction: TerminalZoomDirection,
): number {
  if (direction === "reset") return 0;
  const step = direction === "in" ? 1 : -1;
  const from = zoomedTerminalFontSize(base, offset);
  return clampFontSize(from + step) - Math.round(base);
}
