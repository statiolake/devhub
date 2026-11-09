/**
 * DevHub as a Neovim's UI: the attach, and what Neovim asks of its GUI.
 *
 * One `NeovimUi` per UI connection to a Workspace's headless Neovim
 * (`neovimUiSessions.ts`; the server is `managedNeovim.ts`'s). It runs
 * `SETUP_LUA` on the server — which tells the person's config it is in
 * DevHub's GUI (`g:devhub_gui`), points the clipboard at this Mac's, and
 * provides the `devhub_gui` Lua module — then attaches with the `ext_*`
 * options the page draws natively, and forwards every `redraw` to the page.
 * Neovim's requests on the same channel (the clipboard's paste) are answered here; its
 * notifications about GUI windows are forwarded.
 *
 * The page sends what the person did as API calls by name (`call`), which
 * go out as msgpack-rpc notifications so they stay in order and nothing
 * waits on them. See `docs/neovim-editor.md`.
 */

import { MsgpackExt, decode } from "./msgpack.js";
import { DECOR_LUA } from "./neovimDecor.js";
import { MESSAGES_LUA } from "./neovimMessages.js";
import { LAYERS_LUA } from "./neovimGuiLayers.js";
import { RESTART_STATE_LUA } from "./neovimRestart.js";
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
	/** Whose the keys are while it is current (`gui.open`'s `keyboard`). */
	readonly keyboard: GuiKeyboard;
}

/**
 * `"neovim"`: Neovim's, as in normal mode, a field taking them in insert
 * mode. `"content"`: the page's, `<C-w>` giving them back.
 */
export type GuiKeyboard = "neovim" | "content";

