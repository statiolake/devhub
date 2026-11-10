/**
 * The Lua side of DevHub's messages (`ext_messages`; `docs/neovim-editor.md`,
 * "Messages"): run at every attach, after `SETUP_LUA`.
 *
 * - **`cmdheight` stays the person's.** A UI that takes `ext_messages` makes
 *   Neovim set `cmdheight` to 0 when it attaches (and to 1 when it goes):
 *   Neovim stops drawing messages there and leaves the rows to the UI. The
 *   rows a config keeps are where the person reads what they type, so the
 *   value is read just before that attach and put back after it; one the
 *   person sets while DevHub is attached is theirs, and kept for the next
 *   attach. A pane's `--embed` Neovim reads its config only after its first
 *   attach (`firstAttach`, `neovimUi.ts`): put back at once, and read after.
 * - **The search count while typing.** Neovim says `search_count` only once
 *   a search is entered; the box shows it as the pattern is typed, as the
 *   echo after Enter does (`searchcount()` on `CmdlineChanged`).
 * - **The command-line window.** `q:` is a real window; the page frames it
 *   as the command line's box grown upward, told which window it is.
 * - **The pager.** Long output, `:messages` and the notifications' history
 *   in a Neovim buffer in a float: read with the person's own keys (`j`/`k`,
 *   `/`, `y`), `q` to close, `<Tab>` between Messages and Notifications.
 *   `:DevhubNotifications` opens it.
 */
