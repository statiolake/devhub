/**
 * The page's half of "the shell wears the Workbench's theme".
 *
 * The other half is in main: the page arrives with the palette already in its
 * `<head>`, so the first frame is the right colour and nothing here runs before
 * anything is visible. This is only what happens *afterwards* — a workbench
 * changed theme and the chrome around it has to follow.
 *
 * It sets the same variables the served stylesheet sets, from the same mapping,
 * as inline properties on the root element: inline wins over the stylesheet, so
 * there is one rule for which of the two is showing and it is always the newer
 * one. Nothing here decides what a colour means; `paletteVariables` does, once,
 * for both sides.
 */

import { paletteVariables, type ShellPalette } from "../ipc/palette";
import { devhub } from "./client";

export function applyPalette(
  root: HTMLElement,
  palette: ShellPalette | undefined,
): void {
  if (!palette) return;
  // A theme means the window has no material to show through the chrome; the
  // rules keyed on this in `tokens.css` and `shell.css` paint it instead.
  root.dataset.windowMaterial = "none";
  for (const [name, value] of paletteVariables(palette)) {
    root.style.setProperty(name, value);
  }
}

/**
 * Follow the Workbench's theme for as long as this page is open.
 *
 * Installed outside React, beside the failure handler and the selection guard,
 * because the palette is a fact about the document rather than about any
 * component — and because every page the shell bundle serves needs it, not
 * only the one with a Sidebar in it.
 */
export function installPalette(document: Document): () => void {
  return devhub().onTheme((palette) => {
    applyPalette(document.documentElement, palette);
  });
}
