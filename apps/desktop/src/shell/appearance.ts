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

import { useSyncExternalStore } from "react";
import {
  paletteVariables,
  type ShellPalette,
  type ShellPaletteBase,
} from "../ipc/palette";
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

/** Which half of every two-valued appearance in the page applies. */
export type ColorScheme = ShellPaletteBase;

/**
 * The scheme the page is in right now: the theme's, or the system's until a
 * theme has said otherwise.
 *
 * There is one answer and it is read off the document, because more than one
 * thing needs it and a disagreement between them is *visible*: the content
 * area's ground and the xterm palette painted on it are two colours that have
 * to be the same one. `color-scheme` on the root is the record — main writes
 * it from the palette before the first paint and `applyPalette` writes it on
 * every theme change afterwards — so reading it back cannot drift from what
 * the tokens actually resolved to. `light dark` is the untouched fallback and
 * means no theme has spoken yet, so the system decides.
 */
export function documentColorScheme(view: Window = window): ColorScheme {
  const declared = view
    .getComputedStyle(view.document.documentElement)
    .colorScheme?.trim();
  if (declared === "light" || declared === "dark") return declared;
  return view.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Tell me when that answer can have changed.
 *
 * Two events can move it and both are watched here rather than in whoever
 * happens to be asking: a theme arrives — which `applyPalette` records as
 * inline properties on the root, so the root's `style` attribute mutating is
 * exactly the signal — or the viewer flips the system appearance under a page
 * that has no theme yet.
 */
export function observeColorScheme(
  changed: () => void,
  view: Window & typeof globalThis = window,
): () => void {
  const query = view.matchMedia?.("(prefers-color-scheme: dark)");
  query?.addEventListener("change", changed);
  const observer = new view.MutationObserver(changed);
  observer.observe(view.document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });
  return () => {
    query?.removeEventListener("change", changed);
    observer.disconnect();
  };
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(
    observeColorScheme,
    () => documentColorScheme(),
    () => "light",
  );
}
