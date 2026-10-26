# Terminal mode: a tmux editor area instead of a VS Code workbench

DevHub hosts a patched VS Code and gives every Workspace a workbench of its
own. Terminal mode is the other answer to "what is in the editor area": no
workbench at all, and in its place the Workspace's own tmux session — the same
`ws-<digest>` session the editor's DevHub terminal tabs attach to — drawn by
DevHub's own terminal surface. Neovim does not occupy it. It is a terminal; the
person may run Neovim in it, or anything else.

DevHub is built assuming Neovim is the editor in this mode. There is no
`editor = "vscode" | "neovim"` setting and no plan for one: what is chosen is
whether a workbench exists, and the one place DevHub itself needs an editor —
a file jump — is answered by a Neovim DevHub manages (below). The person's own
Neovim configuration stays in their dotfiles; DevHub never writes it.

## The setting

```toml
[general]
workbench = "terminal"   # or "vscode", the default
```

`general.workbench` is application level, like `appearance.title_bar`: it is
read **once, at launch**, from the file's text before anything is built
(`workbenchModeIn` in `model/config.ts`, `main/shell/workbenchMode.ts`), and a
change takes effect the next time DevHub starts. The Settings window offers it
under General ▸ Editors ("Editor area") and says so. A file that will not parse
answers with the default, for the same reason `titleBarModeIn` does: the real
load runs moments later on the same text and is what reports the problem.

Why a restart rather than a live switch: everything about a workbench — the
lifecycle's plan, the VS Code services it is built through, the terminal
colours it reports, the views attached to it — would have to be torn down or
brought up in one step, and a Workspace half in one mode and half in the other
is a state nobody needs. One mode per process is one answer everywhere.

## What changes in the window

The layout (`main/shell/windowLayout.ts`) has a child kind for it,
`editorTerminal`, keyed by the Workspace's editor key exactly as a workbench
is. Everything that is "where the editor is" is answered for it the same way:

| Arrangement                | VS Code mode                  | Terminal mode                                  |
| -------------------------- | ----------------------------- | ---------------------------------------------- |
| Workspace selected (full)  | its workbench                 | its editor terminal, the whole content area    |
| Split (`Cmd+Q Z`)          | workbench left, Agent right   | editor terminal left, Agent right              |
| Agent alone                | Agent; workbenches stay built | Agent; editor terminals stay attached, hidden  |
| Keyboard `editor` half     | the workbench                 | the editor terminal                            |
| `Cmd+Q E`, `Cmd+Q O`       | to / through the workbench    | to / through the editor terminal               |

The editor terminal is the **Agent terminal pane's machinery reused**: one
`pane.html` view per Workspace (`ShellWindow.syncEditorTerminalViews`), whose
fragment names the Workspace (`#workspace:<id>`) instead of an Agent terminal,
mounting the same `TerminalSurface` on the surface key
`workspace-terminal:<workspaceId>` — a key the terminal service has always
resolved to the Workspace's `ws-` session. There is no second terminal
implementation; chords, the IME, zoom, scroll sensitivity, the theme and the
attach/detach protocol are the Agent pane's. A view is made the first time its
Workspace is shown and kept (hidden, attached) until the Workspace goes, so
coming back is a move rather than a reattach and a reflow, the way an Agent
terminal's view is kept.

A click into it is the editor half taking the keyboard (`ContentFocus`
`editor`), so the split's selected half follows the click as it does for a
workbench.

**An SSH Workspace** works the same way: its editor area is the host's own
`ws-` session — the DevHub tmux on the host that its Agents' terminals already
use — attached through the same remote PTY (`ssh -tt` on the host's master)
an Agent terminal on that host uses. The surface key resolves to the
Workspace's machine, so nothing in the view or the attach knows it is remote.
The first time it is shown in a run, DevHub terraforms the host (below).

**A Workspace whose editor is attached to a dev container** is not supported
in terminal mode yet. Its editor area draws "Terminal mode does not support
Workspaces whose editor is in a dev container yet." (the window's own page, in
the rectangle a view would be laid into) and no view is made; a file jump to
one is refused with the same sentence. Its Agents and their terminals work as
before. Phase 3 below is what lifts this.

