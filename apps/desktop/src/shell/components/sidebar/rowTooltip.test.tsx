// @vitest-environment jsdom

/**
 * The Sidebar decides when a tooltip appears; it no longer decides where.
 *
 * It drew its own until now, and could not draw the one that mattered: a box
 * in this document is clipped by this view, and the row that most needs a
 * tooltip is the glyph on a collapsed rail — 44px wide with a title bar, 76px
 * without. The page's answer was `MIN_READABLE_WIDTH`: below a readable width,
 * draw nothing. That accepted the premise that the tooltip has to fit inside
 * the column, which is what gave the rail no hover at all and gave an expanded
 * row a sentence wrapped into a ribbon — one complaint, not two.
 *
 * So what is pinned here is what this page still owns. **When**: the pointer
 * has to rest, the keyboard does not. **One for the whole tree.** **What it
 * says**, with the row's own lines. And the one number it has to get right —
 * the anchor in the *window's* coordinates, which is the row's box plus the
 * rectangle main told this view it occupies, never anything this page
 * measured about where it is.
 *
 * There is deliberately no assertion here about which side the tooltip lands
 * on, or whether it flips, or whether it is clamped. Those are
 * `windowLayout.ts`'s and are tested there. This file would only be able to
 * restate them.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowTooltip } from "./RowTooltip";
import type {
  SidebarAreaWire,
  TooltipRequestWire,
} from "../../../ipc/contract";

const DESCRIPTION = "widget workspace, path /projects/widget\nbranch main";

/** Everything this page asked main for, in order. `null` is a hide. */
let sent: (TooltipRequestWire | null)[] = [];
/** Main's push of where this view is. */
let pushArea: ((area: SidebarAreaWire) => void) | undefined;

/**
 * The expanded column, as main lays it out: under the title band, 248 wide.
 * Not a number this page could have worked out — that is the point of it
 * arriving on a wire.
 */
const COLUMN: SidebarAreaWire = { x: 0, y: 38, width: 248, height: 862 };
/** The collapsed rail with no title bar: the traffic lights' span. */
const RAIL: SidebarAreaWire = { x: 0, y: 38, width: 76, height: 862 };

/** A row, at a place in this view's own pixels. */
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

function mount(top: number, prefer: "right" | "below" = "below") {
  return render(
    <>
      <Row top={top} />
      <RowTooltip prefer={prefer} />
    </>,
  );
}

/** Main says where this view is. */
function layOut(area: SidebarAreaWire) {
  act(() => {
    if (!pushArea)
      throw new Error("the page never subscribed to its rectangle");
    pushArea(area);
  });
}

