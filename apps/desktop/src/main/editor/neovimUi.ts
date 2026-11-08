/**
 * DevHub as a Neovim's UI: the attach, and what Neovim asks of its GUI.
 *
 * One `NeovimUi` per UI connection to a Workspace's headless Neovim
 * (`neovimUiSessions.ts`; the server is `managedNeovim.ts`'s). It runs
 * `SETUP_LUA` on the server — which tells the person's config it is in
 * DevHub's GUI (`g:devhub_gui`), points the clipboard at this Mac's, and
 * provides the `devhub_gui` Lua module and `:DevhubTerminal` — then attaches
 * with the `ext_*` options the page draws natively, and forwards every
 * `redraw` to the page. Neovim's requests on
 * the same channel (the clipboard's paste) are answered here; its
 * notifications about GUI windows are forwarded.
 *
 * The page sends what the person did as API calls by name (`call`), which
 * go out as msgpack-rpc notifications so they stay in order and nothing
 * waits on them. See `docs/neovim-editor.md`.
 */

import { MsgpackExt, decode } from "./msgpack.js";
import { LAYERS_LUA } from "./neovimGuiLayers.js";
import type { NeovimRpc } from "./neovimRpc.js";

/** What the GUI hears from its Neovim (`neovimUiSessions.ts` sends it on). */
export interface NeovimUiSink {
	redraw(batches: readonly unknown[]): void;
	/** `require('devhub_gui').open{…}`, a window change, or a close. */
	guiWindows(
		windows: readonly GuiWindowReport[],
		current: number,
		layout: readonly WindowLayoutReport[],
	): void;
	guiOpen(open: GuiOpenReport): void;
	guiClose(id: number): void;
	guiSend(id: number, message: unknown): void;
	/** The current buffer's file name (`""` for none), for the window title. */
	bufferChanged?(name: string): void;
	/**
	 * A one-way GUI event from `devhub_gui`: a toast (`notify`), an image and
	 * where it is (`image`, `place`, `image_clear`), the GUI layers' events
	 * (views, cards, decorations, popups).
	 */
	guiEvent?(kind: string, payload: unknown): void;
}

/**
 * This Mac's clipboard, for `g:clipboard`. Main's: the Neovim host asks main
 * for it (a utility process has no clipboard of its own).
 */
export interface NeovimClipboard {
	read(): Promise<string>;
	write(text: string): void;
}

export interface GuiWindowReport {
	readonly id: number;
	readonly win: number;
	/** A float with a border: its content goes inside the border's cells. */
	readonly border?: boolean;
}

/** A window of the current tab page, where Neovim says it is. */
export interface WindowLayoutReport {
	readonly win: number;
	readonly row: number;
	readonly col: number;
	readonly width: number;
	readonly height: number;
}

export interface GuiOpenReport {
	readonly id: number;
	readonly title: string;
	readonly html?: string;
	readonly url?: string;
	readonly terminal?: boolean;
	/** A terminal's tmux status line, which the window does not show. */
	readonly statusRows?: number;
	readonly statusTop?: boolean;
}

/**
 * What the attach asks for. `ext_messages` stays off: in 0.9 it is
 * experimental and takes the grid's own message area away, so Neovim keeps
 * drawing messages in the grid (its message grid, `msg_set_pos`).
 * `ext_hlstate` names the groups each highlight is made of, so the page
 * knows a selection, a pill or a diff's filler by name, not by colour.
 */
export function uiAttachOptions(): Record<string, boolean> {
	return {
		rgb: true,
		ext_linegrid: true,
		ext_multigrid: true,
		ext_hlstate: true,
		ext_popupmenu: true,
		ext_cmdline: true,
		ext_tabline: true,
		ext_messages: false,
	};
}

/**
 * Run on the server at every attach, with this connection's channel id.
 *
 * - `g:devhub_gui` (and `$DEVHUB_NEOVIM_GUI` from the start) say DevHub's
 *   GUI is the UI; `has('gui_running')` is already true for an RPC UI.
 * - `g:clipboard` asks DevHub for `+` and `*`, so a yank on an SSH host
 *   lands on the Mac's clipboard. Re-sourced so it applies even if the
 *   provider was already loaded.
 * - `<D-v>` pastes and `<D-c>` copies the selection, unless the person
 *   mapped them.
 * - `devhub_gui`: GUI windows. A GUI window is a scratch buffer
 *   (`filetype=devhub_gui`, its id in `b:devhub_gui_id`) shown in an
 *   ordinary window or float; DevHub paints its web content over that
 *   window's grid, so `:vsplit`, `<C-w>` moves, `:close`, `:only` and tab
 *   pages are Neovim's own. Which windows show one, and which window is
 *   current, is reported on every window event.
 * - `:DevhubTerminal [float]` opens a GUI window DevHub fills with the
 *   Workspace's terminal, toggled by the same command.
 */