## No workbench is created

Every workbench comes from one executor, `AppController.reconcileWorkbenches`
over the lifecycle's plan (`workbenchLifecycle.ts`). In terminal mode it plans
nothing: `wanted` is empty, so nothing is opened, nothing sleeps, nothing is
capped, and the minute check has nothing to do. The other doors are closed as
well, so that a workbench cannot appear by a side entrance:

- `scratchWorkbench`, `selectedWorkbench` and `workbenchReady` — the callers
  that wait for "the" workbench of a folder — refuse with a sentence instead
  of waiting for an open that will never come.
- VS Code's own `openInBrowserWindow` (a request no DevHub entrance makes in
  this mode, but an extension-less VS Code main process can still be asked) is
  answered by selecting the Workspace and opening nothing.
- Reopening an editor in or out of a dev container is refused.

VS Code's main process still runs: it is what DevHub is built inside, and the
`devhub` CLI's extension commands still talk to it. What does not exist is any
renderer, extension host or remote extension host.

## The managed Neovim server

A file jump needs an editor that DevHub can address. DevHub keeps **one
Neovim per Workspace of its own** — separate from any Neovim the person starts
in the same session (duplicates are fine and expected).

### Where it runs

The first jump into a Workspace opens a **new tmux window** in that Workspace's
`ws-` session (`new-window -P -F '#{pane_id}' -c <root> -- <nvim> --listen
<socket>`), not a split of the active window. A split would shrink whatever
the person has open — usually a shell they were typing in — to half its width,
and take the editor down to half the area it is for; a window is the full
editor area, appears in the person's window list like any other, and leaves
their layout alone. Later jumps `select-window` + `select-pane` on its pane, so
it is in front however the person has moved around since.

Then DevHub selects the Workspace (beside the asking Agent, for a conversation
link, exactly as the VS Code routing does), puts the keyboard in the editor
area, and opens the file over RPC.

### The socket

`<userData>/devhub/nvim/<digest>.sock`, where the digest is the first twelve
hex digits of the SHA-256 of the Workspace id: one per Workspace, stable across
DevHub restarts, and DevHub's alone (the directory is `0700`). A path that
would exceed the platform's `sun_path` (104 bytes on macOS) falls back to
`$TMPDIR/devhub-nvim-<uid>/`; a fallback that is still too long is a failure
that says so, never a socket that silently fails to bind.

### RPC

A small msgpack-rpc client in main (`main/editor/msgpack.ts`,
`main/editor/neovimRpc.ts`) over the unix socket. Chosen over `nvim --server
<sock> --remote` / `--remote-send`, because:

- `--remote-send` types keys, so what it does depends on the mode the person
  left Neovim in (insert, a pending operator, the command line); RPC calls are
  mode-independent.
- one long-lived connection per server is also the **death detector**: the
  socket closing is Neovim exiting, observed the moment it happens, with no
  polling and no extra process per jump.
- arguments travel as values. A path with spaces, quotes or `|` needs no
  escaping because nothing is parsed as a command line.

The open is one `nvim_exec_lua` call with the path, line and column as
arguments: `:drop` the file (it focuses a window already showing it), falling
back to `:edit`; set the cursor (clamped to the buffer); `zv` to open folds;
`zz`. Before it, `nvim_get_mode` — if Neovim is blocked at a prompt (hit-enter,
`confirm()`), `<Esc>` is sent once so the request is not queued behind it. A
selection with an end puts the cursor at its start.

`devhub --wait` is honoured: the same call registers `BufDelete`,
`BufWipeout`, `BufUnload` and `VimLeavePre` autocommands for that buffer that
delete the wait marker, so `EDITOR="devhub --wait"` works with `git commit`.
Markers are also remembered beside the server and deleted by DevHub when the
server dies without running its autocommands (a `kill -9`).

### Lifecycle

