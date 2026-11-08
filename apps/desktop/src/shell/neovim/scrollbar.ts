/**
 * A window's scrollbar as something to use, as VS Code's: a click on a mark
 * (`marks.ts`) goes to its line, a click on the track pages towards it, a
 * drag of the thumb scrolls. Neovim does each — `SCROLLBAR_LUA` asks it
 * with its own motions and scroll commands — so the cursor, the jumplist
 * and `scrolloff` are as the keys would leave them. Each has its keys,
 * named in the track's tooltip: `]d`/`[d` for diagnostics, `n`/`N` for the
 * search, the person's hunk motions (gitsigns' `]c`/`[c`) for git,
 * `<C-f>`/`<C-b>` to page, `{count}%`, `gg`, `G`, `<C-d>` for the thumb.
 *
 * This file is the geometry, pure and unit-tested; the editor listens.
 */

import type { MarkRect } from "./marks";

/** The thumb, as fractions of the track: its top and its size. */
export interface Thumb {
  readonly top: number;
  readonly size: number;
}

/**
 * The thumb of a window showing `shown` of `lineCount` lines from
 * `topline` (0-based), its display `rows` from Neovim's view (pixel
 * scrolling), on a track `height` pixels tall: at least 24 pixels.
 */
export function thumbOf(
  topline: number,
  shown: number,
  lineCount: number,
  rows: number,
  height: number,
): Thumb {
  const top = Math.max(0, Math.min(1, (topline + rows) / lineCount));
  const size = Math.max(
    Math.min(1, shown / lineCount),
    24 / Math.max(1, height),
  );
  return { top: Math.min(1 - size, top), size };
}

/** What a press on the track at `y` pixels from its top is for. */
export type ScrollbarHit =
  | { readonly kind: "thumb" }
  | { readonly kind: "page"; readonly dir: 1 | -1 }
  | {
      readonly kind: "mark";
      readonly mark: "diag" | "search" | "git";
      readonly line: number;
    };

/** How near a mark a press counts as on it (pixels). */
const MARK_SLOP = 3;

/**
 * The thumb first (it must stay draggable, whatever it is over); then the
 * marks, drawn small, so a press within a few pixels of one is on it (the
 * nearest; the worst diagnostic, then the search, then git, when level);
 * the rest of the track pages.
 */
export function hitScrollbar(
  y: number,
  height: number,
  thumb: Thumb,
  marks: readonly MarkRect[],
): ScrollbarHit {
  const top = thumb.top * height;
  const bottom = top + thumb.size * height;
  if (y >= top && y <= bottom) return { kind: "thumb" };
  const rank = { diag: 0, search: 1, git: 2 } as const;
  let best:
    | { d: number; r: number; mark: "diag" | "search" | "git"; line: number }
    | undefined;
  for (const mark of marks) {
    if (mark.kind === undefined || mark.kind === "cursor") continue;
    if (mark.line === undefined) continue;
    const at = Math.min(mark.y, height - mark.h);
    const d = Math.max(0, at - y, y - (at + mark.h));
    if (d > MARK_SLOP) continue;
    const r = rank[mark.kind];
    if (!best || d < best.d || (d === best.d && r < best.r))
      best = { d, r, mark: mark.kind, line: mark.line };
  }
  if (best) return { kind: "mark", mark: best.mark, line: best.line };
  return { kind: "page", dir: y > bottom ? 1 : -1 };
}

/**
 * The `topline` (1-based) a thumb dragged `dy` pixels from where it was
 * pressed puts the window at: the thumb's top as a fraction of the
 * buffer, kept within it.
 */
export function draggedTopline(
  startTop: number,
  dy: number,
  height: number,
  lineCount: number,
): number {
  const top = Math.max(0, startTop + dy / Math.max(1, height));
  return Math.max(1, Math.min(lineCount, Math.round(top * lineCount) + 1));
}

/** The tooltip for a mark: what it is, and the keys that go to it. */
export function markTitle(hit: ScrollbarHit): string {
  switch (hit.kind) {
    case "mark":
      return hit.mark === "diag"
        ? `Line ${String(hit.line)}: diagnostic — ]d / [d`
        : hit.mark === "search"
          ? `Line ${String(hit.line)}: match — n / N`
          : `Line ${String(hit.line)}: change — the hunk motions (]c / [c)`;
    case "page":
      return "Page — <C-f> / <C-b>";
    case "thumb":
      return "Drag to scroll — gg, G, {count}%";
  }
}

/**
 * What the scrollbar asks of Neovim, in window `win` (current window
 * unchanged unless it goes to a mark): `top` — scroll until `arg` is the
 * top line (`<C-e>`/`<C-y>` with a count: the cursor stays unless the view
 * leaves it, `scrolloff` kept); `page` — `<C-f>` (arg 1) or `<C-b>`; `mark`
 * — into the window, a jump to line `arg` (`m'` first, so `<C-o>` comes
 * back), at the diagnostic's or the match's column (`kind`) or the first
 * non-blank. Folds open as a jump opens them (`foldopen`).
 */
export const SCROLLBAR_LUA = `
local action, win, arg, kind = ...
if not vim.api.nvim_win_is_valid(win) then return 0 end
if action == 'mark' then
  vim.api.nvim_set_current_win(win)
  local last = vim.api.nvim_buf_line_count(0)
  local line = math.max(1, math.min(last, arg))
  vim.cmd("normal! m'")
  local col
  if kind == 'diag' then
    for _, d in ipairs(vim.diagnostic.get(0, { lnum = line - 1 })) do
      if not col or d.col < col then col = d.col end
    end
    if col then col = col + 1 end
  elseif kind == 'search' then
    vim.fn.cursor(line, 1)
    local ok, at = pcall(vim.fn.searchpos, vim.fn.getreg('/'), 'cnW', line)
    if ok and at[1] == line then col = at[2] end
  end
  vim.fn.cursor(line, 1)
  if col then vim.fn.cursor(line, col) else vim.cmd('normal! ^') end
  if vim.o.foldopen:find('jump') or vim.o.foldopen:find('all') then vim.cmd('normal! zv') end
  return 1
end
vim.api.nvim_win_call(win, function()
  if action == 'page' then
    vim.cmd('normal! ' .. (arg > 0 and '\\6' or '\\2'))
  elseif action == 'top' then
    local d = arg - vim.fn.line('w0')
    if d > 0 then vim.cmd('normal! ' .. d .. '\\5')
    elseif d < 0 then vim.cmd('normal! ' .. -d .. '\\25') end
  end
end)
return 1
`;
