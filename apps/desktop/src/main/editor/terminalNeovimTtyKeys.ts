/**
 * What tmux writes into the pane of a Neovim DevHub draws, as that Neovim's
 * input (`docs/neovim-editor.md`, "The keyboard").
 *
 * The keys typed in the overlay reach its Neovim over RPC, never through the
 * pane: the Neovim the shim runs reads no tty (`--embed`). But tmux still writes into the pane whatever a binding hands it —
 * `send-prefix` (the prefix pressed twice), a `send-keys` binding,
 * `paste-buffer`, a `devhub tell` typed into the terminal — and before this
 * the pane's tty took those bytes and nobody read them. So while DevHub's UI
 * is attached the pane's `nvim` (`cli/nvim.go`) puts the tty in raw mode and
 * runs this Lua, written beside it (`NVIM_SHIM_KEYS_FILE`), in a second, bare
 * `nvim -l` (DevHub's Neovim, there on this Mac and on an SSH host alike),
 * which reads the tty and hands each key to the Neovim over its own socket:
 * `nvim_input` in `<>` notation, and a bracketed paste as one `nvim_paste`.
 *
 * Like Neovim's TUI it asks the terminal (tmux) for bracketed paste
 * (`CSI ? 2004 h`, which `paste-buffer -p` — tmux's `]` — honours) and for
 * modifyOtherKeys (`CSI > 4 ; 2 m`, which tmux honours with `extended-keys
 * on`), and it reads every encoding tmux may answer with: the legacy bytes,
 * CSI u (`extended-keys-format csi-u`), xterm's `CSI 27 ; m ; c ~`, cursor
 * and function keys with their modifiers, and ESC before a key as Alt. The
 * pane's `nvim` states the modes before it runs this and resets them, and
 * the tty, once Neovim has exited.
 *
 * Nothing typed in the overlay comes this way, so nothing comes twice: the
 * overlay's keys are RPC, and a key the terminal page would hand to the pane
 * under it is taken from the page instead (`ShellWindow.terminalPage`).
 *
 * Arguments: the socket, and the shim's pid, whose end is this one's too. A
 * socket that closes (Neovim restarting on it) is connected to again.
 */
