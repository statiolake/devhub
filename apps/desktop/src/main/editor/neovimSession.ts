/**
 * DevHub's own windows and a Neovim session (`:mksession`, `:restart`,
 * a session plugin's save).
 *
 * A GUI window (`gui.webview`, `filetype=devhub_gui`, named
 * `devhub://<title>/<id>`) and the pager (`filetype=devhub_pager`) are
 * scratch buffers whose content is DevHub's, told to the page by the
 * Neovim it was opened in. A session cannot carry that: with `blank` in
 * 'sessionoptions' (a common setting) `:mksession` saves such a window as
 * an empty one, so `:restart` brought back a dead window — no page in it,
 * squeezed to a few columns by the restore — and, when it was current at
 * the restart (an Outline opened by `:DevhubGuiDemo` keeps the cursor),
 * left the cursor in it.
 *
 * So, after a session is written (`SessionWritePost`), DevHub appends to
 * it what to do once it has been sourced: close the windows that were
 * DevHub's, and if the current one was, make current the window the
 * person was editing in before it (`wincmd p`), else the tab's first one
 * kept. Windows are named by their place among the windows the session
 * saves (`ses_do_win` in Neovim's `ex_session.c`, followed here), checked
 * against the count it restored; a session that does not match is left
 * alone. Neovim has no `SessionWritePre`, so the session itself is not
 * changed while it is written: the live windows stay as they are.
 *
 * At every attach, too, a window showing a `devhub://` buffer with no GUI
 * window behind it (no `b:devhub_gui_id`: one a session restored before
 * this, or sourced by hand) is closed the same way. *
 * The windows' sizes are DevHub's to keep through an attach, too: the
 * priming attach at half the size (`NeovimUi.attach`) and the attach after
 * it give every new row and column to the last window, so each tab's sizes
 * are saved before (`LAYOUT_SAVE_LUA`) and put back, scaled, after
 * (`LAYOUT_RESTORE_LUA`). A Neovim's first UI has no priming attach (it is
 * attached once, at its size: `firstAttach`, `neovimUi.ts`). `:restart` sources
 * its session once a UI is attached, so a session's sizes are saved
 * again when it has loaded and put back at the resize that follows; so are
 * a Neovim's still starting when DevHub attaches (two files split by `-o`: its
 * socket is there before its windows), at `VimEnter`.
 */

/**
 * Each tab's window sizes, as `winrestcmd()` gives them in that tab: a
 * list of `{ window, command, windows }`, the window one of the tab's own
 * (not a float) and `windows` all of them, in order, for
 * `LAYOUT_RESTORE_LUA` — with the rows and columns they shared then
 * (`lines` less `cmdheight`, `columns`).
 */
export const LAYOUT_SAVE_LUA = `
local saved = {}
for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
  local wins = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    if vim.api.nvim_win_get_config(win).relative == "" then table.insert(wins, win) end
  end
  if wins[1] then
    local cmd = vim.api.nvim_win_call(wins[1], vim.fn.winrestcmd)
    table.insert(saved, { wins[1], cmd, wins })
  end
end
return { rows = vim.o.lines - vim.o.cmdheight, cols = vim.o.columns, tabs = saved }
`;

/**
 * `LAYOUT_SAVE_LUA`'s sizes put back, each tab's in that tab. Twice, as
 * `:help winrestcmd()` asks: a window grown first can hold back the next.
 *
 * The sizes are scaled to the rows and columns there are now: they were
 * taken at the size Neovim had before this attach — the previous page's, or
 * the 80x24 an `--embed` Neovim starts at before any UI — and `:resize`
 * gives what a window lets go of to the command line when no window is
 * below it to take it. A 21-row window put back in a 48-row grid made
 * `cmdheight` 26: the command line in the middle of the pane. For the same
 * reason the person's `cmdheight` is put back after, whatever rounding
 * left over (`_keep_cmdheight`, `neovimMessages.ts`).
 *
 * A tab whose windows are no longer the ones saved is left as it is: its
 * sizes would land on other windows. After `:restart` the new server is
 * attached to while it may still be restoring its session: the sizes saved
 * were of its one first window, and put back they gave it every column but
 * one, the session's other windows one each.
 */
