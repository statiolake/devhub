// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalNeovimKeyWire } from "../../ipc/contract";
import type { NeovimHandle } from "../neovim/NeovimApp";
import { PaneNeovims, inNeovim, strokeName } from "./PaneNeovims";

const stroke = (to: string): TerminalNeovimKeyWire => ({
  to,
  key: "q",
  code: "KeyQ",
  control: true,
  alt: false,
  shift: false,
  meta: false,
  leftOption: false,
});

function handle(focused = false): NeovimHandle & { typed: string[] } {
  const typed: string[] = [];
  return {
    typed,
    resizeFor: () => undefined,
    resumePaint: () => undefined,
    drawnSize: () => undefined,
    background: () => undefined,
    typeKey: (key) => typed.push(key.key),
    setReach: () => undefined,
    focused: () => focused,
  };
}

describe("the Neovims of a terminal's page", () => {
  it("makes one element per Neovim, keeps it while it lasts, and drops it when it goes", () => {
    const neovims = new PaneNeovims();
    const told = vi.fn();
    neovims.subscribe(told);
    neovims.update({
      overlays: [{ key: "tnv:1", pane: 2, shown: true }],
      keys: "tnv:1",
    });
    const element = neovims.onPane(2)?.element;
    expect(element?.getAttribute("data-neovim-pane")).toBe("tnv:1");
    document.body.append(element!);
    expect(inNeovim(element!)).toBe(true);
    expect(inNeovim(document.body)).toBe(false);
    // Its pane moved, or was hidden: the same element.
    neovims.update({ overlays: [{ key: "tnv:1", pane: 2, shown: false }] });
    expect(neovims.onPane(2)?.element).toBe(element);
    expect(neovims.keys()).toBeUndefined();
    neovims.update({ overlays: [] });
    expect(neovims.list()).toEqual([]);
    expect(element?.isConnected).toBe(false);
    expect(told).toHaveBeenCalledTimes(3);
  });

  it("keeps a gone Neovim as its pane's last picture while its surface keeps it", () => {
    const neovims = new PaneNeovims();
    let keep = true;
    const asked: string[] = [];
    neovims.keepGone((entry) => {
      asked.push(entry.key);
      return keep;
    });
    neovims.update({
      overlays: [
        { key: "tnv:1", pane: 2, shown: true },
        { key: "tnv:2", pane: 3, shown: true },
      ],
      keys: "tnv:1",
    });
    const element = neovims.onPane(2)?.element;
    document.body.append(element!);
    // Its pane closing, still moving: kept, drawn, no longer any pane's.
    neovims.update({ overlays: [{ key: "tnv:2", pane: 3, shown: true }] });
    const gone = neovims.list().find((entry) => entry.key === "tnv:1");
    expect(gone?.goneAt).toBeTypeOf("number");
    expect(gone?.element).toBe(element);
    expect(element?.isConnected).toBe(true);
    expect(neovims.onPane(2)).toBeUndefined();
    expect(asked).toEqual(["tnv:1"]);
    // Still kept: nothing changes.
    neovims.release();
    expect(neovims.list()).toHaveLength(2);
    // The close's motion over: let go of, its element with it.
    keep = false;
    neovims.release();
    expect(neovims.list().map((entry) => entry.key)).toEqual(["tnv:2"]);
    expect(element?.isConnected).toBe(false);
    // The live one was never asked.
    expect(asked).not.toContain("tnv:2");
  });

  it("drops a gone Neovim at once with no surface keeping it, and all it kept when that surface goes", () => {
    const neovims = new PaneNeovims();
    neovims.update({ overlays: [{ key: "tnv:1", pane: 2, shown: true }] });
    neovims.update({ overlays: [] });
    expect(neovims.list()).toEqual([]);
    neovims.keepGone(() => true);
    neovims.update({ overlays: [{ key: "tnv:3", pane: 4, shown: true }] });
    neovims.update({ overlays: [] });
    expect(neovims.list()).toHaveLength(1);
    neovims.keepGone(undefined);
    expect(neovims.list()).toEqual([]);
  });

  it("types a key main took where it was meant, and moves the focus out of a Neovim", () => {
    const neovims = new PaneNeovims();
    const terminal = { focus: vi.fn(), typeKey: vi.fn(() => true) };
    neovims.lendTerminal(terminal);
    neovims.update({
      overlays: [{ key: "tnv:1", pane: 2, shown: true }],
      keys: "tnv:1",
    });
    const nvim = handle(true);
    neovims.setHandle("tnv:1", nvim);
    // A key that gives the Neovim the keys.
    neovims.typeKey(stroke("tnv:1"));
    expect(nvim.typed).toEqual(["q"]);
    expect(terminal.typeKey).not.toHaveBeenCalled();
    // tmux's prefix typed in it: the terminal's, with the focus.
    neovims.typeKey(stroke(""));
    expect(terminal.focus).toHaveBeenCalled();
    expect(terminal.typeKey).toHaveBeenCalledWith(stroke(""));
    expect(neovims.keys()).toBeUndefined();
    // The keys go to the terminal while the Neovim has the focus.
    terminal.focus.mockClear();
    neovims.update({ overlays: [{ key: "tnv:1", pane: 2, shown: true }] });
    expect(terminal.focus).toHaveBeenCalled();
  });
});

