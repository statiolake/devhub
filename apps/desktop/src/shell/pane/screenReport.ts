/**
 * Tell main where this terminal's emulator draws its cells.
 *
 * A Neovim started in one of the terminal's panes is drawn by DevHub over
 * exactly that pane (`main/editor/terminalNeovims.ts`): main knows the pane's
 * place in cells from tmux and the client's size in cells, and this is the
 * one fact only the page has — where xterm's screen is, and how large, in
 * the page. Said whenever it moves or changes size (a font, a resize).
 */

import { useEffect } from "react";
import type { TerminalScreenWire } from "../../ipc/contract";

export function useTerminalScreenReport(
  report: (screen: TerminalScreenWire) => void,
): void {
  useEffect(() => {
    let last = "";
    let observed: Element | undefined;
    const send = () => {
      const screen = document.querySelector(".xterm-screen");
      if (screen === null) return;
      const rect = screen.getBoundingClientRect();
      const next = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
      const key = JSON.stringify(next);
      if (key === last || rect.width <= 0 || rect.height <= 0) return;
      last = key;
      report(next);
    };
    const resize = new ResizeObserver(send);
    // Only a new screen element is news here (no layout is read): its
    // size is the ResizeObserver's, and it does not move in the page.
    const watch = () => {
      if (observed?.isConnected === true) return;
      const screen = document.querySelector(".xterm-screen") ?? undefined;
      if (screen === observed) return;
      if (observed !== undefined) resize.unobserve(observed);
      if (screen !== undefined) resize.observe(screen);
      observed = screen;
      send();
    };
    // The emulator is made after the first projection, and made again
    // when the terminal reattaches: the screen element is looked for anew.
    const mutations = new MutationObserver(watch);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", send);
    watch();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [report]);
}
