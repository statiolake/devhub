// @vitest-environment jsdom

/**
 * The discarded editor's placeholder: the one place a discarded workbench is
 * started again from.
 *
 * Nothing starts it on its own. The whole editor area, dimmed, is one control
 * that holds the keyboard: Enter or a click starts it, every other key does
 * nothing (DevHub's `Cmd+Q` chords are main's, taken before the page).
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Discarded, Waking } from "./SurfaceState";

function discarded() {
  const onWake = vi.fn();
  render(<Discarded frame="data:image/png;base64," onWake={onWake} />);
  return { onWake, area: screen.getByRole("button") };
}

describe("a discarded editor's placeholder", () => {
  afterEach(() => {
    cleanup();
  });

  it("says it is not running and how to start it, across the whole area", () => {
    const { area } = discarded();
    expect(area).toHaveTextContent(
      "VS Code is not running — press Enter to start",
    );
    expect(area).toHaveAccessibleName(
      "VS Code is not running — press Enter to start",
    );
  });

  it("takes the keyboard when it appears, and again when the page gets it back", () => {
    const { area } = discarded();
    expect(area).toHaveFocus();
    area.blur();
    expect(area).not.toHaveFocus();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(area).toHaveFocus();
  });

  it("starts on Enter", () => {
    const { onWake, area } = discarded();
    fireEvent.keyDown(area, { key: "Enter" });
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("starts on a click anywhere on it", () => {
    const { onWake, area } = discarded();
    fireEvent.click(area);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not start on any other key, a modified Enter, or Enter that ends a composition", () => {
    const { onWake, area } = discarded();
    for (const key of [" ", "a", "Escape", "Tab", "ArrowDown", "e"]) {
      fireEvent.keyDown(area, { key });
    }
    fireEvent.keyDown(area, { key: "Enter", metaKey: true });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(area, { key: "Enter", isComposing: true });
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe("a waking editor's placeholder", () => {
  afterEach(() => {
    cleanup();
  });

  it("is the starting spinner over the frame it left", () => {
    render(<Waking frame="data:x" />);
    expect(screen.getByText("Starting VS Code…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