describe("tmux's prefix handed to a page whose terminal cannot type it", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A page with a Neovim that has the focus, and main's prefix for it. */
  function page() {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const untyped = vi.fn<(keys: readonly string[]) => void>();
    const neovims = new PaneNeovims({ untyped, waitMs: 300 });
    neovims.update({
      overlays: [{ key: "tnv:1", pane: 2, shown: true }],
      keys: "tnv:1",
    });
    const nvim = handle(true);
    neovims.setHandle("tnv:1", nvim);
    // What the Neovim's own input would read.
    const input = document.createElement("textarea");
    document.body.append(input);
    const neovimRead: string[] = [];
    input.addEventListener("keydown", (event) => neovimRead.push(event.key));
    const press = (key: string, code: string) => {
      const event = new KeyboardEvent("keydown", {
        key,
        code,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      return event;
    };
    return { neovims, untyped, neovimRead, press };
  }

  it("names keys as tmux does", () => {
    expect(strokeName(stroke(""))).toBe("C-q");
    expect(
      strokeName({ ...stroke(""), key: "z", code: "KeyZ", control: false }),
    ).toBe("z");
  });

  it("goes to tmux through main, the key after it too, when no surface lends its keys in time", () => {
    const { neovims, untyped, neovimRead, press } = page();
    neovims.typeKey(stroke(""));
    expect(neovims.keys()).toBeUndefined();
    vi.advanceTimersByTime(299);
    expect(untyped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(untyped).toHaveBeenCalledWith(["C-q"]);
    // The key after it is tmux's, not the Neovim's that still has the focus.
    const z = press("z", "KeyZ");
    expect(z.defaultPrevented).toBe(true);
    expect(neovimRead).toEqual([]);
    expect(untyped).toHaveBeenLastCalledWith(["z"]);
    // Then the Neovim's again.
    press("j", "KeyJ");
    expect(neovimRead).toEqual(["j"]);
    expect(untyped).toHaveBeenCalledTimes(2);
  });

  it("waits for the surface, and types it what came meanwhile, in order", () => {
    const { neovims, untyped, neovimRead, press } = page();
    neovims.typeKey(stroke(""));
    expect(press("z", "KeyZ").defaultPrevented).toBe(true);
    // A modifier alone is nothing to tmux, and is not kept.
    expect(press("Shift", "ShiftLeft").defaultPrevented).toBe(false);
    const typed: string[] = [];
    const terminal = {
      focus: vi.fn(),
      typeKey: vi.fn((key: { key: string }) => {
        typed.push(key.key);
        return true;
      }),
    };
    vi.advanceTimersByTime(100);
    neovims.lendTerminal(terminal);
    expect(typed).toEqual(["q", "z"]);
    expect(terminal.focus).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(untyped).not.toHaveBeenCalled();
    expect(neovimRead).toEqual(["Shift"]);
    press("j", "KeyJ");
    expect(neovimRead).toEqual(["Shift", "j"]);
  });

  it("does not wait for a surface that is there and not attached", () => {
    const { neovims, untyped, press } = page();
    const terminal = { focus: vi.fn(), typeKey: vi.fn(() => false) };
    neovims.lendTerminal(terminal);
    neovims.typeKey(stroke(""));
    expect(untyped).toHaveBeenCalledWith(["C-q"]);
    press("z", "KeyZ");
    expect(terminal.typeKey).toHaveBeenCalledTimes(2);
    expect(untyped).toHaveBeenLastCalledWith(["z"]);
  });

  it("goes at once when main gives the keys back before the wait is over", () => {
    const { neovims, untyped, press } = page();
    neovims.typeKey(stroke(""));
    press("z", "KeyZ");
    // The binding's time is up in main (`settle`): the Neovim's again.
    neovims.update({
      overlays: [{ key: "tnv:1", pane: 2, shown: true }],
      keys: "tnv:1",
    });
    expect(untyped).toHaveBeenCalledWith(["C-q", "z"]);
    vi.advanceTimersByTime(1000);
    expect(untyped).toHaveBeenCalledTimes(1);
  });

  it("says a prefix with nowhere to go was lost", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const neovims = new PaneNeovims({ waitMs: 10 });
    neovims.typeKey(stroke(""));
    vi.advanceTimersByTime(10);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("was lost"));
  });
});
