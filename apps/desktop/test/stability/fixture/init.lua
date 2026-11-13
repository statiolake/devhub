-- The stability harness's Neovim config: the plugins plugins.json pins and the
-- smallest setup that has each DevHub extension draw what it draws. run.mjs
-- writes it as the profile's ~/.config/nvim/init.lua with the plugin
-- directories in place of the line below.
local plugins = {} -- @PLUGINS@

for _, dir in ipairs(plugins) do
  vim.opt.rtp:prepend(dir)
end

vim.o.termguicolors = true
vim.o.number = true
vim.o.signcolumn = 'yes'
vim.o.laststatus = 2
vim.o.swapfile = false
vim.o.shada = ''
vim.o.updatetime = 100
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1
vim.g.mapleader = ' '

require('devhub').setup { notify = true, quick_pick = true }

-- Function keys for what the scenarios do: a key with Alt is Meta only where
-- the person's settings say so (mac_option_is_meta), F-keys always reach.
require('snacks').setup {
  picker = {
    enabled = true,
    win = { input = { keys = { ['<F4>'] = { 'toggle_preview', mode = { 'i', 'n' } } } } },
  },
}
require('snacks-ui').setup { enabled = true }
vim.keymap.set('n', '<C-p>', function() Snacks.picker.files() end)

require('blink.cmp').setup {
  fuzzy = { implementation = 'lua' },
  keymap = { preset = 'default' },
  sources = { default = { 'buffer', 'path' } },
  completion = { menu = { auto_show = true }, documentation = { auto_show = false } },
  cmdline = {
    enabled = true,
    sources = { 'cmdline', 'path' },
    completion = { menu = { auto_show = true }, list = { selection = { preselect = false, auto_insert = true } } },
  },
}
require('blink-ui').setup {}

require('nvim-tree').setup {
  renderer = { icons = { show = { file = false, folder = false, folder_arrow = true, git = false } } },
  git = { enable = false },
  filters = { dotfiles = true },
  view = { width = 32 },
}
require('nvim-tree-ui').setup {}
vim.keymap.set('n', '<F2>', '<cmd>NvimTreeToggle<CR>')