export const LAYOUT_RESTORE_LUA = `
local layout = ...
local function scaled(cmd)
  local rows = math.max(1, vim.o.lines - vim.o.cmdheight)
  local ry = rows / math.max(1, layout.rows or rows)
  local rx = vim.o.columns / math.max(1, layout.cols or vim.o.columns)
  local parts = {}
  for part in cmd:gmatch("[^|]+") do
    local vert = part:sub(1, 5) == "vert "
    local nr, size = part:match("^%D*(%d+)resize (%d+)$")
    if nr then
      -- A window's frame is scaled, its status line or separator (the
      -- cell after it) left one cell: they do not grow with the grid.
      local n = math.max(1, math.floor((tonumber(size) + 1) * (vert and rx or ry) - 1 + 0.5))
      part = ("%s%sresize %d"):format(vert and "vert " or "", nr, n)
    end
    table.insert(parts, part)
  end
  return table.concat(parts, "|")
end
local M = package.loaded["devhub_gui"]
-- What :resize does to cmdheight is not the person's (an OptionSet for it).
if M then M._holding = true end
local function same(tab, wins)
  local now = {}
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    if vim.api.nvim_win_get_config(w).relative == "" then table.insert(now, w) end
  end
  if #now ~= #(wins or {}) then return false end
  for i, w in ipairs(now) do
    if wins[i] ~= w then return false end
  end
  return true
end
for _, entry in ipairs(layout.tabs or {}) do
  local win, cmd = entry[1], entry[2]
  if vim.api.nvim_win_is_valid(win) and same(vim.api.nvim_win_get_tabpage(win), entry[3]) then
    pcall(vim.api.nvim_win_call, win, function()
      cmd = scaled(cmd)
      vim.cmd(cmd)
      vim.cmd(cmd)
    end)
  end
end
if M and M._keep_cmdheight then M._keep_cmdheight() end
`;

/** A window closed, its room to the windows beside it (Lua). */
const CLOSE_KEEPING_SIZES_LUA = `
-- Closed without 'equalalways' evening out the others: its room goes to
-- the windows beside it, as when the person closes a window with it off.
-- ('equalalways' itself is not touched: turning it on again evens them.)
local function close_keeping_sizes(win)
  local function parent(node, kind)
    if node[1] == "leaf" then return node[2] == win and kind or nil end
    for _, child in ipairs(node[2]) do
      local found = parent(child, node[1])
      if found ~= nil then return found end
    end
    return nil
  end
  local tabnr = vim.api.nvim_tabpage_get_number(vim.api.nvim_win_get_tabpage(win))
  local kind = parent(vim.fn.winlayout(tabnr), "leaf")
  local ead = vim.o.eadirection
  if kind == "row" then vim.o.eadirection = "ver" elseif kind == "col" then vim.o.eadirection = "hor" end
  pcall(vim.api.nvim_win_close, win, true)
  vim.o.eadirection = ead
end
`;