export const SETUP_LUA = String.raw`
local chan = ...
vim.g.devhub_gui = true
vim.g.devhub_gui_channel = chan

vim.g.clipboard = {
  name = "devhub",
  copy = {
    ["+"] = function(lines, regtype) vim.rpcnotify(chan, "devhub_clipboard_set", lines, regtype) end,
    ["*"] = function(lines, regtype) vim.rpcnotify(chan, "devhub_clipboard_set", lines, regtype) end,
  },
  paste = {
    ["+"] = function() return vim.rpcrequest(chan, "devhub_clipboard_get") end,
    ["*"] = function() return vim.rpcrequest(chan, "devhub_clipboard_get") end,
  },
  cache_enabled = 0,
}
vim.g.loaded_clipboard_provider = nil
pcall(vim.cmd, "runtime autoload/provider/clipboard.vim")

local function map_unless_mapped(modes, lhs, rhs)
  for _, mode in ipairs(type(modes) == "table" and modes or { modes }) do
    if vim.fn.maparg(lhs, mode) == "" then
      vim.keymap.set(mode, lhs, rhs, { desc = "DevHub GUI" })
    end
  end
end
-- The Mac's editing keys, as a Mac editor answers them (DevHub's menu
-- leaves them to this page, editingCommands.ts). Cmd+V is the menu's Paste,
-- which DevHub hands to nvim_paste; these are for a mapping-less call.
map_unless_mapped({ "i", "c" }, "<D-v>", "<C-r><C-o>+")
map_unless_mapped("n", "<D-v>", '"+p')
map_unless_mapped("t", "<D-v>", [[<C-\><C-n>"+pi]])
map_unless_mapped("v", "<D-c>", '"+y')
map_unless_mapped("v", "<D-x>", '"+d')
map_unless_mapped("n", "<D-c>", '"+yy')
-- With nothing selected, Cut and Copy take the line, as a Mac editor does
-- (an unmapped <D-x> would reach Neovim as a plain x).
map_unless_mapped("n", "<D-x>", '"+dd')
map_unless_mapped("i", "<D-c>", '<C-o>"+yy')
map_unless_mapped("i", "<D-x>", '<C-o>"+dd')
map_unless_mapped({ "n", "v" }, "<D-a>", "<Esc>ggVG")
map_unless_mapped("i", "<D-a>", "<Esc>ggVG")
map_unless_mapped("n", "<D-z>", "u")
map_unless_mapped("i", "<D-z>", "<C-o>u")
map_unless_mapped("n", "<D-Z>", "<C-r>")
map_unless_mapped("i", "<D-Z>", "<C-o><C-r>")
map_unless_mapped({ "n", "v" }, "<D-s>", "<Cmd>write<CR>")
map_unless_mapped("i", "<D-s>", "<Esc><Cmd>write<CR>")

local M = package.loaded["devhub_gui"] or {}
package.loaded["devhub_gui"] = M
M._chan = chan
M._handlers = M._handlers or {}
M._open = M._open or {}
M._next = M._next or 0

--- Every GUI window still open, told again (a new DevHub, a reloaded page).
function M._replay()
  for _, open in pairs(M._open) do vim.rpcnotify(M._chan, "devhub_gui_open", open) end
  M._report()
  vim.rpcnotify(M._chan, "devhub_buffer", vim.api.nvim_buf_get_name(0), vim.bo.buftype)
  for id, image in pairs(M._images or {}) do M._event("image", { id = id, src = image.src }) end
  if M._place then vim.schedule(M._place) end
  if M._schedule_marks then M._schedule_marks() end
  -- Attached: what the config asked for before (devhub.nvim's gui queue).
  vim.api.nvim_exec_autocmds("User", { pattern = "DevhubGui", modeline = false })
end

local function report()
  local list, layout = {}, {}
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    local buf = vim.api.nvim_win_get_buf(win)
    local ok, id = pcall(vim.api.nvim_buf_get_var, buf, "devhub_gui_id")
    if ok then
      -- A float's border is cells of its grid: the content goes inside it.
      local border = vim.api.nvim_win_get_config(win).border
      local bordered = type(border) == "table" and #border > 0
        and not (#border == 1 and (border[1] == "" or border[1] == " "))
      table.insert(list, { id = id, win = win, border = bordered })
    end
  end
  -- Where the current tab page's windows are: what a reattached UI is not
  -- always told again (a window that did not move gets no win_pos).
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(win).relative == "" then
      local pos = vim.api.nvim_win_get_position(win)
      table.insert(layout, { win = win, row = pos[1], col = pos[2],
        width = vim.api.nvim_win_get_width(win), height = vim.api.nvim_win_get_height(win) })
    end
  end
  vim.rpcnotify(M._chan, "devhub_gui_windows", list, vim.api.nvim_get_current_win(), layout)
end
M._report = report

local group = vim.api.nvim_create_augroup("devhub_gui", { clear = true })
-- The current buffer's name, for DevHub's window title.
vim.api.nvim_create_autocmd({ "BufEnter", "BufFilePost", "WinEnter" }, {
  group = group,
  callback = function()
    vim.schedule(function()
      vim.rpcnotify(M._chan, "devhub_buffer", vim.api.nvim_buf_get_name(0), vim.bo.buftype)
    end)
  end,
})
vim.api.nvim_create_autocmd({ "WinEnter", "WinNew", "WinClosed", "BufWinEnter", "TabEnter", "VimResized" }, {
  group = group,
  callback = function() vim.schedule(report) end,
})

--- Open a GUI window: { html = "...", url = "...", title = "...",
--- win = "vsplit" | "split" | "float" | "tab" | "current", terminal = bool }.
--- Answers its handle, for send() and on_message().
function M.open(opts)
  opts = opts or {}
  M._next = M._next + 1
  local id = M._next
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_var(buf, "devhub_gui_id", id)
  pcall(vim.api.nvim_buf_set_name, buf, "devhub://" .. (opts.title or "gui") .. "/" .. id)
  vim.bo[buf].filetype = "devhub_gui"
  local how = opts.win or "vsplit"
  local win
  if how == "float" then
    local width = math.floor(vim.o.columns * 0.6)
    local height = math.floor(vim.o.lines * 0.6)
    win = vim.api.nvim_open_win(buf, true, {
      relative = "editor", width = width, height = height,
      row = math.floor((vim.o.lines - height) / 2) - 1,
      col = math.floor((vim.o.columns - width) / 2),
      style = "minimal", border = "rounded", zindex = 60,
    })
  else
    if how ~= "current" then vim.cmd(how == "tab" and "tabnew" or how) end
    win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(win, buf)
  end
  for option, value in pairs({ number = false, relativenumber = false, signcolumn = "no",
                               foldcolumn = "0", list = false, cursorline = false, spell = false }) do
    pcall(function() vim.wo[win][option] = value end)
  end
  local handle = { id = id, buf = buf }
  M._open[id] = { id = id, title = opts.title or "", html = opts.html, url = opts.url, terminal = opts.terminal == true }
  if opts.terminal then
    local rows, top = M._tmux_status()
    M._open[id].status_rows = rows
    M._open[id].status_top = top
  end
  vim.rpcnotify(M._chan, "devhub_gui_open", M._open[id])
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group, buffer = buf, once = true,
    callback = function()
      M._handlers[id] = nil
      M._open[id] = nil
      vim.rpcnotify(M._chan, "devhub_gui_close", id)
      vim.schedule(report)
    end,
  })
  vim.schedule(report)
  return handle
end

--- Send a GUI window's page a message (any value msgpack can carry).
function M.send(handle, message)
  vim.rpcnotify(M._chan, "devhub_gui_send", handle.id or handle, message)
end

--- Call fn(message) for every message the page posts with devhub.send().
function M.on_message(handle, fn)
  M._handlers[handle.id or handle] = fn
end

function M.close(handle)
  local buf = handle.buf
  if buf and vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
end

function M._receive(id, message)
  local fn = M._handlers[id]
  if fn then fn(message) end
end

--- One-way GUI events (a toast, an image, a layer), on one method.
local function gui_event(kind, payload)
  vim.rpcnotify(M._chan, "devhub_gui_event", kind, payload)
end
M._event = gui_event

local LEVELS = { [0] = "debug", [1] = "debug", [2] = "info", [3] = "warn", [4] = "error" }

--- A notification, fidget-like (bottom right, grouped by source, fading):
--- notify{ msg = "…", title = "…", level = "info" | "warn" | "error" |
--- "debug" | vim.log.levels.*, group = "source", key = "id", timeout = ms,
--- progress = true, percent = 0..100, done = bool }; or notify("text").
--- A key updates the notification it named (a progress, an LSP's work).
function M.notify(opts)
  if type(opts) ~= "table" then opts = { msg = opts } end
  local level = opts.level
  if type(level) == "number" then level = LEVELS[level] or "info" end
  if level ~= "debug" and level ~= "warn" and level ~= "error" then level = "info" end
  gui_event("notify", {
    title = opts.title and tostring(opts.title) or "",
    msg = tostring(opts.msg or opts.body or ""),
    level = level,
    timeout = type(opts.timeout) == "number" and opts.timeout or nil,
    group = opts.group and tostring(opts.group) or nil,
    key = opts.key and tostring(opts.key) or nil,
    progress = (opts.progress == true or opts.percent ~= nil) or nil,
    percent = type(opts.percent) == "number" and opts.percent or nil,
    done = opts.done == true or nil,
  })
end

-- Decorations DevHub paints over a window's text area, anchored to Neovim
-- objects: an image in the virt_lines rows of an extmark. Where each is on
-- the screen is told again whenever a window scrolls, moves, folds or
-- closes; the page only follows.
M._images = M._images or {}
local image_ns = vim.api.nvim_create_namespace("devhub_gui_image")
M._image_ns = image_ns

local MIME = { png = "image/png", jpg = "image/jpeg", jpeg = "image/jpeg", gif = "image/gif",
               svg = "image/svg+xml", webp = "image/webp" }

--- An image under line line (1-based) of buf: src is a path on this
--- Neovim's machine or an https URL. opts.height_rows (default 8) rows are
--- reserved with an extmark's virt_lines, and DevHub paints the image there.
--- Answers a handle with :clear().
function M.image(buf, line, src, opts)
  opts = opts or {}
  if buf == 0 or buf == nil then buf = vim.api.nvim_get_current_buf() end
  local rows = math.max(1, math.floor(opts.height_rows or 8))
  local data = src
  if not (src:match("^https://") or src:match("^data:image/")) then
    local path = vim.fn.fnamemodify(vim.fn.expand(src), ":p")
    local file = io.open(path, "rb")
    if not file then error("devhub gui.image: cannot read " .. path) end
    local bytes = file:read("*a")
    file:close()
    if not vim.base64 then error("devhub gui.image: needs Neovim 0.10 or later") end
    local mime = MIME[(path:match("%.(%w+)$") or ""):lower()] or "image/png"
    data = "data:" .. mime .. ";base64," .. vim.base64.encode(bytes)
  end
  local virt = {}
  for _ = 1, rows do table.insert(virt, { { " ", "Normal" } }) end
  local mark = vim.api.nvim_buf_set_extmark(buf, image_ns, line - 1, 0, { virt_lines = virt })
  M._next = M._next + 1
  local id = M._next
  M._images[id] = { id = id, buf = buf, mark = mark, rows = rows, src = data }
  gui_event("image", { id = id, src = data })
  vim.schedule(M._place)
  return { id = id, buf = buf, mark = mark, clear = function() M.image_clear(id) end }
end

function M.image_clear(id)
  local image = M._images[type(id) == "table" and id.id or id]
  if not image then return end
  M._images[image.id] = nil
  pcall(vim.api.nvim_buf_del_extmark, image.buf, image_ns, image.mark)
  gui_event("image_clear", { id = image.id })
  vim.schedule(M._place)
end

--- Where line lnum is in window win (info: its getwininfo): the rows of its
--- first and last screen line from the window's top, and whether it is a
--- closed fold's line; nil when it is hidden in a fold or further than a
--- window's height from the window. Beyond the window too: the page shows
--- up to a window above or below Neovim's view while it scrolls in pixels
--- (Neovim a line or more ahead), and what is there must be placed. Off
--- the window the rows are counted with nvim_win_text_height (0.10+) from
--- topline's first row; a line's fill (diff filler, virt_lines above it
--- and below the line before) is above it, as Neovim counts it.
function M._line_rows(win, info, lnum)
  local folded = vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(lnum) end)
  if folded ~= -1 and folded ~= lnum then return nil end
  local top = info.winrow
  if lnum >= info.topline and lnum <= info.botline then
    local first = vim.fn.screenpos(win, lnum, 1)
    if first.row > 0 then
      local text = vim.api.nvim_buf_get_lines(info.bufnr, lnum - 1, lnum, false)[1] or ""
      local last = folded == -1 and vim.fn.screenpos(win, lnum, math.max(1, #text)) or first
      return first.row - top, (last.row > 0 and last.row or first.row) - top, folded ~= -1
    end
  end
  if not vim.api.nvim_win_text_height then return nil end
  local reach = info.height
  if lnum < info.topline - 4 * reach or lnum > info.botline + 4 * reach then return nil end
  local anchor = vim.fn.screenpos(win, info.topline, 1)
  if anchor.row == 0 then return nil end
  local height = function(a, b)
    return vim.api.nvim_win_text_height(win, { start_row = a - 1, end_row = b - 1 })
  end
  -- The first row of topline's block: its fill, partly shown (topfill).
  local block = anchor.row - top - height(info.topline, info.topline).fill
  local first
  if lnum < info.topline then
    first = block - height(lnum, info.topline - 1).all
  else
    first = block + height(info.topline, lnum - 1).all
  end
  local own = height(lnum, lnum)
  first = first + own.fill
  local last = first + math.max(1, own.all - own.fill) - 1
  if last < -reach or first >= info.height + reach then return nil end
  return first, last, folded ~= -1
end

--- Before a placement is taken: what Neovim has not drawn yet is drawn,
--- so the placement reaches the page after the redraw of the state it is
--- taken in (a scroll can come between a scheduled placement and its
--- redraw; the page counts a placement from the redraws it has heard).
function M._drawn()
  if not vim.api.nvim_get_mode().blocking then vim.cmd("redraw") end
end

--- Where every image is now, on the current tab page: rows from the
--- window's top (beyond it too, M._line_rows). Sent after the redraw that
--- shows this state: the page moves them by what it has drawn since.
function M._place()
  M._drawn()
  local images = {}
  local tab_wins = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do tab_wins[win] = true end
  for id, image in pairs(M._images) do
    local ok, pos = pcall(vim.api.nvim_buf_get_extmark_by_id, image.buf, image_ns, image.mark, {})
    if not ok or not pos[1] then
      M._images[id] = nil
      gui_event("image_clear", { id = id })
    else
      local lnum = pos[1] + 1
      for _, win in ipairs(vim.fn.win_findbuf(image.buf)) do
        local info = tab_wins[win] and vim.fn.getwininfo(win)[1]
        local _, last, folded = nil, nil, nil
        if info then _, last, folded = M._line_rows(win, info, lnum) end
        if last and not folded then
          -- From the window's top: the page places it on the window's box
          -- and cuts it to the window.
          table.insert(images, { id = id, win = win, row = last + 1, col = info.textoff,
            width = info.width - info.textoff, rows = image.rows })
        end
      end
    end
  end
  gui_event("place", { images = images })
end

-- Scrollbar marks ------------------------------------------------------------

--- What each window's scrollbar marks, as VS Code's overview ruler: the
--- lines with diagnostics (by their worst severity), the search's matches
--- while 'hlsearch' shows them, and the changed lines git sees (gitsigns'
--- hunks, when it is there); the cursor's line the page has from
--- win_viewport. Lines are 1-based; the colours are the groups' own.
local MARK_GROUPS = { "DiagnosticError", "DiagnosticWarn", "DiagnosticInfo", "DiagnosticHint",
  "Search", "GitSignsAdd", "GitSignsChange", "GitSignsDelete", "Added", "Changed", "Removed" }
local MAX_MARKS = 4000
local SEARCH_LINES = 100000
local search_cache = {}

local function search_lines(buf, pattern)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local key = pattern .. "\0" .. tick
  local cached = search_cache[buf]
  if cached and cached.key == key then return cached.lines end
  local lines = {}
  if vim.api.nvim_buf_line_count(buf) <= SEARCH_LINES then
    local ok, found = pcall(vim.fn.matchbufline, buf, pattern, 1, "$")
    if ok then
      local last = -1
      for _, m in ipairs(found) do
        if m.lnum ~= last then
          table.insert(lines, m.lnum)
          last = m.lnum
          if #lines >= MAX_MARKS then break end
        end
      end
    end
  end
  search_cache[buf] = { key = key, lines = lines }
  return lines
end

function M._marks()
  local wins = {}
  local pattern = vim.v.hlsearch == 1 and vim.fn.getreg("/") or ""
  local ok_gs, gitsigns = pcall(require, "gitsigns")
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(win).relative == "" then
      local buf = vim.api.nvim_win_get_buf(win)
      local diag = {}
      local worst = {}
      for _, d in ipairs(vim.diagnostic.get(buf)) do
        local l = d.lnum + 1
        if not worst[l] or d.severity < worst[l] then worst[l] = d.severity end
      end
      for l, sev in pairs(worst) do
        if #diag >= MAX_MARKS then break end
        table.insert(diag, { l, sev })
      end
      local git = {}
      if ok_gs and type(gitsigns.get_hunks) == "function" then
        local ok, hunks = pcall(gitsigns.get_hunks, buf)
        if ok and type(hunks) == "table" then
          for _, h in ipairs(hunks) do
            local add = h.added or {}
            local kind = h.type == "add" and 1 or h.type == "delete" and 3 or 2
            table.insert(git, { math.max(1, add.start or 1), math.max(1, add.count or 1), kind })
            if #git >= MAX_MARKS then break end
          end
        end
      end
      local search = pattern ~= "" and search_lines(buf, pattern) or {}
      wins[tostring(win)] = { diag = diag, git = git, search = search }
    end
  end
  local colors = {}
  for _, name in ipairs(MARK_GROUPS) do
    local hl = vim.api.nvim_get_hl(0, { name = name, link = false })
    colors[name] = { fg = hl.fg, bg = hl.bg }
  end
  gui_event("marks", { wins = wins, colors = colors })
end

local marks_due = false
local marks_state = ""
local function schedule_marks()
  if marks_due then return end
  marks_due = true
  vim.defer_fn(function()
    marks_due = false
    pcall(M._marks)
  end, 120)
end
M._schedule_marks = schedule_marks
vim.api.nvim_create_autocmd({ "DiagnosticChanged", "BufWinEnter", "WinNew", "WinClosed", "TabEnter",
  "TextChanged", "InsertLeave", "ColorScheme" }, { group = group, callback = schedule_marks })
vim.api.nvim_create_autocmd("User", { group = group, pattern = "GitSignsUpdate", callback = schedule_marks })
-- A search, n, :nohlsearch: no event says so; when Neovim is idle the
-- pattern and whether it shows are compared with what was sent.
pcall(vim.api.nvim_create_autocmd, "SafeState", {
  group = group,
  callback = function()
    local now = vim.v.hlsearch .. "\0" .. vim.fn.getreg("/")
    if now == marks_state then return end
    marks_state = now
    schedule_marks()
  end,
})

-- A window's fillchars changed (:setlocal, a filetype's): the page asks
-- its theme again, so a person's eob: or diff: shows at once.
vim.api.nvim_create_autocmd("OptionSet", {
  group = group,
  pattern = "fillchars",
  callback = function() gui_event("theme", { win = vim.api.nvim_get_current_win() }) end,
})
vim.api.nvim_create_autocmd({ "FileType", "BufWinEnter" }, {
  group = group,
  callback = function()
    if vim.wo.fillchars ~= vim.go.fillchars then gui_event("theme", { win = vim.api.nvim_get_current_win() }) end
  end,
})

vim.api.nvim_create_autocmd({ "WinScrolled", "WinResized", "WinClosed", "WinNew", "BufWinEnter",
  "TabEnter", "VimResized", "TextChanged", "TextChangedI", "CursorMoved", "CursorMovedI" }, {
  group = group,
  callback = function()
    if next(M._images) == nil then return end
    vim.schedule(M._place)
  end,
})

--- :DevhubImageDemo: an image under a line of a markdown buffer.
vim.api.nvim_create_user_command("DevhubImageDemo", function(o)
  local path = o.args ~= "" and o.args or M._demo_image()
  vim.cmd("enew")
  local buf = vim.api.nvim_get_current_buf()
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].filetype = "markdown"
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, {
    "# Inline images", "", "An image DevHub paints in the rows an extmark reserves:", "",
    "![demo](" .. path .. ")", "", "It follows scrolling, folds (zfk on the line above) and window moves.",
    "Neovim still owns the buffer: the rows are virt_lines, the cursor jumps over them.", "",
  })
  M.image(buf, 5, path, { height_rows = 10 })
end, { nargs = "?", complete = "file", desc = "Show an inline image under a line (DevHub GUI)" })

--- A small PNG for the demo, written once: a 64x40 gradient.
function M._demo_image()
  local path = vim.fn.stdpath("cache") .. "/devhub-image-demo.png"
  if vim.fn.filereadable(path) == 1 then return path end
  local w, h = 64, 40
  local raw = {}
  for y = 0, h - 1 do
    table.insert(raw, "\0")
    for x = 0, w - 1 do
      local r = math.floor(40 + 180 * x / (w - 1))
      local g = math.floor(90 + 120 * y / (h - 1))
      local b = 230 - math.floor(120 * x / (w - 1))
      if ((x - 32) ^ 2 + (y - 20) ^ 2) < 120 then r, g, b = 250, 250, 250 end
      table.insert(raw, string.char(r, g, b))
    end
  end
  raw = table.concat(raw)
  -- zlib "stored" blocks: no compression library needed.
  local function u32(n) return string.char(bit.band(bit.rshift(n, 24), 255), bit.band(bit.rshift(n, 16), 255),
    bit.band(bit.rshift(n, 8), 255), bit.band(n, 255)) end
  local crc_table = {}
  for i = 0, 255 do
    local c = i
    for _ = 1, 8 do c = bit.band(c, 1) == 1 and bit.bxor(0xEDB88320, bit.rshift(c, 1)) or bit.rshift(c, 1) end
    crc_table[i] = c
  end
  local function crc(s)
    local c = 0xFFFFFFFF
    for i = 1, #s do c = bit.bxor(crc_table[bit.band(bit.bxor(c, s:byte(i)), 255)], bit.rshift(c, 8)) end
    return bit.bxor(c, 0xFFFFFFFF) % 4294967296
  end
  local a, b2 = 1, 0
  for i = 1, #raw do a = (a + raw:byte(i)) % 65521; b2 = (b2 + a) % 65521 end
  local blocks, pos = {}, 1
  while pos <= #raw do
    local chunk = raw:sub(pos, pos + 65534)
    pos = pos + #chunk
    local n = #chunk
    table.insert(blocks, string.char(pos > #raw and 1 or 0, n % 256, math.floor(n / 256),
      (65535 - n) % 256, math.floor((65535 - n) / 256)) .. chunk)
  end
  local zdata = "\120\1" .. table.concat(blocks) .. u32(b2 * 65536 + a)
  local function chunk(kind, body) return u32(#body) .. kind .. body .. u32(crc(kind .. body)) end
  local png = "\137PNG\r\n\26\n" .. chunk("IHDR", u32(w) .. u32(h) .. "\8\2\0\0\0") .. chunk("IDAT", zdata)
    .. chunk("IEND", "")
  vim.fn.mkdir(vim.fn.fnamemodify(path, ":h"), "p")
  local file = assert(io.open(path, "wb"))
  file:write(png)
  file:close()
  return path
end

--- How many rows the tmux status line of this Neovim's session takes, and
--- whether it is at the top: a terminal GUI window leaves them out, since
--- Neovim's own statusline already says where it is.
function M._tmux_status()
  if not vim.env.TMUX then return 0, false end
  local cmd = { vim.env.DEVHUB_TMUX or "tmux", "display-message", "-p" }
  if vim.env.TMUX_PANE then vim.list_extend(cmd, { "-t", vim.env.TMUX_PANE }) end
  table.insert(cmd, "#{status}\t#{status-position}")
  local ok, out = pcall(vim.fn.system, cmd)
  if not ok or vim.v.shell_error ~= 0 then return 0, false end
  local status, position = out:match("^(%w+)\t(%w+)")
  local rows = status == "on" and 1 or tonumber(status or "") or 0
  return rows, position == "top"
end

--- :DevhubTerminal [float]: the Workspace's terminal in a window, toggled.
function M.terminal(how)
  if M._terminal and vim.api.nvim_buf_is_valid(M._terminal.buf) then
    local shown = vim.fn.win_findbuf(M._terminal.buf)
    if #shown > 0 then
      for _, w in ipairs(shown) do pcall(vim.api.nvim_win_close, w, true) end
      return
    end
    if how == "float" then
      vim.api.nvim_open_win(M._terminal.buf, true, {
        relative = "editor", width = math.floor(vim.o.columns * 0.8), height = math.floor(vim.o.lines * 0.7),
        row = 2, col = math.floor(vim.o.columns * 0.1), style = "minimal", border = "rounded", zindex = 60,
      })
    else
      vim.cmd("botright split")
      vim.api.nvim_win_set_buf(0, M._terminal.buf)
      vim.cmd("resize " .. math.floor(vim.o.lines * 0.35))
    end
    vim.schedule(report)
    return
  end
  local buf_how = how == "float" and "float" or "botright split"
  M._terminal = M.open({ title = "terminal", terminal = true, win = buf_how })
  local term = M._terminal
  vim.bo[term.buf].bufhidden = "hide"
  vim.bo[term.buf].modifiable = false
  -- Terminal-normal mode (<C-\><C-n> in the terminal): i, a, I, A and <CR>
  -- go back into it, as in a :terminal buffer.
  for _, lhs in ipairs({ "i", "a", "I", "A", "<CR>" }) do
    vim.keymap.set("n", lhs, function() gui_event("terminal_insert", { id = term.id }) end,
      { buffer = term.buf, desc = "DevHub: back into the terminal" })
  end
  if buf_how ~= "float" then vim.cmd("resize " .. math.floor(vim.o.lines * 0.35)) end
end

vim.api.nvim_create_user_command("DevhubTerminal", function(o) M.terminal(o.args) end, {
  nargs = "?", complete = function() return { "float" } end,
  desc = "Toggle the Workspace's DevHub terminal in a window",
})

--- :DevhubGuiDemo: a GUI window whose buttons drive the window beside it.
vim.api.nvim_create_user_command("DevhubGuiDemo", function()
  local source = vim.api.nvim_get_current_win()
  local buf = vim.api.nvim_win_get_buf(source)
  local name = vim.api.nvim_buf_get_name(buf)
  local lines = vim.api.nvim_buf_line_count(buf)
  local outline = {}
  for i, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, math.min(lines, 2000), false)) do
    local fn = line:match("^%s*local%s+function%s+([%w_%.:]+)") or line:match("^%s*function%s+([%w_%.:]+)")
      or line:match("^%s*def%s+([%w_]+)") or line:match("^%s*export%s+function%s+([%w_]+)")
      or line:match("^%s*fn%s+([%w_]+)") or line:match("^#+%s+(.+)")
    if fn and #outline < 200 then table.insert(outline, { line = i, name = fn }) end
  end
  local handle = M.open({ title = "Outline", win = "vsplit", html = M.demo_html })
  vim.cmd("vertical resize 40")
  M.on_message(handle, function(msg)
    if type(msg) ~= "table" then return end
    if msg.kind == "jump" and vim.api.nvim_win_is_valid(source) then
      vim.api.nvim_win_set_cursor(source, { msg.line, 0 })
      vim.api.nvim_win_call(source, function() vim.cmd("normal! zz") end)
    elseif msg.kind == "command" then
      vim.cmd(msg.command)
    elseif msg.kind == "ready" then
      M.send(handle, { kind = "outline", file = vim.fn.fnamemodify(name, ":t"), lines = lines, items = outline })
    end
  end)
end, { desc = "Open DevHub's GUI-window demo beside the current window" })

M.demo_html = [==[
<!doctype html><meta charset="utf-8"><style>
body{font:13px -apple-system,system-ui,sans-serif;margin:0;padding:12px;color:var(--fg,#ddd);background:transparent}
h1{font-size:13px;margin:0 0 8px;opacity:.7;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
button{display:block;width:100%;text-align:left;border:0;border-radius:6px;padding:5px 8px;margin:1px 0;
  background:transparent;color:inherit;font:inherit;cursor:pointer}
button:hover,button:focus{background:rgba(127,127,127,.18);outline:none}
.ln{opacity:.5;float:right;font-variant-numeric:tabular-nums}
.bar{display:flex;gap:6px;margin:0 0 10px}.bar button{background:rgba(127,127,127,.16);text-align:center}
</style><h1 id="title">Outline</h1>
<div class="bar"><button id="top">gg</button><button id="bottom">G</button><button id="write">:write</button></div>
<div id="items"></div><script>
const $ = (id) => document.getElementById(id);
$("top").onclick = () => devhub.send({kind:"command", command:"wincmd p | normal! gg"});
$("bottom").onclick = () => devhub.send({kind:"command", command:"wincmd p | normal! G"});
$("write").onclick = () => devhub.send({kind:"command", command:"wincmd p | write"});
devhub.onMessage((msg) => {
  if (msg.kind !== "outline") return;
  $("title").textContent = msg.file + " — " + msg.lines + " lines";
  const box = $("items"); box.textContent = "";
  for (const item of msg.items) {
    const b = document.createElement("button");
    b.innerHTML = "<span class=ln></span>"; b.firstChild.textContent = item.line;
    b.append(item.name);
    b.onclick = () => devhub.send({kind:"jump", line:item.line});
    box.append(b);
  }
});
devhub.send({kind:"ready"});
</script>
]==]
`;

