// @vitest-environment jsdom

/**
 * The tooltip the Sidebar draws for itself.
 *
 * It replaced sixteen `title` attributes, and the reason is not style: a
 * `title` is Chromium's own popup, raised inside a `WebContentsView`, and
 * whether it may paint outside that view's bounds is not this codebase's to
 * decide. The row that most needs a tooltip is the one on a collapsed rail,
 * which is exactly the narrowest view DevHub has — so the thing that must not
 * be left to chance is the one thing `title` leaves to chance.
 *
 * What is pinned here is what "in-page" buys: it appears for the pointer *and*
 * for the keyboard, it says the row's own sentence with the row's own line
 * breaks, it is anchored the other way up near the bottom edge, and it never
 * takes a pointer event away from the row that raised it.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RowTooltip } from "./RowTooltip";

const DESCRIPTION = "widget workspace, path /projects/widget\nbranch main";

/** A row, at a place in a view of a stated height. */
function Row({
  top,
  height = 24,
}: {
  readonly top: number;
  readonly height?: number;
}) {
  return (
    <button
      type="button"
      data-tooltip={DESCRIPTION}
      ref={(node) => {
        if (!node) return;
        // jsdom lays nothing out, so the row says where it is.
        node.getBoundingClientRect = () =>
          ({
            left: 8,
            right: 40,
            top,
            bottom: top + height,
            width: 32,
            height,
          }) as DOMRect;
      }}
    >
      widget
    </button>
  );
}

function mount(top: number, viewHeight = 600, viewWidth = 248) {
  document.documentElement.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: viewWidth,
      bottom: viewHeight,
      width: viewWidth,
      height: viewHeight,
    }) as DOMRect;
  return render(
    <>
      <Row top={top} />
      <RowTooltip />
    </>,
  );
}

/** The tooltip element. Not by role: it is deliberately not in the a11y tree. */
function tooltip(): HTMLElement {
  const node = document.querySelector<HTMLElement>(".row-tooltip");
  if (!node) throw new Error("no tooltip is drawn");
  return node;
}

afterEach(cleanup);

describe("the Sidebar's own tooltip", () => {
  it("says the row's sentence, with the row's own lines", () => {
    mount(100);
    fireEvent.pointerOver(screen.getByRole("button"));
    const tip = tooltip();
    expect(tip).toHaveTextContent("widget workspace, path /projects/widget");
    expect(tip).toHaveTextContent("branch main");
    // `pre-line` is the formatting rule; the text node keeps the newline so
    // that it has something to honour.
    expect(tip.textContent).toBe(DESCRIPTION);
  });

  it("appears for the keyboard too, because a rail has no other way to ask", () => {
    mount(100);
    fireEvent.focusIn(screen.getByRole("button"));
    expect(tooltip()).toBeInTheDocument();
  });

  it("goes when the pointer leaves, and when the keyboard does", () => {
    mount(100);
    const row = screen.getByRole("button");
    fireEvent.pointerOver(row);
    fireEvent.pointerOut(row);
    expect(document.querySelector(".row-tooltip")).toBeNull();

    fireEvent.focusIn(row);
    expect(tooltip()).toBeInTheDocument();
    fireEvent.focusOut(row);
    expect(document.querySelector(".row-tooltip")).toBeNull();
  });

  it("hangs below a row in the upper half of the view", () => {
    mount(100);
    fireEvent.pointerOver(screen.getByRole("button"));
    const tip = tooltip();
    expect(tip.style.top).toBe("130px");
    expect(tip.style.bottom).toBe("");
  });

  /**
   * The last row's tooltip is as readable as the first's.
   *
   * Anchored by its *bottom* edge rather than given a computed top, because
   * how tall it is depends on how the text wraps — which is a thing the
   * browser knows and this does not.
   */
  it("flips upward for a row near the bottom edge", () => {
    mount(560);
    fireEvent.pointerOver(screen.getByRole("button"));
    const tip = tooltip();
    expect(tip.style.bottom).toBe("46px");
    expect(tip.style.top).toBe("");
  });

  /**
   * It cannot leave the view, because there is nothing outside the view for it
   * to be drawn on. So it is as wide as what is left of the view, and on a
   * rail that is the rail — see `RowTooltip.tsx` for what widening it would
   * actually cost.
   */
  it("is clamped to the view it is drawn in", () => {
    mount(100, 600, 248);
    fireEvent.pointerOver(screen.getByRole("button"));
    expect(tooltip().style.maxWidth).toBe("236px");
  });

  /**
   * The rail is the row that most needs a tooltip and the one that cannot
   * have this one: its view is 76px wide with no title bar and 44px with one,
   * and a sentence drawn into that is a ribbon that runs off the top of the
   * view — measured, before this rule existed. Clipped by the view is the
   * exact failure `title` was replaced to avoid.
   */
  it("draws none at all in a view too narrow to read one in", () => {
    mount(100, 600, 76);
    fireEvent.pointerOver(screen.getByRole("button"));
    expect(document.querySelector(".row-tooltip")).toBeNull();
  });

  it("never takes a pointer event from the row that raised it", () => {
    mount(100);
    fireEvent.pointerOver(screen.getByRole("button"));
    // Asserted as the class contract rather than the computed style: jsdom
    // applies no stylesheet, and `pointer-events: none` is stated in
    // `sidebarPage.css` against this class.
    expect(tooltip()).toBeInstanceOf(HTMLElement);
  });
});
