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
 *   clicked: the repository, the Issue or the pull request of the row.
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

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { devhub } from "./client";
import { toAppError } from "../failure";
import { isGitHubPage } from "../githubPage";
import { useTooltipContent } from "./tooltipText";
import { useTooltipSize } from "./tooltipSize";
import {
  Glyph,
  GLYPH_NAMES,
  type GlyphName,
} from "../components/sidebar/icons";
import type {
  TooltipFactLineWire,
  TooltipMeterLineWire,
} from "../../ipc/contract";
import { resetsIn, resetTime } from "../resetTime";
import { usageLevel } from "../usageLevel";

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
 * way every link DevHub draws does, and only when it is a GitHub page — the
 * three places a row's facts name — whatever the line arrived carrying.
 */
function useFollow(): (
  href: string,
  event: { preventDefault(): void },
) => void {
  return useCallback((href, event) => {
    event.preventDefault();
    if (!isGitHubPage(href)) return;
    void devhub()
      .openExternalUrl(href)
      // What began here is raised and never drawn here: this page has one box
      // in it and no room for a failure, so it goes to the page that draws
      // them. A click that quietly did nothing is the failure this catch
      // exists to prevent.
      .catch((error: unknown) => devhub().raiseFailure(toAppError(error)));
  }, []);
}

export function TooltipApp() {
  const content = useTooltipContent(devhub);
  const measure = useTooltipSize(content);
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
  if (content === undefined) return null;
  const { lines, room } = content;
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
      // The most the box may be, from main: the window less its margins. The
      // box wraps to this width and stops at this height, so what is measured
      // is what fits and the view is never cut short of its own box. See
      // `TooltipContentWire.room`.
      style={
        room === undefined
          ? undefined
          : {
              maxWidth: `min(var(--tooltip-max-width), ${room.width}px)`,
              maxHeight: `${room.height}px`,
            }
      }
      onPointerEnter={() => pointer(true)}
      onPointerLeave={() => pointer(false)}
    >
      {lines.map((line, index) =>
        // The lines of one tooltip have no identity of their own: they are a
        // row's facts in a fixed order, and a row that changes is a new list
        // from top to bottom. The index is the identity.
        line.kind === "meter" ? (
          <MeterLine key={index} line={line} now={Date.now()} />
        ) : (
          <FactLine key={index} line={line} follow={follow} />
        ),
      )}
    </div>
  );
}