/** Neovim's ext handles (Window, Buffer, Tabpage) are ints inside; the page wants numbers. */
export function plainHandles(value: unknown): unknown {
	if (value instanceof MsgpackExt) {
		try {
			const inner = decode(value.data).value;
			return typeof inner === "number" ? inner : 0;
		} catch {
			return 0;
		}
	}
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map((item) => {
			const next = plainHandles(item);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (
		value !== null &&
		typeof value === "object" &&
		!(value instanceof Uint8Array)
	) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value))
			out[key] = plainHandles(item);
		return out;
	}
	return value;
}

/** Batches whose arguments carry handles; the rest are passed as they are. */
const HANDLE_EVENTS = new Set([
	"win_pos",
	"win_float_pos",
	"win_external_pos",
	"win_viewport",
	"win_extmark",
	"tabline_update",
	"msg_set_pos",
]);

function withPlainHandles(batches: readonly unknown[]): unknown[] {
	return batches.map((batch) =>
		Array.isArray(batch) && HANDLE_EVENTS.has(batch[0] as string)
			? plainHandles(batch)
			: batch,
	);
}

function layoutReport(value: unknown): WindowLayoutReport[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const e = (entry ?? {}) as Record<string, unknown>;
		const n = (key: string) =>
			typeof e[key] === "number" ? e[key] : undefined;
		const win = n("win");
		const row = n("row");
		const col = n("col");
		const width = n("width");
		const height = n("height");
		return win === undefined ||
			row === undefined ||
			col === undefined ||
			width === undefined ||
			height === undefined
			? []
			: [{ win, row, col, width, height }];
	});
}

