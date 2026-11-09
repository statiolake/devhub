# Your Neovim setup on an SSH host

Status: design, not built. The ask was 「ssh先にneovimの設定を持ち込む方法も考える必要ありそう」.

DevHub draws the Neovim of an SSH Workspace from this Mac. The process,
config and plugins live on the host (`docs/neovim-editor.md`, "The
process"), and the Neovim is DevHub's own 0.12, delivered like tmux under
`~/.devhub-server/nvim/<version>` (the Neovim bundling work). Today that
Neovim reads whatever config the host has. On most hosts that is none, so
you get bare Neovim in your own DevHub. This document covers how DevHub
brings the setup you use here to the host, so the editor is the same on
both sides.

The design was checked against the config it exists for:
`dotfiles/neovim` (lazy.nvim, 41 plugins in `lazy-lock.json`). Every number
below was measured, not estimated, unless it says otherwise.
"Measured" means a Linux x86_64 container with Neovim 0.12.6 and that lock,
installed with `Lazy! restore` into a temporary `NVIM_APPNAME` (see Sizes).

## Recommendation, in one paragraph

**Carry the built setup from this Mac; never install on the host.** DevHub
asks the local Neovim where its config and lazy root are. It copies the
config and every plugin checkout without `.git`. It drops anything built for
macOS and adds what that plugin needs for the host's `linux-<arch>`, fetched
or cross-built *here*. The result goes over the ControlMaster as one tar
stream into a DevHub-owned `NVIM_APPNAME` (`devhub-nvim`), so the host's own
`~/.config/nvim` is never read or written. A small Lua guard that DevHub
loads with `--cmd` stops lazy.nvim from "repairing" the carried tree. Syncs
run at first connect and on every local change, and send only the units that
changed. Language servers stay the host's business. DevHub reports what is
missing on the host instead of failing silently. Host tooling is the same
argument `runtime/toolDelivery.ts` already makes: "This Mac fetches; the
host receives". It works on a host with no route to github.com, no
compiler and no `curl`, and those are the hosts that most need it.

## What the setup actually is

What `dotfiles/neovim` needs today, by kind. The brief listed
telescope-fzf-native and treesitter parsers. The config no longer has
either: `nvim-treesitter` was removed (`977b017f feat(neovim): remove
treesitter`), and the picker is `snacks.nvim`. Both are still covered below
because the mechanism has to handle them when they come back.

| Kind | In the config | What it needs on a host |
| --- | --- | --- |
| Config | `init.lua`, `lua/`, `lsp/*.lua` (10 servers), `after/` — 228 KB, 28 KB gzipped | nothing |
| Plain Lua/Vimscript plugins | 36 of 41 | nothing arch-specific |
| `saghen/blink.cmp` (`version = '*'`, v1.10.2) | Rust fuzzy matcher, downloaded at first load into `target/release/libblink_cmp_fuzzy.{so,dylib}` | the Linux `.so` for the host's triple; otherwise its Lua matcher, with a warning |
| `statiolake/vscode-review-relay` (`cond = DEVHUB_NEOVIM_GUI`) | `build.lua` runs `go build` into `bin/<os>-<arch>/review-relay` | the `linux-<arch>` binary |
| `statiolake/vscode-incremental-diff` | a committed `server/incremental-diff-server.js` | `node` on the PATH ("incremental-diff needs Node.js") |
| `github/copilot.vim` | `copilot-language-server/` (53 MB) ships `compiled/{darwin,linux,win32}/{x64,arm64}/*.node` | `node`, network and its own sign-in; off by default (`copilot_enabled = false`) |
| `statiolake/devhub.nvim` | Lua only; reads `DEVHUB_THEME_FILE`, `DEVHUB_NEOVIM_GUI` | nothing |
| `mason.nvim` | `ensure_installed`: tree-sitter-cli, lua-language-server, stylua, rust-analyzer, gopls, goimports, tsgo, prettier, biome, pyright, ruff, clangd, shfmt | network to api.github.com and the registries, npm, Go (goimports) — on the host |
| LSP (`vim.lsp.enable`) | lua_ls, pyright, rust_analyzer, tsgo, gopls, clangd, denols, csharp_ls, nim, terraformls | each server's binary on the host's PATH |
| External tools | `rg` (`grepprg`, `lib/grep.lua`, qfwatch), `fd` (snacks files: `fd` → `rg` → `find`), `git` (gitsigns, lazy, gitlinker, incremental-diff), `gh` (gh-pr-comments) | on the host |

`lazy-lock.json` is gitignored in the dotfiles (`.gitignore`:
`neovim/lazy-lock.json`). It lives only in the working tree of each machine,
so the lock that matters is this Mac's.

## Q1: what to carry

Four levels, each including the one before it.

1. **The config only.** 28 KB. On the host, lazy.nvim bootstraps itself by
   `git clone` and installs from the lock. That needs github.com and `git`
   on the host. blink.cmp then downloads its `.so`, which also needs
   github.com, and review-relay's build needs Go on the host. Offline, the
   result is a broken editor: lazy's bootstrap fails in `init.lua` and every
   `require` after it errors.
2. **Plus the lazy plugin tree and lock.** About 100 MB on disk, 37 MB
   gzipped. Every Lua plugin works offline. Built artefacts are still
   macOS's.
3. **Plus arch-specific artefacts for the host.** About 9 MB more per arch:
   blink's `.so` and review-relay's binary. The setup is then complete on
   an offline host.
4. **Plus tools.** `rg` and `fd` are small static musl builds, about 4 MB
   gzipped. `node` is about 30 MB, and Node delivery to hosts is being
   removed with the Go `devhub` command (`docs/devhub-cli.md`). Mason's
   language servers measured 573 MB on disk, 227 MB gzipped (Sizes), and
   would be a list of pins to maintain.

**Recommended: level 3 always, plus `rg` and `fd` from level 4. `node` and
language servers stay off by default and need a decision (below).**

### Syncing from here vs installing on the host from the lock

| | Sync from this Mac (recommended) | Install on the host from the lock |
| --- | --- | --- |
| Host needs | `sh`, `tar`, `gzip`, `mkdir`, `mv`: what tmux's install already needs | `git`, network to github.com (and api.github.com for Mason), `curl`/`wget` for blink, Go for review-relay, a C compiler for anything with a `make` build |
| Offline host | works | does not start cleanly |
| Exactly what runs here | yes: the tree you run, including plugins you edited, `dev` checkouts and plugins newer than the lock | the lock's commits; a plugin outside the lock (`devhub.nvim` is in the spec and not in this lock) is cloned at its default branch |
| Arch artefacts | supplied by DevHub per plugin (recipes, below) | built or downloaded by each plugin on the host |
| First-time cost | 17–37 MB over the SSH connection | the host's own bandwidth; 13 s here for `Lazy! restore` of 41 plugins on a fast link |
| Code paths in DevHub | one | one per host capability; the failure mode depends on which tool the host is missing |

Installing on the host is the better choice only when the host has a fast
network and the SSH link is slow. It is not the default, because it fails
on exactly the hosts where DevHub already refuses to rely on the far end
(`docs/remote-ssh.md`, "tmux on the host").

## Q2: how to carry it

### Where it goes on the host

```
${XDG_CONFIG_HOME:-~/.config}/devhub-nvim/         the carried config         (stdpath('config'))
${XDG_DATA_HOME:-~/.local/share}/devhub-nvim/lazy/ the carried plugin tree    (lazy's root)
${XDG_DATA_HOME:-~/.local/share}/devhub-nvim/mason/ the host's own Mason       never carried, never deleted
${XDG_STATE_HOME:-~/.local/state}/devhub-nvim/     shada, undo, logs, sessions never carried, never deleted
${XDG_CACHE_HOME:-~/.cache}/devhub-nvim/           cache                       never carried
~/.devhub-server/nvim-config/manifest              one line per carried unit: "<unit> <digest>"
~/.devhub-server/nvim-config/carry.lua             the guard (below)
~/.devhub-server/nvim-config/syncing               present while a sync runs
```

**`NVIM_APPNAME=devhub-nvim`, and not `XDG_*_HOME`.** Neovim's `stdpath()`
reads the environment on every call, and children inherit it. If DevHub
moved `XDG_CONFIG_HOME` for Neovim, it would also move it for every
`:terminal`, every language server and `gh` run from inside Neovim. `gh`
would then look for its token in the wrong place, and clangd for
`~/.config/clangd` in the wrong place. `NVIM_APPNAME` moves Neovim's four
directories and nothing else. Neovim 0.12 accepts a name or a relative path
(`:h $NVIM_APPNAME`), not an absolute one, so these directories sit under
the host's XDG roots and not under `~/.devhub-server`. The host's
`~/.config/nvim` and `~/.local/share/nvim` are never read or written. A
`nvim` run outside a DevHub terminal is the host's own as before.

DevHub sets `NVIM_APPNAME` in exactly two places: the shim's `exec` of the
real `nvim` and the managed Neovim's start (`terminalNeovimShim.ts`,
`managedNeovim.ts`). Both paths set it, the TUI fallback included, so a
`nvim` that falls back to the TUI still gets your config. A `NVIM_APPNAME`
the person already set on the host is left alone: that is a choice of the
host's config. A Neovim started inside a DevHub Neovim (`:terminal`,
`git commit`) inherits it, so it opens with the same config.