export const TTY_KEYS_LUA = String.raw`local uv = vim.uv or vim.loop
local socket, parent = _G.arg[1], tonumber(_G.arg[2])

-- Keys read before the socket is connected (again) wait for it.
local out, waiting = nil, {}
local function connect()
	local pipe = uv.new_pipe(false)
	pipe:connect(socket, function(err)
		if err then
			pipe:close()
			vim.defer_fn(connect, 100)
			return
		end
		out = pipe
		for _, message in ipairs(waiting) do pipe:write(message) end
		waiting = {}
		pipe:read_start(function(failed, data)
			if failed or not data then
				out = nil
				pipe:close()
				vim.defer_fn(connect, 100)
			end
		end)
	end)
end
local function send(method, args)
	local message = vim.mpack.encode({ 2, method, args })
	if out then out:write(message) else waiting[#waiting + 1] = message end
end

-- Legacy bytes, as Neovim's TUI names them.
local CONTROL = {
	[0] = "<C-Space>", [8] = "<C-h>", [9] = "<Tab>", [10] = "<C-j>", [13] = "<CR>",
	[27] = "<Esc>", [28] = "<C-Bslash>", [29] = "<C-]>", [30] = "<C-^>", [31] = "<C-_>",
	[127] = "<BS>",
}
-- A code point by its name in <> notation, where it has one.
local NAMED = {
	[9] = "Tab", [13] = "CR", [27] = "Esc", [32] = "Space", [60] = "lt",
	[92] = "Bslash", [124] = "Bar", [127] = "BS",
}
local FINAL = {
	A = "Up", B = "Down", C = "Right", D = "Left", H = "Home", F = "End",
	P = "F1", Q = "F2", R = "F3", S = "F4", I = "FocusGained", O = "FocusLost",
}
local TILDE = {
	[1] = "Home", [2] = "Insert", [3] = "Del", [4] = "End", [5] = "PageUp",
	[6] = "PageDown", [7] = "Home", [8] = "End", [11] = "F1", [12] = "F2",
	[13] = "F3", [14] = "F4", [15] = "F5", [17] = "F6", [18] = "F7", [19] = "F8",
	[20] = "F9", [21] = "F10", [23] = "F11", [24] = "F12",
}

local function utf8(c)
	if c < 0x80 then return string.char(c) end
	if c < 0x800 then return string.char(0xC0 + math.floor(c / 0x40), 0x80 + c % 0x40) end
	if c < 0x10000 then
		return string.char(0xE0 + math.floor(c / 0x1000), 0x80 + math.floor(c / 0x40) % 0x40, 0x80 + c % 0x40)
	end
	return string.char(0xF0 + math.floor(c / 0x40000), 0x80 + math.floor(c / 0x1000) % 0x40,
		0x80 + math.floor(c / 0x40) % 0x40, 0x80 + c % 0x40)
end

-- A key with xterm's modifier parameter (1 + Shift 1, Alt 2, Ctrl 4, Super 8).
local function key(name, modifier)
	local m, prefix = (tonumber(modifier) or 1) - 1, ""
	if m % 2 >= 1 then prefix = prefix .. "S-" end
	if m % 4 >= 2 then prefix = prefix .. "M-" end
	if m % 8 >= 4 then prefix = prefix .. "C-" end
	if m % 16 >= 8 then prefix = prefix .. "D-" end
	if prefix == "" and #name == 1 then return name end
	if prefix == "" and name:byte(1) >= 0x80 then return name end
	return "<" .. prefix .. name .. ">"
end
local function codepoint(c, modifier)
	return key(NAMED[c] or utf8(c), modifier)
end

-- One escape sequence at the start of s: the key, or false for one that is
-- not a key; nil when s ends before the sequence does.
local function sequence(s)
	local params, final, after = s:match("^\27[%[O]([%d;:]*)([%a~])()")
	if not final then
		if s:find("^\27[%[O][%d;:]*$") then return nil end
		return false, 3
	end
	local p = vim.split(params, ";", { plain = true })
	local modifier = p[2] and p[2]:match("^%d+")
	if final == "u" then
		local c = tonumber(p[1]:match("^%d+"))
		return c and codepoint(c, modifier) or false, after
	elseif final == "~" and p[1] == "27" then
		local c = tonumber(p[3])
		return c and codepoint(c, modifier) or false, after
	elseif final == "~" then
		local name = TILDE[tonumber(p[1]) or -1]
		return name and key(name, modifier) or false, after
	elseif final == "Z" then
		return "<S-Tab>", after
	end
	local name = FINAL[final]
	return name and key(name, modifier) or false, after
end

local PASTE_START, PASTE_END = "\27[200~", "\27[201~"
local rest, paste = "", nil
local function feed(data)
	local s, keys = rest .. data, {}
	rest = ""
	local function flush()
		if #keys > 0 then
			send("nvim_input", { table.concat(keys) })
			keys = {}
		end
	end
	while #s > 0 do
		if paste then
			paste = paste .. s
			local e = paste:find(PASTE_END, 1, true)
			if not e then break end
			s = paste:sub(e + #PASTE_END)
			send("nvim_paste", { paste:sub(1, e - 1), true, -1 })
			paste = nil
		elseif s:sub(1, #PASTE_START) == PASTE_START then
			flush()
			paste, s = "", s:sub(#PASTE_START + 1)
		else
			local b, intro = s:byte(1), s:sub(2, 2)
			if b == 27 and (intro == "[" or intro == "O") then
				local name, after = sequence(s)
				if name == nil then
					rest = s
					break
				end
				if name then keys[#keys + 1] = name end
				s = s:sub(after)
			elseif b == 27 and #s > 1 then
				-- ESC before a key is that key with Alt, as a terminal sends it.
				local c = s:byte(2)
				local inner = CONTROL[c] and CONTROL[c]:sub(2, -2)
					or (c < 32 and "C-" .. string.char(c + 96))
					or NAMED[c]
					or s:sub(2, 2)
				keys[#keys + 1] = "<M-" .. inner .. ">"
				s = s:sub(3)
			elseif b < 32 or b == 127 then
				keys[#keys + 1] = CONTROL[b] or "<C-" .. string.char(b + 96) .. ">"
				s = s:sub(2)
			else
				-- Text, a UTF-8 character's bytes as they come; only < is special.
				local text = s:match("^[^%c\27]+")
				keys[#keys + 1] = (text:gsub("<", "<lt>"))
				s = s:sub(#text + 1)
			end
		end
	end
	flush()
end

local input
if uv.guess_handle(0) == "tty" then
	input = uv.new_tty(0, true)
else
	input = uv.new_pipe(false)
	input:open(0)
end
input:read_start(function(err, data)
	if err or not data then os.exit(0) end
	feed(data)
end)
if parent then
	uv.new_timer():start(1000, 1000, function()
		if uv.kill(parent, 0) ~= 0 then os.exit(0) end
	end)
end
connect()
while true do
	vim.wait(3600000)
end
`;
