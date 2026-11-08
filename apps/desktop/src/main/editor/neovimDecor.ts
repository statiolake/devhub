/**
 * Where a window's decorations are — text Neovim draws on cells that is not
 * the buffer's: virtual text at the end of a line, right-aligned or inline
 * (inlay hints), virtual lines, and a closed fold's text — so the page can
 * set them in a proportional face (`painter.ts`, `docs/neovim-editor.md`,
 * "Decorations in a proportional face").
 *
 * Neovim lays them out in cells, as it lays out everything, and the GUI
 * receives only cells: nothing in `grid_line` says which are virtual. So
 * Lua, which knows, says where: the extmarks in each window's visible lines
 * (`nvim_buf_get_extmarks` with details) and the closed folds
 * (`foldclosed`, `foldtextresult`), placed with `screenpos`. Each is sent as
 * a row of the window's grid, a column and the text Neovim draws there; the
 * page draws one only where the grid holds exactly that text there now, so
 * one that is a redraw behind is cells as before, never a wrong guess.
 *
 * Asked after every redraw that drew a window (a decoration provider's
 * `on_win`, sent once the redraw is over), and sent only when it changed.
 * Left out on purpose: `overlay` and `virt_text_win_col` text (it is put on
 * the buffer's own columns — indent guides, tables, concealed markup — and
 * only works on cells), `virt_lines_above`, a fold whose `foldtext` is
 * empty (the line itself, which is content), and anything in a namespace a
 * plugin declared content with `content_namespace(ns)`: virtual text that
 * is code, not words about it (the deleted lines of an inline diff, a hunk
 * preview), stays in the grid's face.
 */