### What is carried, unit by unit

The source is whatever the local Neovim says it is. DevHub asks the
Workspace's managed Neovim over RPC, or starts one with `--headless
--listen` when none runs, under `DEVHUB_NEOVIM_GUI=1` so that `cond`
evaluates as it does in DevHub:

```lua
local C = require('lazy.core.config')
return {
  config = vim.fn.resolve(vim.fn.stdpath('config')),
  root = C.options.root, lockfile = C.options.lockfile,
  plugins = vim.tbl_map(function(p)
    return { name = p.name, dir = p.dir, url = p.url, installed = p._.installed,
             is_local = p._.is_local, build = p.build ~= nil }
  end, vim.tbl_values(C.plugins)),
}
```

The tree is split into units, and each unit has a digest:

- **`config`**: the resolved config directory. If it is inside a git work
  tree, DevHub takes what git takes (tracked files plus untracked files git
  does not ignore) and adds the lockfile by name. For these dotfiles that
  excludes `/neovim/lua51`, `.vim` and `*.swp`, and keeps
  `lazy-lock.json`.
- **`plugin/<name>`**, one per installed plugin. The digest is `<commit>`
  for a clean git checkout, and a content digest otherwise (an edited
  plugin, a `dev` checkout). `.git` is never carried.
- **`overlay/<name>/<linux-arch>`**: the artefacts a recipe adds (below).

Filters, applied to every file of every unit:

1. **Never carried, whatever the settings say**: `.git/` (a remote URL can
   carry a token), and names matching `.env*`, `*.pem`, `*.key`, `*.p12`,
   `*.pfx`, `id_*`, `.netrc`, `.authinfo*`, `*.gpg`, `*.kdbx`, `hosts.yml`
   or `*credentials*`. Text files whose content matches a known token shape
   are also dropped: `ghp_`, `github_pat_`, `gho_`, `sk-`, `xox[bp]-`,
   `AKIA[0-9A-Z]{16}`, or a `-----BEGIN … PRIVATE KEY-----` line. DevHub
   names every dropped file in the sync's notice, so a dropped file is
   never a silent change.
2. **Your exclusions**: `remote_neovim.exclude`, globs relative to the
   unit (below).
3. **Binaries for another platform**: any file that starts with a Mach-O
   magic number (`feedfacf`, `cefaedfe`, `cafebabe`), or a PE header
   (`MZ`). Checking the bytes catches what file names miss. On macOS,
   telescope-fzf-native's build writes `build/libfzf.so`, and a
   treesitter parser lands in `parser/*.so`. Both are Mach-O under an
   ELF-looking name, and the host's `dlopen` would fail on them with
   "invalid ELF header". DevHub drops them, and the recipe for that plugin
   (if there is one) replaces them. copilot.vim's
   `compiled/darwin/*/*.node` are dropped too, harmlessly, because the
   `linux/` ones beside them stay.
4. **Symlinks** are carried as symlinks when they point inside the unit, and
   dropped with a note when they point outside it. DevHub never follows one
   out of the tree, toward `~/.ssh` for example.

Nothing outside these units is read. `~/.config/github-copilot` (Copilot's
OAuth token), `gh`'s `hosts.yml`, shada, undo files, auto-session's
sessions and `lsp.log` are not in any unit, so they are never candidates.

### Recipes: the artefacts lazy would have built

lazy.nvim runs a plugin's `build` only on install and update (and `:Lazy
build`), and never checks what is already on disk. So it does nothing with
a wrong-arch artefact: it neither notices it nor rebuilds it. Each plugin
then finds its file or fails in its own way. Measured with the carried tree
and no network:

- **blink.cmp with the Mac's `target/release/`** (`.dylib`, `.dylib.sha256`,
  `version`): on Linux it looks for `.so`. Its version check reads the git
  tag from `.git`, and in the carried tree that is gone. It reports "No
  fuzzy matching library found!" and falls back to Lua with a warning on
  every start.
- **blink.cmp with the right `.so` but a `version` file and no `.git`**: the
  same warning. The Rust library loads (`require('blink.cmp.fuzzy.rust')`
  succeeds), but blink will not use it.
- **blink.cmp with the right `.so` and `.sha256` and no `version` file**:
  silent, and the Rust matcher in use. blink treats this as "user manually
  placed the .so file" (`fuzzy/download/init.lua`). **So the recipe writes
  exactly that.**
- **review-relay with only `bin/darwin-arm64/`**: `M.executable()` asks for
  `bin/linux-amd64/review-relay`, which is not there, and the plugin says
  it is not executable.

The recipes are a table keyed by plugin name, run on this Mac, and cached
under DevHub's data, keyed by what they depend on:

| Plugin | Recipe | Key | Size |
| --- | --- | --- | --- |
| blink.cmp | `git describe --tags --exact-match` of the local checkout → fetch `https://github.com/saghen/blink.cmp/releases/download/<tag>/<triple>.so` and `.sha256`, verify, write `target/release/libblink_cmp_fuzzy.so` + `.sha256`, no `version`. Triple: `x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu` (`-musl` exists for both) | tag + triple | 2.1 MB (x64), 1.8 MB (arm64); needs glibc 2.17 |
| vscode-review-relay | `CGO_ENABLED=0 GOOS=linux GOARCH=<amd64\|arm64> go build -trimpath -ldflags='-s -w' -o bin/linux-<arch>/review-relay github.com/statiolake/review-relay` in the plugin's checkout, with this Mac's Go | plugin commit + arch | 7.3 MB, static; 26 s cold here (it also fetched a Go toolchain, go1.27.1, through `GOTOOLCHAIN`) |
| nvim-treesitter + `statiolake/neovim-treesitter-binaries` (when it comes back) | fetch `all-linux-<x86_64\|arm64>.tar.gz` from that repository's release and unpack its `.so` into `parser/` | release tag + arch | built on Debian Stretch, so glibc 2.24 |
| telescope-fzf-native (when it comes back) | none possible here (its `make` builds for the machine it runs on); build on the host if the host has `cc` and `make` (below) | — | — |