/**
 * What the attach asks for. `ext_messages`: Neovim's messages, prompts and
 * mode come as events and DevHub draws them (`shell/neovim/messages.ts`):
 * ordinary messages in the notifications' corner, long output in the pager,
 * prompts in the command line's box; `MESSAGES_LUA` keeps the person's
 * `cmdheight`, which the attach would set to 0. `ext_hlstate` names the groups each highlight is made of, so the page
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
		ext_messages: true,
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
 *   current, is reported on every window event. Its keys are Neovim's (its
 *   lines are the page's focusable elements, the cursor line the focused
 *   one, a field insert mode) unless it asks for `keyboard = "content"`.
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
  -- The field that had the keys went with the old page.
  if M._editing then vim.cmd("stopinsert") end
  for _, open in pairs(M._open) do vim.rpcnotify(M._chan, "devhub_gui_open", open) end
  M._report()
  vim.rpcnotify(M._chan, "devhub_buffer", vim.api.nvim_buf_get_name(0), vim.bo.buftype)
  for id, image in pairs(M._images or {}) do M._event("image", { id = id, src = image.src }) end
  if M._place then vim.schedule(M._place) end
  -- In the command-line window (q:): the new page frames it too.
  if M._cmdwin_report then M._cmdwin_report() end
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
--- win = "vsplit" | "split" | "float" | "tab" | "current",
--- keyboard = "neovim" | "content" }.
--- keyboard: whose the keys are while the window is current. "neovim" (an
--- html page's default): Neovim's, as in normal mode, the buffer's lines
--- being the page's focusable elements and a field taking them in insert
--- mode. "content" (a url page's, which has no bridge to Neovim): the page's,
--- <C-w> giving them back. Answers its handle, for send() and on_message().
function M.open(opts)
  opts = opts or {}
  local keyboard = opts.keyboard or (opts.url and "content" or "neovim")
  if keyboard ~= "neovim" and keyboard ~= "content" then
    error("devhub gui.open: keyboard is 'neovim' or 'content'")
  end
  if keyboard == "neovim" and opts.url then
    error("devhub gui.open: a url page cannot tell Neovim what it holds; it takes keyboard = 'content'")
  end
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
  M._open[id] = { id = id, title = opts.title or "", html = opts.html, url = opts.url, keyboard = keyboard }
  if keyboard == "neovim" then M._keyboard(id, buf) end
  vim.rpcnotify(M._chan, "devhub_gui_open", M._open[id])
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group, buffer = buf, once = true,
    callback = function()
      M._handlers[id] = nil
      M._open[id] = nil
      M._pages[id] = nil
      if M._editing == id then M._editing = nil end
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

-- A GUI window's keyboard (keyboard = "neovim"). Neovim is the modal engine:
-- while the window is current and no field in it has the keys, they are
-- Neovim's, as in normal mode. The buffer's lines are the page's focusable
-- elements, one per line in document order (the page tells them,
-- _gui_items), and the cursor line is the focused one — gui.view's model —
-- so j/k, counts, /, gg/G, marks, :, <C-w> and the person's maps are
-- Neovim's own and the page only rings the element. <CR> activates it (a
-- click) or enters it if it is a field; i/a (the caret where it was), I
-- (start), A (end) enter a field: Neovim goes to insert mode and the keys go
-- to the field; <Esc> there is Neovim's <Esc>, and leaving insert mode, by
-- whatever means, gives the keys back.
M._pages = M._pages or {}

--- The window that shows a GUI buffer: the current one, else the first.
local function gui_win(buf)
  local current = vim.api.nvim_get_current_win()
  if vim.api.nvim_win_get_buf(current) == buf then return current end
  return vim.fn.win_findbuf(buf)[1]
end

--- The focused element's index (0-based), -1 for none.
local function focus_index(page)
  local win = gui_win(page.buf)
  if not win then return -1 end
  local lnum = vim.api.nvim_win_get_cursor(win)[1]
  return lnum <= #page.items and lnum - 1 or -1
end

--- What the page is told: { id, action = "focus" | "activate" | "edit" |
--- "leave" | "key", index, ring = the cursor's colour, caret, lhs }.
local function control(id, action, extra)
  local page = M._pages[id]
  if not page then return end
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = "Cursor", link = false })
  local rgb = ok and type(hl) == "table" and (hl.bg or hl.fg) or nil
  local payload = { id = id, action = action, index = focus_index(page),
    ring = rgb and string.format("#%06x", rgb) or nil }
  for key, value in pairs(extra or {}) do payload[key] = value end
  gui_event("gui_keys", payload)
end

--- Into the focused field: insert mode, the keys the field's. The buffer is
--- modifiable only meanwhile (Neovim enters no insert mode in one that is
--- not), with no undo, and a key that still reaches Neovim is undone.
local function edit(id, caret)
  local page = M._pages[id]
  if not page then return end
  local item = page.items[focus_index(page) + 1]
  if not item or not item.editable then return end
  M._editing = id
  vim.bo[page.buf].modifiable = true
  vim.cmd("startinsert")
  control(id, "edit", { caret = caret })
end

local function render(page)
  local lines = {}
  for _, item in ipairs(page.items) do table.insert(lines, item.label) end
  if #lines == 0 then lines = { "" } end
  local modifiable = vim.bo[page.buf].modifiable
  vim.bo[page.buf].modifiable = true
  vim.api.nvim_buf_set_lines(page.buf, 0, -1, false, lines)
  vim.bo[page.buf].modifiable = modifiable
  vim.bo[page.buf].modified = false
end

--- The maps the window always has, then the page's own (devhub.keys).
local function keymaps(id, page)
  local function map(lhs, fn, desc)
    vim.keymap.set("n", lhs, fn, { buffer = page.buf, desc = "DevHub GUI: " .. desc })
  end
  map("<CR>", function()
    local item = page.items[focus_index(page) + 1]
    if item and item.editable then edit(id, "keep") elseif item then control(id, "activate") end
  end, "activate the focused element")
  map("i", function() edit(id, "keep") end, "type into the focused field")
  map("a", function() edit(id, "keep") end, "type into the focused field")
  map("I", function() edit(id, "start") end, "type at the focused field's start")
  map("A", function() edit(id, "end") end, "type at the focused field's end")
  for _, lhs in ipairs(page.declared) do
    map(lhs, function() control(id, "key", { lhs = lhs }) end, "the page's " .. lhs)
  end
end

--- The window's maps and autocmds; again at every attach, since the
--- autocmds' group starts empty then.
local function watch(id, page)
  local buf = page.buf
  keymaps(id, page)
  vim.api.nvim_create_autocmd("CursorMoved", {
    group = group, buffer = buf, callback = function() control(id, "focus") end,
  })
  -- A click in another window while in the field: that window gets the
  -- cursor in normal mode, as leaving a field leaves its typing.
  vim.api.nvim_create_autocmd("WinLeave", {
    group = group, buffer = buf,
    callback = function() if M._editing == id then vim.cmd("stopinsert") end end,
  })
  vim.api.nvim_create_autocmd("TextChangedI", {
    group = group, buffer = buf, callback = function() render(page) end,
  })
end

function M._keyboard(id, buf)
  local page = { buf = buf, items = {}, declared = {} }
  M._pages[id] = page
  vim.bo[buf].modifiable = false
  vim.bo[buf].undolevels = -1
  watch(id, page)
end

for id, page in pairs(M._pages) do
  if vim.api.nvim_buf_is_valid(page.buf) then watch(id, page) else M._pages[id] = nil end
end

-- Leaving insert mode while in a field — <Esc> in it, <C-c>, a stopinsert —
-- gives the keyboard back. ModeChanged, since <C-c> runs no InsertLeave.
vim.api.nvim_create_autocmd("ModeChanged", {
  group = group,
  callback = function()
    local id = M._editing
    if not id or vim.v.event.new_mode:sub(1, 1) == "i" then return end
    M._editing = nil
    local page = M._pages[id]
    if page and vim.api.nvim_buf_is_valid(page.buf) then vim.bo[page.buf].modifiable = false end
    control(id, "leave")
  end,
})

--- The page's focusable elements: { { label, editable }, … }.
function M._gui_items(id, items)
  local page = M._pages[id]
  if not page or not vim.api.nvim_buf_is_valid(page.buf) then return end
  page.items = {}
  for _, item in ipairs(type(items) == "table" and items or {}) do
    local label = type(item) == "table" and type(item.label) == "string" and item.label or ""
    table.insert(page.items, { label = (label:gsub("%c", " ")), editable = item.editable == true })
  end
  render(page)
  control(id, "focus")
end

--- The page moved its focus (a click, <Tab> in a field): the cursor follows,
--- and the mode with it — insert in a field, normal elsewhere.
function M._gui_focused(id, index)
  local page = M._pages[id]
  if not page or type(index) ~= "number" then return end
  local item = page.items[index + 1]
  local win = gui_win(page.buf)
  if item and win then vim.api.nvim_win_set_cursor(win, { index + 1, 0 }) end
  if item and item.editable then
    if M._editing ~= id and win == vim.api.nvim_get_current_win() then
      M._editing = id
      vim.bo[page.buf].modifiable = true
      vim.cmd("startinsert")
      control(id, "edit", { caret = "keep" })
    end
  elseif M._editing == id then
    vim.cmd("stopinsert")
  end
end

--- The page's own keys (devhub.keys{ lhs = fn }): buffer-local maps that
--- tell it which was pressed.
function M._gui_declare(id, list)
  local page = M._pages[id]
  if not page or not vim.api.nvim_buf_is_valid(page.buf) then return end
  for _, lhs in ipairs(page.declared) do pcall(vim.keymap.del, "n", lhs, { buffer = page.buf }) end
  page.declared = {}
  for _, lhs in ipairs(type(list) == "table" and list or {}) do
    if type(lhs) == "string" and lhs ~= "" then table.insert(page.declared, lhs) end
  end
  keymaps(id, page)
end

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
  local payload = {
    title = opts.title and tostring(opts.title) or "",
    msg = tostring(opts.msg or opts.body or ""),
    level = level,
    timeout = type(opts.timeout) == "number" and opts.timeout or nil,
    group = opts.group and tostring(opts.group) or nil,
    key = opts.key and tostring(opts.key) or nil,
    progress = (opts.progress == true or opts.percent ~= nil) or nil,
    percent = type(opts.percent) == "number" and opts.percent or nil,
    done = opts.done == true or nil,
  }
  M._remember(payload)
  gui_event("notify", payload)
end

-- The notifications shown, oldest first, at most HISTORY_MAX: the toasts
-- fade, this is where they can be read again. Work in progress is kept
-- only once it is done (its ticks are not news); a key shown again
-- replaces its entry and moves it to the end. Kept across attaches.
local HISTORY_MAX = 200
M._history = M._history or {}

function M._remember(n)
  if n.progress and not n.done then return end
  if n.msg == "" and n.title == "" then return end
  local list = M._history
  if n.key then
    for i = #list, 1, -1 do
      if list[i].key == n.key then table.remove(list, i) break end
    end
  end
  table.insert(list, {
    time = os.time(),
    group = n.group or (n.title ~= "" and n.title or nil),
    title = n.title,
    msg = n.msg,
    level = n.level,
    key = n.key,
  })
  while #list > HISTORY_MAX do table.remove(list, 1) end
end

--- The notifications shown so far, oldest first: { time = os.time(), group,
--- title, msg, level = "debug" | "info" | "warn" | "error", key }, copies.
function M.history()
  return vim.deepcopy(M._history)
end

function M.clear_history()
  M._history = {}
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
--- the window the rows are counted with nvim_win_text_height from
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

--- The virt_lines rows Neovim draws under line lnum (1-based) of buf
--- before those of ns's mark: two images, cards or a plugin's virtual
--- lines under one line stack in the order the marks are kept, which is
--- the order nvim_buf_get_extmarks lists them in.
function M._rows_before(buf, ns, mark, lnum)
  local ok, marks = pcall(vim.api.nvim_buf_get_extmarks, buf, -1, { lnum - 1, 0 }, { lnum - 1, -1 },
    { details = true })
  if not ok then return 0 end
  local rows = 0
  for _, m in ipairs(marks) do
    local d = m[4] or {}
    if d.ns_id == ns and m[1] == mark then return rows end
    if d.virt_lines and not d.virt_lines_above then rows = rows + #d.virt_lines end
  end
  return 0
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
          local before = M._rows_before(image.buf, image_ns, image.mark, lnum)
          table.insert(images, { id = id, win = win, row = last + 1 + before, col = info.textoff,
            width = info.width - info.textoff, rows = image.rows })
        end
      end
    end
  end
  gui_event("place", { images = images })
end

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

--- :DevhubGuiDemo: a GUI window whose buttons drive the window beside it,
--- and a field that filters them: its keys are Neovim's (j/k, <CR>, :,
--- <C-w>), i types into the field and <Esc> leaves it.
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
button:hover,[data-devhub-focus]{background:rgba(127,127,127,.18)}
input{box-sizing:border-box;width:100%;margin:0 0 8px;padding:5px 8px;border-radius:6px;font:inherit;color:inherit;
  border:1px solid rgba(127,127,127,.35);background:transparent}
input:focus{outline:none;border-color:var(--devhub-ring,currentColor)}
.ln{opacity:.5;float:right;font-variant-numeric:tabular-nums}
.bar{display:flex;gap:6px;margin:0 0 10px}.bar button{background:rgba(127,127,127,.16);text-align:center}
.hint{opacity:.5;font-size:11px;margin:10px 0 0}
</style><h1 id="title">Outline</h1>
<div class="bar"><button id="top">gg</button><button id="bottom">G</button><button id="write">:write</button></div>
<input id="filter" placeholder="Filter" aria-label="Filter">
<div id="items"></div>
<p class="hint">j/k move · &lt;CR&gt; runs · i types in Filter, &lt;Esc&gt; leaves · X clears it</p><script>
const $ = (id) => document.getElementById(id);
$("top").onclick = () => devhub.send({kind:"command", command:"wincmd p | normal! gg"});
$("bottom").onclick = () => devhub.send({kind:"command", command:"wincmd p | normal! G"});
$("write").onclick = () => devhub.send({kind:"command", command:"wincmd p | write"});
let outline = [];
const draw = () => {
  const words = $("filter").value.toLowerCase();
  const box = $("items"); box.textContent = "";
  for (const item of outline) {
    if (words && !item.name.toLowerCase().includes(words)) continue;
    const b = document.createElement("button");
    b.innerHTML = "<span class=ln></span>"; b.firstChild.textContent = item.line;
    b.append(item.name);
    b.onclick = () => devhub.send({kind:"jump", line:item.line});
    box.append(b);
  }
};
$("filter").oninput = draw;
// A key of the page's own: Neovim maps it on this window's buffer.
devhub.keys({ X: () => { $("filter").value = ""; draw(); } });
devhub.onMessage((msg) => {
  if (msg.kind !== "outline") return;
  $("title").textContent = msg.file + " — " + msg.lines + " lines";
  outline = msg.items;
  draw();
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
		// What a pane's program needs to follow a `:restart`.
		await this.client.request("nvim_exec_lua", [RESTART_STATE_LUA, []]);
		// Views, inline cards and decorations (`gui.view`, `gui.inline`,
		// `gui.decorate`): the same module, grown by its own file.
		await this.client.request("nvim_exec_lua", [LAYERS_LUA, []]);
		// Where virtual text and folds' text are, for a proportional face.
		await this.client.request("nvim_exec_lua", [DECOR_LUA, []]);
		// Messages: cmdheight held through the attach, the pager, `q:`.
		await this.client.request("nvim_exec_lua", [MESSAGES_LUA, []]);
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
		// The person's cmdheight, held through the attach that zeroes it.
		await this.client.request("nvim_exec_lua", [
			"local M = package.loaded['devhub_gui']; if M and M._before_attach then M._before_attach() end",
			[],
		]);
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
				"local M = package.loaded['devhub_gui']; if M and M._keep_cmdheight then M._keep_cmdheight() end; if M and M._replay then M._replay() end",
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
					keyboard: open["keyboard"] === "content" ? "content" : "neovim",
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
