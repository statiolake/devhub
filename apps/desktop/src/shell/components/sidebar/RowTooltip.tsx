/**
 * The Sidebar's tooltips, drawn by the Sidebar.
 *
 * # Why not `title=`
 *
 * They were sixteen `title` attributes, and a `title` is Chromium's own
 * tooltip widget: a native popup the page does not own, positioned by the
 * browser, and — this is the part that matters — raised inside a
 * `WebContentsView`. Whether such a popup may paint outside the view's bounds
 * is not something this codebase gets to decide, and it is not something it
 * can rely on either: it is Chromium's, per platform, and it changes.
 *
 * That is a bad thing to depend on, because the row that most needs a tooltip
 * is the one on a collapsed rail — where the words are gone, the glyph is all
 * there is, and the tooltip is wider than the column it is raised in. A
 * tooltip the view clips is worse than no tooltip: it appears, it is
 * unreadable, and nothing on screen says why.
 *
 * So it is decided by construction instead. This is a DOM element in the
 * Sidebar's own document, positioned by the Sidebar against the Sidebar's own
 * box, and there is no arrangement in which it can be clipped by something it
 * does not know about. What it cannot do is leave the view — see below.
 *
 * # What it is
 *
 * One tooltip for the whole tree, not one per row: only one can be up, and
 * saying so here is what makes that true rather than hoping every row hides
 * its own when another shows. Anything with `data-tooltip` gets one, from the
 * pointer and from the keyboard alike, because a row reached with the arrows
 * has exactly the same question to answer as a row under the pointer.
 *
 * The text is the row's description (`rowDescription.ts`), which is also its
 * accessible name — one composition, two readers, so they cannot drift. It is
 * drawn one line per line: `pre-line`, because the description's newlines are
 * the lines the expanded row would have drawn.
 *
 * # Where it goes, and where it does not
 *
 * Beside the row, and inside this view. It flips upward when the row is near
 * the bottom, so the last row's tooltip is as readable as the first's, and it
 * is clamped to the view's box in both directions, because the box is the
 * whole of what this page has.
 *
 * **It is as wide as this view and no wider — so on a rail there is none.**
 * That is not a preference; it is what the rail measures. With
 * `title_bar = hidden` the collapsed Sidebar's view is the traffic lights'
 * span, 76px, and the first cut of this file drew a three-line description
 * into it as a 42px-wide column 809px tall that ran off the top of the view.
 * Clipped by the view, which is the exact failure `title` was replaced to
 * avoid — the same failure, drawn by DevHub instead of by Chromium.
 *
 * So the rule is the one the replacement was made under: a tooltip that does
 * not fit is worse than no tooltip, and `MIN_READABLE_WIDTH` is where this
 * page stops drawing one. The rail keeps what it always had — the row's
 * accessible name, which is this same sentence, and the glyph.
 *
 * Giving the rail a tooltip means giving it something that is not this view:
 * a child of the *window* whose rectangle is its own content, the way the
 * `toasts` view already is (`main/shell/toastsView.ts`). Widening the
 * Sidebar's view instead does not work — the Sidebar is deliberately the one
 * child nothing is ever drawn over, and that is only true because its
 * rectangle never overlaps anything.
 *
 * `pointer-events: none`, always: a tooltip is something to read, never
 * something to hit, and one that took a click would take it from the row that
 * raised it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Where the tooltip is, in this view's own pixels. */
interface Placement {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly maxWidth: number;
  /** Anchored by its bottom edge, because the row is near the view's. */
  readonly flipped: boolean;
}

/** How far from the anchor the tooltip sits, and from the view's edges. */
const GAP = 6;
const MARGIN = 4;

/**
 * Narrower than this and no tooltip is drawn at all.
 *
 * A row description is a sentence, and a sentence in a 42px column is not
 * something anybody reads — it is a tall thin ribbon that runs off the top of
 * the view. Measured: the rail is 76px with `title_bar = hidden` and 44px
 * with a bar. This is the width at which the first line of the shortest
 * description still fits on one line.
 */
const MIN_READABLE_WIDTH = 160;

