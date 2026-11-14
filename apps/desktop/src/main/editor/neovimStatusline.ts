/**
 * Each window's footer, drawn by DevHub in the status line row Neovim keeps
 * for it (`docs/neovim-editor.md`, "Status lines"). Run on the server after
 * `LAYERS_LUA` at every attach, in the same `devhub_gui` module.
 *
 * DevHub does not paint grid 1, the cells Neovim draws round its windows;
 * this decides, window by window, what is drawn in each status line row
 * instead:
 *
 * 1. the config registered `gui.statusline(fn)` and `fn(win, ctx)` answers
 *    a component tree: that tree;
 * 2. else a plugin gave the window's buffer a footer of its own
 *    (`gui.footer(buf, footer)`: a view that draws its window natively, as
 *    devhub.nvim's quickfix window): that tree, or an empty footer;
 * 3. else the window has a `statusline` of its own (window-local: the
 *    quickfix ftplugin's, a person's, a window picker's hints): Neovim's
 *    cells of that row, as Neovim drew them;
 * 4. else the global `statusline` is Neovim's default (empty, or the
 *    option's default value — 0.12's is an expression): DevHub's default
 *    footer, a tree built here;
 * 5. else (a person's or a plugin's global `statusline`): Neovim's cells,
 *    unless the config chose the default footer (`gui.statusline('default')`
 *    or `vim.g.devhub_statusline = 'default'`).
 *
 * What changes at every key — the cursor's line and column, the mode, the
 * pending command — is a slot in the tree (`{ type = 'slot' }`), filled by
 * the page from Neovim's own redraw (`win_viewport`, `mode_change`,
 * `msg_showcmd`): no Lua and no message per key. The trees are made again
 * on buffer, window, modified, diagnostic, option and colorscheme events,
 * at most once per turn of the event loop, and a window's is sent only
 * when it changed. Neovim's layout is untouched: `laststatus` is the
 * person's, the rows are Neovim's, and a click that no node takes is
 * Neovim's (grid 1's cells: a drag resizes, a click moves to the window).
 */
