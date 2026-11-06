// @vitest-environment jsdom

/**
 * The placeholder of an editor that is not running — never started (nothing
 * starts one until it is asked for), stopped with `Cmd+Q Shift+E`, or
 * discarded: the one place a workbench is started from.
 *
 * Nothing starts it on its own. The whole editor area, dimmed, says how to
 * start it and holds a Start button that has the keyboard: Enter, the button
 * or a click anywhere on the area starts it, every other key does nothing
 * (DevHub's `Cmd+Q` chords are main's, taken before the page).
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

function discarded(frame = "data:image/png;base64,") {
  const onWake = vi.fn();
  const { container } = render(<Discarded frame={frame} onWake={onWake} />);
  return {
    onWake,
    button: screen.getByRole("button", { name: "Start" }),
    area: container.querySelector(".surface-discarded") as HTMLElement,
  };
}

describe("a not-running editor's placeholder", () => {
  afterEach(() => {
    cleanup();
  });

  it("says it is not running and how to start it, with a Start button", () => {
    const { area } = discarded();
    expect(area).toHaveTextContent("Editor not running — press Enter to start");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("draws the frame a stopped or discarded one left, and none for one never started", () => {
    expect(discarded().area.querySelector("img")).not.toBeNull();
    cleanup();
    expect(discarded("").area.querySelector("img")).toBeNull();
  });

  it("puts the keyboard on its button when it appears, and again when the page gets it back", () => {
    const { button } = discarded();
    expect(button).toHaveFocus();
    button.blur();
    expect(button).not.toHaveFocus();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(button).toHaveFocus();
  });

  it("starts on Enter, once", () => {
    const { onWake, button } = discarded();
    fireEvent.keyDown(button, { key: "Enter" });
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("starts on its button, once", () => {
    const { onWake, button } = discarded();
    fireEvent.click(button);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("starts on a click anywhere on it", () => {
    const { onWake, area } = discarded();
    fireEvent.click(area);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not start on any other key, a modified Enter, or Enter that ends a composition", () => {
    const { onWake, button } = discarded();
    for (const key of [" ", "a", "Escape", "Tab", "ArrowDown", "e"]) {
      fireEvent.keyDown(button, { key });
    }
    fireEvent.keyDown(button, { key: "Enter", metaKey: true });
    fireEvent.keyDown(button, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(button, { key: "Enter", isComposing: true });
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