/** Run at every attach, after `SETUP_LUA` (`NeovimUi.attach`). */
export const SESSION_LUA = String.raw`
local M = package.loaded["devhub_gui"] or {}
package.loaded["devhub_gui"] = M
local api = vim.api

--- Whether a window is DevHub's own: a GUI window, or the pager.
local function devhub_window(win)
  local buf = api.nvim_win_get_buf(win)
  if pcall(api.nvim_buf_get_var, buf, "devhub_gui_id") then return true end
  local ft = vim.bo[buf].filetype
  return ft == "devhub_gui" or ft == "devhub_pager"
end

--- Whether ':mksession' saves a window (Neovim's ses_do_win).
local function saved(win, ssop)
  if api.nvim_win_get_config(win).relative ~= "" then return false end
  local buf = api.nvim_win_get_buf(win)
  local bt = vim.bo[buf].buftype
  if bt == "terminal" then return ssop.terminal == true end
  if api.nvim_buf_get_name(buf) == "" or bt == "nofile" or bt == "prompt" then
    return ssop.blank == true
  end
  if bt == "help" then return ssop.help == true end
  return true
end

--- What the session just written is to do once sourced: per tab page it
--- saved, how many windows and their sizes, which were DevHub's, and the
--- one to be current; and the size of the screen they shared.
function M._session_spec()
  local ssop = {}
  for _, flag in ipairs(vim.opt.sessionoptions:get()) do ssop[flag] = true end
  local tabs = ssop.tabpages and api.nvim_list_tabpages() or { api.nvim_get_current_tabpage() }
  local current = api.nvim_get_current_win()
  local spec = { tabs = {}, columns = vim.o.columns, lines = vim.o.lines }
  for _, tab in ipairs(tabs) do
    local wins = {}
    for _, win in ipairs(api.nvim_tabpage_list_wins(tab)) do
      if saved(win, ssop) then table.insert(wins, win) end
    end
    local entry = { count = #wins, gui = {}, sizes = {} }
    local index, kept = {}, nil
    for i, win in ipairs(wins) do
      index[win] = i
      entry.sizes[i] = { api.nvim_win_get_width(win), api.nvim_win_get_height(win) }
      if devhub_window(win) then
        table.insert(entry.gui, i)
      elseif kept == nil then
        kept = i
      end
    end
    if tab == api.nvim_get_current_tabpage() and index[current] and devhub_window(current) then
      local prev = vim.fn.win_getid(vim.fn.winnr("#"))
      if index[prev] and not devhub_window(prev) then entry.target = index[prev] else entry.target = kept end
    end
    table.insert(spec.tabs, entry)
  end
  return spec
end

--- Run where the session is sourced (a new server, DevHub not yet there).
M._session_restore = [==[
local spec = vim.json.decode(DEVHUB_SPEC)
local api = vim.api
local tabs = api.nvim_list_tabpages()
if #tabs ~= #spec.tabs then return end
local function wins(tab)
  local out = {}
  for _, win in ipairs(api.nvim_tabpage_list_wins(tab)) do
    if api.nvim_win_get_config(win).relative == "" then table.insert(out, win) end
  end
  return out
end
for i, entry in ipairs(spec.tabs) do
  if #wins(tabs[i]) ~= entry.count then return end
end
local close = {}
for i, entry in ipairs(spec.tabs) do
  local ws = wins(tabs[i])
  if entry.target and ws[entry.target] then pcall(api.nvim_set_current_win, ws[entry.target]) end
  for _, n in ipairs(entry.gui) do table.insert(close, ws[n]) end
end
-- Each window's size when the session was written; one that takes a
-- closed window's room takes its size too, and its line.
local exact = {}
for i, entry in ipairs(spec.tabs) do
  for n, win in ipairs(wins(tabs[i])) do exact[win] = entry.sizes[n] end
end
${CLOSE_KEEPING_SIZES_LUA}for _, win in ipairs(close) do
  if api.nvim_win_is_valid(win) and #wins(api.nvim_win_get_tabpage(win)) > 1 then
    local was = {}
    for _, w in ipairs(wins(api.nvim_win_get_tabpage(win))) do
      was[w] = { api.nvim_win_get_width(w), api.nvim_win_get_height(w) }
    end
    close_keeping_sizes(win)
    local gone = exact[win] or { 0, 0 }
    exact[win] = nil
    for w, size in pairs(was) do
      if w ~= win and api.nvim_win_is_valid(w) and exact[w] then
        if api.nvim_win_get_width(w) ~= size[1] then exact[w][1] = exact[w][1] + gone[1] + 1 end
        if api.nvim_win_get_height(w) ~= size[2] then exact[w][2] = exact[w][2] + gone[2] + 1 end
      end
    end
  end
end
-- For DevHub, if it is attaching (the sizes above are for its screen).
_G.__devhub_session_sizes = { columns = spec.columns, lines = spec.lines, wins = exact }
]==]

local group = api.nvim_create_augroup("devhub_gui_session", { clear = true })
api.nvim_create_autocmd("SessionWritePost", {
  group = group,
  callback = function()
    local file = vim.v.this_session
    if file == nil or file == "" then return end
    local ok, spec = pcall(M._session_spec)
    if not ok or spec == nil then return end
    local json = vim.json.encode(spec)
    local lines = {
      '" DevHub: its own windows (a GUI window, the pager) are not the session' .. "'s.",
      "lua << DEVHUB_EOF",
      "local DEVHUB_SPEC = [==[" .. json .. "]==]",
    }
    vim.list_extend(lines, vim.split(M._session_restore, "\n", { plain = true }))
    table.insert(lines, "DEVHUB_EOF")
    pcall(vim.fn.writefile, lines, file, "a")
  end,
})

${CLOSE_KEEPING_SIZES_LUA}
--- A devhub:// window with no GUI window behind it (a session's, restored
--- before DevHub was there) closed; the cursor, if it was in one, back where
--- the person was.
function M._close_husks()
  local husks = {}
  for _, win in ipairs(api.nvim_list_wins()) do
    local buf = api.nvim_win_get_buf(win)
    if api.nvim_buf_get_name(buf):match("^devhub://")
      and not pcall(api.nvim_buf_get_var, buf, "devhub_gui_id") then
      husks[win] = true
    end
  end
  if next(husks) == nil then return end
  local current = api.nvim_get_current_win()
  if husks[current] then
    local prev = vim.fn.win_getid(vim.fn.winnr("#"))
    if prev ~= 0 and not husks[prev] then
      api.nvim_set_current_win(prev)
    else
      for _, win in ipairs(api.nvim_tabpage_list_wins(0)) do
        if not husks[win] and api.nvim_win_get_config(win).relative == "" then
          api.nvim_set_current_win(win)
          break
        end
      end
    end
  end
  for win in pairs(husks) do
    local tab = api.nvim_win_get_tabpage(win)
    if #api.nvim_tabpage_list_wins(tab) > 1 then close_keeping_sizes(win) end
  end
end
pcall(M._close_husks)

-- A session sourced while a UI is still attaching (':restart' runs its
-- restore once the first UI is there, at whatever size that UI had) sets
-- its windows' sizes for that size; the real attach then gives
-- every new column and row to the last window. Its sizes are kept here and
-- put back, scaled, at the next resize, as an attach's are
-- (LAYOUT_RESTORE_LUA), if that comes soon.
M._layout_save = loadstring([==[${LAYOUT_SAVE_LUA}]==])
M._layout_restore = loadstring([==[${LAYOUT_RESTORE_LUA}]==])
--- Each window at the size given (by window), twice, as winrestcmd() is.
local function exact_sizes(sizes)
  M._holding = true
  for _ = 1, 2 do
    for win, size in pairs(sizes) do
      if api.nvim_win_is_valid(win) then
        pcall(api.nvim_win_set_height, win, size[2])
        pcall(api.nvim_win_set_width, win, size[1])
      end
    end
  end
  if M._keep_cmdheight then M._keep_cmdheight() end
end
--- The windows' sizes as they are now, put back (scaled) at each resize
--- that comes within 3 s: windows laid out while a UI attaches. A
--- session's own sizes, when the screen is back at the size it was written
--- at, are put back as they were (scaling them twice loses rows).
local resized, session
local function keep_sizes_until_resize()
  local ok, layout = pcall(M._layout_save)
  if not ok then return end
  -- One kept at a time: the last laid out, and a session's own sizes.
  if resized then pcall(api.nvim_del_autocmd, resized) end
  session = _G.__devhub_session_sizes or session
  _G.__devhub_session_sizes = nil
  local mine
  -- Every resize until then (an attach may come as more than one): at the
  -- session's own size, its sizes, and done.
  mine = api.nvim_create_autocmd("VimResized", {
    group = group,
    callback = function()
      if session and vim.o.columns == session.columns and vim.o.lines == session.lines then
        exact_sizes(session.wins)
        resized, session = nil, nil
        return true
      end
      pcall(M._layout_restore, layout)
    end,
  })
  resized = mine
  vim.defer_fn(function()
    if resized == mine then
      pcall(api.nvim_del_autocmd, mine)
      resized, session = nil, nil
    end
  end, 3000)
end
api.nvim_create_autocmd("SessionLoadPost", {
  group = group,
  callback = function()
    -- 'doautoall' fires it once for each buffer: one is enough. Once the
    -- session file is through: DevHub's windows it closes at its end
    -- (above) are not among the sizes kept.
    if M._session_loading then return end
    M._session_loading = true
    vim.schedule(function()
      M._session_loading = nil
      keep_sizes_until_resize()
    end)
  end,
})
-- A Neovim still starting when DevHub attaches (its socket is there before
-- Neovim given two files to split has made its windows) lays them out at
-- the size of the UI then attached.
if vim.v.vim_did_enter == 0 then
  api.nvim_create_autocmd("VimEnter", {
    group = group,
    once = true,
    callback = function() vim.schedule(keep_sizes_until_resize) end,
  })
end
`;