export const MESSAGES_LUA = String.raw`
local M = package.loaded["devhub_gui"]
if not M then return end
local api = vim.api
local group = api.nvim_create_augroup("devhub_gui_messages", { clear = true })

-- cmdheight: held through the attach (Neovim zeroes it for an
-- ext_messages UI), put back after; the person's own changes are kept.
local function ext_messages_ui()
  for _, ui in ipairs(api.nvim_list_uis()) do
    if ui.ext_messages then return true end
  end
  return false
end
api.nvim_create_autocmd("OptionSet", {
  group = group,
  pattern = "cmdheight",
  callback = function()
    -- A UI coming or going sets it too: that is not the person's.
    if M._holding or not ext_messages_ui() then return end
    M._cmdheight = vim.o.cmdheight
  end,
})
--- Just before the attach that takes ext_messages: the person's value is
--- what the config left (a pane's --embed Neovim reads its config only
--- once a UI has attached, so not earlier), unless an earlier attach of
--- DevHub's already knows it (its going set it to 1).
function M._before_attach()
  if M._cmdheight == nil then M._cmdheight = vim.o.cmdheight end
  M._holding = true
end
--- The attach that is a starting Neovim's first UI (an --embed one, which
--- reads its config only once that attach is through): the attach has just
--- zeroed cmdheight, before the config, so it is put back now; the config
--- then sets its own, without an OptionSet (none fires while Neovim starts),
--- and what it leaves is the person's, read once Neovim has started
--- (_keep_cmdheight, or VimEnter: a config that waits, vim.wait or
--- vim.system():wait(), has Neovim answer DevHub's next request before it
--- goes on).
function M._attached_first()
  M._attached_first_ui = true
  if M._cmdheight ~= nil and vim.o.cmdheight ~= M._cmdheight then vim.o.cmdheight = M._cmdheight end
  M._cmdheight = nil
  api.nvim_create_autocmd("VimEnter", {
    group = group,
    once = true,
    callback = function()
      if M._cmdheight == nil then M._cmdheight = vim.o.cmdheight end
    end,
  })
end
function M._keep_cmdheight()
  M._holding = false
  if M._cmdheight == nil then
    if vim.v.vim_did_enter == 1 then M._cmdheight = vim.o.cmdheight end
    return
  end
  if vim.o.cmdheight ~= M._cmdheight then vim.o.cmdheight = M._cmdheight end
end

-- The search count as the pattern is typed.
local function searching()
  local kind = vim.fn.getcmdtype()
  return kind == "/" or kind == "?"
end
api.nvim_create_autocmd("CmdlineChanged", {
  group = group,
  callback = function()
    if not searching() then return end
    local pattern = vim.fn.getcmdline()
    local text = ""
    if pattern ~= "" then
      local ok, c = pcall(vim.fn.searchcount,
        { pattern = pattern, recompute = true, maxcount = 999, timeout = 30 })
      if ok and type(c) == "table" and (c.total or 0) > 0 then
        local total = c.incomplete == 2 and (">" .. c.maxcount) or tostring(c.total)
        text = ("%d/%s"):format(c.current or 0, total)
      elseif ok then
        text = "0/0"
      end
    end
    M._event("search_count", { text = text })
  end,
})
api.nvim_create_autocmd("CmdlineLeave", {
  group = group,
  callback = function()
    if searching() then M._event("search_count", { text = "" }) end
  end,
})

-- The command-line window: which window the box grows over.
local function cmdwin_report()
  local kind = vim.fn.getcmdwintype()
  if kind == "" then
    M._event("cmdwin", { win = 0 })
  else
    M._event("cmdwin", { win = api.nvim_get_current_win(), type = kind })
  end
end
api.nvim_create_autocmd({ "CmdwinEnter", "CmdwinLeave" }, {
  group = group,
  callback = function(ev)
    if ev.event == "CmdwinLeave" then
      M._event("cmdwin", { win = 0 })
    else
      cmdwin_report()
    end
  end,
})
M._cmdwin_report = cmdwin_report

-- The pager.
local ns = api.nvim_create_namespace("devhub_gui_pager")
local P = M._pager_state or {}
M._pager_state = P

local function width_of(s) return vim.fn.strdisplaywidth(s) end

--- A header or footer of chunks across width cells: left, a gap, right.
local function spread(left, right, width)
  local used = 0
  for _, c in ipairs(left) do used = used + width_of(c[1]) end
  for _, c in ipairs(right) do used = used + width_of(c[1]) end
  local out = vim.list_extend({}, left)
  table.insert(out, { (" "):rep(math.max(1, width - used)), "NormalFloat" })
  return vim.list_extend(out, right)
end

local function close()
  if P.win and api.nvim_win_is_valid(P.win) then
    pcall(api.nvim_win_close, P.win, true)
  end
  P.win = nil
  M._event("pager", { win = 0 })
end
M._pager_close = close

local function buffer()
  if P.buf and api.nvim_buf_is_valid(P.buf) then return P.buf end
  local buf = api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "devhub_pager"
  local function map(lhs, fn)
    vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true, desc = "DevHub pager" })
  end
  map("q", close)
  map("<Esc>", close)
  -- Enter closes, as it dismissed Neovim's own hit-enter prompt.
  map("<CR>", close)
  map("<Tab>", function()
    if P.source ~= "notifications" then return M.notifications() end
    -- :messages comes back to the page (msg_history_show), which shows it
    -- here with its highlights; an empty history says nothing at all.
    if vim.trim(vim.fn.execute("messages")) == "" then
      M._pager_show({ source = "messages", lines = {} })
    else
      vim.cmd("messages")
    end
  end)
  -- Out of the pager is done with it, as a hit-enter screen is.
  api.nvim_create_autocmd("WinLeave", {
    buffer = buf,
    callback = function() vim.schedule(close) end,
  })
  P.buf = buf
  return buf
end

--- Show lines ({ { text, hl }, … } each; hl a group's id or name) in the
--- pager: source "output" (title is the command), "messages" or
--- "notifications" (the two tabs).
function M._pager_show(opts)
  local source = opts.source or "output"
  local lines = opts.lines or {}
  local buf = buffer()
  local text, marks = {}, {}
  for i, line in ipairs(lines) do
    local parts, col = {}, 0
    for _, chunk in ipairs(line) do
      local s = tostring(chunk[1] or ""):gsub("[\r\n]", " ")
      table.insert(parts, s)
      local hl = chunk[2]
      if hl and hl ~= 0 and hl ~= "" and #s > 0 then
        table.insert(marks, { i - 1, col, col + #s, hl })
      end
      col = col + #s
    end
    table.insert(text, table.concat(parts))
  end
  if #text == 0 then
    text = { source == "notifications" and "No notifications yet" or "No messages" }
    marks = { { 0, 0, #text[1], "Comment" } }
  end
  vim.bo[buf].modifiable = true
  api.nvim_buf_set_lines(buf, 0, -1, false, text)
  vim.bo[buf].modifiable = false
  api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  for _, m in ipairs(marks) do
    pcall(api.nvim_buf_set_extmark, buf, ns, m[1], m[2], { end_col = m[3], hl_group = m[4] })
  end
  P.source = source

  -- Across the editor, its bottom on the lowest status line's top: where
  -- the eye already is after typing a command, over the windows like
  -- Neovim's own scrolled messages, and as wide as lines of output are.
  local columns, total = vim.o.columns, vim.o.lines
  local status = vim.o.laststatus == 0 and 0 or 1
  local room = total - vim.o.cmdheight - status - 2 - (vim.o.showtabline == 2 and 1 or 0)
  local width = math.max(20, columns - 2)
  -- As tall as its lines are on screen (a long one wraps), at most 60 % of
  -- the room: the windows above stay in sight, it is a look, not a switch.
  -- The text starts a cell in (a fold column of the float's ground), in
  -- the column the header's and footer's words start: not on the frame.
  local rows = 0
  for _, line in ipairs(text) do
    rows = rows + math.max(1, math.ceil(width_of(line) / (width - 1)))
  end
  local height = math.max(1, math.min(rows, math.floor(room * 0.6)))
  -- Comment's colour on the float's ground: header and footer words.
  local float = api.nvim_get_hl(0, { name = "NormalFloat", link = false })
  local comment = api.nvim_get_hl(0, { name = "Comment", link = false })
  api.nvim_set_hl(0, "DevhubPagerDim", { fg = comment.fg, bg = float.bg, italic = comment.italic })
  local tabs = source == "output"
      and { { " " .. (opts.title or "Output"), "NormalFloat" } }
      or {
        { " Messages", source == "messages" and "NormalFloat" or "DevhubPagerDim" },
        { "   Notifications", source == "notifications" and "NormalFloat" or "DevhubPagerDim" },
      }
  local n = opts.count or #lines
  local noun = source == "notifications" and "notification" or "line"
  local count = n .. " " .. noun .. (n == 1 and "" or "s")
  local title = spread(tabs, { { count .. " · newest last ", "DevhubPagerDim" } }, width)
  local footer = spread({
    { " j k", "NormalFloat" }, { " move   ", "DevhubPagerDim" },
    { "/", "NormalFloat" }, { " search   ", "DevhubPagerDim" },
    { "y", "NormalFloat" }, { " yank   ", "DevhubPagerDim" },
    { "⇥", "NormalFloat" },
    { source == "notifications" and " messages" or " notifications", "DevhubPagerDim" },
  }, { { "q", "NormalFloat" }, { " close ", "DevhubPagerDim" } }, width)
  local config = {
    relative = "editor",
    anchor = "SW",
    row = total - vim.o.cmdheight - status,
    col = 0,
    width = width,
    height = height,
    border = "solid",
    title = title,
    title_pos = "left",
    footer = footer,
    footer_pos = "left",
    zindex = 150,
  }
  if P.win and api.nvim_win_is_valid(P.win) then
    api.nvim_win_set_config(P.win, config)
    api.nvim_set_current_win(P.win)
  else
    config.style = "minimal"
    P.win = api.nvim_open_win(buf, true, config)
  end
  local wo = vim.wo[P.win]
  wo.wrap = true
  wo.linebreak = true
  wo.cursorline = true
  wo.foldcolumn = "1"
  wo.foldenable = false
  wo.winhighlight = "NormalFloat:NormalFloat,FloatBorder:NormalFloat,FoldColumn:NormalFloat,"
    .. "CursorLineFold:CursorLine"
  -- Newest last, as :messages: the cursor on the newest, the view ending
  -- there (a view left scrolled by the last content would hide the first).
  api.nvim_win_set_cursor(P.win, { #text, 0 })
  api.nvim_win_call(P.win, function() vim.cmd("normal! zb") end)
  -- Notifications rise above it, as above the command line's box.
  M._event("pager", { win = P.win })
end

local LEVEL_HL = { error = "DiagnosticError", warn = "DiagnosticWarn" }

--- The notifications' history (gui.history) in the pager.
function M.notifications()
  local list = M.history and M.history() or {}
  local widest = 0
  for _, n in ipairs(list) do
    widest = math.max(widest, width_of(n.group or n.title or ""))
  end
  widest = math.min(widest, 20)
  local lines = {}
  for _, n in ipairs(list) do
    local source = n.group or (n.title ~= "" and n.title) or ""
    if width_of(source) > widest then source = vim.fn.strcharpart(source, 0, widest - 1) .. "…" end
    local pad = (" "):rep(widest - width_of(source))
    local msg_hl = LEVEL_HL[n.level] or "Comment"
    local msg = n.msg ~= "" and n.msg or n.title or ""
    for i, part in ipairs(vim.split(msg, "\n", { plain = true })) do
      if i == 1 then
        table.insert(lines, {
          { os.date("%H:%M", n.time) .. "  ", "Comment" },
          { source .. pad .. "  ", "NormalFloat" },
          { part, msg_hl },
        })
      else
        table.insert(lines, { { (" "):rep(7 + widest + 2) .. part, msg_hl } })
      end
    end
  end
  M._pager_show({ source = "notifications", lines = lines, count = #list })
end

pcall(api.nvim_del_user_command, "DevhubNotifications")
api.nvim_create_user_command("DevhubNotifications", function() M.notifications() end,
  { desc = "DevHub: the notifications shown, in the pager" })
`;