`ManagedNeovims` (`main/editor/managedNeovim.ts`) holds `{ paneId, socket,
client, waitMarkers }` per Workspace. Every jump re-establishes the truth
before using it:

1. **Alive** — the record's connection is open *and* the pane is still one of
   that Workspace's marked panes on DevHub's tmux server: activate the pane,
   open the file.
2. **Not known, but a server answers on the socket** — DevHub restarted while
   Neovim kept running in tmux (sessions outlive DevHub, so this is the normal
   case after a relaunch). The server is asked for `$TMUX_PANE`, the pane is
   checked against the Workspace's panes, and it is **adopted**. No state file:
   the socket path is deterministic and the pane is the server's own answer.
3. **Dead or stale** — the connection closed, the pane is gone or not this
   Workspace's, or the socket file exists with nothing listening (`ECONNREFUSED`):
   the record is dropped, the stale socket unlinked, outstanding wait markers
   deleted, and a new Neovim is started in a new window.

Starting waits (bounded) for the socket to accept a connection, and gives up
early — with "Neovim exited before it opened its socket" — if the pane has
already gone, which is what a broken config that `:cq`s looks like.

**Closing a Workspace** kills the managed pane and unlinks the socket, in the
close's `editor` step (the step a workbench's unload is in VS Code mode). Its
unsaved buffers are protected the way any running program in the Workspace's
session is: the close confirmation counts a pane running something other than
the shell as busy work, so the person is asked first. **Quitting DevHub** only
closes the RPC connections; Neovim keeps running in tmux and is adopted on the
next jump.

### The `nvim` binary

On this Mac: the person's `nvim`, looked up on the login PATH DevHub already
imported (the same lookup `runtimes.*` gets, `main/shell/runtimes.ts`),
resolved at the first jump. Missing is a notice that names `nvim` and the
directories searched, and the jump is refused — not a pane that flashes and
closes.

On an SSH host: the Neovim DevHub carries, installed there by terraforming,
started through the wrapper that gives it the person's configuration — or the
host's own `nvim` when DevHub's cannot run there, said as a notice. See "SSH
Workspaces" below.

## File-open routing

The rule that picks *which Workspace* is unchanged (`routeOpen`,
`routeAgentOpen`); what changes is what is done with the answer
(`AppController.openRouted`).

| Entrance                                       | VS Code mode                                   | Terminal mode                                                   |
| ---------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `devhub <file>` on this Mac                    | the containing Workspace's workbench / Scratch | that Workspace's managed Neovim / Scratch's                     |
| `devhub -g <file>:<line>:<col>`                | caret at the position                          | cursor at the position                                          |
| `devhub --wait <file>`                         | `filesToWait`                                  | buffer autocommands delete the marker; DevHub on server death   |
| `devhub <folder>`                              | Workspace selected, workbench shown            | Workspace selected, editor terminal shown                       |
| Conversation file link                         | split beside the Agent, workbench in front     | split beside the Agent, editor terminal in front, Neovim        |
| Finder Open With / Dock drop / `open -a`       | via `openFromCli`                              | via `openFromCli`, as above                                     |
| `devhub` on an SSH host                        | that Workspace's remote workbench              | that Workspace's managed Neovim, on the host                    |
| Conversation link of an Agent on an SSH host   | the Workspace's remote workbench               | the Workspace's managed Neovim, on the host                     |
| `devhub` in a dev container                    | the window attached to that container          | refused: not supported in terminal mode yet                     |
| A Workspace whose editor is in a container     | its workbench                                  | refused, same sentence                                          |
| VS Code's own open (`openInBrowserWindow`)     | DevHub's Workspace / Scratch rule              | Workspace selected; no workbench is opened                      |

## What is hidden or inert in terminal mode

None of these error; they are not offered, or have nothing to act on.

- **Everything that lives inside a workbench**: DevHub Vim, tidy, Copilot, the
  bridge and remote extensions, VS Code's menus and command palette, the
  integrated Browser, diff and review editors. There is no workbench for them
  to run in.
