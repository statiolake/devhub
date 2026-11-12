/**
 * The buffer-backed GUI layers of `devhub_gui`, run on the server after
 * `SETUP_LUA` at every attach: `view` (a component per buffer line, painted
 * over the windows showing the buffer), `inline` (a component in the
 * `virt_lines` rows of an extmark, as tall as DevHub measures it), `popup`
 * (a hover)
 * — a view may instead be drawn in a frame over a float, round a query
 * field and a preview window: a picker's frontend, whoever's picker it is.
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
M._popups = M._popups or {}
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
  local ok, h = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  if not ok or type(h) ~= "table" then return nil end
  local out = {}
  for _, k in ipairs({ "fg", "bg", "sp" }) do if type(h[k]) == "number" then out[k] = h[k] end end
  for _, k in ipairs({ "bold", "italic", "underline", "strikethrough", "reverse" }) do
    if h[k] then out[k] = true end
  end
  -- A group the colorscheme left empty is no group.
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

local HL_KEYS = { hl = true, accent = true, bg = true, band = true }

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
    elseif k == "marks" and type(v) == "table" then
      -- a markdown's marks over its code: their groups are resolved too
      local list = {}
      for _, mark in ipairs(v) do
        if type(mark) == "table" and type(mark.hl) == "string" then
          hls[mark.hl] = true
          table.insert(list, mark)
        end
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

local function win_of(member)
  local win = type(member) == "table" and member.win or member
  return type(win) == "number" and win ~= 0 and win or nil
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
    -- An item is a component, or { node = component, heading = component }:
    -- a heading is drawn above the item and is not an item.
    local heading
    if type(node) == "table" and node.type == nil and (node.node ~= nil or node.heading ~= nil) then
      node, heading = node.node, node.heading
    end
    local s = node ~= nil and serialize(node, actions, hls, 0) or nil
    local h = heading ~= nil and serialize(heading, actions, hls, 0) or nil
    table.insert(items, { line = lnum, node = s, heading = h, text = lines[lnum] })
  end
  local frame
  if view.frame then
    local f = view.frame
    local function part(node)
      return node ~= nil and serialize(node, actions, hls, 0) or nil
    end
    frame = { title = part(f.title), status = part(f.status), preview_title = part(f.preview_title),
      placeholder = f.placeholder }
  end
  M._actions["view:" .. view.id] = actions
  event("view", { id = view.id, items = items, hl = hl_table(hls), keys = keys_list(view.keys), frame = frame })
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

--- gui.view{ buf, win?, items = fn(lnum, line) | { [lnum] = node }, on_click?,
--- on_scroll?, on_rows?, keys? }: the buffer's lines drawn as components, one
--- item per line, over every window that shows the buffer (an item may be
--- { node, heading }: a heading above it that is not an item). win: a
--- window, or 'vsplit' | 'split' | 'float' | 'current' to open one.
--- on_click(lnum, clicks).
--- frame = { win, query = { win, placeholder? }, preview = { win, title? },
--- title?, status? }: the view is drawn in a frame over the float win instead
--- of over its window (a hidden window showing buf, whose cursor line is the
--- focus): a header (title, the query window's first line as a field with
--- its caret in Insert mode, status), the items, the preview window's cells
--- with its title above, and keys as the hint row. There on_scroll(rows)
--- gets the wheel and on_rows(rows) how many items fit (the plugin pages).
--- Answers a handle: :update(items?), :frame{ … }, :redraw(), :close().
function M.view(opts)
  opts = opts or {}
  local buf = buf_of(opts.buf)
  local view = { id = next_id(), buf = buf, items = opts.items, on_click = opts.on_click, keys = opts.keys,
    on_scroll = opts.on_scroll, on_rows = opts.on_rows }
  if type(opts.frame) == "table" then
    local f = opts.frame
    local frame_win = win_of(f.win)
    if not frame_win or not vim.api.nvim_win_is_valid(frame_win) then
      error("devhub_gui.view: frame.win must be a window")
    end
    view.frame = { win = frame_win, query_win = win_of(f.query), placeholder = type(f.query) == "table" and f.query.placeholder or nil,
      preview_win = win_of(f.preview), preview_title = type(f.preview) == "table" and f.preview.title or nil,
      title = f.title, status = f.status }
  end
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
  --- The cursor moved without an autocmd (nvim_win_set_cursor on a window
  --- that is not current): the focus is placed again.
  function handle.redraw()
    if M._views[view.id] == view then schedule_place() end
  end
  --- A framed view's parts: { title?, status?, preview_title?, placeholder?,
  --- preview_win? (false: none) }.
  function handle.frame(self, changes)
    if type(self) ~= "table" or self.id == nil then changes = self end
    local f = view.frame
    if not f or M._views[view.id] ~= view or type(changes) ~= "table" then return end
    for _, key in ipairs({ "title", "status", "preview_title", "placeholder" }) do
      if changes[key] ~= nil then f[key] = changes[key] end
    end
    if changes.preview_win ~= nil then f.preview_win = win_of(changes.preview_win) end
    schedule_render(view)
  end
  if view.frame then
    vim.api.nvim_create_autocmd("WinClosed", { group = group, pattern = tostring(view.frame.win), once = true,
      callback = function() M.view_clear(view.id) end })
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

-- Popups ---------------------------------------------------------------------

-- What closes a popup that is not focused, unless opts.close_on says.
local CLOSE_ON = { "CursorMoved", "CursorMovedI", "InsertCharPre", "BufLeave" }
local popup_seq = 0

-- The plain text of a tree: what y yanks when the popup was given none.
local function plain_text(node, out)
  if type(node) == "string" then table.insert(out, node) return out end
  if type(node) ~= "table" then return out end
  if node.type == "markdown" and type(node.text) == "string" then table.insert(out, node.text) end
  if node.type == "text" then
    if type(node.text) == "string" then table.insert(out, node.text) end
    if type(node.runs) == "table" then
      local line = {}
      for _, run in ipairs(node.runs) do
        local t = type(run) == "string" and run or (type(run) == "table" and (run.text or run[1])) or nil
        if type(t) == "string" then table.insert(line, t) end
      end
      table.insert(out, table.concat(line))
    end
  end
  for _, child in ipairs(node.children or node) do
    if type(child) == "table" then plain_text(child, out) end
  end
  return out
end

local function send_popup(p)
  local actions, hls = {}, {}
  local node = serialize(p.component, actions, hls, 0)
  M._actions["popup:" .. p.id] = actions
  if node then
    event("popup", { id = p.id, node = node, hl = hl_table(hls), placement = p.placement,
      max_width = p.max_width, max_height = p.max_height, min_width = p.min_width })
  end
end

local function popup_scroll(p, by, n, pane)
  popup_seq = popup_seq + 1
  event("popup_scroll", { id = p.id, by = by, n = n or 1, seq = popup_seq,
    pane = type(pane) == "string" and pane or nil })
end

-- The tree's pane of that name (stack{ pane = name }).
local function pane_of(node, name, depth)
  if type(node) ~= "table" or depth > 24 then return nil end
  if node.type == "stack" and node.pane == name then return node end
  if node.type ~= "stack" and node.type ~= "hstack" then return nil end
  for _, child in ipairs(node.children or node) do
    local found = pane_of(child, name, depth + 1)
    if found then return found end
  end
end

-- The tree's list: its first column with a band (stack{ selected, band }).
local function banded(node, depth)
  if type(node) ~= "table" or depth > 24 then return nil end
  if node.type == "stack" and node.band ~= nil then return node end
  if node.type ~= "stack" and node.type ~= "hstack" then return nil end
  for _, child in ipairs(node.children or node) do
    local found = banded(child, depth + 1)
    if found then return found end
  end
end

-- The keys of a focused popup: buffer-local maps on the anchor's buffer,
-- what they replaced put back when it loses the focus.
local function popup_keys(p)
  local keys = {
    ["j"] = function() popup_scroll(p, "line", vim.v.count1) end,
    ["k"] = function() popup_scroll(p, "line", -vim.v.count1) end,
    ["<Down>"] = function() popup_scroll(p, "line", 1) end,
    ["<Up>"] = function() popup_scroll(p, "line", -1) end,
    ["<C-e>"] = function() popup_scroll(p, "line", vim.v.count1) end,
    ["<C-y>"] = function() popup_scroll(p, "line", -vim.v.count1) end,
    ["<C-d>"] = function() popup_scroll(p, "half", 1) end,
    ["<C-u>"] = function() popup_scroll(p, "half", -1) end,
    ["<C-f>"] = function() popup_scroll(p, "page", 1) end,
    ["<C-b>"] = function() popup_scroll(p, "page", -1) end,
    ["<PageDown>"] = function() popup_scroll(p, "page", 1) end,
    ["<PageUp>"] = function() popup_scroll(p, "page", -1) end,
    ["gg"] = function() popup_scroll(p, "top") end,
    ["G"] = function() popup_scroll(p, "bottom") end,
    ["q"] = function() M.popup_close(p.id) end,
    ["<Esc>"] = function() M.popup_close(p.id) end,
    ["y"] = function()
      local text = p.text or table.concat(plain_text(p.component, {}), "\n")
      vim.fn.setreg(vim.v.register, text)
    end,
  }
  for lhs, fn in pairs(p.keys or {}) do
    if type(fn) == "function" then keys[lhs] = function() fn(p.handle) end end
  end
  return keys
end

local function popup_unmap(p)
  if not p.mapped then return end
  for lhs, saved in pairs(p.mapped) do
    pcall(vim.keymap.del, "n", lhs, { buffer = p.buf })
    if saved ~= false and vim.fn.mapset then pcall(vim.fn.mapset, "n", false, saved) end
  end
  p.mapped = nil
end

local function popup_focus(p, on)
  -- A popup on the command line has no buffer to map its keys on.
  if not M._popups[p.id] or p.cmdline or (p.focused == true) == (on ~= false) then return end
  p.focused = on ~= false
  if p.focused then
    if not vim.api.nvim_buf_is_valid(p.buf) then return end
    p.mapped = {}
    for lhs, fn in pairs(popup_keys(p)) do
      local saved = vim.fn.maparg(lhs, "n", false, true)
      p.mapped[lhs] = (type(saved) == "table" and saved.buffer == 1) and saved or false
      vim.keymap.set("n", lhs, fn, { buffer = p.buf, nowait = lhs ~= "gg", silent = true,
        desc = "devhub popup" })
    end
  else
    popup_unmap(p)
  end
  schedule_place()
end

--- gui.popup{ anchor = 'cursor' | { buf, lnum, col } | 'cmdline' | { cmdline = col },
--- placement = 'below' | 'above' | 'auto', component, max_width?, max_height?, min_width? (cells),
--- close_on = { events }, keys = { [lhs] = fn(handle) }, text?, on_close? }: a popup
--- DevHub draws at a buffer position (a hover), with no Neovim window: it
--- follows the position as the window scrolls, flips above when there is no
--- room below, and scrolls inside when taller than it may be. Moving the
--- cursor (close_on) closes it; :focus() gives it the keys — j/k, <C-d>/<C-u>,
--- gg/G scroll, q/<Esc> close, y yanks (text, or the content's text) — until
--- the cursor moves. A node with anchor = true is lined up with the anchor's
--- column. Answers a handle: :update(component), :select(n) (the list's —
--- stack{ selected, band } — selection moved, without the tree),
--- :pane(name, children) (a stack{ pane = name }'s content, alone), :focus(),
--- :scroll(n | 'half' | '-half' | 'page' | '-page' | 'top' | 'bottom', pane?)
--- (a stack{ pane = name } inside, or the popup), :close(), :is_open().
--- anchor = 'cmdline' (or { cmdline = col }, a 0-based byte of the command
--- line's text) puts it against DevHub's command-line box instead: above it
--- (placement 'below': under it) and never over it, its anchored node over
--- that byte's cell; it follows the box and closes with the command line.
--- Nil when no command line is being typed.
-- What devhub.nvim's gui.has_cmdline_popup() asks: this DevHub takes
-- anchor = 'cmdline'.
M.popup_cmdline = true
function M.popup(opts)
  opts = opts or {}
  local win = vim.api.nvim_get_current_win()
  local buf, lnum, col
  local cmdline = opts.anchor == "cmdline"
    or (type(opts.anchor) == "table" and opts.anchor.cmdline ~= nil)
  if cmdline then
    if vim.fn.getcmdtype() == "" then return nil end
    local at = type(opts.anchor) == "table" and tonumber(opts.anchor.cmdline) or 0
    col = math.max(0, math.min(math.floor(at), #vim.fn.getcmdline()))
    win = nil
  elseif type(opts.anchor) == "table" then
    buf = buf_of(opts.anchor.buf or opts.anchor[1])
    lnum = opts.anchor.lnum or opts.anchor[2] or 1
    col = opts.anchor.col or opts.anchor[3] or 0
    if vim.api.nvim_win_get_buf(win) ~= buf then
      win = vim.fn.bufwinid(buf)
      if win == -1 then return nil end
    end
  else
    buf = vim.api.nvim_win_get_buf(win)
    local cursor = vim.api.nvim_win_get_cursor(win)
    lnum, col = cursor[1], cursor[2]
  end
  if not cmdline then
    local count = vim.api.nvim_buf_line_count(buf)
    lnum = math.max(1, math.min(lnum, count))
    local line = vim.api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1] or ""
    col = math.max(0, math.min(col, #line))
  end
  local placement = (opts.placement == "above" or opts.placement == "auto") and opts.placement or "below"
  if cmdline then
    -- As Neovim's own wildmenu: up from the command line.
    placement = opts.placement == "below" and "below" or "above"
  end
  local p = { id = next_id(), buf = buf, win = win, component = opts.component, text = opts.text,
    cmdline = cmdline or nil, col = cmdline and col or nil, placement = placement,
    max_width = type(opts.max_width) == "number" and opts.max_width or nil,
    max_height = type(opts.max_height) == "number" and opts.max_height or nil,
    min_width = type(opts.min_width) == "number" and opts.min_width or nil,
    keys = opts.keys, on_close = opts.on_close }
  -- Left gravity: text put in at the anchor (typing at the cursor, a
  -- completion's preview) goes after it, and the popup stays where it was.
  if not cmdline then
    p.mark = vim.api.nvim_buf_set_extmark(buf, ns, lnum - 1, col, { right_gravity = false })
    p.at = vim.api.nvim_win_get_cursor(win)
  end
  M._popups[p.id] = p
  local handle = { id = p.id, buf = buf, win = win }
  p.handle = handle
  function handle.update(self, component)
    if type(self) ~= "table" or self.id == nil then component = self end
    if M._popups[p.id] ~= p then return end
    p.component = component
    send_popup(p)
    schedule_place()
  end
  -- Only the list's selection moved: its index, not the tree again.
  function handle.select(self, n)
    if type(self) ~= "table" or self.id == nil then n = self end
    if M._popups[p.id] ~= p then return end
    n = type(n) == "number" and math.max(0, math.floor(n)) or 0
    local list = banded(p.component, 0)
    if not list then return end
    list.selected = n > 0 and n or nil
    event("popup_select", { id = p.id, n = n })
  end
  -- Only a pane's content changed: it alone, not the rest of the tree.
  function handle.pane(self, name, children)
    if type(self) ~= "table" or self.id == nil then name, children = self, name end
    if M._popups[p.id] ~= p or type(name) ~= "string" then return end
    local node = pane_of(p.component, name, 0)
    if not node then return end
    if type(children) ~= "table" or children.type ~= nil then children = { children } end
    for i = #node, 1, -1 do node[i] = nil end
    node.children = children
    local actions, hls = M._actions["popup:" .. p.id] or {}, {}
    local list = {}
    for _, child in ipairs(children) do
      local s = serialize(child, actions, hls, 1)
      if s ~= nil then table.insert(list, s) end
    end
    -- only the groups it names: the page keeps the tree's
    local hl = {}
    for group in pairs(hls) do hl[group] = hl_attrs(group) end
    event("popup_pane", { id = p.id, pane = name, children = list, hl = hl })
  end
  function handle.focus() popup_focus(p, true) end
  function handle.unfocus() popup_focus(p, false) end
  function handle.scroll(self, by, pane)
    if type(self) ~= "table" or self.id == nil then by, pane = self, by end
    if M._popups[p.id] ~= p then return end
    if type(by) == "number" then popup_scroll(p, "line", by, pane)
    elseif by == "half" or by == "-half" then popup_scroll(p, "half", by == "half" and 1 or -1, pane)
    elseif by == "page" or by == "-page" then popup_scroll(p, "page", by == "page" and 1 or -1, pane)
    elseif by == "top" or by == "bottom" then popup_scroll(p, by, nil, pane) end
  end
  function handle.close() M.popup_close(p.id) end
  function handle.is_open() return M._popups[p.id] == p end
  p.group = vim.api.nvim_create_augroup("devhub_gui_popup_" .. p.id, { clear = true })
  local events = type(opts.close_on) == "table" and opts.close_on or (cmdline and {} or CLOSE_ON)
  for _, ev in ipairs(events) do
    local buffer_event = ev:match("^Cursor") or ev:match("^Insert") or ev:match("^Buf")
    pcall(vim.api.nvim_create_autocmd, ev, { group = p.group, buffer = buffer_event and buf or nil,
      callback = function()
        -- A CursorMoved still owed for a move before the popup opened is
        -- not a move; the focused popup's own keys move nothing.
        if ev:match("^CursorMoved") and win and vim.api.nvim_get_current_win() == win then
          local now = vim.api.nvim_win_get_cursor(win)
          if now[1] == p.at[1] and now[2] == p.at[2] then return end
        end
        M.popup_close(p.id)
        return true
      end })
  end
  if cmdline then
    vim.api.nvim_create_autocmd("CmdlineLeave", { group = p.group,
      callback = function() M.popup_close(p.id) return true end })
  else
    vim.api.nvim_create_autocmd({ "WinClosed" }, { group = p.group, pattern = tostring(win),
      callback = function() M.popup_close(p.id) return true end })
  end
  send_popup(p)
  schedule_place()
  return handle
end

function M.popup_close(id)
  id = type(id) == "table" and id.id or id
  local p = M._popups[id]
  if not p then return end
  M._popups[id] = nil
  M._actions["popup:" .. id] = nil
  popup_unmap(p)
  pcall(vim.api.nvim_del_augroup_by_id, p.group)
  if p.mark then pcall(vim.api.nvim_buf_del_extmark, p.buf, ns, p.mark) end
  event("popup_clear", { id = id })
  schedule_place()
  if type(p.on_close) == "function" then pcall(p.on_close, p.handle) end
end

--- The popup that a focus_id names (an LSP hover's), still open.
function M.popup_find(pred)
  for _, p in pairs(M._popups) do
    if pred(p.handle) then return p.handle end
  end
end

-- Framed views ---------------------------------------------------------------

local function border_sides(config)
  local border = config.border
  if type(border) ~= "table" or #border == 0 then return 0, 0, 0, 0 end
  local function side(i)
    local c = border[((i - 1) % #border) + 1]
    if type(c) == "table" then c = c[1] end
    return (c ~= nil and c ~= "") and 1 or 0
  end
  return side(2), side(4), side(6), side(8)
end

-- A window's outer rect on the screen (its border included), 0-based, as
-- the page places grids. A hidden float is never drawn, so Neovim does not
-- keep its screen position: a float's is worked out from its config (its
-- anchor, and the window it is relative to), as the compositor would.
local function outer_rect(win, depth)
  if not win or not vim.api.nvim_win_is_valid(win) then return nil end
  local config = vim.api.nvim_win_get_config(win)
  local top, right, bottom, left = border_sides(config)
  local width = vim.api.nvim_win_get_width(win) + left + right
  local height = vim.api.nvim_win_get_height(win) + top + bottom
  local row, col
  if config.relative == "editor" or (config.relative == "win" and (depth or 0) < 8) then
    local base_row, base_col = 0, 0
    if config.relative == "win" then
      local parent = outer_rect(config.win, (depth or 0) + 1)
      if parent then
        local ptop, _, _, pleft = border_sides(vim.api.nvim_win_get_config(config.win))
        base_row, base_col = parent.row + ptop, parent.col + pleft
      end
    end
    row = base_row + math.floor((config.row or 0) + 0.5)
    col = base_col + math.floor((config.col or 0) + 0.5)
    local anchor = config.anchor or "NW"
    if anchor:sub(1, 1) == "S" then row = row - height end
    if anchor:sub(2, 2) == "E" then col = col - width end
  else
    local ok, pos = pcall(vim.api.nvim_win_get_position, win)
    if not ok then return nil end
    row, col = pos[1], pos[2]
  end
  return { row = row, col = col, width = width, height = height, top = top,
    hidden = config.hide == true }
end
M._outer_rect = outer_rect

-- Where a framed view's windows stand, for the page.
local function place_frame(view, current)
  local f = view.frame
  if not vim.api.nvim_win_is_valid(f.win) then return nil end
  if vim.api.nvim_win_get_tabpage(f.win) ~= vim.api.nvim_get_current_tabpage() then return nil end
  local list_win
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == view.buf and win ~= f.win then list_win = win break end
  end
  if not list_win then return nil end
  -- Its windows: the page draws their chrome, the painter only their cells.
  local entry = { id = view.id, win = f.win, frame = outer_rect(f.win),
    wins = vim.tbl_filter(function(w) return w ~= nil end, { f.win, list_win, f.query_win, f.preview_win }) }
  local list = outer_rect(list_win)
  list.cursor = vim.api.nvim_win_get_cursor(list_win)[1]
  list.current = current == list_win
  entry.list = list
  if f.query_win and vim.api.nvim_win_is_valid(f.query_win) then
    local q = outer_rect(f.query_win)
    local qbuf = vim.api.nvim_win_get_buf(f.query_win)
    q.text = vim.api.nvim_buf_get_lines(qbuf, 0, 1, false)[1] or ""
    q.caret = vim.api.nvim_win_get_cursor(f.query_win)[2]
    q.current = current == f.query_win
    q.insert = q.current and vim.fn.mode():sub(1, 1) == "i"
    entry.query = q
  end
  if f.preview_win and vim.api.nvim_win_is_valid(f.preview_win) then
    local pv = outer_rect(f.preview_win)
    if pv and not pv.hidden then
      pv.win = f.preview_win
      entry.preview = pv
    end
  end
  return entry
end

local function call(fn, ...)
  local ok, err = pcall(fn, ...)
  if not ok then vim.notify("devhub gui: " .. tostring(err), vim.log.levels.ERROR) end
end

--- The page: a click on a framed view's row (clicks: 1, or 2 for a double
--- click). The keys stay where they are (the query): the view's on_click
--- runs, or the list window's cursor goes to the row.
function M._frame_click(id, line, clicks)
  local view = M._views[id]
  if not view or not view.frame then return end
  if type(view.on_click) == "function" then
    call(view.on_click, line, clicks or 1)
  else
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if vim.api.nvim_win_get_buf(win) == view.buf and win ~= view.frame.win then
        pcall(vim.api.nvim_win_set_cursor, win, { line, 0 })
      end
    end
    schedule_place()
  end
end

--- The page: a node with an on_click in a frame's header (a toggle).
function M._frame_action(id, action)
  local fn = (M._actions["view:" .. id] or {})[action]
  if type(fn) == "function" then call(fn) end
end

--- The page: the wheel over a view that takes it (on_scroll), in items.
function M._view_scroll(id, rows)
  local view = M._views[id]
  if view and type(view.on_scroll) == "function" and type(rows) == "number" then call(view.on_scroll, rows) end
end

--- The page: how many items a framed view shows at once.
function M._view_rows(id, rows)
  local view = M._views[id]
  if not view or type(rows) ~= "number" or rows < 1 or view.rows == rows then return end
  view.rows = rows
  if type(view.on_rows) == "function" then call(view.on_rows, rows) end
end

-- Placement ------------------------------------------------------------------

local function tab_windows(buf)
  local out = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == buf then table.insert(out, win) end
  end
  return out
end

local line_rows = M._line_rows

function M._place_layers()
  M._drawn()
  local views, inlines, measure, popups = {}, {}, {}, {}
  local current = vim.api.nvim_get_current_win()
  local frames = {}
  for id, view in pairs(M._views) do
    if not vim.api.nvim_buf_is_valid(view.buf) then
      M.view_clear(id)
    elseif view.frame then
      if not vim.api.nvim_win_is_valid(view.frame.win) then
        M.view_clear(id)
      else
        local entry = place_frame(view, current)
        if entry then table.insert(frames, entry) end
      end
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
          if last and not folded then
            -- Its rows under the line, from the window's top (beyond it
            -- too); the page cuts it to the window.
            shown = true
            local cursor = vim.api.nvim_win_get_cursor(win)[1]
            local range = card.range or { lnum, lnum }
            local before = M._rows_before(card.buf, ns, card.mark, lnum)
            table.insert(inlines, { id = id, win = win, row = last + 1 + before, col = info.textoff,
              width = width, rows = card.rows,
              active = card.focus == true or (win == current and cursor >= range[1] and cursor <= (range[2] or range[1])) })
          elseif not shown and #measure < 64 then
            table.insert(measure, { id = id, width = width, full = card.rows })
            shown = true
          end
        end
      end
    end
  end
  local tab = vim.api.nvim_get_current_tabpage()
  local typing = vim.fn.getcmdtype() ~= ""
  for id, p in pairs(M._popups) do
    local ok, pos
    if not p.cmdline then
      ok, pos = pcall(vim.api.nvim_buf_get_extmark_by_id, p.buf, ns, p.mark, {})
    end
    if p.cmdline then
      -- Against the command line's box: the page knows where it is.
      if typing then
        table.insert(popups, { id = id, cmdline = p.col, focused = false })
      else
        M.popup_close(id)
      end
    elseif not ok or not pos[1] or not vim.api.nvim_win_is_valid(p.win) then
      M.popup_close(id)
    elseif vim.api.nvim_win_get_tabpage(p.win) == tab and vim.api.nvim_win_get_buf(p.win) == p.buf then
      local info = vim.fn.getwininfo(p.win)[1]
      local sp = vim.fn.screenpos(p.win, pos[1] + 1, pos[2] + 1)
      if info and sp.row > 0 then
        -- The anchor's cell, from the window's top-left.
        table.insert(popups, { id = id, win = p.win, row = sp.row - info.winrow,
          col = sp.col - info.wincol, focused = p.focused == true })
      end
    end
  end
  event("layers", { views = views, inlines = inlines, measure = measure, popups = popups,
    frames = frames })
end

--- A click on the page: the cursor goes to the item (or the card's line) in
--- that window, then the node's on_click (or the view's) runs.
function M._layers_click(kind, id, win, line, action)
  local owner = kind == "view" and M._views[id] or kind == "popup" and M._popups[id] or M._inlines[id]
  if not owner then return end
  if kind ~= "popup" and win and vim.api.nvim_win_is_valid(win) then
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
  for _, p in pairs(M._popups) do send_popup(p) end
  schedule_place()
end

local base_replay = M._replay
function M._replay()
  M._layers_replay()
  base_replay()
end

vim.api.nvim_create_autocmd({ "WinScrolled", "WinResized", "WinClosed", "WinNew", "WinEnter", "BufWinEnter",
  "TabEnter", "VimResized", "TextChanged", "TextChangedI", "CursorMoved", "CursorMovedI", "ModeChanged" }, {
  group = group,
  callback = function()
    if next(M._views) == nil and next(M._inlines) == nil
      and next(M._popups) == nil then return end
    schedule_place()
  end,
})
-- New colours: every tree again, with its groups resolved again.
vim.api.nvim_create_autocmd("ColorScheme", {
  group = group,
  callback = function() vim.schedule(M._layers_replay) end,
})
`;
