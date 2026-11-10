# Your Neovim setup on an SSH host

Status: built. The ask was 「ssh先にneovimの設定を持ち込む方法も考える必要ありそう」.

DevHub draws the Neovim of an SSH Workspace from this Mac. The process,
config and plugins live on the host (`docs/neovim-editor.md`, "The
process"), and the Neovim is DevHub's own 0.12, delivered like tmux under
`~/.devhub-server/nvim/<version>`. Before this, that Neovim read whatever
config the host had, usually none: bare Neovim in your own DevHub, and the
notice "DevHub Dark is meant to be worn as the colorscheme …" because the
theme plugin was not there. Now DevHub brings the setup you use here to the
host, so the editor is the same on both sides.

The code is `apps/desktop/src/main/runtime/carryTree.ts` (what the setup is,
the units, the filters, the tar stream), `carryManifest.ts` (what the host
has and what to send), `carryHost.ts` (the launcher, the guard, the sync,
the build step and the report) and `RemoteShellRuntime.neovimProgram`
(where it starts).

## What it does, in one paragraph

**DevHub carries the setup you run here and never installs on the host.**
It asks the local Neovim where its config and lazy root are, and copies the
config and every installed plugin without `.git`, tests or source maps. The
copy goes over the ControlMaster as one tar stream into a DevHub-owned
`NVIM_APPNAME` (`devhub-nvim`), so the host's own `~/.config/nvim` is never
read or written. A small Lua guard, loaded with `--cmd`, stops lazy.nvim
from installing, updating or "repairing" the carried tree. lazy.nvim's own
build step then runs on the host for the plugins whose spec declares one. A
sync runs at first connect and on every local change, and sends only the
units that changed. `rg`, `fd` and `node` are delivered beside Neovim and
appended to its `PATH`. Language servers stay the host's business, and
DevHub says which ones are missing there instead of failing silently.
The app carries the tools and the host receives them: it works on a host
with no route to github.com, no compiler and no `curl`.

## What was decided

The design listed seven decisions. The person did not mind much, so the
design's recommendations were taken, with three corrections from them while
it was built:

| # | Decision | Meaning |
| --- | --- | --- |
| 1 | **Carry config + plugins, always.** No `carry` level setting. | Every host gets the whole setup. Nothing has to be cloned there, so a host with no route to github.com and no git still starts your editor. |
| — | **No per-plugin special cases** (correction). DevHub knows lazy.nvim's standard spec, not plugins. | There is no "recipe" table, and no code, doc or message in DevHub names a plugin. A plugin that needs a built artefact on the host gets it from its own `build` step (`build = …` or a `build.lua`), run by lazy.nvim on the host, as lazy would have run it on install. What that step does (download a release, compile) is the plugin's business. When it fails, DevHub shows lazy's own message, naming the plugin. |
| — | **Nothing is dropped by binary format** (correction). | A plugin that commits a binary for every platform under `bin/<os>-<arch>/` works as it is copied. A binary this Mac built for itself is a dead file on the host, which the plugin's own build replaces there if it has one. |
| 2 | **Language servers are the host's.** Not carried. | After each sync the host is probed; each enabled LSP config whose command is not executable there (on `PATH` as the carried config leaves it) is named in the notice, with whether the host can reach github.com to download it. |
| 3 | **`node` is carried** (correction: the design had it off). | Language servers often run on Node, so Mason on a host with network can install the npm-based ones. Node is delivered like `rg` and `fd`. Copilot still needs its own sign-in on the host. |
| 4 | **A plugin's binaries come from the plugin**: its own build step, or binaries it commits for every platform. | DevHub neither fetches nor cross-builds anything for a plugin. |
| 5 | **Trimmed**: `tests/` and `test/` at a plugin's top, and `*.map` anywhere. | 16.8 MB sent instead of about 37 MB. None of them is on the runtimepath or read at run time. A `test/` deeper inside a plugin (a Lua module, say) is kept. |
| 6 | **No per-host opt-out.** | The design recommended none: a setting per host is what `docs/remote-ssh.md` argues against. A `NVIM_APPNAME` you set on the host yourself is left alone, which is the way to use a host config. |
| 7 | **Two Macs on one host: last sync wins.** | One shared `devhub-nvim`. The manifest records the source, and the notice says when a sync replaced one from another Mac. |

## Where things go on the host

```
${XDG_CONFIG_HOME:-~/.config}/devhub-nvim/          the carried config          (stdpath('config'))
${XDG_DATA_HOME:-~/.local/share}/devhub-nvim/lazy/  the carried plugin tree     (lazy's root)
${XDG_DATA_HOME:-~/.local/share}/devhub-nvim/mason/ the host's own Mason        never carried, never deleted
${XDG_STATE_HOME:-~/.local/state}/devhub-nvim/      shada, undo, logs           never carried
~/.devhub-server/nvim-config/nvim                   the launcher: what DevHub runs as "nvim" there
~/.devhub-server/nvim-config/carry.lua              the guard
~/.devhub-server/nvim-config/manifest               "<unit>\t<digest>\t<directory>" per unit, written last
~/.devhub-server/nvim-config/syncing                "<time> <pid>" while a sync runs
~/.devhub-server/nvim-config/{build,probe}.lua      the build step and the probe, run headless
~/.devhub-server/nvim-config/notice                 the last sync's report, shown once in Neovim
~/.devhub-server/nvim-config/build-failed           plugins whose build failed, tried again at next connect
~/.devhub-server/{rg,fd,node}/<version>/            the tools appended to the carried Neovim's PATH
```

**`NVIM_APPNAME=devhub-nvim`, and not `XDG_*_HOME`.** `NVIM_APPNAME` moves
Neovim's four directories and nothing else; moving `XDG_CONFIG_HOME` would
move it for every `:terminal`, language server and `gh` run from inside
Neovim too. The roots are resolved from the host's login environment.

**The launcher** (`carriedLauncherScript`) is what
`RemoteShellRuntime.neovimProgram` answers on a host, so both the shim's
`nvim` in a pane (and its TUI fallback) and the `devhub-nvim` window's
keeper run it; nothing in the shim or the keeper changed. It:

- appends the delivered tools' directories to `PATH` (once), so the host's
  own `rg` or `node` wins and a `:terminal` sees its usual `PATH` plus one
  directory at the end;
- sets `NVIM_APPNAME=devhub-nvim` when something has been carried (a
  `manifest` or a `syncing` marker exists) and you have not set one;
- execs DevHub's Neovim with `--cmd "lua dofile('…/carry.lua')"` for that
  app name, and as it is for `-l`, `--version`, `--api-info` and the like.

A Neovim started inside a carried Neovim inherits `NVIM_APPNAME` and so
opens with the same config. A `nvim` run outside DevHub's terminals is the
host's own as before.

## What is carried, unit by unit

The source is whatever DevHub's own Neovim here says it is
(`resolveLocalSetup`): started `--headless` with your environment and
`DEVHUB_NEOVIM_GUI=1` (so `cond` evaluates as it does in DevHub), with a
`--cmd` guard of its own so that asking installs nothing here either. It
answers `stdpath('config')` and `stdpath('data')` with symlinks resolved,
lazy's `root` and `lockfile`, and every plugin of the spec: its directory,
whether it is installed, and whether it declares a build step (`build`, or
a `build.lua` / `build/init.lua` in it, which is lazy's own rule).

The units:

- **`config`**: the resolved config directory. In a git work tree DevHub
  takes what git takes (tracked files plus untracked files git does not
  ignore) and adds the lockfile by name. For these dotfiles that leaves out
  `/neovim/lua51`, `.vim` and `*.swp` and keeps `lazy-lock.json`.
- **`plugin/<name>`**, one per installed plugin directory, placed under the
  host's `stdpath('data')` at the same path lazy's root has under this
  Mac's.

Each unit's digest is a sha256 over every entry's path, kind, mode and
content. File digests are cached by size, mtime and inode, so an unchanged
tree is not read again.

Filters, applied to every file:

1. **Never carried**: `.git` (a remote URL can carry a token); macOS litter
   (`.DS_Store`, `._*`); names matching `.env*`, `*.pem`, `*.key`, `*.p12`,
   `*.pfx`, `id_*`, `.netrc`, `.authinfo*`, `*.gpg`, `*.kdbx`, `hosts.yml`
   or `*credentials*`; and text files up to 2 MB with a token shape in them
   (`ghp_…`, `gho_…`, `github_pat_…`, `sk-…`, `xox[bp]-…`, `AKIA…`, a
   private key block). Each dropped file is named in the notice.
2. **Trimmed**: `tests/` and `test/` at a plugin's top, `*.map` anywhere.
3. **Symlinks** stay symlinks when they point inside the unit and are
   dropped, with a note, when they point outside it.

Nothing else is read: Copilot's token, `gh`'s `hosts.yml`, shada, undo
files and sessions are in no unit.

## The build step: lazy.nvim's spec, not plugins

lazy.nvim runs a plugin's `build` on install and update, never at start. The
carried tree is neither installed nor updated on the host, so after a sync
DevHub runs that step itself, headless with the carried config and the
guard: `require('lazy.manage').build({ plugins = <names>, wait = true })`
for the plugins whose spec declares one and whose unit was sent this time
(all of them on the first sync), plus, at each connect, those whose build
failed last time. Each plugin's outcome is read from lazy's own build task
(`task:has_errors()`, `task:output()`).

That is the whole of DevHub's knowledge about plugins: a spec may declare a
build step, and lazy knows how to run it. What a build does is the plugin's:
a `build.lua` that downloads a release binary needs the host's `curl` and a
route to github.com; one that compiles needs the toolchain there. When it
cannot, the build fails, the notice says so in lazy's words, naming the
plugin, and the plugin degrades the way it does on its own. A plugin that
finds its binary some other way at run time (for instance by asking git for
its tag) gets no `.git` on the host and does what it does without one.

## The guard

lazy.nvim decides a plugin is installed when its directory exists, so a
carried tree starts silently. But `:Lazy update` on it would delete it: with
no `.git`, lazy renames every plugin to `<name>.cloning` and clones again
(measured: offline, all 41 left as husks and the lockfile rewritten to one
entry). The host's tree is a one-way mirror, so `carry.lua` (`carryGuardLua`):

- waits while a sync runs (below);
- sets `vim.g.devhub_carried = { source = '<Mac (profile)>', digest = … }`;
- puts a `package.preload['lazy']` in front of the real lazy.nvim that
  forces `install.missing = false` and `checker.enabled = false` in `setup`
  and leaves every other option as you wrote it;
- after `setup`, replaces `install`, `update`, `sync`, `restore`, `clean`
  and `check` in `lazy.manage` with a notice ("the plugins here are carried
  from <Mac>. Update them there; DevHub brings the result."). `build`
  stays. If those functions are not there (a lazy.nvim that renamed them),
  it says so instead of failing;
- shows the last sync's notice once, with `vim.notify` (devhub.nvim draws it
  as a native notification), once per set of problems.

A config without lazy.nvim gets `vim.g.devhub_carried` and nothing else.

## The sync

One host, one sync at a time (`HostCarry`):

1. **Claim**: one `sh` creates `syncing` with `set -C` (taking over a marker
   whose process is gone and that is older than a minute) and prints the
   manifest and `build-failed`. A second sync, from this Mac or another,
   waits for the first.
2. **Resolve** here and **compare** against the manifest: the units whose
   digest or place changed, and the directories of units that are gone.
3. **Send**: one `sh` with the tar on its stdin. The tar is written by
   DevHub (ustar, with a pax header for names past ustar's 255 bytes, gzip
   from `node:zlib`), not by this Mac's `tar`, so it holds exactly the
   filtered list with owners `0/0` and no AppleDouble entries. The script
   rewrites `syncing` with its own pid, unpacks into a staging directory,
   and for each unit moves the old directory aside, the new one into place
   and deletes the old one; removes the gone units; renames the new
   manifest over the old one; and removes `syncing`. A dropped connection
   leaves the old manifest, so the next sync sends those units again; a
   half-written unit never sits behind a name that means "done".
4. **Build**, as above, and **probe**: the carried Neovim, headless, lists
   each enabled LSP config whose `cmd[1]` is not executable (on `PATH` as
   the carried config leaves it), whether `rg`, `fd`, `git` and `node` are there, and whether
   github.com answers `curl`.
5. **Report** (`composeReport`): logged always; raised in DevHub as a notice
   (`neovim_config_incomplete`) when something is missing, a build failed,
   a tool could not be delivered or a file was left here; written to
   `notice` for the carried Neovim to show once. A change sync whose
   problems are the same as the last one's is only logged.

The host needs `sh`, `tar`, `gzip`, `mkdir`, `mv`, `rm` and `date`: what
tmux's install already needs. No git, curl or network, except what a
plugin's own build step wants.

### When

- **First connect.** The first `neovimProgram` on a host installs DevHub's
  Neovim, writes the launcher and the guard, starts the sync and the tool
  deliveries in the background, and answers once the sync has claimed the
  host (at most 15 s). The terminal is not delayed. A Neovim started from
  then on waits for the sync in its guard, up to 120 s, saying "DevHub is
  bringing your Neovim config to this host…"; in a pane drawn by DevHub the
  guard runs after the GUI attached (`--embed` waits for its UI before
  `--cmd`), so the shim's 10 s wait for a UI is not affected. Past 120 s it
  starts with what is there, which is the old tree whole: nothing is
  swapped before the unpack starts.
- **On change.** DevHub watches the resolved config directory and lazy's
  root (`fs.watch`, recursive, `.git` ignored, debounced 2 s), asks the
  local Neovim again and syncs every host it has carried to. A sync that
  did not finish marks the host stale, and the next Neovim asked for there
  syncs again. A running Neovim sees new files the way a local one sees an
  edit: modules already loaded stay; `:restart` takes all of it.

## Sizes, measured

Measured on this machine with the person's dotfiles (a clone), 42 plugins
from the lock plus the plugins `DEVHUB_NEOVIM_GUI=1` enables, and a host
over ssh (`carrySsh.test.ts`, and DevHub itself; see Checked):

| What | Size |
| --- | --- |
| Carried, on disk here (filtered) | 59.8 MB |
| **First sync, sent** (43 units, gzip) | **16.8 MB** (17,588,654 bytes), about 18 s on a local link |
| On the host's disk | 71 MB plugins + 232 KB config |
| A config edit, sent | 34 KB (1 unit) |
| `rg` 15.2.0 / `fd` 10.5.1, sent once per host (from the app's `out/host-tools`) | about 2 MB each |
| `node` 26.13.0 (LTS), sent once per host (from the app's `out/host-tools`) | 62.9 MB (230 MB on disk) |
| DevHub's Neovim 0.12.6 | 41 MB on disk |
| Mason's `ensure_installed` (not carried) | 573 MB on disk, 227 MB gzipped |

Node is most of a first connect's bytes. It is sent once per host and
version and kept like tmux.

## Hosts without network, or with an old glibc

**No network.** The carry needs none. Plugins, config, and any plugin that
carries its own binaries work. A plugin whose build step downloads fails
that step, and the notice names it with lazy's message. Language servers
cannot be downloaded: the notice says the host has no route to github.com.
`:Lazy update` is refused by the guard.

**Old glibc, or musl.** DevHub's Neovim needs glibc 2.34 and is refused by
name on such a host (`neovimHostRefusal`), so there is no carried Neovim
either, and the host's own config is untouched.

## Not built

- The settings in the design (`[remote_neovim] carry`, `config`, `exclude`,
  `tools`). Decisions 1 and 6 removed `carry`; the rest can be added on top
  of `NeovimConfigSource` when they are wanted. The built-in secret filters
  apply whatever a setting would say.
- `devhub nvim-config sync|status` on a host and a palette command: a sync
  happens at connect and on change; a stale host syncs at the next Neovim.
- `--metrics` entry `neovimConfig`: the report is in the log
  (`[devhub] Neovim config on <host>: …`).
- `dev = true` plugins: carried into lazy's root under their name, which
  lazy uses only when the dev path is absent and `dev.fallback` allows it.

## Risks

- **Coupling to lazy.nvim's module names** (`lazy`, `lazy.core.config`,
  `lazy.manage`). A rename disables the guard with a notice; it does not
  break the editor. `carryHost.test.ts` checks the guard against lazy's
  contract, and against a real lazy.nvim checkout with
  `DEVHUB_LAZY_NVIM=<dir>`.
- **`cond` evaluated here.** The tree carries what is installed here, under
  `DEVHUB_NEOVIM_GUI=1`. A plugin whose `cond` is false in DevHub's GUI and
  true elsewhere is not installed here, so a TUI Neovim on the host (the
  shim's fallback) finds it missing, and with `install.missing = false`
  lazy says "Plugin … is not installed".
- **Tools ahead of the Mac's.** `fd` on the host's `PATH` where this Mac has
  none changes which command a picker runs. A config that passes `rg`-only
  arguments to a picker that prefers `fd` then lists nothing there.
- **The rename window**: a running Neovim that lazy-loads a module during
  its unit's `mv` pair fails that `require` once, as during a local
  `:Lazy update`.
- **`XDG_*` differing between the login shell and a pane.** The sync
  resolves the roots in the login environment.
- **Disk**: about 110 MB per host plus Node and whatever Mason installs.
  Old units are deleted by the swap.

## Checked

- `carryTree.test.ts`: the filters (no `.git`, tests, maps or secrets; every
  binary kept), symlinks, the digest, git's file list for the config, and
  the tar stream unpacked by `tar` (long names, pax, links, modes, owners).
- `carryHost.test.ts`: the manifest and its diff; the launcher; a sync to a
  host that is a second home directory under `/bin/sh` with DevHub's real
  Neovim and a lazy.nvim stand-in: the carried tree, lazy's build on the
  host for the specs that declare one (and a failing one reported in its
  own words), the missing language server, a one-unit change, a removed
  plugin, the guard (no installs, no checker, no update or sync, `build`
  kept), a `NVIM_APPNAME` the person set, a Neovim started mid-sync waiting,
  and a dead sync's marker not waited on. With `DEVHUB_LAZY_NVIM` the guard
  runs against that lazy.nvim.
- `carrySsh.test.ts` (with `DEVHUB_CARRY_SSH_HOST`): through `SshRuntime`
  and a real ssh.
- End to end, on this machine: a throwaway account behind `sshd -i` in a
  network namespace with no network (and a second one with network), opened
  as SSH Workspaces in DevHub. `nvim` in a pane came up drawn by DevHub with
  the colorscheme, the statusline, gitsigns, snacks and the snacks-ui framed
  picker, devhub.nvim, and the guard; the missing language servers and the
  failed builds were in DevHub's notice; a config edit here was on the host
  2 s later as a 34 KB sync; the host's `~/.config/nvim` was untouched.