- **Workbench hibernation and the awake cap** (`general.workbench_hibernate_minutes`,
  `general.workbench_awake_max`): the plan has nothing to put to sleep. The
  Settings rows stay, with a note that they apply to VS Code mode.
- **View ▸ Toggle Integrated Terminal** and its chord: not in the menu.
- **Reopen Editor in Container / Locally** on a Workspace row: not in the menu.
- **Workbench placeholders** (asleep, waking, restarting, gave up): never
  raised.

Agents, Agent terminals, the Sidebar, notices, chords, usage, the `devhub`
command and every tmux-side feature (`devhub --tell terminal …`, moving an
Agent's terminal to the editor — which now lands in the editor area, in view)
are unchanged.

## Theme

The chrome and the terminal palette come from the VS Code colour theme
DevHub's own settings name (`appearance.theme_dark` / `appearance.theme_light`,
read by `colorThemeCatalog.ts` and `shellTheme.ts` from the extensions on
disk), not from a workbench's report. That source never needed a workbench —
it paints the window from a cold start and with every workbench asleep — so
terminal mode uses it unchanged: the editor area's terminal is an Agent pane's
surface and wears the same `terminal_theme` (the theme's terminal colours by
default, or the configured palettes).

## SSH Workspaces: terraforming (phase 2)

The idea is the one the remote extension host already follows, taken further:
DevHub brings everything the editor area needs onto the machine — tmux,
Neovim, the person's Neovim config — so the host needs nothing installed and
nothing configured. It is done the first time an SSH Workspace's editor area
is shown in a run (`NeovimMachines.warm`), and again, cheaply, before every
new managed Neovim there.

### What goes where

```
~/.devhub-server/                     serverDataFolderName, beside the REH
  tmux/<version>/                     DevHub's static tmux (already there)
  nvim/<version>-<sha12>/             the Neovim DevHub carries, for this
    bin/nvim  share/nvim/runtime/…    host's architecture
  nvim/devhub-relay-<sha12>.lua       the RPC relay, named by its content
  xdg/config/nvim/                    a copy of ~/.config/nvim from the Mac
  xdg/config/nvim.devhub-digest       which copy it is
  xdg/data/ xdg/state/ xdg/cache/     plugins (lazy), servers (mason), shada,
                                      undo, logs — the host's own, kept
  run/nvim/<digest>.sock              one managed Neovim per Workspace (0700)
~/.devhub/devhub-bin-<tag>/nvim       a wrapper, first on every DevHub pane's
                                      PATH there (beside the `devhub` shim)
```

Everything travels over the connection DevHub already holds, as bytes on the
stdin of a `sh` on the host (`RemoteShellRuntime.exec`), unpacked by the
host's `tar` into a staging directory and renamed into place — the tmux
install's shape. Nothing on the host reaches the network for DevHub.

- **The Neovim** (`scripts/build_nvim.py`, `editor/neovimDelivery.ts`): the
  owner's builds from https://github.com/statiolake/neovim-binaries — upstream
  tags built with upstream's own cpack recipe on Debian stretch, so they need
  glibc **2.14** (x86_64) / **2.17** (aarch64) instead of the official
  tarball's 2.31. Pinned in the build script by tag (`v0.12.6`) and the
  sha256 of each asset, and the glibc floor is pinned too and checked against
  the binary's own symbol versions. Fetched at build time into `dist/nvim/`,
  packaged into `Contents/Resources/nvim/` with a statement (`nvim.json`);
  never fetched while DevHub runs. The version directory is named by the
  tarball's hash, so "installed" is a directory that answers `--version`,
  and an unchanged one is never sent again.
- **The configuration** (`editor/neovimConfig.ts`): `$XDG_CONFIG_HOME/nvim`
  on this Mac, else `~/.config/nvim` — symlinks followed (the dotfiles link,
  and any link inside; a loop walked once; a dangling link skipped), without
  `.git`, `.DS_Store`, `node_modules`, `.cache`, `__pycache__`, `.venv`, and
  without any single file over 8 MB (said as a notice); over 64 MB in all is
  refused. Hashed over what it means (paths, kinds, exec bits, bytes), packed
  as a deterministic ustar (+ pax for long names) and gzipped, and sent only
  when the host's digest differs. No configuration here removes the copy
  there. The copy is replaced whole: it is DevHub's mirror, not a place to
  edit (a `lazy-lock.json` lazy.nvim rewrites there is overwritten by the
  next sync from the Mac).