/**
 * What the window title calls the current buffer: its file's name, or
 * nothing for one that is not a file (a GUI window, a terminal, help).
 */
export function bufferTitle(name: unknown, buftype: unknown): string {
	if (typeof name !== "string" || name === "") return "";
	if (buftype !== "" && buftype !== undefined) return "";
	if (name.startsWith("devhub://")) return "";
	return name.split("/").at(-1) ?? "";
}

/** The text DevHub hands `g:clipboard`'s paste: `[lines, regtype]`. */
export function clipboardPaste(text: string): [string[], string] {
	const normal = text.replaceAll("\r\n", "\n");
	if (normal.endsWith("\n")) return [normal.slice(0, -1).split("\n"), "V"];
	return [normal.split("\n"), "v"];
}

/** `g:clipboard`'s copy, as the text this Mac's clipboard gets. */
export function clipboardCopy(
	lines: readonly unknown[],
	regtype: unknown,
): string {
	const strings = lines.map((line) => (typeof line === "string" ? line : ""));
	const text = strings.join("\n");
	// Linewise: Neovim's list already ends with "" (the last newline), or not.
	return regtype === "V" && strings.at(-1) !== "" ? `${text}\n` : text;
}

export interface NeovimUiAttach {
	readonly version: string;
}

export class NeovimUi {
	private attached = false;
	/** Attached a moment only to free stale grids: nothing it says is drawn. */
	private priming = false;
	private sink: NeovimUiSink | undefined;

