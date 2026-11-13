/**
 * `gui.document`: a document DevHub renders — Markdown, by the renderer the
 * conversation and the Orchestrator draw with — painted over a Neovim
 * window, as `gui.view` paints a list. Run on the server after `LAYERS_LUA`
 * at every attach, in the same `devhub_gui` module.
 *
 * Neovim keeps the window, the keys and the state: the window is an
 * ordinary split on a scratch buffer that holds the document's text (line N
 * of the buffer is line N of the source, so `/` finds a word in it and
 * `:42` goes to its line), and its keys are buffer maps. The page keeps
 * only how far down, in pixels, the drawing is scrolled: the keys ask it to
 * scroll (`document_scroll`), and it says back which source lines it shows
 * (`_document_view`), which become the window's view. A link is followed
 * by the page, as a click on it would be; a file the document names is
 * found and read here, on the Neovim's machine (an SSH host's too), never
 * fetched. See `docs/neovim-editor.md`, "Documents".
 */
export const DOCUMENT_LUA = String.raw`
local M = package.loaded["devhub_gui"]
local event = M._event
M._documents = M._documents or {}
local group = vim.api.nvim_create_augroup("devhub_gui_document", { clear = true })

local scroll_seq = 0
local function next_seq()
  scroll_seq = scroll_seq + 1
  return scroll_seq
end

local function split_lines(text)
  if type(text) == "table" then return text end
  local lines = vim.split(tostring(text or ""), "\n", { plain = true })
  if #lines > 1 and lines[#lines] == "" then table.remove(lines) end
  return lines
end

local function send(doc)
  event("document", { id = doc.id, format = doc.format, text = table.concat(doc.lines, "\n"),
    base = doc.base, remote_images = doc.remote_images or nil, title = doc.title })
end

local function set_lines(doc)
  if not vim.api.nvim_buf_is_valid(doc.buf) then return end
  vim.bo[doc.buf].modifiable = true
  vim.api.nvim_buf_set_lines(doc.buf, 0, -1, false, doc.lines)
  vim.bo[doc.buf].modifiable = false
  vim.bo[doc.buf].modified = false
end

-- The links of a source line, in order: [text](href "title"), <scheme:...>,
-- and bare http(s) URLs. What the page draws as a link is the judge: a match
-- that is no link there (code) is passed over by the page.
local function links_of(line)
  local out, taken = {}, {}
  for from, href in line:gmatch("()%b[]%(%s*<?([^%s%)>]+)") do
    table.insert(out, { col = from, href = href })
    taken[href] = true
  end
  for from, href in line:gmatch("()<(%a[%w+.-]*:[^%s>]+)>") do
    table.insert(out, { col = from, href = href })
    taken[href] = true
  end
  for from, href in line:gmatch("()(https?://[^%s%)>%]]+)") do
    if not taken[href] then table.insert(out, { col = from, href = href }) end
  end
  table.sort(out, function(a, b) return a.col < b.col end)
  return out
end
M._document_links_of = links_of

local function doc_win(doc)
  if doc.win and vim.api.nvim_win_is_valid(doc.win) and vim.api.nvim_win_get_buf(doc.win) == doc.buf then
    return doc.win
  end
  local win = vim.fn.win_findbuf(doc.buf)[1]
  doc.win = win
  return win
end

local function scroll(doc, by, n, line)
  event("document_scroll", { id = doc.id, seq = next_seq(), by = by, n = n or 1, line = line })
end

-- The next (dir 1) or previous (dir -1) link from the focused one — from
-- the top (or the foot) of what is in sight when that is not in sight.
local function move_focus(doc, dir)
  local view = doc.view or { top = 1, bottom = #doc.lines }
  local focus = doc.focus
  if focus and (focus.line < view.top or focus.line > view.bottom) then focus = nil end
  local line, index
  if focus then
    line, index = focus.line, focus.index + dir
  elseif dir > 0 then
    line, index = view.top, 1
  else
    line, index = view.bottom, math.huge
  end
  while line >= 1 and line <= #doc.lines do
    local links = links_of(doc.lines[line] or "")
    if index == math.huge then index = #links end
    if links[index] then
      doc.focus = { line = line, index = index, href = links[index].href }
      M._schedule_place()
      return
    end
    line = line + dir
    index = dir > 0 and 1 or math.huge
  end
end

-- Follow the focused link (else the first in sight): the page does, as a
-- click on it would — a URL in the browser, a file in Neovim, an anchor in
-- the document.
local function activate(doc)
  if not doc.focus then move_focus(doc, 1) end
  local f = doc.focus
  if f then event("document_activate", { id = doc.id, seq = next_seq(), line = f.line, href = f.href }) end
end

local function back(doc)
  local to = vim.fn.win_getid(vim.fn.winnr("#"))
  if to == 0 or to == vim.api.nvim_get_current_win() then to = doc.source_win end
  if to and to ~= 0 and vim.api.nvim_win_is_valid(to) then vim.api.nvim_set_current_win(to) end
end

local function keymaps(doc)
  local function map(lhs, fn, desc)
    vim.keymap.set("n", lhs, fn, { buffer = doc.buf, nowait = true, desc = "DevHub document: " .. desc })
  end
  local function count() return math.max(1, vim.v.count1) end
  map("j", function() scroll(doc, "line", count()) end, "scroll down")
  map("k", function() scroll(doc, "line", -count()) end, "scroll up")
  map("<Down>", function() scroll(doc, "line", count()) end, "scroll down")
  map("<Up>", function() scroll(doc, "line", -count()) end, "scroll up")
  map("<C-e>", function() scroll(doc, "line", count()) end, "scroll down")
  map("<C-y>", function() scroll(doc, "line", -count()) end, "scroll up")
  map("<C-d>", function() scroll(doc, "half", count()) end, "half a page down")
  map("<C-u>", function() scroll(doc, "half", -count()) end, "half a page up")
  map("<C-f>", function() scroll(doc, "page", count()) end, "a page down")
  map("<C-b>", function() scroll(doc, "page", -count()) end, "a page up")
  map("<PageDown>", function() scroll(doc, "page", count()) end, "a page down")
  map("<PageUp>", function() scroll(doc, "page", -count()) end, "a page up")
  map("<Space>", function() scroll(doc, "page", count()) end, "a page down")
  map("gg", function() scroll(doc, "top") end, "the top")
  map("G", function() scroll(doc, "bottom") end, "the end")
  map("<Tab>", function() move_focus(doc, 1) end, "the next link")
  map("<S-Tab>", function() move_focus(doc, -1) end, "the previous link")
  map("<CR>", function() activate(doc) end, "follow the link")
  map("<Esc>", function() back(doc) end, "back to the editor")
  map("q", function() M.document_close(doc.id) end, "close")
end

local function open_window(doc, how, enter)
  local source = vim.api.nvim_get_current_win()
  if type(how) == "number" and how ~= 0 and vim.api.nvim_win_is_valid(how) then
    vim.api.nvim_win_set_buf(how, doc.buf)
    return how, source
  end
  local side = ({ right = "right", left = "left", below = "below", above = "above",
    vsplit = "right", split = "below" })[how or "right"] or "right"
  local win = vim.api.nvim_open_win(doc.buf, enter == true, { split = side, win = source })
  return win, source
end

local function window_options(win)
  for option, value in pairs({ number = false, relativenumber = false, signcolumn = "no", foldcolumn = "0",
                               list = false, cursorline = false, cursorcolumn = false, spell = false,
                               wrap = false, scrolloff = 0, colorcolumn = "", foldenable = false }) do
    pcall(function() vim.wo[win][option] = value end)
  end
  pcall(function() vim.wo[win].winfixbuf = true end)
end

--- gui.document{ text, format = 'markdown', base = dir, split = 'right' |
--- 'left' | 'below' | 'above' | win, enter = false, title, remote_images =
--- false, on_link = fn(link), on_close = fn(handle), scroll = { line } }:
--- text drawn by DevHub in a
--- window of its own, beside the current one (or in win). base: the folder
--- relative links and pictures are found in, on this Neovim's machine.
--- on_link(link) — link = { path, line?, col?, href } — is asked first when a
--- link to a file is followed (true: it was handled); else the file opens
--- in the window the document was opened from. A URL opens in the browser;
--- a #fragment scrolls the document. Its window's keys: j/k, <C-d>/<C-u>,
--- <C-f>/<C-b>, gg/G scroll; <Tab>/<S-Tab> move between links, <CR> follows
--- one; <Esc> goes back; q closes. Answers a handle: :update(text, base?),
--- :scroll_to(line) (the source line at the top), :close(), :is_open(),
--- :view() ({ top, bottom }: the source lines in sight).
function M.document(opts)
  opts = opts or {}
  local format = opts.format or "markdown"
  if format ~= "markdown" then error("devhub_gui.document: format must be 'markdown'") end
  local doc = { id = M._next + 1, format = format, lines = split_lines(opts.text),
    base = opts.base and vim.fn.fnamemodify(vim.fn.expand(opts.base), ":p"):gsub("/$", "") or vim.fn.getcwd(),
    title = opts.title, on_link = opts.on_link, on_close = opts.on_close, remote_images = opts.remote_images == true }
  M._next = doc.id
  doc.buf = vim.api.nvim_create_buf(false, true)
  vim.bo[doc.buf].buftype = "nofile"
  vim.bo[doc.buf].bufhidden = "wipe"
  vim.bo[doc.buf].swapfile = false
  vim.bo[doc.buf].undolevels = -1
  vim.api.nvim_buf_set_var(doc.buf, "devhub_document_id", doc.id)
  pcall(vim.api.nvim_buf_set_name, doc.buf, "devhub://document/" .. doc.id .. "/" .. (opts.title or "preview"))
  set_lines(doc)
  vim.bo[doc.buf].filetype = "devhub_document"
  M._documents[doc.id] = doc
  doc.win, doc.source_win = open_window(doc, opts.split or opts.win, opts.enter)
  window_options(doc.win)
  keymaps(doc)
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group, buffer = doc.buf, once = true,
    callback = function() M.document_close(doc.id, true) end,
  })
  send(doc)
  if type(opts.scroll) == "table" and type(opts.scroll.line) == "number" then
    scroll(doc, "to", 1, opts.scroll.line)
  end
  M._schedule_place()

  local handle = { id = doc.id, buf = doc.buf, win = doc.win }
  local function args(self, ...)
    if type(self) == "table" and self.id == doc.id then return ... end
    return self, ...
  end
  function handle.update(...)
    local text, base = args(...)
    if M._documents[doc.id] ~= doc then return end
    doc.lines = split_lines(text)
    if base then doc.base = vim.fn.fnamemodify(vim.fn.expand(base), ":p"):gsub("/$", "") end
    set_lines(doc)
    send(doc)
    M._schedule_place()
  end
  function handle.scroll_to(...)
    local line = args(...)
    if M._documents[doc.id] ~= doc or type(line) ~= "number" then return end
    scroll(doc, "to", 1, math.max(1, math.floor(line)))
  end
  function handle.close() M.document_close(doc.id) end
  function handle.is_open() return M._documents[doc.id] == doc end
  function handle.view() return doc.view and vim.deepcopy(doc.view) or nil end
  doc.handle = handle
  return handle
end

function M.document_close(id, wiped)
  local doc = M._documents[id]
  if not doc then return end
  M._documents[id] = nil
  event("document_clear", { id = id })
  if not wiped and vim.api.nvim_buf_is_valid(doc.buf) then
    pcall(vim.api.nvim_buf_delete, doc.buf, { force = true })
  end
  if type(doc.on_close) == "function" then
    local ok, err = pcall(doc.on_close, doc.handle)
    if not ok then vim.notify("devhub document: " .. tostring(err), vim.log.levels.ERROR) end
  end
  M._schedule_place()
end

-- The page ----------------------------------------------------------------

--- The page scrolled the drawing (a key, the wheel, a link to a heading):
--- the source lines it shows, top and bottom. The window's view follows,
--- with its cursor on the top line.
function M._document_view(id, top, bottom)
  local doc = M._documents[id]
  if not doc or type(top) ~= "number" then return end
  local count = math.max(1, #doc.lines)
  top = math.min(math.max(1, math.floor(top)), count)
  bottom = math.min(math.max(top, math.floor(tonumber(bottom) or top)), count)
  doc.view = { top = top, bottom = bottom }
  doc.told = top
  local win = doc_win(doc)
  if win then
    pcall(vim.api.nvim_win_call, win, function()
      vim.fn.winrestview({ topline = top, lnum = top, col = 0 })
    end)
  end
  M._schedule_place()
end

--- A click in the document: its window becomes the current one.
function M._document_focus(id)
  local doc = M._documents[id]
  local win = doc and doc_win(doc)
  if win then vim.api.nvim_set_current_win(win) end
end

local function absolute(doc, path)
  if type(path) ~= "string" or path == "" then return nil end
  path = vim.fn.expand(path)
  if path:sub(1, 1) ~= "/" then path = doc.base .. "/" .. path end
  return vim.fs.normalize(path)
end

--- Which of paths name a file here (relative ones to base, or to cwd when
--- given): the absolute path, or vim.NIL. A request: the page waits on it.
function M._document_resolve(id, cwd, paths)
  local doc = M._documents[id]
  local out = {}
  for i, path in ipairs(type(paths) == "table" and paths or {}) do
    local found = vim.NIL
    if doc then
      local base = type(cwd) == "string" and cwd ~= "" and cwd or doc.base
      local abs = absolute({ base = base }, path)
      local stat = abs and vim.uv.fs_stat(abs)
      if stat and stat.type == "file" then found = abs end
    end
    out[i] = found
  end
  return out
end

-- A file read for the page is at most this big: a picture, not a disk image.
local MAX_READ = 20 * 1024 * 1024
local MIME = { png = "image/png", jpg = "image/jpeg", jpeg = "image/jpeg", gif = "image/gif",
  svg = "image/svg+xml", webp = "image/webp", avif = "image/avif", bmp = "image/bmp",
  md = "text/markdown", markdown = "text/markdown", mmd = "text/plain", txt = "text/plain" }

local function signature(stat)
  return string.format("%d:%d.%d", stat.size, stat.mtime.sec, stat.mtime.nsec or 0)
end

--- A file's bytes for the page (a picture the document draws), base64:
--- { media_type, base64, signature }, or vim.NIL when it is not there.
function M._document_read(id, path)
  if not M._documents[id] or type(path) ~= "string" then return vim.NIL end
  local stat = vim.uv.fs_stat(path)
  if not stat or stat.type ~= "file" or stat.size > MAX_READ then return vim.NIL end
  local file = io.open(path, "rb")
  if not file then return vim.NIL end
  local bytes = file:read("*a")
  file:close()
  local ext = (path:match("%.([%w]+)$") or ""):lower()
  return { media_type = MIME[ext] or "application/octet-stream", base64 = vim.base64.encode(bytes),
    signature = signature(stat) }
end

--- What changes when that file does, or vim.NIL when it is gone.
function M._document_signature(id, path)
  if not M._documents[id] or type(path) ~= "string" then return vim.NIL end
  local stat = vim.uv.fs_stat(path)
  return stat and signature(stat) or vim.NIL
end

--- A link to a file was followed (path absolute, as _document_resolve
--- answered): the document's on_link first, else the file in the window the
--- document was opened from, at line (and col).
function M._document_open(id, path, line, col)
  local doc = M._documents[id]
  if not doc or type(path) ~= "string" then return end
  local link = { path = path, line = type(line) == "number" and line or nil,
    col = type(col) == "number" and col or nil, href = path }
  if type(doc.on_link) == "function" then
    local ok, handled = pcall(doc.on_link, link)
    if not ok then vim.notify("devhub document: " .. tostring(handled), vim.log.levels.ERROR) end
    if ok and handled then return end
  end
  local target = doc.source_win
  if not (target and vim.api.nvim_win_is_valid(target)) or target == doc_win(doc) then
    target = vim.fn.win_getid(vim.fn.winnr("#"))
  end
  if target ~= 0 and vim.api.nvim_win_is_valid(target) then vim.api.nvim_set_current_win(target) end
  local ok, err = pcall(vim.cmd.edit, vim.fn.fnameescape(path))
  if not ok then
    vim.notify("devhub document: " .. tostring(err), vim.log.levels.ERROR)
    return
  end
  if link.line then
    pcall(vim.api.nvim_win_set_cursor, 0, { link.line, math.max(0, (link.col or 1) - 1) })
  end
end

--- Something the page could not do for the document (a file that is not
--- there), said where Neovim says things.
function M._document_say(message)
  if type(message) == "string" and message ~= "" then
    vim.notify("devhub document: " .. message, vim.log.levels.WARN)
  end
end

-- Placement ----------------------------------------------------------------

--- Where each document is: its window (in this tab page), the line at the
--- window's top (Neovim moved it: a search, :42), whether it is current,
--- and the link that has the keyboard's focus.
function M._document_places()
  local out = {}
  local current = vim.api.nvim_get_current_win()
  for id, doc in pairs(M._documents) do
    if not vim.api.nvim_buf_is_valid(doc.buf) then
      M.document_close(id, true)
    else
      for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        if vim.api.nvim_win_get_buf(win) == doc.buf then
          local topline = vim.fn.line("w0", win)
          local entry = { id = id, win = win, topline = topline, current = win == current,
            told = doc.told == topline or nil }
          if doc.focus then entry.focus = { line = doc.focus.line, href = doc.focus.href } end
          table.insert(out, entry)
        end
      end
    end
  end
  return out
end

function M._document_replay()
  for _, doc in pairs(M._documents) do send(doc) end
end

local base_layers_replay = M._layers_replay
function M._layers_replay()
  M._document_replay()
  base_layers_replay()
end

-- Where the documents are goes with every placement of the layers (after a
-- scroll, a cursor move, a window change): its own event, beside "layers".
local base_place = M._place_layers
function M._place_layers()
  base_place()
  if next(M._documents) ~= nil or M._documents_placed then
    M._documents_placed = next(M._documents) ~= nil
    event("documents", { documents = M._document_places() })
  end
end

-- Neovim scrolled a document's window itself (a search, :42), or moved it.
vim.api.nvim_create_autocmd({ "WinScrolled", "WinResized", "WinClosed", "WinNew", "WinEnter", "BufWinEnter",
  "TabEnter", "VimResized", "CursorMoved" }, {
  group = group,
  callback = function()
    if next(M._documents) ~= nil then M._schedule_place() end
  end,
})
`;