- **The wrapper** sets `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`
  and `XDG_CACHE_HOME` to `xdg/*` and `exec`s the chosen Neovim. It lives in
  the directory DevHub already puts first on the PATH of every pane it
  creates on the host (`remoteCliBinDirectory`), so `nvim` typed in the
  editor area — or in an Agent's terminal there — is the same Neovim with the
  same configuration the managed one has. The host's own `~/.config` and
  `~/.local` are not read or written, and a login outside DevHub is
  untouched.
- **Plugins and language servers** are the configuration's business, on the
  host: lazy.nvim bootstraps with `git` on first start and keeps its plugins
  in `xdg/data`, mason downloads with `curl`/`wget` and unpacks with `unzip`.
  No treesitter parser or native plugin is prebuilt.

### Detection, notices and fallbacks

One probe (`probeScript`) answers everything at once: home, `uname -s/-m`,
uid, the C library (`LIBC_PROBE`, the REH's), the glibc version (`getconf
GNU_LIBC_VERSION`, else `ldd --version`), which of `git`, `curl`, `wget`,
`unzip` are on the login PATH, the host's own `nvim` and its version, which
bundle directories already answer, and the configuration copy's digest.

| Host                                              | Neovim used                            | Said                                             |
| ------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| Linux x86_64 / aarch64, glibc ≥ the floor         | DevHub's                               | nothing                                          |
| musl (Alpine), glibc below the floor, other arch, not Linux, no bundle in this DevHub | the host's `nvim` (≥ 0.9) | a notice: why, and that the host's is used, with the person's configuration |
| DevHub's unpacked but does not start (`libnsl.so.1` missing, …) | the host's, and DevHub's is removed | a notice with the loader's own line   |
| none of the above, and no usable host `nvim`      | none: a jump there is refused          | the refusal, with every reason                   |
| no `git` / no `curl` and `wget` / no `unzip` (with a configuration) | unchanged             | a notice naming what lazy.nvim / mason cannot do |
| the `devhub` command's Node (the REH) cannot be installed | unchanged                     | a notice: panes and Agents there cannot open files in DevHub |

The notices are one standing condition per host (`neovim:<machine>`), taken
down when a later terraform has nothing to say. None of them blocks the
editor area: it is tmux, and tmux is the one thing that has to work.

The host's own Neovim must be 0.9 or newer, because the relay is `nvim -l`.

### The editor area

The editor terminal attaches the host's `ws-` session through the existing
remote PTY, exactly as an Agent terminal on that host does — nothing new.

### The `devhub` command on the host

It is run by the remote extension host's Node, which a workbench installs in
VS Code mode. In terminal mode there is no workbench, so terraforming
installs the server's files on the host (`RemoteServerHost.installServerFiles`
— the install alone, nothing started), in the background: a pane or an Agent
there can then `devhub <file>`, and the file opens in that Workspace's managed
Neovim on the host. A conversation link of an Agent on the host goes the same
way.

### The managed Neovim on a host

The lifecycle is phase 1's, unchanged (`ManagedNeovims`, one instance per
machine, built in `shell/neovimMachines.ts`): a new window of the host's `ws-`
session running `<wrapper> --listen ~/.devhub-server/run/nvim/<digest>.sock`
(falling back to `/tmp/devhub-nvim-<uid>/` when the path will not fit a
socket address); reused while alive; started anew after it exits; adopted
after a DevHub restart by asking it for `$TMUX_PANE`; killed when the
Workspace closes (and, on an unreachable host, left to go with the session —
a close is never held up by a host it cannot reach). Waiting for the socket
is a round trip per poll, so it polls every 250 ms for up to 15 s.

### RPC through a relay

The client is phase 1's msgpack-rpc client over a `NeovimWire` instead of a
socket. The wire is the stdio of `ssh -T` on the host's master running

    <neovim> --clean --headless -n -i NONE -l ~/.devhub-server/nvim/devhub-relay-<sha>.lua <socket>

— a few lines of `vim.uv` that splice stdio to the socket
(`editor/neovimRelay.ts`). It says `devhub-relay connected` or `devhub-relay
refused <ERRNO>` on stderr before any RPC byte, so stdout stays pure msgpack
and a refusal carries the errno the lifecycle already reads (`ENOENT`,
`ECONNREFUSED` = stale socket). Chosen over:

- **OpenSSH stream-local forwarding** (`-L` / `-O forward` of a unix
  socket): needs `AllowStreamLocalForwarding`, which hardened hosts disable;
  leaves a socket file on the Mac to manage; and is not a death detector —
  the forward stays up after the Neovim behind it exits.
- **`socat` / `nc -U`**: not on a bare host.

The relay keeps phase 1's property that one long-lived connection per server
is the death detector: Neovim exits → the socket closes → the relay exits →
ssh exits → the wire closes. It holds one session of the host's ssh master
(`MuxSessions`) while it lives.

### Routing

`devhub` on the host, a conversation link of an Agent there, and a jump to an
SSH Workspace from this Mac all land in that Workspace's managed Neovim on its
host. A path on one machine is never opened by a Neovim on another: a host
path that routes to Scratch (no Workspace on that host contains it) is refused
with a sentence that names both machines.

## Phase 3: dev containers (specified, not implemented)

A Workspace's editor attached to a dev container keeps being refused in
terminal mode until this lands. Everything below is what it takes.

### The decision to make first

`docs/remote-containers.md` makes a rule of where things run: a Workspace's
terminals, its tmux server and its Agents run **where its folder is** (this
Mac or the SSH host), never in the container, and `ContainerHost` refuses a
pty, a stream and tmux as the bug they would be. The editor's DevHub terminal
of a workbench attached to a container is the Workspace's own `ws-` session
on its machine.

The earlier sketch of this phase put tmux, and the Workspace's `ws-` session,
inside the container. That breaks the rule: the editor area's session would
be in one place and the Agents' terminals in another, the session sweep,
activity loop and close confirmation (which walk each `Runtime`'s tmux)
would not see it, and a rebuilt container would take the person's shells
with it. So the specification below keeps the rule:

- **The editor area** stays the Workspace's `ws-` session on its machine —
  exactly what VS Code mode's editor terminal is for a container Workspace,
  and what phases 1 and 2 already draw. The person reaches the container
  from it the way they already do (`devcontainer exec`, `docker exec`).
- **The managed Neovim** runs **in the container**, where the toolchain and
  the language servers are.

If the editor area must instead be a session inside the container, the
rule in `remote-containers.md` changes first, with `ContainerHost` growing
`spawnPty`/`spawnStream`/`tmuxProgram`, the container becoming a machine the
terminal service, the sweep and the activity loop know — a separate,
larger piece of work, and the person's call.

### Terraforming a container

`NeovimTerraform` is machine-neutral: it needs a `TerraformShell`, and
`ContainerHost`'s `exec` is `docker exec -i [-u remoteUser] <id> /bin/sh -c`
with stdin — the same channel the REH install into a container already uses.
So a container is terraformed by the same code with the same layout under the
container user's `$HOME/.devhub-server/` (`docker cp` is not needed: a
stream on stdin is what both SSH and the container already carry). The
probe's libc detection matters more here: Alpine-based images are common, and
fall back to the image's own `nvim` with the notice. The `devhub` command in
the container already exists (its relay is `ContainerHost`'s), so no server
install is added. A container rebuilt from its definition loses all of it;
the next jump terraforms again, and the hash makes that a copy, not a
download. The wrapper goes where the container's `devhub` shim is
(`startServerScript`'s bin directory), so `nvim` in `docker exec` shells the
person opens through DevHub finds it.

### The managed Neovim in a container

- **Pane:** a new window of the Workspace's `ws-` session on its machine,
  running `docker exec -it -e TMUX_PANE [-u remoteUser] -w <container folder>
  <container id> <wrapper> --listen <socket in the container>`. `-e TMUX_PANE`
  with no value forwards the pane's own, so adoption by `$TMUX_PANE` works
  unchanged. `docker` is the one `ContainerMachine` names on that machine
  (`localContainerMachine` / `hostContainerMachine`).
- **Relay:** `docker exec -i [-u remoteUser] <id> <neovim> --clean --headless
  -l <relay> <socket>`, launched through `ContainerMachine.dockerLaunch` —
  over the host's master for a container on an SSH host.
- **Paths:** a jump carries a path on the Workspace's machine (Agents run
  there); the Neovim needs the container's. `ContainerHost.workspacePath()`
  (the CLI's own `workspaceFolder`) and the Workspace's root give the prefix
  map, applied both ways (`devhub` inside the container sends container
  paths, which `openFromContainer` already resolves there). A path outside
  the mounted folder is refused by name.
- **Lifecycle:** unchanged. A rebuild changes the container id; the old
  `docker exec` ends, the relay ends, the record is dropped, and the next
  jump starts one in the new container. Reopen Folder Locally kills the
  container's managed Neovim (the Workspace's editor moved), as a Workspace
  close does.
- **Menus:** Reopen in Container / Locally come back in terminal mode, and
  mean "where the managed Neovim runs"; the editor area does not move.

### Tests

The same shapes as phase 2: `NeovimTerraform` against a fake
`TerraformShell` whose probe says musl/Alpine; the path map as a pure
function; and a docker test (gated like `rehInstall.docker.test.ts`) that
terraforms a `debian` and an `alpine` container and opens a file through the
relay.

### Order

1. Local (phase 1): the mode, the editor area, the managed Neovim, routing.
2. SSH (phase 2): Neovim bundle + config terraforming + relay; the SSH
   editor area; `devhub` on the host.
3. Dev containers (phase 3): as specified above.

## Open questions

- **musl hosts.** The bundle is glibc (2.14/2.17 floor, which covers the
  Synology and CentOS 7 cases); a musl host falls back to its own `nvim`.
  Should DevHub also carry a static musl Neovim, in `build_tmux.py`'s style,
  for an Alpine host with no `nvim` of its own?
- **XDG reaches Neovim's children.** The wrapper's `XDG_CONFIG_HOME` is
  inherited by what Neovim starts (`:terminal`, `:!git`, a lazygit), so a
  `git` run from inside it reads `~/.devhub-server/xdg/config/git/config`
  rather than `~/.config/git/config` (`~/.gitconfig` is read either way).
  Should the wrapper restore the originals for children (`vim.env` in a
  `--cmd`), at the price of a second mechanism?
- **Plugins offline.** Bootstrapping lazy.nvim on a host with no route to
  GitHub fails. Should terraforming also copy the local plugin tree
  (`~/.local/share/nvim/lazy`), which is pure Lua for this person's setup?
- **Selections.** A link with a range puts the cursor at its start. Should it
  select the range in Visual mode instead?
- **Several clients.** Two clients attached to one `ws-` session share its
  current window, so selecting the Neovim window for a jump also moves any
  other client (a `tmux attach` the person runs in Terminal.app). Acceptable,
  or should the editor area use a grouped session?
- **`devhub --wait` and `:wq`.** `:wq` in the managed Neovim ends the server
  (and the marker with it), and the next jump opens a new window. Should a
  `--wait` jump instead open its buffer in a *new* Neovim that ends with it,
  the way `git commit`'s editor usually does?
- **The activity mark.** A Workspace's row shows "working" while a non-shell
  program in its session prints, and Neovim redrawing as the person types is
  that. Should an editor (`nvim`, `vim`) in front of a pane count as a prompt
  rather than as work?
- **The setting's name.** `general.workbench` names what is chosen (whether a
  workbench exists). If a third mode ever appears this stays right; an
  `editor = …` would not.