export const STATUSLINE_LUA = String.raw`
local M = package.loaded["devhub_gui"]
local event = M._event
local serialize, hl_table = M._serialize, M._hl_table
local S = M._statusline or {}
M._statusline = S
S.sent, S.meta, S.pending = {}, nil, false
local group = vim.api.nvim_create_augroup("devhub_gui_statusline", { clear = true })
local extra = vim.api.nvim_create_augroup("devhub_gui_statusline_extra", { clear = true })

-- DevHub's Nerd Symbols (the page's font has them whatever guifont is).
local ICON = { error = "\u{f057}", warn = "\u{f071}", branch = "\u{e725}", lock = "\u{f023}" }
-- Groups every footer's tree is drawn with: its ground (StatusLine,
-- StatusLineNC), its hairline (WinSeparator), its words.
local GROUNDS = { StatusLine = true, StatusLineNC = true, WinSeparator = true, Normal = true, Comment = true }

local function text(s, hl, opts)
  local node = { type = "text", text = s, hl = hl, ink = true }
  for k, v in pairs(opts or {}) do node[k] = v end
  return node
end

-- The branch of the repository a path is in, from its HEAD (a worktree's
-- too): a file read, no git started.
local function branch_of(path)
  local ok, root = pcall(vim.fs.root, path, ".git")
  if not ok or not root then return nil end
  local dotgit = root .. "/.git"
  local head = dotgit .. "/HEAD"
  local stat = vim.uv.fs_stat(dotgit)
  if stat and stat.type == "file" then
    local f = io.open(dotgit)
    if not f then return nil end
    local line = f:read("*l") or ""
    f:close()
    local dir = line:match("^gitdir:%s*(.-)%s*$")
    if not dir then return nil end
    if dir:sub(1, 1) ~= "/" then dir = root .. "/" .. dir end
    head = dir .. "/HEAD"
  end
  local f = io.open(head)
  if not f then return nil end
  local line = f:read("*l")
  f:close()
  if not line then return nil end
  return line:match("^ref: refs/heads/(.+)$") or line:sub(1, 7)
end
M._branch_of = branch_of

--- DevHub's footer: where the file is and what state it is in at the left
--- (a dim path, the name, the modified dot, a lock); its diagnostics at the
--- right, and for the current window where the cursor is, the filetype and
--- the branch. The mode only when nothing else shows it (noshowmode, or
--- cmdheight=0).
function M.statusline_default(win, current)
  local buf = vim.api.nvim_win_get_buf(win)
  local name = vim.api.nvim_buf_get_name(buf)
  local bo = vim.bo[buf]
  local ink = current and "Normal" or "Comment"
  local left = {}
  if current and (not vim.o.showmode or vim.o.cmdheight == 0) then
    table.insert(left, { type = "slot", slot = "mode", hl = "Comment", ink = true })
    table.insert(left, { type = "spacer", size = 8 })
  end
  if bo.buftype == "help" then
    table.insert(left, text("Help  ", "Comment"))
    table.insert(left, text(vim.fn.fnamemodify(name, ":t"), ink, { bold = true }))
  elseif bo.buftype == "terminal" then
    table.insert(left, text(vim.b[buf].term_title or vim.fn.fnamemodify(name, ":t"), ink, { bold = true }))
  elseif name == "" then
    table.insert(left, text("[No Name]", ink, { bold = true }))
  else
    local rel = vim.fn.fnamemodify(name, ":~:.")
    local dir = rel:match("^(.*/)")
    if dir then table.insert(left, text(dir, "Comment")) end
    table.insert(left, text(vim.fn.fnamemodify(name, ":t"), ink, { bold = true }))
  end
  if bo.modified then table.insert(left, text(" ●", ink)) end
  if bo.buftype ~= "help" and (bo.readonly or not bo.modifiable) then
    table.insert(left, { type = "spacer", size = 6 })
    table.insert(left, { type = "icon", glyph = ICON.lock, hl = "Comment" })
  end
  local right = {}
  local counts = vim.diagnostic.count(buf)
  local errors, warns = counts[vim.diagnostic.severity.ERROR], counts[vim.diagnostic.severity.WARN]
  if errors or warns then
    local d = { type = "hstack", gap = 10, children = {} }
    for _, it in ipairs({ { errors, ICON.error, "DiagnosticError" }, { warns, ICON.warn, "DiagnosticWarn" } }) do
      if it[1] then
        table.insert(d.children, { type = "hstack", gap = 4, children = {
          { type = "icon", glyph = it[2], hl = it[3] },
          text(tostring(it[1]), current and it[3] or "Comment"),
        } })
      end
    end
    table.insert(right, d)
  end
  if current then
    table.insert(right, { type = "slot", slot = "position", format = "Ln %l, Col %c", hl = "Comment", ink = true })
    if bo.filetype ~= "" and bo.buftype ~= "help" then table.insert(right, text(bo.filetype, "Comment")) end
    local b = bo.buftype ~= "help" and branch_of(name ~= "" and name or vim.fn.getcwd()) or nil
    if b then
      table.insert(right, { type = "hstack", gap = 4, children = {
        { type = "icon", glyph = ICON.branch, hl = "Comment" }, text(b, "Comment") } })
    end
  end
  return { type = "hstack", align = "center", pad = { 0, 10 }, children = {
    { type = "hstack", gap = 0, grow = true, children = left },
    { type = "hstack", gap = 12, children = right },
  } }
end

-- Neovim's own statusline: none, or its default (0.12's is an expression).
local function default_statusline()
  local value = vim.go.statusline
  if value == "" then return true end
  local ok, info = pcall(vim.api.nvim_get_option_info2, "statusline", {})
  return ok and type(info) == "table" and info.default == value
end
M._default_statusline = default_statusline

-- A window's own statusline. One that is the global value again (a window
-- picker puts back what it read, as a local value) says nothing of its own.
local function local_statusline(win)
  local ok, value = pcall(vim.api.nvim_get_option_value, "statusline", { win = win, scope = "local" })
  if not ok or value == "" or value == vim.go.statusline then return nil end
  return value
end

--- What window win's row shows, by the rules (the module's comment):
--- { kind = 'tree', node, default = bool } or { kind = 'cells' }.
function M._statusline_entry(win, current)
  local lstl = local_statusline(win)
  if type(S.fn) == "function" then
    local ctx = { current = current, laststatus = vim.o.laststatus, width = vim.api.nvim_win_get_width(win),
      local_statusline = lstl, default = function() return M.statusline_default(win, current) end }
    local ok, node = pcall(S.fn, win, ctx)
    if not ok then
      if not S.failed then
        S.failed = true
        vim.notify("devhub gui.statusline: " .. tostring(node), vim.log.levels.ERROR)
      end
    elseif node == false then
      return { kind = "tree", node = { type = "hstack", children = {} } }
    elseif type(node) == "table" or type(node) == "string" then
      return { kind = "tree", node = node }
    end
  end
  local claim = S.claims and S.claims[vim.api.nvim_win_get_buf(win)]
  if claim ~= nil then
    local node = claim
    if type(claim) == "function" then
      local ok, value = pcall(claim, win, current)
      node = ok and value or nil
    end
    if node == false then
      return { kind = "tree", node = { type = "hstack", children = {} } }
    elseif type(node) == "table" or type(node) == "string" then
      return { kind = "tree", node = node }
    end
  end
  if lstl then return { kind = "cells" } end
  local choice = S.choice or vim.g.devhub_statusline
  if choice == "cells" then return { kind = "cells" } end
  if choice == "default" or default_statusline() then
    return { kind = "tree", node = M.statusline_default(win, current), default = true }
  end
  return { kind = "cells" }
end

-- The windows a status line row is kept for, and the current one.
local function windows()
  local ls, cur = vim.o.laststatus, vim.api.nvim_get_current_win()
  if ls == 0 then return {}, cur end
  if ls == 3 then return { cur }, cur end
  local list = {}
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(w).relative == "" then table.insert(list, w) end
  end
  if ls == 1 and #list < 2 then return {}, cur end
  return list, cur
end

local function payload(win, current)
  local entry = M._statusline_entry(win, current)
  if entry.kind ~= "tree" then
    M._actions["statusline:" .. win] = nil
    return { kind = "cells" }
  end
  local actions, hls = {}, {}
  for name in pairs(GROUNDS) do hls[name] = true end
  local node = serialize(entry.node, actions, hls, 0)
  M._actions["statusline:" .. win] = actions
  if node == nil then return { kind = "cells" } end
  return { kind = "tree", node = node, hl = hl_table(hls), edge = entry.default == true }
end

--- Every footer made again, and those that changed sent (one event).
function M._statusline_send()
  S.pending = false
  local list, cur = windows()
  local changed, keep, seen = {}, {}, {}
  for _, win in ipairs(list) do
    local ok, entry = pcall(payload, win, win == cur)
    if not ok then entry = { kind = "cells" } end
    local key = vim.json.encode(entry)
    seen[win] = true
    table.insert(keep, win)
    if S.sent[win] ~= key then
      S.sent[win] = key
      changed[tostring(win)] = entry
    end
  end
  for win in pairs(S.sent) do
    if not seen[win] then
      S.sent[win] = nil
      M._actions["statusline:" .. win] = nil
    end
  end
  local meta = tostring(vim.o.laststatus) .. ":" .. tostring(cur) .. ":" .. table.concat(keep, ",")
  if next(changed) == nil and meta == S.meta then return end
  S.meta = meta
  S.sends = (S.sends or 0) + 1
  -- flush: made in the redraw that is about to be flushed (below), so the
  -- page draws it with that flush and not a frame before.
  event("statusline", { laststatus = vim.o.laststatus, current = cur, wins = changed, keep = keep,
    flush = S.in_redraw or nil })
end

--- The footers go with the redraw that shows what changed them. A change
--- (a buffer entered, a window split) marks them pending; Neovim then
--- redraws, and at the start of that redraw — before it flushes the new
--- grid lines on this same channel — they are made and sent: the page has
--- them before the flush, and draws both in one frame. A scheduled send
--- runs after the flush (Neovim flushes before it waits for input, and
--- runs scheduled callbacks while it waits), so a file opened showed its
--- text under the last file's name for a frame. A scheduled callback can
--- also run before the redraw (an open by RPC: devhub <file>), and a
--- tree sent then, unmarked, was drawn as soon as it came, over the last
--- file's text. So the scheduled send redraws first: the redraw's start
--- sends it, marked, with the flush that follows; only a change that
--- leaves nothing to redraw is sent here, unmarked.
local function send_pending()
  if not S.pending then return end
  pcall(vim.cmd, "redraw")
  if S.pending then M._statusline_send() end
end

local function schedule()
  if S.pending then return end
  S.pending = true
  vim.schedule(send_pending)
end
M._statusline_schedule = schedule

vim.api.nvim_set_decoration_provider(vim.api.nvim_create_namespace("devhub_gui_statusline"), {
  on_start = function()
    if S.pending then
      S.in_redraw = true
      pcall(M._statusline_send)
      S.in_redraw = false
    end
    return false
  end,
})

local EVENTS = { "BufEnter", "BufWinEnter", "BufFilePost", "BufWritePost", "BufModifiedSet", "FileType",
  "WinEnter", "WinLeave", "WinNew", "WinClosed", "WinResized", "TabEnter", "VimResized", "DiagnosticChanged",
  "DirChanged", "LspAttach", "LspDetach", "FocusGained" }
vim.api.nvim_create_autocmd(EVENTS, { group = group, callback = function() schedule() end })
vim.api.nvim_create_autocmd("OptionSet", { group = group,
  pattern = { "readonly", "modifiable", "filetype", "buftype", "statusline", "laststatus", "showmode", "cmdheight" },
  callback = function() schedule() end })
-- New colours: every tree again (their groups resolved again).
vim.api.nvim_create_autocmd("ColorScheme", { group = group, callback = function()
  S.sent, S.meta = {}, nil
  schedule()
end })

--- gui.statusline(fn, { events }): fn(win, ctx) answers a component tree
--- (drawn in win's status line row), nil (the rules: a window's own
--- statusline is Neovim's cells, Neovim's default statusline DevHub's
--- default footer, a global one cells) or false (an empty footer).
--- ctx = { current, laststatus, width, local_statusline, default() }.
--- gui.statusline('default') or ('cells') chooses without a function;
--- gui.statusline(nil) lets go. events: autocmds that make it again too.
function M.statusline(fn, opts)
  S.fn, S.choice, S.failed = nil, nil, false
  if type(fn) == "function" then
    S.fn = fn
  elseif fn == "default" or fn == "cells" then
    S.choice = fn
  end
  vim.api.nvim_clear_autocmds({ group = extra })
  local events = type(opts) == "table" and opts.events or nil
  if type(events) == "table" and #events > 0 then
    pcall(vim.api.nvim_create_autocmd, events, { group = extra, callback = function() schedule() end })
  end
  S.sent, S.meta = {}, nil
  schedule()
end

--- gui.footer(buf, footer): the footer of every window showing buf, over
--- the window's own statusline (rule 2): a component tree, false (an empty
--- footer), or fn(win, current) answering either (nil: the rules). nil lets
--- go, and the rules (the window's own statusline's cells) are back. Gone
--- with the buffer. A footer the config's gui.statusline fn answers wins.
function M.statusline_buffer(buf, footer)
  if buf == nil or buf == 0 then buf = vim.api.nvim_get_current_buf() end
  S.claims = S.claims or {}
  S.claims[buf] = footer
  if footer ~= nil then
    vim.api.nvim_create_autocmd("BufWipeout", { group = group, buffer = buf, once = true,
      callback = function() if S.claims then S.claims[buf] = nil end end })
  end
  schedule()
end

--- Make the footers again now (a plugin's state changed).
function M.statusline_refresh()
  schedule()
end

--- The page: a node with an on_click in win's footer.
function M._statusline_click(win, action)
  local fn = (M._actions["statusline:" .. tostring(win)] or {})[action]
  if type(fn) ~= "function" then return end
  local ok, err = pcall(fn, win)
  if not ok then vim.notify("devhub gui: " .. tostring(err), vim.log.levels.ERROR) end
end

local base_replay = M._replay
function M._replay()
  S.sent, S.meta = {}, nil
  schedule()
  base_replay()
end
schedule()
`;
