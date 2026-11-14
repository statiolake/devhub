/**
 * The paint theme of a Neovim the page draws (`shell/neovim/chrome.ts`,
 * `themeOf`): the colours of the groups DevHub paints with, links followed,
 * `cmdheight`, the global `fillchars` and each window's of the tab page.
 * Nothing of any plugin: DevHub knows Neovim, not what the person installed
 * in it.
 *
 * Asked by the page (`nvim_exec_lua`) and pushed by Lua: DevHub's setup runs
 * the same code at each attach, before the UI's first redraw, and on every
 * `ColorScheme`, before the redraw that shows it, as the `gui-event`
 * `PAINT_THEME_EVENT` (`main/editor/neovimUi.ts`). So the page has a new
 * colorscheme's grounds as its cells come, and its first frame and a
 * recolour do not wait on a round trip to Neovim for them.
 */

export const THEME_LUA = `local names = ...
local out = { groups = {}, wins = {}, cmdheight = vim.o.cmdheight, laststatus = vim.o.laststatus, fillchars = vim.go.fillchars }
for _, name in ipairs(names) do
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  if ok then out.groups[name] = hl end
end
out.grounds = {}
local function bg(name)
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  return ok and hl.bg or nil
end
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  out.wins[tostring(win)] = vim.wo[win].fillchars
  local map = {}
  for from, to in vim.wo[win].winhighlight:gmatch('([^,:]+):([^,]+)') do map[from] = to end
  out.grounds[tostring(win)] = { normal = bg(map.Normal or 'Normal'), nc = bg(map.NormalNC or 'NormalNC') }
end
return out`;

/** The `gui-event` kind Lua pushes the paint theme as. */
export const PAINT_THEME_EVENT = "paint_theme";

/**
 * The groups asked: DevHub's chrome's, and each completion kind's
 * (`shell/neovim/kinds.ts`, `KIND_GROUPS`, which a test holds to this).
 */
export const THEME_GROUPS: readonly string[] = [
	"Normal",
	"NormalFloat",
	"FloatBorder",
	"StatusLine",
	"WinSeparator",
	"Comment",
	"DiagnosticInfo",
	"DiagnosticWarn",
	"DiagnosticError",
	"DiagnosticOk",
	"Pmenu",
	"PmenuSel",
	"PmenuKind",
	"PmenuExtra",
	"PmenuKindSel",
	"PmenuExtraSel",
	"Visual",
	// The completion kinds' (`KIND_GROUPS`).
	"@function.method",
	"@function",
	"@constructor",
	"@variable.member",
	"@property",
	"@variable",
	"@type",
	"@module",
	"Directory",
	"@markup.link",
	"@number",
	"@constant",
	"@keyword",
	"@operator",
	"Special",
];

/**
 * `THEME_LUA` as a Lua function of the group list (`paint_theme(groups)`),
 * and the list as a Lua table: what the setup is built with.
 */
export const PAINT_THEME_FUNCTION_LUA = `local function paint_theme(...)
${THEME_LUA}
end
local paint_theme_groups = { ${THEME_GROUPS.map((g) => JSON.stringify(g)).join(", ")} }`;
