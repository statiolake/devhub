/**
 * The Sidebar's tooltips — decided here, drawn somewhere else.
 *
 * # Why this page stopped drawing them
 *
 * They were sixteen `title` attributes first. A `title` is Chromium's own
 * tooltip widget: a native popup the page does not own, positioned by the
 * browser, and — this is the part that mattered — raised inside a
 * `WebContentsView`. Whether such a popup may paint outside the view's bounds
 * is not something this codebase gets to decide, and not something it can rely
 * on either: it is Chromium's, per platform, and it changes.
 *
 * So this file replaced them with a `<div>` in the Sidebar's own document,
 * which made the clipping decidable. And the answer was that it is clipped.
 * The row that most needs a tooltip is the glyph on a collapsed rail, and that
 * view is 44px wide with a title bar and 76px without — the first cut drew a
 * three-line description into it as a 42px-wide column 809px tall that ran off
 * the top of the view. The same failure `title` was replaced to avoid, drawn
 * by DevHub instead of by Chromium.
 *
 * `MIN_READABLE_WIDTH` was the answer to that: below a readable width, draw
 * nothing. It was honest, and it was the wrong shape — it accepted the
 * premise that the tooltip has to fit inside the column. The rail then had no
 * hover at all, and an expanded row's sentence wrapped into a narrow ribbon,
 * which are one complaint and not two.
 *
 * # What it is now
 *
 * A sender. The tooltip is a child of the *window* whose rectangle is its own
 * content (`main/shell/tooltipView.ts`), exactly as the notices are, so it may
 * run out over the editor and there is no width at which it stops being
 * readable. This page keeps the three things only it can know:
 *
 * - **When.** The pointer has to *rest* on a row (`HOVER_DELAY_MS`); a pointer
 *   crossing the column on its way somewhere else raises nothing. The keyboard
 *   has no such delay, because a row reached with the arrows was chosen rather
 *   than crossed.
 * - **One tooltip for the whole tree**, not one per row. Saying so here is
 *   what makes it true rather than hoping every row hides its own when another
 *   shows — and main cannot hold two either, so the rule is kept twice.
 * - **What it says.** The row's description (`rowDescription.ts`), which is
 *   also its accessible name: one composition, two readers, so they cannot
 *   drift. Drawn one line per line, because the description's newlines are the
 *   lines the expanded row would have drawn.
 *
 * # The anchor is in the window's coordinates
 *
 * Which is the one thing this component has to get right, and it is one
 * addition: the row's box, plus the rectangle main told this view it occupies
 * (`onSidebarArea`). Not `window.screenX`, which is the screen's and needs the
 * window's own origin taken back off; not `documentElement`'s box, which is
 * this view's and is stale for a while after main moves it. Where anything is,
 * is `main/shell/windowLayout.ts`, and a page that needs a number from it is
 * told the number.
 *
 * The anchor is clipped to the Sidebar's rectangle, because a row scrolled
 * half out of the column has half a row on screen and a tooltip pointing at
 * the invisible half points at nothing.
 *
 * Nothing here decides *where* the tooltip goes. `prefer` is a fact about the
 * row — a glyph has its sentence beside it, a line of text has it underneath —
 * and the owner turns that into a rectangle, flipping and clamping against a
 * window this page cannot see.
 */

import { useCallback, useEffect, useRef } from "react";
import { devhub } from "../../sidebar/client";
import type {
  SidebarAreaWire,
  TooltipLineWire,
  TooltipRequestWire,
} from "../../../ipc/contract";

/**
 * How long the pointer rests on a row before its tooltip is drawn.
 *
 * A pointer crossing the Sidebar on its way somewhere else passes over every
 * row it crosses, and a tooltip raised on entry for each of them is a flicker
 * of sentences nobody asked for. Resting on a row is the question; this is how
 * long resting takes. The keyboard has no such delay: a row reached with the
 * arrows was chosen, not crossed.
 */
const HOVER_DELAY_MS = 300;

