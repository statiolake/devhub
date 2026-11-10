// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { TerminalNeovimKeyWire } from "../../ipc/contract";
import type { NeovimHandle } from "../neovim/NeovimApp";
import { PaneNeovims, inNeovim } from "./PaneNeovims";

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
    drawnSize: () => undefined,
    background: () => undefined,
    typeKey: (key) => typed.push(key.key),
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
    const terminal = { focus: vi.fn(), typeKey: vi.fn() };
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