**A plugin with a `build` and no recipe** is reported by name ("built here,
not on host"). If the host has the toolchain its `build` needs, DevHub can
run `nvim --headless "+Lazy! build <name>" +qa` there once per carried
commit, and the output is kept in the host's copy of that plugin. That is
the user's own build step, run where lazy would have run it. It is
best-effort and never required.

### The guard: lazy.nvim must not repair the carried tree

lazy.nvim decides that a plugin is installed when its directory exists. It
does not need `.git` for that, so a carried tree starts silently, and that
was measured. But **`:Lazy update` on the carried tree deletes it.** With no
`.git`, lazy's `origin` task decides the remote does not match, renames
every plugin to `<name>.cloning` and clones it again. Measured offline: all
41 plugins were left as `*.cloning` husks, and `lazy-lock.json` was
rewritten down to one entry. With network the clones succeed, but they undo
the carry: the host's tree diverges from this Mac's, its builds run on the
host, and the next sync overwrites the whole tree again.

The host's tree is a one-way mirror, so updating it on the host is never
meaningful. DevHub writes `~/.devhub-server/nvim-config/carry.lua` and starts
every carried Neovim with `--cmd "lua dofile(...)"`. `--cmd` runs before
`init.lua`. The file does three things:

- sets `vim.g.devhub_carried = { source = '<this Mac>', digest = '<manifest digest>' }`,
  so a config can tell where it is running;
- puts a `package.preload['lazy']` in front of the real lazy.nvim that wraps
  `setup` to force `install.missing = false` and `checker.enabled = false`,
  and leaves every other option as the person wrote it;
- on `User LazyDone`, replaces `update`, `sync`, `restore`, `clean` and
  `check` in `require('lazy.manage')` with one notice: "Plugins here are
  carried from <Mac>. Update them there; DevHub brings the result." `build`
  stays.

This couples DevHub to lazy.nvim's module names (`lazy.manage`,
`lazy.core.config`), so `test:pty` needs a test that runs the guard against
the lazy.nvim commit in the person's lock. A config that does not use
lazy.nvim gets `vim.g.devhub_carried` and nothing else.

