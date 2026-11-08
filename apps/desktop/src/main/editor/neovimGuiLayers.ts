/**
 * The buffer-backed GUI layers of `devhub_gui`, run on the server after
 * `SETUP_LUA` at every attach: `view` (a component per buffer line, painted
 * over the windows showing the buffer), `inline` (a component in the
 * `virt_lines` rows of an extmark, as tall as DevHub measures it) and
 * `decorate` (a dimmed, highlighted or tagged line range).
 *
 * Neovim keeps the state, the layout and the keys: the buffer's lines are
 * the items (searchable, `5j`, marks), its cursor line is the focus, and an
 * item's click runs its Lua here. The components are data
 * (`shell/neovim/components.ts`); every colour is a highlight group, sent
 * with its attributes as Neovim resolves them. Where everything is goes to
 * the page as one `layers` event after every scroll, cursor move, edit and
 * window change. See `docs/neovim-editor.md`.
 */
export const LAYERS_LUA = String.raw`
local M = package.loaded["devhub_gui"]
local event = M._event
M._views = M._views or {}
M._inlines = M._inlines or {}
M._decos = M._decos or {}
M._actions = M._actions or {}
local ns = vim.api.nvim_create_namespace("devhub_gui_layers")
M._layers_ns = ns
local group = vim.api.nvim_create_augroup("devhub_gui_layers", { clear = true })

-- Highlight groups every tree may lean on: its ground, muted text, the
-- cursor's colour for the focus ring, the cursor line, and the usual tones.
local BASE = { "Normal", "NormalFloat", "Comment", "CursorLine", "Cursor", "Visual", "Title",
  "Directory", "DiagnosticError", "DiagnosticWarn", "DiagnosticInfo", "DiagnosticHint", "DiagnosticOk",
  "Function", "Keyword", "String", "Special", "Constant", "Type", "Added", "Changed", "Removed",
  "DiffAdd", "DiffChange", "DiffDelete" }

--- Tones: names for highlight groups, so a tree reads like what it means.
M.tones = M.tones or {
  info = "DiagnosticInfo", warn = "DiagnosticWarn", error = "DiagnosticError", ok = "DiagnosticOk",
  hint = "DiagnosticHint", muted = "Comment", accent = "Function", special = "Special",
  keyword = "Keyword", string = "String", title = "Title", added = "Added", changed = "Changed",
  removed = "Removed",
}

local function hl_attrs(name)
  local ok, h
  if vim.api.nvim_get_hl then
    ok, h = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  else
    ok, h = pcall(vim.api.nvim_get_hl_by_name, name, true)
    if ok and type(h) == "table" then
      h = { fg = h.foreground, bg = h.background, sp = h.special, bold = h.bold, italic = h.italic,
            underline = h.underline, strikethrough = h.strikethrough, reverse = h.reverse }
    end
  end
  if not ok or type(h) ~= "table" then return nil end
  local out = {}
  for _, k in ipairs({ "fg", "bg", "sp" }) do if type(h[k]) == "number" then out[k] = h[k] end end
  for _, k in ipairs({ "bold", "italic", "underline", "strikethrough", "reverse" }) do
    if h[k] then out[k] = true end
  end
  -- 0.9 has no Added/Changed/Removed: fall back to the diff colours.
  if next(out) == nil then return nil end
  return out
end

local function hl_table(names)
  local out = {}
  for _, name in ipairs(BASE) do out[name] = hl_attrs(name) end
  for name in pairs(names) do out[name] = hl_attrs(name) end
  return out
end
M._hl_table = hl_table

local MIME = { png = "image/png", jpg = "image/jpeg", jpeg = "image/jpeg", gif = "image/gif",
               svg = "image/svg+xml", webp = "image/webp" }
local image_cache = {}
local function data_url(src)
  if type(src) ~= "string" then return nil end
  if src:match("^https://") or src:match("^data:image/") then return src end
  local path = vim.fn.fnamemodify(vim.fn.expand(src), ":p")
  local stat = vim.loop.fs_stat(path)
  if not stat or not vim.base64 then return nil end
  local key = path .. ":" .. tostring(stat.mtime.sec) .. ":" .. tostring(stat.size)
  if image_cache[key] then return image_cache[key] end
  local file = io.open(path, "rb")
  if not file then return nil end
  local bytes = file:read("*a")
  file:close()
  local mime = MIME[(path:match("%.(%w+)$") or ""):lower()] or "image/png"
  image_cache[key] = "data:" .. mime .. ";base64," .. vim.base64.encode(bytes)
  return image_cache[key]
end

local HL_KEYS = { hl = true, accent = true, bg = true }

--- A component tree as data for the page: functions (on_click) become
--- action numbers kept in actions, highlight names are collected in hls,
--- tones become groups, an image's path becomes a data URL.
local function serialize(node, actions, hls, depth)
  if depth > 24 then return nil end
  if type(node) == "string" then return node end
  if type(node) ~= "table" then return nil end
  local out = {}
  for k, v in pairs(node) do
    if type(k) ~= "string" then
      -- the list part: children, for a container written as { a, b }
    elseif k == "on_click" then
      if type(v) == "function" then
        table.insert(actions, v)
        out.action = #actions
      end
    elseif type(v) == "function" then
      -- not data
    elseif k == "children" or k == "runs" or k == "series" then
      local list = {}
      for _, child in ipairs(v) do
        local s = serialize(child, actions, hls, depth + 1)
        if s ~= nil then table.insert(list, s) end
      end
      out[k] = list
    elseif HL_KEYS[k] and type(v) == "string" then
      local name = M.tones[v] or v
      hls[name] = true
      out[k] = name
    elseif k == "tone" then
      -- below
    else
      out[k] = v
    end
  end
  if node.children == nil and node[1] ~= nil and (node.type == "stack" or node.type == "hstack") then
    local list = {}
    for _, child in ipairs(node) do
      local s = serialize(child, actions, hls, depth + 1)
      if s ~= nil then table.insert(list, s) end
    end
    out.children = list
  end
  if out.type == "text" and out.text == nil and out.runs == nil and type(node[1]) == "string" then
    out.text = node[1]
  end
  if type(node.tone) == "string" and out.hl == nil then
    local name = M.tones[node.tone] or node.tone
    hls[name] = true
    out.hl = name
  end
  if out.type == "image" then
    out.src = data_url(out.src)
    if not out.src then return nil end
  end
  return out
end
M._serialize = serialize

local function buf_of(buf)
  if buf == nil or buf == 0 then return vim.api.nvim_get_current_buf() end
  return buf
end

local function next_id()
  M._next = M._next + 1
  return M._next
end

local place_pending = false
local function schedule_place()
  if place_pending then return end
  place_pending = true
  vim.schedule(function()
    place_pending = false
    M._place_layers()
  end)
end
M._schedule_place = schedule_place

-- Views ---------------------------------------------------------------------

local function keys_list(keys)
  local out = {}
  if type(keys) ~= "table" then return out end
  for _, entry in ipairs(keys) do
    if type(entry) == "table" and entry[1] and entry[2] then
      table.insert(out, { tostring(entry[1]), tostring(entry[2]) })
    end
  end
  return out
end

local MAX_ITEMS = 5000

local function render_view(view)
  if not vim.api.nvim_buf_is_valid(view.buf) then return end
  local actions, hls, items = {}, {}, {}
  local count = math.min(vim.api.nvim_buf_line_count(view.buf), MAX_ITEMS)
  local lines = vim.api.nvim_buf_get_lines(view.buf, 0, count, false)
  for lnum = 1, count do
    local node
    if type(view.items) == "function" then
      local ok, value = pcall(view.items, lnum, lines[lnum])
      node = ok and value or nil
    elseif type(view.items) == "table" then
      node = view.items[lnum]
    end
    local s = node ~= nil and serialize(node, actions, hls, 0) or nil
    table.insert(items, { line = lnum, node = s, text = lines[lnum] })
  end
  M._actions["view:" .. view.id] = actions
  event("view", { id = view.id, items = items, hl = hl_table(hls), keys = keys_list(view.keys) })
end

local render_pending = {}
local function schedule_render(view)
  if render_pending[view.id] then return end
  render_pending[view.id] = true
  vim.schedule(function()
    render_pending[view.id] = nil
    if M._views[view.id] == view then
      render_view(view)
      schedule_place()
    end
  end)
end

local function open_window(buf, how)
  if type(how) == "number" then
    if vim.api.nvim_win_is_valid(how) then vim.api.nvim_win_set_buf(how, buf) end
    return how
  end
  if how == nil then return nil end
  if how == "float" then
    local width = math.floor(vim.o.columns * 0.5)
    local height = math.floor(vim.o.lines * 0.6)
    return vim.api.nvim_open_win(buf, true, {
      relative = "editor", width = width, height = height,
      row = math.floor((vim.o.lines - height) / 2) - 1, col = math.floor((vim.o.columns - width) / 2),
      style = "minimal", border = "rounded", zindex = 50,
    })
  end
  if how ~= "current" then vim.cmd(how) end
  local win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(win, buf)
  return win
end

--- gui.view{ buf, win?, items = fn(lnum, line) | { [lnum] = node }, on_click?, keys? }:
--- the buffer's lines drawn as components, one item per line, over every
--- window that shows the buffer. win: a window, or 'vsplit' | 'split' |
--- 'float' | 'current' to open one. Answers a handle: :update(items?),
--- :close().
function M.view(opts)
  opts = opts or {}
  local buf = buf_of(opts.buf)
  local view = { id = next_id(), buf = buf, items = opts.items, on_click = opts.on_click, keys = opts.keys }
  M._views[view.id] = view
  local handle = { id = view.id, buf = buf }
  function handle.update(self, items)
    if type(self) ~= "table" or self.id == nil then items = self end
    if items ~= nil then view.items = items end
    if M._views[view.id] == view then schedule_render(view) end
  end
  function handle.close()
    M.view_clear(view.id)
  end
  vim.api.nvim_buf_attach(buf, false, {
    on_lines = function()
      if M._views[view.id] ~= view then return true end
      schedule_render(view)
    end,
    on_reload = function() schedule_render(view) end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group, buffer = buf, once = true,
    callback = function() M.view_clear(view.id) end,
  })
  handle.win = open_window(buf, opts.win)
  if handle.win then
    for option, value in pairs({ wrap = false, cursorline = false, list = false, spell = false }) do
      pcall(function() vim.wo[handle.win][option] = value end)
    end
  end
  render_view(view)
  schedule_place()
  return handle
end

function M.view_clear(id)
  id = type(id) == "table" and id.id or id
  if not M._views[id] then return end
  M._views[id] = nil
  M._actions["view:" .. id] = nil
  event("view_clear", { id = id })
  schedule_place()
end

-- Inline cards --------------------------------------------------------------

local function blank_lines(rows)
  local virt = {}
  for _ = 1, rows do table.insert(virt, { { " ", "Normal" } }) end
  return virt
end

local function send_inline(card)
  local actions, hls = {}, {}
  local node = serialize(card.component, actions, hls, 0)
  M._actions["inline:" .. card.id] = actions
  if node then event("inline", { id = card.id, node = node, hl = hl_table(hls) }) end
end

--- gui.inline{ buf, lnum, component, id?, rows?, range? }: a card under line
--- lnum (1-based), in virt_lines rows DevHub measures and Neovim reserves.
--- id: a key of yours; the same key in the same buffer updates that card.
--- range = { first, last }: the lines whose cursor makes the card active.
--- Answers a handle: :update(component), :move(lnum), :clear().
function M.inline(opts)
  opts = opts or {}
  local buf = buf_of(opts.buf)
  local key = opts.id ~= nil and (tostring(buf) .. ":" .. tostring(opts.id)) or nil
  M._inline_keys = M._inline_keys or {}
  local card = key and M._inlines[M._inline_keys[key] or -1]
  if not card then
    card = { id = next_id(), buf = buf, key = key }
    card.rows = math.max(1, math.floor(opts.rows or 2))
    M._inlines[card.id] = card
    if key then M._inline_keys[key] = card.id end
  end
  card.component = opts.component
  card.range = opts.range
  local lnum = math.max(1, math.min(opts.lnum or 1, vim.api.nvim_buf_line_count(buf)))
  card.mark = vim.api.nvim_buf_set_extmark(buf, ns, lnum - 1, 0,
    { id = card.mark, virt_lines = blank_lines(card.rows) })
  send_inline(card)
  schedule_place()
  local handle = { id = card.id, buf = buf }
  function handle.update(self, component)
    if type(self) ~= "table" or self.id == nil then component = self end
    if M._inlines[card.id] ~= card then return end
    card.component = component
    send_inline(card)
    schedule_place()
  end
  function handle.move(self, to)
    if type(self) ~= "table" or self.id == nil then to = self end
    if M._inlines[card.id] ~= card then return end
    card.mark = vim.api.nvim_buf_set_extmark(card.buf, ns, to - 1, 0,
      { id = card.mark, virt_lines = blank_lines(card.rows) })
    schedule_place()
  end
  function handle.clear() M.inline_clear(card.id) end
  return handle
end

function M.inline_clear(id)
  id = type(id) == "table" and id.id or id
  local card = M._inlines[id]
  if not card then return end
  M._inlines[id] = nil
  M._actions["inline:" .. id] = nil
  if card.key and M._inline_keys then M._inline_keys[card.key] = nil end
  pcall(vim.api.nvim_buf_del_extmark, card.buf, ns, card.mark)
  event("inline_clear", { id = id })
  schedule_place()
end

--- Every card of buf (all: nil), cleared.
function M.inline_clear_all(buf)
  for id, card in pairs(M._inlines) do
    if buf == nil or card.buf == buf_of(buf) then M.inline_clear(id) end
  end
end

--- The page measured a card: rows is what it takes. Only a change is applied,
--- and the height depends on the width alone, so this settles at once.
function M._inline_rows(id, rows)
  local card = M._inlines[id]
  if not card or type(rows) ~= "number" then return end
  rows = math.max(1, math.min(200, math.floor(rows)))
  if rows == card.rows then return end
  card.rows = rows
  local ok, pos = pcall(vim.api.nvim_buf_get_extmark_by_id, card.buf, ns, card.mark, {})
  if not ok or not pos[1] then return end
  card.mark = vim.api.nvim_buf_set_extmark(card.buf, ns, pos[1], 0,
    { id = card.mark, virt_lines = blank_lines(rows) })
  schedule_place()
end

--- gui.inline_focus(handle, true|false): ring the card as if the cursor were on it.
function M.inline_focus(id, on)
  local card = M._inlines[type(id) == "table" and id.id or id]
  if not card then return end
  card.focus = on ~= false
  schedule_place()
end

-- Decorations ----------------------------------------------------------------

--- gui.decorate{ buf, range = { first, last }, style = 'dim' | 'highlight' |
--- 'tag', tag = 'text'?, hl = group or tone? }: a line range painted over
--- every window showing it (diff windows too). The range follows edits (an
--- extmark). Answers a handle: :clear().
function M.decorate(opts)
  opts = opts or {}
  local buf = buf_of(opts.buf)
  local range = opts.range or { opts.lnum or 1, opts.lnum or 1 }
  local first, last = range[1], range[2] or range[1]
  local count = vim.api.nvim_buf_line_count(buf)
  first = math.max(1, math.min(first, count))
  last = math.max(first, math.min(last, count))
  local deco = { id = next_id(), buf = buf, style = opts.style or "highlight", tag = opts.tag }
  if deco.style ~= "dim" and deco.style ~= "highlight" and deco.style ~= "tag" then deco.style = "highlight" end
  deco.mark = vim.api.nvim_buf_set_extmark(buf, ns, first - 1, 0,
    { end_row = last - 1, end_col = 0, end_right_gravity = true })
  local hls = {}
  local name = opts.hl and (M.tones[opts.hl] or opts.hl) or nil
  if name then hls[name] = true end
  deco.group = name
  M._decos[deco.id] = deco
  event("deco", { id = deco.id, style = deco.style, tag = deco.tag, group = name, hl = hl_table(hls) })
  schedule_place()
  return { id = deco.id, buf = buf, clear = function() M.decorate_clear(deco.id) end }
end

function M.decorate_clear(id)
  id = type(id) == "table" and id.id or id
  local deco = M._decos[id]
  if not deco then return end
  M._decos[id] = nil
  pcall(vim.api.nvim_buf_del_extmark, deco.buf, ns, deco.mark)
  event("deco_clear", { id = id })
  schedule_place()
end

function M.decorate_clear_all(buf)
  for id, deco in pairs(M._decos) do
    if buf == nil or deco.buf == buf_of(buf) then M.decorate_clear(id) end
  end
end

-- Placement ------------------------------------------------------------------

local function tab_windows(buf)
  local out = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == buf then table.insert(out, win) end
  end
  return out
end

--- The screen rows (from the window's top) of line lnum in win: its first
--- and its last, or nil when it is not in view.
local function line_rows(win, info, lnum)
  if lnum < info.topline then return nil end
  local folded = vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(lnum) end)
  local text = vim.api.nvim_buf_get_lines(info.bufnr, lnum - 1, lnum, false)[1] or ""
  local first = vim.fn.screenpos(win, lnum, 1)
  if first.row == 0 then return nil end
  local last = folded == -1 and vim.fn.screenpos(win, lnum, math.max(1, #text)) or first
  local top = info.winrow - 1
  return first.row - top - 1, (last.row > 0 and last.row or first.row) - top - 1, folded ~= -1
end

function M._place_layers()
  local views, inlines, measure, decos = {}, {}, {}, {}
  local current = vim.api.nvim_get_current_win()
  for id, view in pairs(M._views) do
    if not vim.api.nvim_buf_is_valid(view.buf) then
      M.view_clear(id)
    else
      for _, win in ipairs(tab_windows(view.buf)) do
        table.insert(views, { id = id, win = win, cursor = vim.api.nvim_win_get_cursor(win)[1],
          current = win == current })
      end
    end
  end
  for id, card in pairs(M._inlines) do
    local ok, pos = pcall(vim.api.nvim_buf_get_extmark_by_id, card.buf, ns, card.mark, {})
    if not ok or not pos[1] then
      M.inline_clear(id)
    else
      local lnum = pos[1] + 1
      local shown = false
      for _, win in ipairs(tab_windows(card.buf)) do
        local info = vim.fn.getwininfo(win)[1]
        if info then
          local width = info.width - info.textoff
          local _, last, folded = line_rows(win, info, lnum)
          local row, visible, clip
          if last and not folded then
            row = last + 1
            visible = math.min(card.rows, info.height - row)
            clip = 0
          elseif lnum == info.topline - 1 then
            -- The line is just above the top, its rows partly in view (topfill).
            local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
            local fill = math.min(view.topfill or 0, card.rows)
            if fill > 0 then row, visible, clip = 0, math.min(fill, info.height), card.rows - fill end
          end
          if row and visible and visible > 0 then
            shown = true
            local cursor = vim.api.nvim_win_get_cursor(win)[1]
            local range = card.range or { lnum, lnum }
            table.insert(inlines, { id = id, win = win, row = row, col = info.textoff, width = width,
              rows = visible, full = card.rows, clip = clip,
              active = card.focus == true or (win == current and cursor >= range[1] and cursor <= (range[2] or range[1])) })
          elseif not shown and #measure < 64 then
            table.insert(measure, { id = id, width = width, full = card.rows })
            shown = true
          end
        end
      end
    end
  end
  for id, deco in pairs(M._decos) do
    local ok, pos = pcall(vim.api.nvim_buf_get_extmark_by_id, deco.buf, ns, deco.mark, { details = true })
    if not ok or not pos[1] then
      M.decorate_clear(id)
    else
      local first = pos[1] + 1
      local last = (pos[3] and pos[3].end_row or pos[1]) + 1
      for _, win in ipairs(tab_windows(deco.buf)) do
        local info = vim.fn.getwininfo(win)[1]
        if info then
          local top, bottom
          -- Not topline + height: closed folds (a diff's) hide any number of lines.
          local from = math.max(first, info.topline)
          for lnum = from, math.min(last, from + 2000) do
            local a, b = line_rows(win, info, lnum)
            if a then
              top = top or a
              bottom = b
            elseif top then
              break
            end
          end
          if top then
            top = math.max(0, top)
            bottom = math.min(bottom, info.height - 1)
            if bottom >= top then
              table.insert(decos, { id = id, win = win, row = top, rows = bottom - top + 1,
                col = info.textoff, width = info.width - info.textoff })
            end
          end
        end
      end
    end
  end
  event("layers", { views = views, inlines = inlines, measure = measure, decos = decos })
end

--- A click on the page: the cursor goes to the item (or the card's line) in
--- that window, then the node's on_click (or the view's) runs.
function M._layers_click(kind, id, win, line, action)
  local owner = kind == "view" and M._views[id] or M._inlines[id]
  if not owner then return end
  if win and vim.api.nvim_win_is_valid(win) then
    vim.api.nvim_set_current_win(win)
    if kind == "inline" then
      local ok, pos = pcall(vim.api.nvim_buf_get_extmark_by_id, owner.buf, ns, owner.mark, {})
      if ok and pos[1] then line = pos[1] + 1 end
    end
    if type(line) == "number" then pcall(vim.api.nvim_win_set_cursor, win, { line, 0 }) end
  end
  local fn = type(action) == "number" and (M._actions[kind .. ":" .. id] or {})[action] or nil
  local ok, err = true, nil
  if fn then
    ok, err = pcall(fn, line)
  elseif kind == "view" and owner.on_click then
    ok, err = pcall(owner.on_click, line)
  end
  if not ok then vim.notify("devhub gui: " .. tostring(err), vim.log.levels.ERROR) end
end

--- The wheel scrolled a view: its cursor follows to an item in sight.
function M._view_cursor(id, win, line)
  if not M._views[id] or not vim.api.nvim_win_is_valid(win) then return end
  pcall(vim.api.nvim_win_set_cursor, win, { line, 0 })
end

function M._layers_replay()
  for _, view in pairs(M._views) do render_view(view) end
  for _, card in pairs(M._inlines) do send_inline(card) end
  for _, deco in pairs(M._decos) do
    local hls = {}
    if deco.group then hls[deco.group] = true end
    event("deco", { id = deco.id, style = deco.style, tag = deco.tag, group = deco.group, hl = hl_table(hls) })
  end
  schedule_place()
end

local base_replay = M._replay
function M._replay()
  M._layers_replay()
  base_replay()
end

vim.api.nvim_create_autocmd({ "WinScrolled", "WinResized", "WinClosed", "WinNew", "WinEnter", "BufWinEnter",
  "TabEnter", "VimResized", "TextChanged", "TextChangedI", "CursorMoved", "CursorMovedI" }, {
  group = group,
  callback = function()
    if next(M._views) == nil and next(M._inlines) == nil and next(M._decos) == nil then return end
    schedule_place()
  end,
})
-- New colours: every tree again, with its groups resolved again.
vim.api.nvim_create_autocmd("ColorScheme", {
  group = group,
  callback = function() vim.schedule(M._layers_replay) end,
})
`;
