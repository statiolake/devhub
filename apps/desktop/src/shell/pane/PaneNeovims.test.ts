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