The alternative is to keep `.git` in the carried tree, so that the host
could update itself. The full `.git` costs 87.5 MB gzipped against
36.9 MB without it. A `--depth 1` clone of each plugin still costs
65.7 MB, because git's objects are already compressed. And it would still
make the host diverge. Rejected.

### The transport

The tar is written by DevHub, in TypeScript (ustar and gzip from
`node:zlib`), and not by `/usr/bin/tar`. macOS's bsdtar adds `._*`
AppleDouble entries and extended attributes (`com.apple.provenance`,
quarantine). It would also follow the rules of the Mac's filesystem rather
than the filters above. DevHub's writer emits exactly the filtered list, with
normalised owners, the executable bit kept, and nothing else.

**Not rsync.** Hosts are not guaranteed to have it: a minimal container or
NAS image often does not. macOS ships `openrsync`, so two rsync dialects
would meet. And it would be a second transport beside the one
`toolDelivery.ts` already has. The unit manifest gives the same
"send what changed" for the case that matters: a config edit costs 28 KB,
and one plugin's update costs that one plugin.

The flow, for one host:

1. **Resolve** (here): ask the local Neovim (above). Each unit's digest is
   kept in memory, keyed by path and mtime, so an unchanged tree is not
   hashed again.
2. **Compare**: `cat ~/.devhub-server/nvim-config/manifest` on the host
   (one `sh` over the ControlMaster) against the local units, giving the
   units to send and the units to remove.