/** The pointer arrives on the row and rests there long enough. */
function hover(row: HTMLElement) {
  fireEvent.pointerOver(row);
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

/** The last thing asked for, which must be a request rather than a hide. */
function raised(): TooltipRequestWire {
  const last = sent.at(-1);
  if (!last) throw new Error("no tooltip was asked for");
  return last;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  pushArea = undefined;
  window.devhub = {
    raiseFailure: () => undefined,
    onTheme: () => () => undefined,
    onSidebarArea: (listener: (area: SidebarAreaWire) => void) => {
      pushArea = listener;
      return () => (pushArea = undefined);
    },
    showTooltip: (request: TooltipRequestWire) => sent.push(request),
    hideTooltip: () => sent.push(null),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.devhub;
});

describe("the Sidebar's tooltips", () => {
  it("waits for the pointer to rest on the row before asking for anything", () => {
    mount(100);
    layOut(COLUMN);
    const row = screen.getByRole("button");
    fireEvent.pointerOver(row);
    expect(sent).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(sent).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(raised().text).toBe(DESCRIPTION);
  });

  it("asks for nothing for a row the pointer only crossed", () => {
    mount(100);
    layOut(COLUMN);
    const row = screen.getByRole("button");
    fireEvent.pointerOver(row);
    fireEvent.pointerOut(row);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(sent.filter((entry) => entry !== null)).toEqual([]);
  });

  it("asks at once for the keyboard, because a row reached was chosen", () => {
    mount(100);
    layOut(COLUMN);
    fireEvent.focusIn(screen.getByRole("button"));
    expect(raised().text).toBe(DESCRIPTION);
  });

  it("says the row's sentence, with the row's own lines", () => {
    mount(100);
    layOut(COLUMN);
    hover(screen.getByRole("button"));
    // `pre-line` on the tooltip page is the formatting rule; the string
    // carries the newline so that it has something to honour.
    expect(raised().text).toBe(DESCRIPTION);
  });

  /**
   * The one number this page has to get right: the row's own box plus the
   * rectangle main told this view it occupies. Not `window.screenX`, not
   * anything measured about where this view is.
   */
  it("gives the anchor in the window's coordinates, not this view's", () => {
    mount(100);
    layOut(COLUMN);
    hover(screen.getByRole("button"));
    expect(raised().anchor).toEqual({
      x: 0 + 8,
      y: 38 + 100,
      width: 32,
      height: 24,
    });
  });

  it("moves the anchor when main moves the column", () => {
    mount(100);
    layOut({ ...COLUMN, y: 0 });
    hover(screen.getByRole("button"));
    expect(raised().anchor.y).toBe(100);
  });

  /**
   * Nothing is asked for before main has said where this view is. A guessed
   * origin puts the sentence somewhere that is not beside the row, which is
   * worse than a tooltip that is a moment late.
   */
  it("asks for nothing at all until it knows where it is", () => {
    mount(100);
    hover(screen.getByRole("button"));
    expect(sent.filter((entry) => entry !== null)).toEqual([]);
  });

  /**
   * The rail is the row this whole change exists for. It used to get nothing;
   * it now gets a tooltip, and the side it asks for is beside the glyph
   * because that is what a rail row is.
   */
  it("asks for a tooltip on the rail, beside the glyph", () => {
    mount(100, "right");
    layOut(RAIL);
    hover(screen.getByRole("button"));
    expect(raised().prefer).toBe("right");
    expect(raised().text).toBe(DESCRIPTION);
  });

  it("asks for one under the row in the expanded column", () => {
    mount(100, "below");
    layOut(COLUMN);
    hover(screen.getByRole("button"));
    expect(raised().prefer).toBe("below");
  });

  /**
   * A row scrolled half out of the column has half a row on screen, and a
   * tooltip pointing at the invisible half points at nothing.
   */
  it("clips the anchor to the column when the row is half scrolled out", () => {
    mount(-10);
    layOut(COLUMN);
    hover(screen.getByRole("button"));
    // The row runs from -10 to 14 in this view; only the lower part is in it.
    expect(raised().anchor.y).toBe(COLUMN.y);
    expect(raised().anchor.height).toBe(14);
  });

  it("asks for nothing for a row scrolled entirely out of the column", () => {
    mount(-40);
    layOut(COLUMN);
    hover(screen.getByRole("button"));
    expect(sent.filter((entry) => entry !== null)).toEqual([]);
  });

  it("takes it down when the pointer leaves, and when the keyboard does", () => {
    mount(100);
    layOut(COLUMN);
    const row = screen.getByRole("button");
    hover(row);
    fireEvent.pointerOut(row);
    expect(sent.at(-1)).toBeNull();

    fireEvent.focusIn(row);
    expect(sent.at(-1)).not.toBeNull();
    fireEvent.focusOut(row);
    expect(sent.at(-1)).toBeNull();
  });

  /**
   * Anything that moves the row out from under the tooltip takes it down. It
   * matters more than it did: the tooltip is another view now and cannot be
   * scrolled or resized away by the document that raised it.
   */
  it.each(["scroll", "resize", "blur"] as const)(
    "takes it down on %s, which the tooltip's own view cannot see",
    (event) => {
      mount(100);
      layOut(COLUMN);
      hover(screen.getByRole("button"));
      fireEvent(window, new Event(event));
      expect(sent.at(-1)).toBeNull();
    },
  );

  /**
   * A tooltip drawn by another view outlives this component otherwise —
   * unmounting takes nothing off the screen, which is the one new way this
   * could leave a sentence standing over the editor with nothing under it.
   */
  it("takes it down when the Sidebar itself goes away", () => {
    const view = mount(100);
    layOut(COLUMN);
    hover(screen.getByRole("button"));
    view.unmount();
    expect(sent.at(-1)).toBeNull();
  });

  /**
   * One tooltip for the whole tree. The second row replaces the first rather
   * than adding to it — and main could not hold two either, so the rule is
   * kept at both ends.
   */
  it("replaces the tooltip that is up when the pointer moves to another row", () => {
    render(
      <>
        <Row top={100} />
        <RowTooltip prefer="below" />
      </>,
    );
    layOut(COLUMN);
    const row = screen.getByRole("button");
    hover(row);
    const first = sent.length;
    fireEvent.pointerOut(row);
    hover(row);
    expect(sent.length).toBeGreaterThan(first);
    expect(raised().text).toBe(DESCRIPTION);
  });
});
