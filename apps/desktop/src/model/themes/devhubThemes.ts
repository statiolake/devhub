/**
 * DevHub's own two themes, and the default pair: the terminal colours of VS
 * Code's "Dark 2026" and "Light 2026" (MIT), which DevHub wore by default
 * before its themes became its own — so a person who never chose a theme
 * sees the same colours as before.
 */

import type { Theme } from "./theme.js";

export const DEVHUB_THEMES: readonly Theme[] = [
  {
    name: "DevHub Dark",
    background: "#121314",
    foreground: "#bbbebf",
    cursor: "#bbbebf",
    cursorText: "#121314",
    selectionBackground: "#245c73",
    selectionForeground: "#bbbebf",
    palette: [
      "#555555",
      "#ff7b72",
      "#7ee787",
      "#e5ba7d",
      "#79c0ff",
      "#d2a8ff",
      "#3994bc",
      "#bbbebf",
      "#8c8c8c",
      "#f48771",
      "#72c892",
      "#ffa657",
      "#48a0c7",
      "#b267e6",
      "#53a5ca",
      "#ededed",
    ],
  },
  {
    name: "DevHub Light",
    background: "#ffffff",
    foreground: "#202020",
    cursor: "#202020",
    cursorText: "#ffffff",
    selectionBackground: "#bfd9f2",
    selectionForeground: "#202020",
    palette: [
      "#202020",
      "#cf222e",
      "#116329",
      "#b69500",
      "#0550ae",
      "#8250df",
      "#0069cc",
      "#606060",
      "#606060",
      "#ad0707",
      "#1a7f37",
      "#9a6700",
      "#0969da",
      "#6639ba",
      "#1f6feb",
      "#1f2328",
    ],
  },
];