3. **Prepare** (here): run recipes for the host's `linux-<arch>` (from
   `describeRemote`), from the cache when the key is already there.
4. **Send**: one `sh` with the tar on its stdin, POSIX only, as for tmux.
   It creates `syncing` with `set -C`, so a second sync waits instead of
   interleaving. It runs `tar xzf - -C <staging>`. For each unit it
   `mv`s the old directory aside and the new one into place, then deletes
   the old one. Removed units are deleted. It writes `manifest.new` and
   `mv`s it over `manifest` last, then removes `syncing`. A dropped
   connection leaves the old manifest, so the next sync sends those units
   again. A half-written unit never sits behind a name that means "done".
5. **Check** (once per new manifest): run the carried Neovim headless on
   the host with a probe. It lists each enabled LSP config whose `cmd[1]`
   is not executable, each of `rg`, `fd`, `git`, `node`, `go` that is
   missing, and whether blink's Rust matcher loaded. The answer goes into
   the notice and `--metrics` (Q3).

### When

- **First connect.** Right after tmux and Neovim are installed on the host,
  in the background, without delaying the Workspace's terminal. The first
  Neovim on that host waits for the sync. The managed Neovim's start awaits
  it. A pane's `nvim` started by the shim waits for its UI under `--embed`,
  so the config is not read yet, and DevHub attaches only once the sync
  ends. The shim's 10-second wait for a UI is extended while `syncing`
  exists, up to 120 s, with one line in the pane: "DevHub is bringing your
  Neovim config to this host (17 MB)…". Past that, it starts with what is
  there.
- **On change.** DevHub watches the resolved config directory, the
  lockfile and the lazy root (`fs.watch`, debounced 2 s). It syncs every
  host that has a live connection, and remembers the rest as stale until
  they connect. Each carried Neovim launch also compares digests in memory,
  so a missed event costs one manifest read and nothing more. A running
  Neovim sees the new files the way a local one sees an edit or a
  `:Lazy update`: modules already loaded stay, later `require`s get the new
  files. The notice offers `:restart` (Neovim 0.12) to take all of it.
