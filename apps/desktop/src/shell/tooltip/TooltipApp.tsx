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
 * - `devhub:raise-failure` — what began *here*, one way. Drawn nowhere here:
 *   this page has no room for a failure and no business reporting one, so it
 *   goes to the page that draws them like every other page's does.
 *
 * **And nothing else.** In particular *not* the anchor and *not* the side the
 * row prefers, though both are part of the request the Sidebar sends. They are
 * the owner's: `windowLayout.ts` turns them into a rectangle, and this page
 * never learns where it ended up. Handing them to a renderer that cannot act
 * on them would be two more members on a bridge whose page has no use for
 * them — the shape `onModals` had on four bridges that could never receive it,
 * which is exactly what the per-page contract exists to make unspellable.
 */

import { devhub } from "./client";
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

export function TooltipApp() {
  const lines = useTooltipLines(devhub);
  const measure = useTooltipSize(lines);
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
    <div className="tooltip-box" aria-hidden="true" ref={measure}>
      {lines.map((line: TooltipLineWire, index: number) => {
        const icon = glyphName(line.icon);
        return (
          <div
            className={`tooltip-line${line.style ? ` is-${line.style}` : ""}`}
            // The lines of one tooltip have no identity of their own: they are
            // a row's facts in a fixed order, and a row that changes is a new
            // list from top to bottom. The index is the identity.
            key={index}
            data-tone={line.tone}
          >
            {/* The column is reserved whether or not this line has a mark, so
                the facts line up down the box the way the rows they came from
                line up down the Sidebar. */}
            <span className="tooltip-line-mark">
              {icon ? <Glyph name={icon} /> : null}
            </span>
            <span className="tooltip-line-text">{line.text}</span>
          </div>
        );
      })}
    </div>
  );
}
