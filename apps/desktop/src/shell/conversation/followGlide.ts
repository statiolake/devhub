/**
 * Following what arrived, shown as a glide rather than a jump.
 *
 * A following transcript is put at its end the moment an entry arrives
 * (`followScroll.ts`): the scroll position is the real one at once, so
 * whatever reads it — the person's next scroll, find, the "at the bottom"
 * answer — reads the layout as it is. What the person *sees* is FLIP
 * (docs/motion.md): the transcript is translated back down by exactly how
 * far the scroll moved, so in the first frame every line is where it was,
 * and is let go to where the layout put it. The entry that arrived comes up
 * from below the composer with everything above it, while it fades in on
 * its own (`conversation-rise-in`).
 *
 * The glide is a change of place, so it is the one DevHub's panes make
 * (`docs/pane-motion.md`): WinUI's point to point curve, 167 ms. It starts at
 * speed — the lines are already moving in the first frame, so the follow
 * reads as the content being pushed up by what arrived, not as a pause and
 * then a scroll — and settles hard, without overshoot, exactly on the
 * layout. It is shorter than the arrival's fade (`--motion-slow`, 240 ms), so
 * the new entry is in its place while it is still finishing appearing.
 *
 * Several arrivals in quick succession never jitter or warp: each one starts
 * its glide from where the transcript is *drawn* — what the running glide
 * still had it translated by, read off the computed transform, plus how far
 * this scroll moved — and every glide ends on `none`, the layout. Growth that
 * is not an arrival (an answer streaming in) is followed by the scroll alone,
 * as before: the running glide, if any, carries on to its end on top of it.
 *
 * The transform must not make the transcript scroll further: a translated
 * box counts towards its scroller's scrollable overflow, so the end would
 * move down by the glide's offset and following it would chase it. The
 * transcript is therefore wrapped in a box that clips its own block
 * overflow (`.conversation-follow`, `overflow-y: clip`): what the glide
 * moves past the end is under the composer, out of view, and out of the
 * scroll's reach.
 *
 * Under Reduce Motion nothing glides: the follow is the jump it always was.
 */

/** How long the glide takes: WinUI's point to point duration. */
export const FOLLOW_GLIDE_MS = 167;
/** WinUI's point to point curve (`paneMotion.ts`), as CSS. */
export const FOLLOW_GLIDE_EASING = "cubic-bezier(0.55, 0.55, 0, 1)";

/** Closer than this is no move: sub-pixel rounding. */
const STILL_PX = 0.5;

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** How far down `element`'s transform has it translated now, in px. */
export function translatedY(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (transform === "" || transform === "none") return 0;
  const flat = /^matrix\(([^)]*)\)$/.exec(transform);
  if (flat) return Number(flat[1]!.split(",")[5]) || 0;
  const deep = /^matrix3d\(([^)]*)\)$/.exec(transform);
  if (deep) return Number(deep[1]!.split(",")[13]) || 0;
  return 0;
}

export interface FollowGlide {
  /**
   * The scroller has just been moved `by` px down to follow what arrived:
   * draw the content where it was seen, and let it go to its place.
   */
  readonly follow: (by: number) => void;
  /** End any glide now, on the layout (the view jumped, or was set aside). */
  readonly finish: () => void;
}

/** A glide for `content`, the transcript inside its clipping box. */
export function followGlide(content: HTMLElement): FollowGlide {
  let running: Animation | undefined;
  const finish = () => {
    running?.finish();
    running = undefined;
  };
  const follow = (by: number) => {
    if (by <= STILL_PX) return;
    if (reducedMotion() || typeof content.animate !== "function") {
      finish();
      return;
    }
    // Where it is drawn now: the glide still running, plus the scroll.
    const from = (running ? translatedY(content) : 0) + by;
    running?.cancel();
    running = undefined;
    if (Math.abs(from) < STILL_PX) return;
    const glide = content.animate(
      [{ transform: `translateY(${String(from)}px)` }, { transform: "none" }],
      { duration: FOLLOW_GLIDE_MS, easing: FOLLOW_GLIDE_EASING },
    );
    running = glide;
    glide.onfinish = () => {
      if (running === glide) running = undefined;
    };
  };
  return { follow, finish };
}