- **On demand.** A palette command, "Neovim: bring my config to <host>
  now". On the host, `devhub nvim-config sync` and `devhub nvim-config
  status` ask DevHub over the control socket. These are two more verbs
  for the Go command (`docs/devhub-cli.md`); the work stays in the app.

## Q3: hosts without network, or with an old glibc

**No network.** The carry itself needs none on the host. What does not work
there:

| What | On an offline host | Measured |
| --- | --- | --- |
| Plugins, config, blink's Rust matcher, review-relay | work (carried, recipes) | yes |
| Mason's `ensure_installed` | fails **silently**: `mason.log` has `Cannot find package "lua-language-server"` and the rest; no message on screen. A host that reaches github.com but not api.github.com fails the same way, because Mason resolves its registry tag there | yes |
| LSP | servers not on the PATH never start, **silently**: `vim.lsp.get_clients()` is empty after opening a `.lua`, `:messages` is empty | yes |
| copilot, gh-pr-comments | need the network anyway | — |
| `:Lazy update` | refused by the guard with its notice (without the guard: the tree is destroyed, as above) | yes |

The silent failures are the reason for step 5. After each new manifest the
person is told once, per host, in DevHub's notice and in Neovim
(`vim.notify`, which devhub.nvim draws as a native notification):

> Your Neovim config is on build-1 (41 plugins, 17 MB). Not available
> there: lua-language-server, rust-analyzer, clangd, pyright (LSP off for
> Lua, Rust, C, Python); fd (pickers use rg); node (incremental-diff,
> copilot). Mason cannot install them: build-1 has no route to github.com.

`devhub --metrics` gets a `neovimConfig` entry per machine, shaped like
`terminalLauncher`'s: `carried`, `digest`, `bytes`, `missing[]`,
`dropped[]` (secrets and wrong-platform files by path), `reason`.

**Old glibc, or musl.** Neovim's own Linux build needs glibc 2.34, and the
bundling work refuses an older glibc or musl by name, with no fallback to
the host's Neovim. On such a host there is no DevHub Neovim, so DevHub
carries nothing and says so once in the same sentence ("…so DevHub does not
bring your config there either"). Everything a recipe or the tool list adds
needs less than 2.34: blink's `.so` 2.17, the treesitter binaries 2.24,
Node 22 2.28. review-relay, `rg` and `fd` are static. So Neovim stays the
floor, and no host can run Neovim while lacking what the recipes add. If
Neovim ever runs on musl, blink's recipe switches to the `-musl` triple.

## Q4: secrets

Never carried. Filters 1 and 4 above apply before any user setting, and no
setting turns them off. The units are the only roots, and the secret stores
a Neovim setup touches all sit outside them: Copilot's token, `gh`'s
`hosts.yml`, shada (registers and search history can hold a pasted token)
and undo files. **Exclusions are honoured** in three layers: git's ignore
rules for a config that is a git work tree, `remote_neovim.exclude` globs,
and the built-in list. Each dropped file is named in the notice and in
`--metrics`. That way an over-broad pattern shows up as a missing file you
can see, not as config that quietly behaves differently.

On a host, the person signs in to Copilot or `gh` there, if they want them.
DevHub does not move a credential to make an editor complete.

## Q5: the dotfiles' `neovim/` or whatever `~/.config/nvim` resolves to?

**Whatever the local Neovim resolves.** That is
`stdpath('config')` with symlinks resolved, under the environment DevHub's
own local Neovim runs with. For this person `install.py` makes
`~/.config/nvim` a symlink to `dotfiles/neovim` (`setup_neovim` → `linkd`),
so both answers are the same directory today. They differ only when they
should:

- DevHub has no reason to know a dotfiles layout, and a person without one
  should get the same feature;
- a local `NVIM_APPNAME`, or an `XDG_CONFIG_HOME` that differs, is carried
  as it runs. The rule is "what you run here runs there", and a path in a
  repository that the editor does not read would break that;
- the lazy root and the lockfile come from the same question, so they are
  correct even when a config moves them (`lazy.setup { root = … }`).

`remote_neovim.config` overrides it with a path, for someone who wants a
config on hosts that differs from the one here.

## Settings

```toml
[remote_neovim]
carry   = "plugins"   # "off": the host's own ~/.config/nvim, as today
                      # "config": the config only; lazy installs on the host
                      # "plugins" (default): config + plugins + recipes
