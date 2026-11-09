/**
 * The control surface's stacking order, in one table (docs/rendering-layers.md,
 * "Manual z-ordering"): every layer over the panes at a declared z, in the
 * order tmux's own client puts them.
 *
 * - The panes' grids and what is drawn on them: the notice, the hairlines,
 *   the cursor, copy mode's badge and scroll, the IME's preedit.
 * - A pane's modes: the chooser (`choose-tree`) and its preview, and
 *   `display-panes`' numbers — tmux draws them in or over the panes.
 * - A popup (`display-popup`): its frame, its grid, the cursor in it.
 * - A menu (`display-menu`): tmux draws it over a popup it was opened from.
 * - The prompt (`command-prompt`, `confirm-before`): tmux's status line,
 *   which no popup or menu ever covers — so a prompt raised from a shell in
 *   a popup is over the popup — and its completion menu over it.
 *
 * Neovim's overlays over the panes are separate views (`ShellWindow`); this
 * page is raised over them while any of the layers from the chooser up is
 * open (`terminal-mode.md`, "Over a Neovim").
 */
export const CONTROL_Z = {
  panes: 1,
  notice: 2,
  borders: 4,
  cursor: 5,
  copy: 6,
  preedit: 6,
  chooser: 20,
  chooserPreview: 21,
  numbers: 25,
  popupFrame: 40,
  popup: 50,
  popupCursor: 51,
  menu: 70,
  prompt: 80,
  completion: 90,
} as const;

/** The table as CSS custom properties (`--control-z-<layer>`). */
export function controlZStyle(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CONTROL_Z).map(([k, v]) => [`--control-z-${k}`, String(v)]),
  );
}