	constructor(
		readonly client: NeovimRpc & {
			notify(method: string, params: readonly unknown[]): void;
		},
		private readonly clipboard: NeovimClipboard,
	) {
		client.onNotification?.((method, params) => {
			this.notified(method, params);
		});
		client.onRequest?.((method, params) => this.requested(method, params));
	}

	/** Attach (again) as the UI, the page at `sink` hearing what it draws. */
	async attach(
		sink: NeovimUiSink,
		cols: number,
		rows: number,
	): Promise<NeovimUiAttach> {
		this.sink = sink;
		const info = (await this.client.request("nvim_get_api_info", [])) as [
			number,
			{ version?: { major?: number; minor?: number; patch?: number } },
		];
		const channel = info[0];
		// A Neovim at a prompt (hit-enter, more, confirm) answers nothing but
		// fast calls until it is dismissed, and nothing is attached to see it.
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const mode = (await this.client.request("nvim_get_mode", [])) as
				| { readonly blocking?: boolean }
				| undefined;
			if (mode?.blocking !== true) break;
			await this.client.request("nvim_input", ["<Esc>"]);
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
		const v = info[1]?.version ?? {};
		const version = `${String(v.major ?? 0)}.${String(v.minor ?? 0)}.${String(v.patch ?? 0)}`;
		if (this.attached) {
			// A page that started over: the grid is drawn again from scratch.
			await this.client.request("nvim_ui_detach", []).catch(() => undefined);
			this.attached = false;
		}
		await this.client.request("nvim_exec_lua", [SETUP_LUA, [channel]]);
		// Views, inline cards and decorations (`gui.view`, `gui.inline`,
		// `gui.decorate`): the same module, grown by its own file.
		await this.client.request("nvim_exec_lua", [LAYERS_LUA, []]);
		// A Neovim that had a multigrid UI before (DevHub restarted, the page
		// reloaded) keeps its window grids and believes the new UI has them
		// too, so it would send only what changes from here. A moment attached
		// without multigrid frees them; the real attach then gets every cell.
		this.priming = true;
		try {
			// At another size, so every window moves or resizes and is placed
			// again (`win_pos`) at the real attach: an unmoved one would not be.
			await this.client.request("nvim_ui_attach", [
				Math.max(20, Math.floor(cols / 2)),
				Math.max(6, Math.floor(rows / 2)),
				{ rgb: true, ext_linegrid: true },
			]);
			await this.client.request("nvim_command", ["redraw!"]);
			await this.client.request("nvim_ui_detach", []);
		} finally {
			this.priming = false;
		}
		await this.client.request("nvim_ui_attach", [
			Math.max(1, Math.floor(cols)),
			Math.max(1, Math.floor(rows)),
			uiAttachOptions(),
		]);
		this.attached = true;
		// The GUI windows already open (a DevHub restart, a page reload) are
		// told again: the page knew none of them.
		await this.client
			.request("nvim_exec_lua", [
				"local M = package.loaded['devhub_gui']; if M and M._replay then M._replay() end",
				[],
			])
			.catch(() => undefined);
		return { version };
	}

