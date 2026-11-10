/**
 * The trees of the status line rows (`statusline.ts`), each drawn in its
 * row's element (`GridPainter.footerTree`), which the painter places in
 * the row and moves with its window. The slots in a tree are filled here
 * from Neovim's redraw at every flush — the footer's window's cursor
 * (`win_viewport`), the mode, the pending command — so nothing runs in Lua
 * for them. A node's `on_click` runs its Lua; any other press on a footer
 * is Neovim's (`GUI_OWNED`).
 */

import { createPortal } from "react-dom";
import { ComponentTree, type ComponentTheme } from "./ComponentView";
import { isDark } from "./components";
import type { NeovimUiState } from "./redraw";
import type { Footer } from "./statusline";

export function Footers({
  footers,
  state,
  tree,
  mono,
  openLink,
  lua,
}: {
  readonly footers: readonly Footer[];
  readonly state: NeovimUiState;
  readonly tree: (key: string) => HTMLElement;
  readonly mono: string;
  readonly openLink: (url: string) => void;
  readonly lua: (fn: string, args: readonly unknown[]) => void;
}) {
  const showcmd = state.showcmd.map((c) => c.text).join("");
  return (
    <>
      {footers.map((footer) => {
        const entry = footer.entry;
        if (entry.kind !== "tree") return null;
        const grid =
          footer.grid ??
          [...state.gridWins].find(([, win]) => win === footer.win)?.[0];
        const viewport =
          grid !== undefined ? state.windows.get(grid)?.viewport : undefined;
        const normal = entry.hl.get("Normal");
        const ground =
          entry.hl.get(footer.current ? "StatusLine" : "StatusLineNC")?.bg ??
          normal?.bg ??
          state.defaults.background;
        const theme: ComponentTheme = {
          hl: entry.hl,
          fg: normal?.fg ?? state.defaults.foreground,
          bg: ground,
          dark: isDark(ground),
          mono,
          openLink,
          onAction: (action) => {
            lua("_statusline_click", [footer.win, action]);
          },
          slots: {
            position: viewport,
            mode: footer.current ? state.mode.name : undefined,
            showcmd: footer.current ? showcmd : undefined,
          },
        };
        return createPortal(
          <ComponentTree node={entry.node} theme={theme} />,
          tree(footer.key),
          footer.key,
        );
      })}
    </>
  );
}
