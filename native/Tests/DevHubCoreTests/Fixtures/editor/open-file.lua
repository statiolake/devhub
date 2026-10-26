
local path, line, column, marker = ...
local function given(value) return value ~= nil and value ~= vim.NIL end
local escaped = vim.fn.fnameescape(path)
if vim.fn.mode() ~= "n" then vim.cmd("stopinsert") end
if not pcall(vim.cmd, "drop " .. escaped) then vim.cmd("edit " .. escaped) end
if given(line) then
  local last = vim.api.nvim_buf_line_count(0)
  local row = math.max(1, math.min(line, last))
  local text = vim.api.nvim_buf_get_lines(0, row - 1, row, false)[1] or ""
  local byte = 0
  if given(column) and column > 1 then
    byte = vim.fn.byteidx(text, column - 1)
    if byte < 0 then byte = #text end
  end
  vim.api.nvim_win_set_cursor(0, { row, byte })
  vim.cmd("normal! zvzz")
end
if given(marker) then
  local buffer = vim.api.nvim_get_current_buf()
  local group = vim.api.nvim_create_augroup("devhub_wait_" .. tostring(vim.uv.hrtime()), { clear = true })
  local function done()
    os.remove(marker)
    pcall(vim.api.nvim_del_augroup_by_id, group)
  end
  vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout", "BufUnload" }, { group = group, buffer = buffer, once = true, callback = done })
  vim.api.nvim_create_autocmd("VimLeavePre", { group = group, once = true, callback = done })
end