config  = ""          # default: the local Neovim's stdpath('config'), resolved
exclude = []          # globs, e.g. ["lua/work/**", "lazy/copilot.vim/**"]
tools   = ["rg", "fd"]  # static tools DevHub delivers beside Neovim; "node" is opt-in
```

These are global. A per-host value would be useful on a shared machine
where the person keeps a host config they want to use. It is listed under
decisions, since `docs/remote-ssh.md` ("Pointing one host somewhere else")
argues against per-host settings for what DevHub ships. This is the
person's config rather than DevHub's.

The tools are delivered with `toolDelivery.ts` (`HostTool` grows `rg` and
`fd`). They are upstream's static musl releases, pinned with digests in
`product.json` like tmux, and installed into `~/.devhub-server/<tool>/<version>`.
They are *appended* to the carried Neovim's PATH, so a host's own `rg`
wins and a `:terminal` sees the PATH it always had, with one more directory
at the end.

## Sizes

Measured on Linux x86_64 with Neovim 0.12.6 from the person's lock
(`Lazy! restore` into a temporary `NVIM_APPNAME`, then removed). The Mac's
tree has the same commits. Its only differences are blink's `.dylib` and
review-relay's `bin/darwin-arm64/`, and the filters drop both.

| What | On disk | Sent (gzip) |
| --- | --- | --- |
| Config | 228 KB | 28 KB |
| Plugin tree with `.git` (41 plugins) | 161 MB | 87.5 MB |
| Plugin tree, `--depth 1` `.git` | 136 MB | 65.7 MB |
| **Plugin tree without `.git` (carried)** | **100 MB** (3,624 files) | **36.9 MB** |
| — also without `tests/`, `test/`, `*.map` | 72 MB | 17.3 MB |
| of which copilot.vim | 54 MB | 15.4 MB |
| of which snacks.nvim | 21 MB (18 MB of it `tests/`) | — |
| review-relay checkout (not in the measured tree: `cond` is GUI-only) | 0.5 MB | 0.1 MB |
| blink.cmp `.so` per arch | 2.1 MB | — |
| review-relay binary per arch | 7.3 MB | — |
| `rg` + `fd` (static, x64) | — | 2.4 + 1.6 MB |
| DevHub's Neovim 0.12.6 (the bundling work) | 41 MB | — |
| Mason's `ensure_installed` (13 packages, x64; not carried) | 573 MB | 227 MB |

**Mason's `ensure_installed`**, measured separately. The config's own
`mason.setup()` could not resolve its registry here: Mason asks
api.github.com for the latest registry tag, and this container's proxy
refuses that host. That is the "host without network" case, and it fails
silently. The registry was then pinned to a tag read with `git ls-remote`
(`registries = { 'github:mason-org/mason-registry@2026-11-08-usual-prairie' }`),
and all 13 packages installed:

| Package | On disk | Package | On disk |
| --- | --- | --- | --- |
| clangd | 225 MB | tsgo (npm) | 31 MB |
| biome | 93 MB | tree-sitter-cli | 28 MB |
| rust-analyzer | 42 MB | ruff | 25 MB |
| gopls (`go install`) | 41 MB | lua-language-server | 22 MB |
| pyright (npm) | 38 MB | stylua | 11 MB |
| prettier (npm) | 9.7 MB | goimports (`go install`) | 7.8 MB |
| shfmt | 3.5 MB | **all 13** | **573 MB, 227 MB gzipped** |

So Mason's set costs 6× the plugin tree, per host and per arch. Some of it
cannot be carried even in principle. pyright and prettier are Node programs,
so they need `node` on the host. gopls and goimports are built by
`go install` on the machine that installs them, so they link against
*that* machine's glibc: the gopls built here needs `GLIBC_2.34`.
rust-analyzer needs 2.28, biome 2.30, clangd and LuaLS 2.17, and ruff is
static. That is why language servers are not carried by default.

So a first sync sends about 37 MB, or 17 MB if tests and source maps are
trimmed, plus about 10 MB of recipes, and needs about 110 MB of disk on the
host. A config edit sends 28 KB. A `:Lazy update` of one plugin here sends
that plugin. Trimming `tests/`, `test/` and `*.map` is a safe default: none
of them is on the runtimepath or read by a plugin at run time. It is listed
as a decision because it is a heuristic.

## Alternatives considered

- **Config only; lazy installs on the host** (`carry = "config"`). Kept as
  a setting for hosts with good network. It fails offline from the
  bootstrap's `git clone` onward.
- **Carry `.git`** so the host can update itself: 2.4× the bytes, and the
  host diverges from this Mac. See The guard.
- **Git bundles**: send `git bundle` files over the connection and clone on
  the host. Real repositories, but builds still need the host's toolchain,
  and it costs as much as `.git`.
- **Mount this Mac's config** (sshfs over a reverse forward). Every
  `require` pays a round trip, the host needs FUSE, and the Mac's binaries
  are still the wrong ones.
- **rsync**: see The transport.
- **Carry Mason's packages**: Mason has no "install for another platform",
  so DevHub would maintain its own pin list of Linux builds for each
  server. Left as a decision.

## Risks

- **Coupling to lazy.nvim internals.** The guard uses `lazy.manage` and
  `lazy.core.config`. A lazy.nvim release that renames them disables the
  guard, which is detected by the guard's own test and by `carry.lua`
  checking that the functions exist and saying so. It does not break the
  editor.
- **The rename window.** A running Neovim that lazy-loads a module during
  the `mv` pair of its plugin's unit fails that `require` once. The window
  is microseconds. This is the same window as a local `:Lazy update`.
- **`XDG_*` differing between the login shell and a pane.** The sync
  resolves `${XDG_DATA_HOME:-…}` in the login environment
  (`docs/remote-ssh.md`, "Commands run in the environment you log in to").
  A pane whose shell rc moves `XDG_DATA_HOME` would start Neovim with a
  different `stdpath`. The shim can pass the paths the sync used, and the
  probe in step 5 reports a mismatch.
- **`dev` plugins.** `dev = { path = find_dev_path() }` resolves on the
  host to `~/dev/github…` or nothing. A carried `dev = true` plugin is put
  in lazy's root under its name. That root is where lazy looks only when
  the dev path is absent and `dev.fallback` allows it, so this needs a test
  before `dev = true` is supported.
- **`cond` evaluated here, not there.** The tree carries what is installed
  here. A plugin whose `cond` is true only on Linux is not installed on
  this Mac, so it is not carried. With the guard's `install.missing =
  false` it stays absent, and the probe names it.
- **Plugins that write into their own directory** (blink's download, a
  cache) have those writes replaced at the next sync of that unit. The
  recipes cover the one that matters.
- **Two Macs, one host.** Both write `devhub-nvim`. The manifest records the
  source, and a sync from a different source overwrites the tree and says
  so. Alternatively the app name carries the profile's tag (as
  `~/.devhub/terminal/nvim-<tag>` does), which splits shada and undo per
  Mac.
- **Disk.** About 110 MB per host, plus whatever Mason installs there. Old
  units are deleted by the swap; nothing accumulates across versions.

## What the person decides

1. **The default level**: config + plugins + recipes (recommended) or config
   only.
2. **Language servers**: the host's own, or Mason on the host when it has
   network (recommended). The alternative is a curated set of Linux builds
   delivered by DevHub: 573 MB per host for today's `ensure_installed`
   (227 MB sent), a pin list to maintain, and Node on the host for pyright
   and prettier.
3. **`node` on hosts**: incremental-diff and copilot need it, and Node
   delivery is going away with the Go `devhub` command. Carry a pinned Node
   as an opt-in tool (about 30 MB gzipped), or let those two degrade.
4. **review-relay's binary**: cross-build with this Mac's Go (works today,
   26 s cold), or publish `linux-<arch>` binaries from that repository's
   releases so no Go is needed here. The second is better and is a change
   to vscode-review-relay.
5. **Trimming `tests/`, `test/`, `*.map`**: 37 MB → 17 MB.
6. **Per-host `carry = "off"`** for machines where you keep a host config.
7. **Two Macs on one host**: one shared `devhub-nvim`, last writer wins
   (proposed), or one per DevHub profile.