/**
 * What this element has to say, as the lines a tooltip draws.
 *
 * Two attributes, because there are two kinds of thing with a tooltip in the
 * Sidebar and they are genuinely different. A control says one thing — *Create
 * agent*, *Retry close* — and carries it as `data-tooltip`, a plain string,
 * which is all such a thing has ever needed. A row is a list of facts about
 * something, composed by `rowDescription.ts`, and carries it as
 * `data-tooltip-lines`: the same list the row's accessible name is made of,
 * serialised onto the element that raises it.
 *
 * It is on the element rather than in a lookup because *which* element the
 * pointer came to rest on is the whole question, and the answer is found by
 * `closest()` on the DOM. A map from row id to lines would be the same facts
 * kept in a second place, keyed by something the pointer does not carry.
 *
 * Bad JSON draws nothing rather than throwing: this runs on every pointer move
 * over the column, and the one thing a tooltip must never do is take the
 * Sidebar down with it. It cannot be bad in practice — the only writer is
 * `JSON.stringify` three files away — which is exactly why an exception here
 * would be unactionable noise.
 */
function tooltipFor(
  element: HTMLElement,
): readonly TooltipLineWire[] | undefined {
  const rich = element.dataset["tooltipLines"];
  if (rich !== undefined && rich !== "") {
    const parsed: unknown = JSON.parse(rich);
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as TooltipLineWire[])
      : undefined;
  }
  const text = element.dataset["tooltip"];
  return text === undefined || text === "" ? undefined : [{ text }];
}

/**
 * Which side of the row its sentence goes on.
 *
 * A fact about the row rather than about the window: on a rail there is a
 * glyph and the words belong beside it, and in the expanded column there is a
 * line of text and they belong under it. Whether there is *room* on that side
 * is the owner's question — see `tooltipRect`.
 */
export type TooltipSide = TooltipRequestWire["prefer"];

export function RowTooltip({ prefer }: { readonly prefer: TooltipSide }) {
  /**
   * Where main has laid this view, which is the whole of what this page
   * knows about where it is. Undefined until the first push, and a tooltip
   * is simply not raised until then: a guessed origin would put the sentence
   * somewhere that is not beside the row, which is worse than a tooltip that
   * is a moment late.
   */
  const area = useRef<SidebarAreaWire | undefined>(undefined);
  useEffect(() => devhub().onSidebarArea((next) => (area.current = next)), []);

  // The side is read through a ref so that the effect below subscribes once:
  // collapsing the Sidebar changes `prefer` and must not tear down and
  // rebuild every pointer listener on the document.
  const side = useRef(prefer);
  side.current = prefer;

  const hide = useCallback(() => {
    devhub().hideTooltip();
  }, []);

  const show = useCallback((element: HTMLElement) => {
    const lines = tooltipFor(element);
    if (lines === undefined) return;
    const sidebar = area.current;
    if (!sidebar) return;
    const box = element.getBoundingClientRect();
    // This view's own pixels plus this view's origin in the window. The
    // row's box is relative to the view; main's rectangle says where the
    // view is; the sum is where the row is on the window.
    const x = sidebar.x + box.left;
    const y = sidebar.y + box.top;
    // Clipped to the column, because a row scrolled half out of it has
    // half a row on screen. `top` and `bottom` are clipped independently
    // so that a row leaving by either edge shrinks rather than moves.
    const top = Math.max(sidebar.y, Math.min(y, sidebar.y + sidebar.height));
    const bottom = Math.max(
      sidebar.y,
      Math.min(y + box.height, sidebar.y + sidebar.height),
    );
    if (bottom <= top) return;
    devhub().showTooltip({
      lines,
      anchor: {
        x,
        y: top,
        width: Math.min(box.width, sidebar.width),
        height: bottom - top,
      },
      prefer: side.current,
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
      const element = target.closest<HTMLElement>(
        "[data-tooltip], [data-tooltip-lines]",
      );
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
    // Pointer and keyboard alike: a row reached with the arrows has the
    // same question to answer as a row under the pointer.
    document.addEventListener("pointerover", pointerEnter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", keyboardEnter);
    document.addEventListener("focusout", leave);
    // Anything that can move the row out from under the tooltip takes it
    // down rather than leaving it pointing at nothing. It matters more now
    // than it did: the tooltip is a separate view and cannot be scrolled
    // or resized away by the document that raised it.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      cancelRest();
      // A tooltip outlives this component otherwise. It is drawn by
      // another view, so unmounting takes nothing off the screen —
      // which is the one new way this could leave a sentence standing
      // over the editor with nothing under it.
      hide();
      document.removeEventListener("pointerover", pointerEnter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", keyboardEnter);
      document.removeEventListener("focusout", leave);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, [hide, show]);

  // Nothing is drawn here. That is the point of the file.
  return null;
}