	/** A call from the page, in order and unanswered. */
	call(method: string, params: readonly unknown[]): void {
		this.client.notify(method, params);
	}

	request(method: string, params: readonly unknown[]): Promise<unknown> {
		return this.client.request(method, params);
	}

	/** A GUI window's page posted a message: its Lua handler gets it. */
	guiMessage(id: number, message: unknown): void {
		this.client.notify("nvim_exec_lua", [
			"local M = package.loaded['devhub_gui']; if M then M._receive(...) end",
			[id, message],
		]);
	}

	private notified(method: string, params: readonly unknown[]): void {
		const sink = this.sink;
		if (sink === undefined) return;
		switch (method) {
			case "redraw":
				if (this.priming) return;
				sink.redraw(withPlainHandles(params));
				return;
			case "devhub_clipboard_set":
				this.clipboard.write(
					clipboardCopy(
						Array.isArray(params[0]) ? (params[0] as unknown[]) : [],
						params[1],
					),
				);
				return;
			case "devhub_gui_windows": {
				const list = plainHandles(params[0]);
				const current = plainHandles(params[1]);
				sink.guiWindows(
					Array.isArray(list)
						? list.flatMap((entry) => {
								const e = entry as {
									id?: unknown;
									win?: unknown;
									border?: unknown;
								};
								return typeof e.id === "number" && typeof e.win === "number"
									? [
											{
												id: e.id,
												win: e.win,
												...(e.border === true ? { border: true } : {}),
											},
										]
									: [];
							})
						: [],
					typeof current === "number" ? current : 0,
					layoutReport(plainHandles(params[2])),
				);
				return;
			}
			case "devhub_gui_open": {
				const open = (params[0] ?? {}) as Record<string, unknown>;
				if (typeof open["id"] !== "number") return;
				sink.guiOpen({
					id: open["id"],
					title: typeof open["title"] === "string" ? open["title"] : "",
					...(typeof open["html"] === "string" ? { html: open["html"] } : {}),
					...(typeof open["url"] === "string" ? { url: open["url"] } : {}),
					...(open["terminal"] === true ? { terminal: true } : {}),
					...(typeof open["status_rows"] === "number"
						? {
								statusRows: open["status_rows"],
								statusTop: open["status_top"] === true,
							}
						: {}),
				});
				return;
			}
			case "devhub_gui_event":
				if (typeof params[0] === "string") {
					sink.guiEvent?.(params[0], plainHandles(params[1]));
				}
				return;
			case "devhub_buffer":
				sink.bufferChanged?.(bufferTitle(params[0], params[1]));
				return;
			case "devhub_gui_close":
				if (typeof params[0] === "number") sink.guiClose(params[0]);
				return;
			case "devhub_gui_send":
				if (typeof params[0] === "number") sink.guiSend(params[0], params[1]);
				return;
			default:
				return;
		}
	}

	private requested(
		method: string,
		_params: readonly unknown[],
	): Promise<unknown> {
		if (method === "devhub_clipboard_get") {
			return this.clipboard.read().then(clipboardPaste);
		}
		return Promise.reject(new Error(`DevHub does not answer ${method}`));
	}
}
