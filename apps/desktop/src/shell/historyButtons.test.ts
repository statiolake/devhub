// @vitest-environment jsdom

/**
 * The mouse's side buttons on DevHub's own pages: Back and Forward, and the
 * page's own navigation cancelled so the view never leaves its document.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { installHistoryButtons } from "./historyButtons";

function press(button: number, type = "mouseup"): MouseEvent {
  const event = new MouseEvent(type, {
    button,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  return event;
}

describe("the mouse's side buttons", () => {
  let remove: () => void = () => undefined;
  afterEach(() => {
    remove();
  });

  it("go Back on button 3 and Forward on button 4", () => {
    const navigate = vi.fn();
    remove = installHistoryButtons(document, navigate);
    expect(press(3).defaultPrevented).toBe(true);
    expect(press(4).defaultPrevented).toBe(true);
    expect(navigate.mock.calls).toEqual([["back"], ["forward"]]);
  });

  it("cancel the press too, and act only on the release", () => {
    const navigate = vi.fn();
    remove = installHistoryButtons(document, navigate);
    expect(press(3, "mousedown").defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leave every other button alone", () => {
    const navigate = vi.fn();
    remove = installHistoryButtons(document, navigate);
    expect(press(0).defaultPrevented).toBe(false);
    expect(press(1).defaultPrevented).toBe(false);
    expect(press(2).defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stop listening once removed", () => {
    const navigate = vi.fn();
    installHistoryButtons(document, navigate)();
    press(3);
    expect(navigate).not.toHaveBeenCalled();
  });
});
