/**
 * Where the widgets DevHub draws for Neovim go: pure, so tested without a page.
 */

/** Height of one completion row and the list's cap, as `neovim.css` draws them. */
const PUM_ROW = 21;
const PUM_MAX = 280;

/**
 * Under the anchor cell, or over it when there is no room below — the way
 * Neovim itself flips its own menu — and never past the right edge.
 */
export function popupmenuPlace(
  area: { readonly width: number; readonly height: number },
  anchorTop: number,
  anchorLeft: number,
  cellHeight: number,
  items: number,
): { left: number; top: number; maxHeight: number } {
  const wanted = Math.min(PUM_MAX, items * PUM_ROW + 8);
  const below = area.height - (anchorTop + cellHeight) - 2;
  const above = anchorTop - 2;
  const left = Math.max(0, Math.min(anchorLeft, area.width - 200));
  if (below >= wanted || below >= above) {
    return {
      left,
      top: anchorTop + cellHeight + 2,
      maxHeight: Math.max(40, below),
    };
  }
  const height = Math.min(wanted, above);
  return { left, top: anchorTop - height - 2, maxHeight: height };
}
