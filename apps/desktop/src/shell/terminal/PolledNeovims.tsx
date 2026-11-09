/**
 * The Neovims over an xterm.js terminal's panes (without tmux control
 * mode): tmux is polled by main, which says each pane's cells in its
 * client's screen (`TerminalNeovimWire.cells`), and each Neovim's element
 * (`PaneNeovims`) is put over those cells of the emulator's screen, in the
 * page. Nothing moves here: tmux draws the panes, and a layout change is
 * placed when the next reading has it.
 */

import { useEffect, useRef, useState } from "react";
import type { PaneNeovims } from "../pane/PaneNeovims";
import {
  useTerminalScreenReport,
  type TerminalScreenWire,
} from "../pane/screenReport";

export function PolledNeovims({ neovims }: { readonly neovims: PaneNeovims }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<TerminalScreenWire>();
  useTerminalScreenReport(setScreen);
  const [, setTick] = useState(0);
  // The keys back in the emulator; nothing is ever typed into it from a
  // Neovim here (tmux's prefix is main's to put the client in).
  useEffect(() => {
    neovims.lendTerminal({
      focus: () => {
        document
          .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
          ?.focus();
      },
      typeKey: () => undefined,
    });
    return () => {
      neovims.lendTerminal(undefined);
    };
  }, [neovims]);
  useEffect(
    () =>
      neovims.subscribe(() => {
        setTick((tick) => tick + 1);
      }),
    [neovims],
  );
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    for (const entry of neovims.list()) {
      const el = entry.element;
      if (el.parentElement !== layer) layer.append(el);
      const cells = entry.cells;
      if (
        screen === undefined ||
        cells === undefined ||
        !entry.shown ||
        cells.cols <= 0 ||
        cells.rows <= 0
      ) {
        // Hidden where it was: its pane keeps its size in tmux.
        el.style.visibility = "hidden";
        continue;
      }
      const cw = screen.width / cells.cols;
      const ch = screen.height / cells.rows;
      const left = Math.round(screen.x + cells.x * cw);
      const top = Math.round(screen.y + cells.y * ch);
      const right = Math.round(screen.x + (cells.x + cells.width) * cw);
      const bottom = Math.round(screen.y + (cells.y + cells.height) * ch);
      el.style.visibility = "";
      el.style.position = "absolute";
      el.style.left = `${String(left)}px`;
      el.style.top = `${String(top)}px`;
      el.style.width = `${String(right - left)}px`;
      el.style.height = `${String(bottom - top)}px`;
      neovims.setPlaced(entry.key, true);
    }
  });
  return <div ref={layerRef} className="polled-neovims" />;
}