/**
 * How long the pointer rests on a row before its tooltip is drawn.
 *
 * A pointer crossing the Sidebar on its way somewhere else passes over every
 * row it crosses, and a tooltip raised on entry for each of them is a
 * flicker of sentences nobody asked for. Resting on a row is the question;
 * this is how long resting takes. The keyboard has no such delay: a row
 * reached with the arrows was chosen, not crossed.
 */
const HOVER_DELAY_MS = 300;

export function RowTooltip() {
  const [placement, setPlacement] = useState<Placement | undefined>(undefined);
  const hide = useCallback(() => {
    setPlacement(undefined);
  }, []);

  const show = useCallback((element: HTMLElement) => {
    const text = element.dataset["tooltip"];
    if (text === undefined || text === "") return;
    const box = element.getBoundingClientRect();
    // The view's own box, which is the whole of what this page has to place
    // anything in. `documentElement` and not `window.innerWidth`: the same
    // number, and this one says where it came from.
    const view = document.documentElement.getBoundingClientRect();
    // A rail has no room for a sentence. See `MIN_READABLE_WIDTH`.
    if (view.width < MIN_READABLE_WIDTH) return;
    const left = Math.min(
      Math.max(MARGIN, box.left),
      Math.max(MARGIN, view.width - MARGIN),
    );
    const below = box.bottom + GAP;
    // Flipped when there is more room above than below. The row's own height
    // is the unit: a tooltip that would start below the halfway line has more
    // room the other way, whatever it turns out to be tall.
    const flipped = below > view.height / 2;
    setPlacement({
      text,
      left,
      top: flipped ? view.height - box.top + GAP : below,
      maxWidth: Math.max(0, view.width - left - MARGIN),
      flipped,
    });
  }, []);

  const anchor = useRef<HTMLElement | null>(null);
  const resting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const cancelRest = () => {
      if (resting.current === undefined) return;
      clearTimeout(resting.current);
      resting.current = undefined;
    };
    const anchorFor = (event: Event): HTMLElement | undefined => {
      const target = event.target;
      if (!(target instanceof Element)) return undefined;
      const element = target.closest<HTMLElement>("[data-tooltip]");
      if (!element || element === anchor.current) return undefined;
      return element;
    };
    // The pointer has to rest on a row first. See `HOVER_DELAY_MS`.
    const pointerEnter = (event: Event) => {
      const element = anchorFor(event);
      if (!element) return;
      cancelRest();
      anchor.current = element;
      resting.current = setTimeout(() => {
        resting.current = undefined;
        if (anchor.current === element) show(element);
      }, HOVER_DELAY_MS);
    };
    // The keyboard chose the row; it is drawn at once.
    const keyboardEnter = (event: Event) => {
      const element = anchorFor(event);
      if (!element) return;
      cancelRest();
      anchor.current = element;
      show(element);
    };
    const leave = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!anchor.current || !anchor.current.contains(target)) return;
      cancelRest();
      anchor.current = null;
      hide();
    };
    // Pointer and keyboard alike: a row reached with the arrows has the same
    // question to answer as a row under the pointer, and on a rail it is the
    // only way to ask it.
    document.addEventListener("pointerover", pointerEnter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", keyboardEnter);
    document.addEventListener("focusout", leave);
    // Anything that can move the row out from under the tooltip takes it
    // down rather than leaving it pointing at nothing.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      cancelRest();
      document.removeEventListener("pointerover", pointerEnter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", keyboardEnter);
      document.removeEventListener("focusout", leave);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, [hide, show]);

  if (!placement) return null;
  return (
    <div
      className="row-tooltip"
      // Not `role="tooltip"`, and hidden from the accessibility tree
      // outright: the row's own accessible name *is* this sentence
      // (`rowDescription.ts` composes both), so a reader announced it as the
      // row was reached. Exposing it again would read the row twice, once as
      // itself and once as its own tooltip.
      aria-hidden="true"
      style={{
        left: `${String(placement.left)}px`,
        [placement.flipped ? "bottom" : "top"]: `${String(placement.top)}px`,
        maxWidth: `${String(placement.maxWidth)}px`,
      }}
    >
      {placement.text}
    </div>
  );
}
