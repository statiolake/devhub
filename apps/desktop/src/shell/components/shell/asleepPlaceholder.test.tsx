// @vitest-environment jsdom

/**
 * The asleep editor's placeholder: the one place an asleep (or never started)
 * workbench is woken from.
 *
 * Nothing wakes it on its own any more. The whole editor area, dimmed, is one
 * control that holds the keyboard: Enter or a click wakes it, every other key
 * does nothing (DevHub's `Cmd+Q` chords are main's, taken before the page).
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
import { Asleep, Waking } from "./SurfaceState";

function asleep(started = true) {
  const onWake = vi.fn();
  render(
    <Asleep frame="data:image/png;base64," started={started} onWake={onWake} />,
  );
  return { onWake, area: screen.getByRole("button") };
}

describe("an asleep editor's placeholder", () => {
  afterEach(() => {
    cleanup();
  });

  it("says it is asleep and how to wake it, across the whole area", () => {
    const { area } = asleep();
    expect(area).toHaveTextContent("Sleeping — press Enter to wake");
    expect(area).toHaveAccessibleName("Sleeping — press Enter to wake");
    expect(area).toHaveAttribute("data-started", "true");
  });

  it("says a never started one is not running, and how to start it", () => {
    const { area } = asleep(false);
    expect(area).toHaveTextContent(
      "VS Code is not running — press Enter to start",
    );
  });

  it("takes the keyboard when it appears, and again when the page gets it back", () => {
    const { area } = asleep();
    expect(area).toHaveFocus();
    area.blur();
    expect(area).not.toHaveFocus();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(area).toHaveFocus();
  });

  it("a never started one takes the keyboard too, and Enter starts it", () => {
    const { onWake, area } = asleep(false);
    expect(area).toHaveFocus();
    fireEvent.keyDown(area, { key: "Enter" });
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("wakes on Enter", () => {
    const { onWake, area } = asleep();
    fireEvent.keyDown(area, { key: "Enter" });
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("wakes on a click anywhere on it", () => {
    const { onWake, area } = asleep();
    fireEvent.click(area);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not wake on any other key, a modified Enter, or Enter that ends a composition", () => {
    const { onWake, area } = asleep();
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