function FactLine({
  line,
  follow,
}: {
  readonly line: TooltipFactLineWire;
  readonly follow: (href: string, event: { preventDefault(): void }) => void;
}) {
  const icon = glyphName(line.icon);
  const href =
    line.href !== undefined && isGitHubPage(line.href) ? line.href : undefined;
  return (
    <div
      className={`tooltip-line${line.style ? ` is-${line.style}` : ""}`}
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
      {/* Everything after the mark is one run of text, so a path's copy
          button flows in it like a character: it follows the path, wraps
          with it, and the qualifier carries on after it on the same line.
          The mark keeps its column; the words do not have columns. */}
      <span className="tooltip-line-body">
        {/* A fact that names a page is the link to it — the repository, the
            Issue, the pull request. The row's own marks have no hover of
            their own, so this box is where they are followed. Everything
            else is words. */}
        {href === undefined ? (
          <span className="tooltip-line-text">
            {withCopy(line.text, line.copy, line.text)}
          </span>
        ) : (
          <a
            className="tooltip-line-text tooltip-line-link"
            href={href}
            // Out of the tab order, because the box is out of the
            // accessibility tree; this view never holds the keyboard anyway.
            tabIndex={-1}
            onClick={(event) => follow(href, event)}
          >
            {line.text}
          </a>
        )}
        {/* A link's copy button is outside the link, so a click on it copies
            rather than follows. Nothing sends both today. */}
        {href !== undefined && line.copy !== undefined ? (
          <CopyPath path={line.copy} />
        ) : null}
        {/* Subdued words after the fact, on its line: where a Workspace is,
            beside its name; what a worktree was cut from, beside its path —
            with that path's own button right after the path. */}
        {line.qualifier === undefined || line.qualifier === "" ? null : (
          <>
            {" "}
            <span className="tooltip-line-qualifier">
              {withCopy(
                line.qualifier,
                line.qualifierCopy,
                line.qualifierCopyAfter,
              )}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/** How long the check stands on a copy button after the copy landed. */
export const COPIED_MS = 1000;

/**
 * Words with a path's copy button in them, right after the path.
 *
 * The button is an inline element in the text, like an emoji: it follows the
 * last character of the path and wraps with it. What keeps the two together
 * is a `nowrap` run holding the path's last character, the button and
 * whatever closes the words straight after it with no space (the bracket of
 * `(worktree of ~/src/widget)`), so the button can never begin a line on its
 * own and a bracket can never be left behind it. Only that much is held
 * together: a path is one long word, and holding all of it would push it past
 * the box's edge instead of letting it wrap.
 *
 * `after` is how the path is written in `text`; the button follows its last
 * occurrence. Absent or not found, it follows the whole text.
 */
function withCopy(
  text: string,
  copy: string | undefined,
  after: string | undefined,
): ReactNode {
  if (copy === undefined) return text;
  const at = after === undefined || after === "" ? -1 : text.lastIndexOf(after);
  const end = at < 0 ? text.length : at + after!.length;
  const rest = text.slice(end);
  // Held with the button only when it closes the words — no space in it.
  const held = /\s/u.test(rest) ? "" : rest;
  const free = held === "" ? rest : "";
  const chars = Array.from(text.slice(0, end));
  const last = chars.pop() ?? "";
  return (
    <>
      {chars.join("")}
      <span className="tooltip-copy-join">
        {last}
        <CopyPath path={copy} />
        {held}
      </span>
      {free}
    </>
  );
}

/**
 * A quiet button in the words of a path that puts its absolute form on the
 * clipboard. Inline and sized in `em`, so it is the size of the text it sits
 * in and wraps with it (`withCopy`).
 *
 * Low contrast at rest and stronger under the pointer, and no hover of its
 * own — nothing small in DevHub's tooltips raises one. A click copies through
 * main (`writeClipboard`); once the write lands the mark is a check for
 * `COPIED_MS`, in place. A write that failed is raised, never confirmed. The
 * box stays up while the pointer is in it (`tooltipView.ts`), so this can be
 * reached.
 */
function CopyPath({ path }: { readonly path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="tooltip-copy"
      // Out of the tab order: the box is out of the accessibility tree and
      // never holds the keyboard.
      tabIndex={-1}
      data-copied={copied || undefined}
      onClick={(event) => {
        event.preventDefault();
        void devhub()
          .writeClipboard(path)
          .then(
            () => setCopied(true),
            (error: unknown) => devhub().raiseFailure(toAppError(error)),
          );
      }}
    >
      <Glyph name={copied ? "statusIdle" : "copy"} />
    </button>
  );
}

/**
 * A measure of use, as a labelled bar: what is measured and how much of it is
 * used on one line, the bar under it, and when it starts again under that.
 *
 * The words about time are worked out here, as the box is drawn, from this
 * page's clock (see `TooltipMeterLineWire`). A reading whose reset has passed
 * is history — what was used then, with nothing newer reported — and the
 * whole meter is drawn faded and says so, rather than showing an old number
 * as the present one. The bar's colour follows `usageLevel`, the rule every
 * usage meter in DevHub keeps.
 */
function MeterLine({
  line,
  now,
}: {
  readonly line: TooltipMeterLineWire;
  readonly now: number;
}) {
  const stale = line.resetsAt !== undefined && line.resetsAt <= now;
  const used = line.usedPercent;
  return (
    <div
      className="tooltip-meter"
      // History is not a warning: what was near its limit then is not now.
      data-level={stale ? "calm" : usageLevel(used)}
      data-stale={stale || undefined}
    >
      <div className="tooltip-meter-head">
        <span className="tooltip-meter-label">{line.label}</span>
        <span
          className="tooltip-meter-value"
          data-unknown={used === undefined || undefined}
        >
          {used === undefined ? "not reported" : `${Math.round(used)}%`}
        </span>
      </div>
      <div className="tooltip-meter-track">
        <div
          className="tooltip-meter-fill"
          style={{ width: `${Math.min(Math.max(used ?? 0, 0), 100)}%` }}
        />
      </div>
      <div className="tooltip-meter-reset">
        {resetWords(line.resetsAt, now)}
      </div>
    </div>
  );
}

function resetWords(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "Reset time not reported";
  const at = resetTime(resetsAt, now);
  return resetsAt <= now
    ? `Reset ${at} · nothing reported since`
    : `Resets ${resetsIn(resetsAt, now)} · ${at}`;
}
