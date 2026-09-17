/**
 * The page a tooltip is drawn on.
 *
 * Its own view, its own entry, its own root handler, and less in it than any
 * other page DevHub has: one box with a list of facts in it. No model, no
 * snapshot, no appearance, no notices.
 *
 * # Why this is a page at all
 *
 * Because the Sidebar could not draw it. A tooltip drawn inside the Sidebar's
 * `WebContentsView` is clipped by that view, and the row that most needs one
 * is the glyph on a collapsed rail — where the view is 44px wide with a title
 * bar and 76px without. `RowTooltip.tsx` measured that and refused to draw
 * anything at all below a readable width, which was the honest answer to the
 * wrong question: the fix is not a narrower sentence, it is a box that is not
 * inside the column. This view is a child of the *window*, so the sentence
 * runs out over the editor the way a tooltip is supposed to.
 *
 * That is the same move the notices made, for the same reason, and it keeps
 * the same bargain: **this view is exactly as big as what it draws.** A
 * `WebContentsView` is a native view whose hit testing is by rectangle — every
 * click inside its bounds is its own whether or not anything is painted there,
 * and Electron 42 gives a view no way to stand aside. So a window-sized
 * transparent tooltip layer would be a window-sized hole in the editor. The
 * page measures; main places.
 *
 * # The whole contract, said once
 *
 * **Arriving from main**
 * - `devhub:tooltip-text` — the facts to draw, or nothing to draw none.
 * - `devhub:theme-changed` — the palette, handled outside React by
 *   `installPalette`, so the box wears the Workbench's colours.
 *
 * **Leaving for main**
 * - `devhub:tooltip-size` — how big the box is. This view is exactly that big.
 * - `devhub:tooltip-pointer` — whether the pointer is in the box. Half of an
 *   answer main assembles: the Sidebar's leave is the other half, and neither
 *   page can see the other's pointer. See `main/shell/tooltipView.ts`.
 * - `devhub:open-external-url` — a line that names a page on GitHub was
 *   clicked. The same route the row's own link takes.
 * - `devhub:raise-failure` — what began *here*, one way. Drawn nowhere here:
 *   this page has no room for a failure and no business reporting one, so it
 *   goes to the page that draws them like every other page's does.
 *
 * **And nothing else.** In particular *not* the anchor, though it is part of
 * the request the Sidebar sends. It is the owner's: `windowLayout.ts` turns it
 * into a rectangle, and this page never learns where it ended up. Handing it
 * to a renderer that cannot act on it would be one more member on a bridge
 * whose page has no use for it — the shape `onModals` had on four bridges that could never receive it,
 * which is exactly what the per-page contract exists to make unspellable.
 */

import { useCallback } from "react";
import { devhub } from "./client";
import { toAppError } from "../failure";
import { useTooltipLines } from "./tooltipText";
import { useTooltipSize } from "./tooltipSize";
import {
  Glyph,
  GLYPH_NAMES,
  type GlyphName,
} from "../components/sidebar/icons";
import type { TooltipLineWire } from "../../ipc/contract";

/**
 * Whether this is a mark this page can draw.
 *
 * The wire carries an identifier and never a drawing, so the two pages share
 * one set of marks (`icons.tsx`) and no SVG crosses the bridge. A name that
 * does not resolve draws no mark rather than throwing: the fact beside it is
 * still the fact, and a tooltip is the last place in DevHub that should be
 * able to take a view down.
 */
function glyphName(icon: string | undefined): GlyphName | undefined {
  return icon !== undefined && (GLYPH_NAMES as readonly string[]).includes(icon)
    ? (icon as GlyphName)
    : undefined;
}

/**
 * One of the box's links, followed.
 *
 * `preventDefault` because this document is never navigating anywhere: it is
 * one box drawn in a view the size of itself, and replacing it with GitHub's
 * page would put a website inside a tooltip. The URL leaves through main, the
 * way every link DevHub draws does — not through the navigation backstop in
 * `externalLinks.ts`, which catches what a page did not mean to do and would
 * swallow a refusal nobody is awaiting.
 */
function useFollow(): (
  href: string,
  event: { preventDefault(): void },
) => void {
  return useCallback((href, event) => {
    event.preventDefault();
    void devhub()
      .openExternalUrl(href)
      // What began here is raised and never drawn here: this page has one box
      // in it and no room for a failure, so it goes to the page that draws
      // them. A click that quietly did nothing is the failure this catch
      // exists to prevent, not one it creates.
      .catch((error: unknown) => devhub().raiseFailure(toAppError(error)));
  }, []);
}

export function TooltipApp() {
  const lines = useTooltipLines(devhub);
  const measure = useTooltipSize(lines);
  const follow = useFollow();
  // Where the pointer is, as a fact for main. The box is a view of its own, so
  // the pointer crossing into it from a row is a leave in the Sidebar and an
  // enter here, and only main sees both. It is reported on the box rather than
  // on the document because the view is exactly the box's size: entering the
  // view *is* entering the box.
  const pointer = useCallback((inside: boolean) => {
    devhub().reportTooltipPointer(inside);
  }, []);
  // Nothing to say is a size of zero, which is how this view leaves the
  // window altogether — reported by `useTooltipSize`, which watches the
  // element going away rather than waiting for an observer that cannot fire
  // on a detached node.
  if (lines === undefined) return null;
  return (
    // Not `role="tooltip"`, and hidden from the accessibility tree outright:
    // the row's own accessible name is these same facts in words
    // (`rowDescription.ts` composes both), so a reader announced them as the
    // row was reached. Exposing them again would read the row twice, once as
    // itself and once as its own tooltip. It is doubly true now that the two
    // are in different documents — nothing here is in the Sidebar's tree to be
    // read at all.
    <div
      className="tooltip-box"
      aria-hidden="true"
      ref={measure}
      onPointerEnter={() => pointer(true)}
      onPointerLeave={() => pointer(false)}
    >
      {lines.map((line: TooltipLineWire, index: number) => {
        const icon = glyphName(line.icon);
        const href = line.href;
        return (
          <div
            className={`tooltip-line${line.style ? ` is-${line.style}` : ""}`}
            // The lines of one tooltip have no identity of their own: they are
            // a row's facts in a fixed order, and a row that changes is a new
            // list from top to bottom. The index is the identity.
            key={index}
            data-tone={line.tone}
          >
            {/* A line with no mark starts at the box's edge: the name and the
                path are the heading, and a heading indented past an empty
                column reads as a gap nobody meant. The marked facts below it
                keep their column. */}
            {/* The mark names itself on the element that draws it, so the
                colour a mark wears is a rule about that mark rather than a
                colour composed with the fact and sent over the wire. One
                place decides what an open Issue's green is: this stylesheet,
                out of the same tokens the row's own marks light up with. */}
            {icon ? (
              <span className="tooltip-line-mark" data-mark={icon}>
                <Glyph name={icon} />
              </span>
            ) : null}
            {/* A fact that names a page is the link to it — the same page
                the row's own mark leads to, so the box a person is reading is
                the thing they can act on. Everything else is words. */}
            {href === undefined ? (
              <span className="tooltip-line-text">{line.text}</span>
            ) : (
              <a
                className="tooltip-line-text tooltip-line-link"
                href={href}
                // Out of the tab order, because the box is out of the
                // accessibility tree: an anchor that could be tabbed to inside
                // `aria-hidden` is a stop a reader is taken to and told nothing
                // about. There is nothing to reach it with anyway — this view
                // never holds the keyboard (`keyboardChild` never names it).
                tabIndex={-1}
                onClick={(event) => follow(href, event)}
              >
                {line.text}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