export const DECOR_LUA = String.raw`
local M = package.loaded["devhub_gui"]
if not M then return end
local ns = vim.api.nvim_create_namespace("devhub_gui_decor")
M._decor_dirty = M._decor_dirty or {}
M._decor_sent = M._decor_sent or {}
M._content_ns = M._content_ns or {}

--- Declare the virtual text and lines of namespace ns (an id or a name) as
--- content — code, drawn on cells in the grid's face like the buffer's own
--- lines — rather than words about the code (pass false to undo).
function M.content_namespace(ns, on)
  if type(ns) == "string" then ns = vim.api.nvim_create_namespace(ns) end
  if type(ns) ~= "number" then return end
  M._content_ns[ns] = on ~= false or nil
  M._decor_last = nil
  for _, win in ipairs(vim.api.nvim_list_wins()) do M._decor_dirty[win] = true end
  if not M._decor_pending then
    M._decor_pending = true
    vim.schedule(M._decor_send)
  end
end

local function chunks_text(chunks)
  local parts = {}
  for _, chunk in ipairs(chunks or {}) do
    if type(chunk) == "table" and type(chunk[1]) == "string" then table.insert(parts, chunk[1]) end
  end
  return table.concat(parts)
end

--- A window's decorations: { row, col, text, kind } in its grid's cells.
--- kind: "eol" (col is where the line's text ends: the text is at or after
--- it), "right" (ends at the window's edge), "inline", "lines" (a virtual
--- line), "fold" (a closed fold's text after its +-- marker).
local function spans_of(win)
  local info = vim.fn.getwininfo(win)[1]
  if not info or info.height == 0 then return {} end
  local buf = info.bufnr
  local out = {}
  local top, wincol = info.winrow, info.wincol
  local function pos(lnum, col)
    local p = vim.fn.screenpos(win, lnum, col)
    if p.row == 0 then return nil end
    return p
  end
  local folding = vim.wo[win].foldenable
  local foldtext = vim.wo[win].foldtext
  -- The closed folds' text: the +-- marker stays on cells (the cursor sits
  -- on its first cell, its dashes count the level); the words after it.
  local lnum = info.topline
  while lnum <= info.botline do
    local closed = folding and vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(lnum) end) or -1
    if closed ~= -1 then
      local last = vim.api.nvim_win_call(win, function() return vim.fn.foldclosedend(lnum) end)
      if foldtext ~= "" then
        local p = pos(lnum, 1)
        local text = vim.api.nvim_win_call(win, function() return vim.fn.foldtextresult(lnum) end)
        local marker = text:match("^%+%-*") or ""
        local lead = math.max(1, #marker)
        local rest = text:sub(lead + 1)
        if p and rest:match("%S") then
          table.insert(out, { row = p.row - top, col = info.textoff + lead, text = rest, kind = "fold" })
        end
      end
      lnum = math.max(last, lnum) + 1
    else
      lnum = lnum + 1
    end
  end
  local ok, marks = pcall(vim.api.nvim_buf_get_extmarks, buf, -1, { info.topline - 1, 0 },
    { info.botline - 1, -1 }, { details = true })
  if not ok then return out end
  local lines_below = {}
  local inline_at = {}
  for _, m in ipairs(marks) do
    local row0, col0, d = m[2], m[3], m[4] or {}
    local l = row0 + 1
    local closed = folding and vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(l) end) or -1
    local content = d.ns_id ~= nil and M._content_ns[d.ns_id]
    if closed == -1 and content and d.virt_lines and not d.virt_lines_above then
      -- Content lines still take their rows: later lines under this one go after them.
      lines_below[row0] = (lines_below[row0] or 0) + #d.virt_lines
    elseif closed == -1 and not content then
      local line = vim.api.nvim_buf_get_lines(buf, row0, row0 + 1, false)[1] or ""
      -- Where the line's text ends: its last screen row, and the cell after
      -- its last character (the text area's start for an empty line).
      local function line_end()
        if #line == 0 then
          local p = pos(l, 1)
          return p and p.row - top, info.textoff
        end
        local p = pos(l, #line)
        return p and p.row - top, p and (p.endcol - wincol + 1)
      end
      if d.virt_text and not d.virt_text_hide then
        local where = d.virt_text_pos or "eol"
        local text = chunks_text(d.virt_text)
        if text:match("%S") then
          if where == "eol" or where == "right_align" or where == "eol_right_align" then
            local row, from = line_end()
            if row then
              table.insert(out, { row = row, col = from, text = text,
                kind = where == "right_align" and "right" or "eol" })
            end
          elseif where == "inline" then
            inline_at[row0] = inline_at[row0] or {}
            inline_at[row0][col0] = inline_at[row0][col0] or {}
            table.insert(inline_at[row0][col0], text)
          end
        end
      end
      if d.virt_lines and not d.virt_lines_above then
        local row = line_end()
        if row then
          local before = lines_below[row0] or 0
          for i, vl in ipairs(d.virt_lines) do
            local text = chunks_text(vl)
            if text:match("%S") then
              table.insert(out, { row = row + before + i, col = d.virt_lines_leftcol and 0 or info.textoff,
                text = text, kind = "lines" })
            end
          end
          lines_below[row0] = before + #d.virt_lines
        end
      end
    end
  end
  -- Inline text sits before the character at its column: screenpos of
  -- that character starts where the first of them starts.
  for row0, cols in pairs(inline_at) do
    local l = row0 + 1
    local line = vim.api.nvim_buf_get_lines(buf, row0, row0 + 1, false)[1] or ""
    for col0, texts in pairs(cols) do
      local p
      if col0 < #line then
        p = pos(l, col0 + 1)
        if p then p = { row = p.row, col = p.col } end
      elseif #line > 0 then
        local q = pos(l, #line)
        if q then p = { row = q.row, col = q.endcol + 1 } end
      else
        local q = pos(l, 1)
        if q then p = { row = q.row, col = q.col } end
      end
      if p then
        local col = p.col - wincol
        for _, text in ipairs(texts) do
          table.insert(out, { row = p.row - top, col = col, text = text, kind = "inline" })
          col = col + vim.fn.strdisplaywidth(text)
        end
      end
    end
  end
  return out
end

function M._decor_send()
  M._decor_pending = false
  if not M._chan then return end
  local wins = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if M._decor_dirty[win] or M._decor_sent[win] == nil then
      local ok, spans = pcall(spans_of, win)
      M._decor_sent[win] = ok and spans or {}
    end
    wins[tostring(win)] = M._decor_sent[win]
  end
  for win in pairs(M._decor_sent) do
    if not vim.api.nvim_win_is_valid(win) then M._decor_sent[win] = nil end
  end
  M._decor_dirty = {}
  if vim.deep_equal(wins, M._decor_last) then return end
  M._decor_last = wins
  M._event("decor", { wins = wins })
end

vim.api.nvim_set_decoration_provider(ns, {
  on_win = function(_, win)
    M._decor_dirty[win] = true
    return false
  end,
  on_end = function()
    if not M._decor_pending and next(M._decor_dirty) then
      M._decor_pending = true
      vim.schedule(M._decor_send)
    end
  end,
})
M._decor_last = nil
vim.schedule(M._decor_send)
`;
