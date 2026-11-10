# SSH Workspaces

Open a folder on another machine and work in it as if it were local. DevHub
already holds a connection to the host — a ControlMaster, for git, terminals
and Agents — and runs everything a Workspace there needs over it: the
Workspace's terminal (its `ws-` tmux session, on the host), its Agents, and its
editor, the Neovim DevHub draws over that terminal (`docs/neovim-editor.md`).
Nothing on the host has to be installed by hand.

DevHub used to open a VS Code window on the host instead, with VS Code's
remote extension host copied there; that went with VS Code
(`docs/without-vscode.md`).

## The `devhub` command DevHub puts on a host

The `devhub` command on a host is the app's own static Go binary for that
platform (`cli/`, `docs/devhub-cli.md`), carried inside the app in
`out/cli/<os>-<arch>/devhub` and installed the same way as tmux and bash —
the same `ToolDelivery`, written over the connection as one file rather than
unpacked from a tarball (`BundledToolDelivery`, `runtime/bundledTool.ts`),
into `~/.devhub-server/devhub/<build>`. It needs no Node and no particular
libc, so a musl host gets it too. Nothing has to be published for it.

## Everything a host is given comes from inside the app

tmux, bash, Neovim, Node, ripgrep and fd reach a host the same way. The app
build (`apps/desktop/scripts/fetch-binaries.mjs`, `build:binaries`) downloads
every pinned asset for both Linux architectures, checks it against the sha256
`apps/desktop/product.json` pins, and keeps it compressed in the app:

```
out/host-tools/manifest.json                 per tool: version, binary path; per platform: file, sha256, directory
out/host-tools/linux-x64/tmux-3.7c.tar.gz    DevHub's tools release (tools-<toolsVersion>)
out/host-tools/linux-x64/bash-5.3.20.tar.gz  DevHub's tools release
out/host-tools/linux-x64/nvim-0.12.6.tar.gz  Neovim's release
out/host-tools/linux-x64/node-26.13.0.tar.gz nodejs.org, the official LTS
out/host-tools/linux-x64/rg-15.2.0.tar.gz    ripgrep's static musl build
out/host-tools/linux-x64/fd-10.5.1.tar.gz    fd's static musl build
out/host-tools/linux-arm64/…                 the same for arm64
```

On a host, DevHub asks `~/.devhub-server/<tool>/<version>/<binary>` for its
version. If nothing answers, it checks the app's tarball against the
manifest, sends it as bytes over the connection already open, and unpacks
it from a `tar` reading stdin (`runtime/toolDelivery.ts`,
`BundledArchiveDelivery`). Then it asks again. **Nothing downloads at
runtime**, not this Mac and not the host. A NAS behind a firewall has no
route to github.com, and a laptop on a plane still connects to the machine
on the next desk.

## Everything DevHub sends a host is POSIX `sh`

Every script `main/runtime/remoteShellRuntime.ts` and `main/runtime/ssh.ts`
compose is `sh`: `case`, `[ ]`, `printf`, `command -v`, `set -C` for an exclusive
create, `cd -P && pwd -P` for a realpath, `kill -0` for "is that pid alive". The
server install is the same rule — a staging directory and a `mv`, not
`tar --strip-components`, which GNU tar and bsdtar have and POSIX does not
require — and so is the wait loop, which sleeps whole seconds because BusyBox's
`sleep` refuses a fraction.

This is not a style preference. There is no bash on a Synology and no guarantee
of one anywhere, and the host this product exists for is exactly that host.

## tmux on the host

Every DevHub terminal and every Agent is a tmux session on the machine the
Workspace lives on — that is the whole of "Agents and terminals on the host",
further down. The host therefore needs a tmux, and DevHub brings its own rather
than looking for one.

**The host's own tmux is never used.** Not preferred-if-present, not
fallen-back-to: not used. tmux's control surface — the `list-sessions` format,
`capture-pane -e`, `display-message -p` — differs between versions in ways that
surface as an Agent whose output is subtly wrong rather than as an error, and
the adapter is written against one version. It is also not a thing every host
has: the case this exists for is a Synology NAS, where there is no tmux in the
image, no package manager worth the name and no sudo, and "install tmux" is not
an instruction the owner of the box can follow.

The machine DevHub runs on is no different: the app carries the same build
(`out/tmux`, darwin-arm64 in the Mac app), and the PATH's tmux is not used
there either. A host's panes find the delivered binary first on their PATH,
ahead of the host's own (`docs/terminal-mode.md`, "DevHub's tmux").

### What is built, and where it is published

`scripts/build_tmux.py` builds tmux from a pinned release tarball together with
pinned libevent and ncurses, links all three in statically, and packs:

```
devhub-tmux-linux-x64/
  bin/tmux            the statically linked binary, mode 0755
  terminfo/           a small compiled database — see below
  licenses/           tmux, libevent and ncurses, whose code is in the binary
```

The three pins, their checksums and the reasons behind them are at the top of
the script; the versions as of writing are tmux 3.7c, libevent 2.1.13-stable
and ncurses 6.6. The tarball is a couple of megabytes.

It is published on DevHub's **tools release**, beside bash. tmux and bash
have no good upstream distribution, so DevHub builds them itself. Each
architecture is one tarball (`scripts/build_tools.py`) holding each tool's
tarball as it was built, plus a `tools.json` naming them:

```
https://github.com/statiolake/devhub/releases/download/tools-<toolsVersion>/devhub-tools-<toolsVersion>-<os>-<arch>.tar.gz
                                                                            …/SHA256SUMS
```

`darwin-arm64`, `linux-x64` and `linux-arm64` are each built on a runner of
their own architecture, with no cross-build, by `.github/workflows/tools.yml`
when a tag `tools-<toolsVersion>` is pushed. `toolsVersion` is the release's
own version, independent of DevHub's and of the tools'. `product.json` pins it
and each asset's URL and sha256 (`toolsDownloadUrls`, `toolsDownloadSha256`),
along with the tmux and bash versions the release must hold. A release never
moves. A new tool pin, or a change to the build, is a new `toolsVersion` and
a new tag. The run's summary prints the `toolsDownloadSha256` to paste in.

### Static, and why musl

The binary has to start on a Synology running a glibc from a decade ago and on
this year's Debian, and may not assume a libevent or an ncurses exists
anywhere. It is built with `musl-gcc` (Ubuntu's `musl-tools`), not with glibc's
`-static`: a statically linked glibc still `dlopen`s the NSS modules of the
machine that built it the moment anything asks who the user is, and tmux does
exactly that at startup — `getpwuid`, to find the login shell and the home
directory. On an older host that is a crash or a wrong shell with no message
attached. A musl static tmux has no libc on the host at all.

The build refuses to fall back to the system compiler, and refuses to pack a
binary `file` does not call statically linked.

### Terminfo travels with it

A static ncurses has the terminfo code compiled in and no terminfo _database_ —
that is a directory read at runtime, and a bare host may have none. So the
tarball carries one: eleven names (`xterm-256color`, `screen-256color`,
`tmux-256color`, `linux`, `vt100` and friends, plus the aliases `tic` writes
alongside them), compiled by the `tic` the same build produced. DevHub sets `TERMINFO` to the unpacked `terminfo/` directory
when it runs the binary, so nothing reads the host's database and nothing
writes to it.

### Where it is installed

```
~/.devhub-server/tmux/<version>/bin/tmux
~/.devhub-server/tmux/<version>/terminfo
```

Beside the remote extension host, under the same `serverDataFolderName`, and
versioned for the same reason the server is keyed on a commit: two DevHubs of
different ages on one host each find their own and neither disturbs the other.
DevHub installs it on first use and sends nothing when the binary is already
there.

### Installing one by hand

To try a build that is not published yet. `<version>` is the one the app asks
for; `product.json`'s `tmuxVersion` and the pin at the top of
`scripts/build_tmux.py` are the same number.

```sh
# on the host
version=3.7c
mkdir -p ~/.devhub-server/tmux/$version
tar -xzf devhub-tmux-linux-x64-$version.tar.gz \
    --strip-components 1 -C ~/.devhub-server/tmux/$version
~/.devhub-server/tmux/$version/bin/tmux -V     # should print: tmux 3.7c
```

Nothing else about the flow changes: DevHub finds the binary where it would
have put it and sends nothing.

### Building one locally

```sh
sudo apt-get install -y musl-tools build-essential   # on Ubuntu
scripts/build_tmux.py linux-x64                      # writes dist/devhub-tmux-linux-x64-<version>.tar.gz
```

Only the target that matches the machine: there is no cross-build, and a binary
this machine cannot run is a binary the build cannot ask `-V`. On a Mac,
`scripts/build_tmux.py darwin-arm64` builds and packs the same layout, linked
dynamically against libSystem alone (macOS has no static libc). That is the
tmux inside DevHub.app.

`scripts/build_tools.py` builds this machine's whole tools tarball (tmux and
bash). To build the app against one before its release exists, put the tarballs
and a `SHA256SUMS` in one directory and set `DEVHUB_TOOLS_DIR` to it for
`build:binaries`. The manifest then records the local build, and packaging a
downloadable app refuses it.

## bash for Claude Code

Claude Code will not start without bash or zsh. It takes `$SHELL` if that is a
bash or a zsh, then looks for `zsh` and `bash` on `PATH` and in the usual
directories, and accepts `CLAUDE_CODE_SHELL` only when it names a bash or a
zsh. busybox `sh` is not accepted, so on a Synology NAS — busybox only, no
package manager, no sudo, no internet — a Claude Agent ended at once with the
CLI's "No suitable shell found. Claude CLI requires a Posix shell
environment…", which says nothing its owner could act on.

So DevHub delivers a bash as well, by the same mechanism as tmux
(`main/runtime/toolDelivery.ts`). The static tarball comes from the tools
release, bundled in the app (`out/host-tools`), and is unpacked on the host
from a stream on a `tar` stdin.

```
devhub-bash-linux-x64/
  bin/bash            statically linked (musl), mode 0755
  licenses/bash.txt   GPL-3.0
```

installed at

```
~/.devhub-server/bash/<version>/bin/bash
```

**Always, and only for the Agent.** DevHub runs only the binaries it carries
or delivers (`docs/bundled-binaries.md`), so when it starts a Claude Agent on a
host — a terminal one or a GUI one, and when a terminal one is restarted — it
installs this bash there (once per version) whatever bash or zsh the host has
of its own, and that Agent's process — and only it — gets `CLAUDE_CODE_SHELL`
pointing at it (`main/runtime/agentShell.ts`; not `SHELL`, which tmux sets
to a pane's `default-shell` whatever the session says). The login shell,
tmux's `default-shell` and every terminal stay the person's. A profile that
sets either variable itself keeps its own. On this Mac the same rule holds
with the bash inside the app (`out/bash`, `build:binaries`).

**When there is none to be had** — an architecture the app carries no bash for
(only `linux-x64` and `linux-arm64` are carried), or a build without
`out/host-tools` — the Agent does not start, and its row says, in DevHub's
words, which host and why. DevHub does not fall back to a bash or zsh
installed on the host.

**Published on the tools release**, beside tmux, built by
`scripts/build_bash.py` (which reuses `build_tmux.py`'s fetching, pinning,
static-link check and packing). The version is bash's release plus its patch
level: every official upstream patch is applied, each pinned by sha256. So
`5.3.20` is bash 5.3 with patches 001–020, and `bash --version` on the host
says so.

To build one locally (`sudo apt-get install -y musl-tools build-essential
patch` on Ubuntu): `scripts/build_bash.py linux-x64`. To install one by hand, as
for tmux: unpack `devhub-bash-<platform>-<version>.tar.gz` and move its one
directory to `~/.devhub-server/bash/<version>`.

## The Neovim DevHub draws on a host

The Neovim of a Workspace on a host — its `devhub-nvim` window, and `nvim`
typed in its panes (`docs/neovim-editor.md`, "Which Neovim") — is DevHub's,
never the host's: Neovim's own release archive for the host's platform
(`nvim-linux-x86_64.tar.gz`, `nvim-linux-arm64.tar.gz` from
github.com/neovim/neovim), at the version `product.json` pins
(`nvimVersion`) and checked against `nvimDownloadSha256` when the app is
built. Like tmux it is carried in the app (`out/host-tools`) and unpacked on
the host from stdin, the first time a session there is made, into

```
~/.devhub-server/nvim/<version>/bin/nvim
~/.devhub-server/nvim/<version>/share/nvim/runtime
```

and run by that path (it finds its runtime beside itself). Neovim's Linux
build needs glibc 2.34 or later: a musl host, an older glibc and a host that
is not Linux on x86_64 or arm64 are refused before anything is sent, with
the host and the reason in the notice; its panes' `nvim` is then the host's
own. DevHub publishes nothing for it: Neovim's own release is what the app
bundles. To install one by hand: unpack
the archive and move its one directory to `~/.devhub-server/nvim/<version>`.

## Pointing one host somewhere else

There is no setting for this, per host or otherwise. Which servers a DevHub
carries is a fact about the build — they were made alongside it, from its
patches — and a person who could point one host at a different server could
point it at a server of a different commit, which the server itself would then
refuse.

The `remote.SSH.*` settings the vendored extension had —
`serverDownloadUrlTemplate`, `serverValidation`, `serverInstallPath`,
`enableDynamicForwarding` and the rest — are gone with it, and nothing in DevHub
reads them.

## DevHub on the host

DevHub's control socket is reverse-forwarded onto the host (`ssh -O forward -R ~/.devhub/terminal/control-<tag>.sock:<local socket>`, added to the ControlMaster that is already up), and DevHub writes its programs there under `~/.devhub/terminal/`; the `<tag>` is a digest of DevHub's control-socket path, so two DevHub profiles on one Mac reaching one host do not adopt each other's files.

### The `devhub` command on a host

A pane on a host has a `devhub` on its PATH, and it is DevHub's own. A tmux
pane inherits the tmux **server's** environment, the session's own
`new-session -e` entries and, for `PATH`, the environment of the client that
created the session (see "The PATH a pane gets", below), so the control socket
is written *into* the shim rather than exported.

It speaks DevHub's own control protocol over the socket that is **already**
reverse-forwarded onto the host. Nothing new is opened:

- the command is the app's own Go binary, installed under
  `~/.devhub-server/devhub/<build>/bin/devhub` (above)
- the shim is generated, with the host's own absolute facts in it: that
  binary, the machine, and `~/.devhub/terminal/control-<tag>.sock`
- it goes at `~/.devhub/terminal/bin-<tag>/devhub`, and that **directory** is
  what is put in front of every pane's PATH. A tagged directory rather than a
  tagged file, because two DevHub profiles reaching one host would otherwise
  put two `devhub` scripts at one name
- the PATH is the machine's own with one entry in front. A machine with no PATH
  at all gets no PATH set: a pane that can run `devhub` and not `ls` would be
  worse than a pane with no `devhub`

#### What it carries, and the `/devhub` skill on a host

Every request the host's `devhub` sends says where it comes from, in two
fields, because they answer two questions:

- `machine` — `DEVHUB_MACHINE`, written into the shim (`ssh:<host>`, or the
  container's id): which computer the **paths** in the request are on. A file
  opens in the Workspace on that machine whose root contains it, `devhub
  --tell workspace open .` opens the host's folder on the host, and a `<w>`
  given as a folder (`--workspace /srv/app`, or `.`, made absolute where it was
  typed) matches only Workspaces on that machine — the host's `/srv/app` is
  never this Mac's. `--tell` carries it too, so a `devhub` run outside a
  DevHub pane (an Agent's subshell, a script on the host) still says where it is.
- `origin` — the pane's `DEVHUB_ORIGIN` (`<machine>\t<workspace>\t<agent>`):
  which Workspace and Agent is **asking**. `devhub --tell agent new` with no
  `--workspace` starts the Agent in the asking pane's Workspace, and an answer
  is credited to the asking Agent.

Agents started on a host get `/devhub` as on this Mac. When the machine's
`devhub` command is installed, DevHub also writes the skill's `SKILL.md` to
`~/.devhub/terminal/skill-<tag>/.claude/skills/devhub/` (0700 directory, 0600
file), naming the host's shim by its full path; a Claude Agent there is given
`--add-dir=<that directory>`, and a Codex GUI Agent's `developerInstructions`
point at that `SKILL.md`. A skill that cannot be written is logged and skipped;
the Agents start without it.

Security: the forwarded socket is `~/.devhub/terminal/control-<tag>.sock` in
a 0700 directory owned by the person's account, named by a digest of this
DevHub's own socket path (so two profiles never share one, and the stale one a
previous DevHub left is removed before the forward is made). Anyone who can
reach it can already run commands as that account on that host; it gives them
nothing more there, but it does let them drive DevHub here — which is why the
directory is 0700 and why nothing in it is exported through the environment.
The forward lives on the ssh master and goes with it.

#### The PATH a pane gets

Not through `new-session -e`, and that is not a detail. tmux takes a new pane's
`PATH` from **the client that created the session**, and it beats both the
server's environment and the session's own `-e` entry. Measured against tmux
3.7c, the version DevHub ships:

```sh
# server started by a client holding PATH=/serverpath
tmux -L x new-session -d -s base 'sleep 300'
# session created by a client holding PATH=/clientpath, with -e PATH=/epath
PATH=/clientpath tmux -L x new-session -d -s probe -e PATH=/epath -- sh -c 'echo $PATH'
```

`show-environment -t probe` answers `/epath`; the pane answers `/clientpath`.

On the host that read as everything being in place and nothing working:
`DEVHUB_ORIGIN` arrived, `tmux show-environment` named the tagged directory,
and `command -v devhub` in the pane was empty.

So DevHub states the pane's PATH on **every tmux client it runs** — the
`new-session` and the attaching PTY alike, from the one place that composes a
client's environment (`TmuxTerminalRuntime.tmuxEnvironment`). One rule for both
machines: on this Mac there is nothing to put in front, so nothing is. A pane a
person splits from inside another pane inherits that pane's PATH and needs no
rule of its own.

`DEVHUB_ORIGIN` stays on `new-session -e`, where it works: the client-beats-all
behaviour is `PATH`'s alone.

`-`, `--wait` and `--goto` are the same `stdin.ts`, `wait.ts` and `goto.ts` the
local command uses — that is the point of there being one protocol. Two things
the shim says that the local launcher does not have to:

- `DEVHUB_MACHINE=ssh:<host>`, which is which computer the paths typed into
  that pane are paths on. Without it a host's `/srv/app` is matched against a
  Workspace of the same name on this Mac, and the file opens off the wrong disk
- nothing about how to start DevHub, because there is no way to. DevHub runs on
  the machine the window is on, and this socket is forwarded from it. A
  `devhub` there that finds nothing listening says
  `DevHub is not listening on <socket>`

### Agents and terminals on the host

There is one `TmuxTerminalRuntime` per `Runtime`, built on first use and cached
beside `runtimeFor` (`main/shell/terminalRuntimes.ts`). Everything a tmux
adapter does — the socket, the marker protocol, the bootstrap probe, the
inventory, the captures — goes through that machine's `Runtime.exec`, and the
attaching client's PTY through its `spawnPty`. A terminal target carries its
machine (`RuntimeId`), so two hosts with the same `/srv/api` are two sessions
and every consumer takes its adapter from the target rather than from whichever
one it is holding.

- **`$HOME`, `tmux` and the shell are resolved on the machine**, by
  `Runtime.home` and `Runtime.resolveProgram`. A host with no `tmux` makes that
  machine's adapter unavailable, with the sentence naming what was looked for
  and where — git, worktrees and the Issue and pull-request rows on that host
  are unaffected, because none of them needs tmux.
- **The bootstrap config is written on the machine**, exclusively-created
  through `Runtime.writeNewTextFile` (`open(…, "wx")` here, `set -C` there) in
  that machine's `~/.devhub/tmp`. A `-f` path is only meaningful on the machine
  tmux is starting on.
- **One reconcile loop per machine**, at that machine's cadence, and
  `reconcile_agents` carries the machine it is about. A round is one question
  to one tmux server: its session list is complete for that server and says
  nothing about any other, so a round scoped to two machines would report the
  other machine's Agents as ended. The coordinator keeps one in-flight
  reconcile _per scope_ — one machine's Agents, or one Agent — so two machines'
  overlapping rounds do not invalidate each other.
- **An Agent launches, is typed into and is read on its Workspace's machine.**
  Its command is resolved there (`Runtime.resolveProgram`), its session is
  created on that machine's tmux, and `send-keys` and `capture-pane` go the
  same way. A failure is the Agent's, reported on its row.
- **At startup**, the Agents restored from the state file reconcile on their own
  machines, and the stray-session sweep runs once per machine that has a
  Workspace on it. A host that is unreachable then is not fatal and adds no
  state: its Workspaces come up with the runtime failure that names the host,
  and the next successful round is when they recover.
- **A machine no Workspace is on any more is let go of** — its tmux adapter, its
  `devhub` command installation and its ssh connection together. The sessions over
  there are untouched; reopening a Workspace on that host finds them again by
  their markers, which is what a restart does too.

There is no longer a predicate about which machine a feature works on.
`supportsLocalAgents`, `LOCAL_AGENTS_UNAVAILABLE` and the terminal error code
`workspace_remote` are gone, and the Sidebar's New Agent button is offered for
an ssh row exactly as for a local one. A host DevHub cannot reach reports that
as a failure naming the host, which is a sentence a person can act on — unlike
a button that was never there.

### What a first real run must check

Nothing here can be verified without a reachable host. A packaged build or a
source run started by `apps/desktop/scripts/dev.sh` will do. In order:

1. `ls -l ~/.devhub/terminal/` on the host after opening an ssh Workspace:
   `bin-<tag>/devhub` is there, mode 0755.
2. `ls -l ~/.devhub/terminal/control-*.sock` is a socket, and `devhub
   --version` in a pane there answers. If it does not, the forward is the
   thing that failed; check whether the host's sshd left a stale socket, and
   whether `AllowStreamLocalForwarding` is on (some hardened sshd
   configurations turn it off, and that is a refusal DevHub cannot work
   around).
3. The Workspace's terminal attaches to a tmux session on the _host_
   (`tmux -L devhub list-sessions` there shows it, and `ps` on the Mac shows
   no new tmux).
4. Two Workspaces on two different hosts with folders at the same path get two
   different sessions.
5. `tmux -L devhub list-sessions` on the host shows a `workspace-…` session for
   the folder and, once an Agent is created from the row, an `agent-…` one
   beside it — and `tmux -L devhub list-sessions` on the Mac shows neither.
6. Creating an Agent from an ssh row starts it on the host: the process is in
   `ps` there and not here, its status leaves "Starting runtime", and text sent
   to it arrives in its pane.
7. `devhub --metrics` names the host with a connected runtime, a median round
   trip and the reconcile interval derived from it. A LAN host should settle at
   the 500 ms floor; a slow one should be visibly slower and should _not_ make
   the local Agents slower.
8. Stopping the host mid-session: the Workspaces on it show the runtime
   failure naming the host, the local Workspaces are unaffected, and bringing
   the host back recovers on the next round with no restart.
9. A host with no `tmux`: git, the branch and the Issue row still work, and
   only the terminal and the Agent refuse, with the sentence naming `tmux` and
   the host.
10. Any host, a Synology NAS with busybox alone among them: a Claude Agent
    starts, `~/.devhub-server/bash/<version>/bin/bash --version` answers there,
    and `tr '\0' '\n' < /proc/<pid>/environ | grep SHELL` for the CLI shows
    `CLAUDE_CODE_SHELL` pointing at it — while a terminal on
    the same host still runs the person's own shell.

## Two facts about running one by hand

**A profile's shared-data directory is the profile's.** VS Code derives
`~/.devhub-shared` from `product.json`'s `sharedDataFolderName`, which is one
string for the whole build — so every profile wrote its `sharedStorage` into
one directory until `resolveArgs` began passing `--shared-data-dir`. A
non-default profile gets `~/.devhub-shared-<profile>`; the default one has not
moved.

**Keep `--user-data-dir` short.** VS Code's IPC socket is a unix socket under
the user-data directory, and a unix socket path has a hard limit of around 104
bytes on macOS. A user-data directory much past 100 characters — a scratch run
under a long temporary path, say — fails at startup with `listen EINVAL` and
nothing that names the length. Point isolated runs at something like `~/.dhX`.

## Clipboard

Copying in tmux's copy-mode — on the host as much as on the Mac — reaches the
Mac's clipboard through **OSC 52**, `ESC ] 52 ; c ; <base64> BEL`. It is the
only route there is over SSH: the host has no `pbcopy`, and DevHub's pane is
reading a byte stream, not a shared selection. DevHub's terminal answers the
sequence the way VS Code's integrated terminal and Ghostty do — it puts the
text on the clipboard. It answers a _query_ (`ESC ] 52 ; c ; ? BEL`) with
nothing at all: that one asks the terminal to send the clipboard's contents
back down the stream, to a program that over SSH is running on somebody else's
machine.

Two things have to be true on the tmux side, and both already are:

- `set-clipboard` must be `on`. It is a server option, and tmux's own default
  is `external`, which only forwards a sequence a program inside a pane wrote —
  copy-mode's own copy is not forwarded. So this line is needed:

  ```tmux
  set -s set-clipboard on
  ```

- the terminfo entry for the _outer_ terminal's `TERM` must carry the extended
  capability `Ms`, or tmux will not emit OSC 52 whatever `set-clipboard` says.
  DevHub attaches with `TERM=xterm-256color` (`main/terminal/pty.ts`, and the
  `export TERM` in the ssh launcher). macOS's own `xterm-256color` has
  `Ms=\E]52;%p1%s;%p2%s\007`, and so does the copy in the tmux tarball: the
  entries are taken out of ncurses 6.6 with `infocmp -x` and compiled with
  `tic -x`, and both flags are what keeps a user-defined capability like `Ms`
  from being dropped on the way (`scripts/build_tmux.py`). Checked in ncurses
  6.6, `Ms` is present on `xterm`, `xterm-256color`, `tmux` and
  `tmux-256color`, and absent from `screen` and `screen-256color`. Only the
  outer `TERM` — the one the tmux _client_ was started with — decides this, so
  that absence matters only to a tmux nested inside another one, whose outer
  terminal is a tmux pane; give such a pane `set -g default-terminal
"tmux-256color"` and the inner one can copy too.

What a copy-mode binding should then be depends on the host. `pbcopy` exists
only on a Mac, so a binding that pipes to it copies nothing on a Linux host and
says nothing about it. Piping to tmux itself works everywhere, because tmux
≥ 3.2 writes a buffer loaded with `-w` out to the clipboard as OSC 52:

```tmux
bind -T copy-mode-vi y send -X copy-pipe-and-cancel "tmux load-buffer -w -"
```

These three lines belong in the `tmux.conf` DevHub's own tmux server reads —
the one in DevHub's config directory, beside `settings.toml`, not
`~/.tmux.conf`, which belongs to the tmux you run yourself. DevHub does not
write it, and sets no `set-clipboard` of its own, so until that line is there
tmux stays on its default of `external` and copy-mode copies nothing.

## What DevHub does on a host, from the app's side

Three things the app itself decides, all of them the same on every host and
none of them configurable per machine.

### One tmux config, and DevHub owns where it is

```
~/.config/devhub/tmux.conf          the default profile
~/.config/devhub-dev/tmux.conf      DEVHUB_PROFILE=dev
```

Beside `settings.toml`, profile-aware with it, and the only user config DevHub
sources. `~/.tmux.conf` and `~/.config/tmux/tmux.conf` are **not** read. They
are the config of the tmux a person runs themselves, and DevHub's server is not
that tmux: it has DevHub's own session names, DevHub's own markers and a status
line DevHub decided about. Sourcing a config written for one server into the
other is how a `new-session` in somebody's config ends up creating a session
DevHub then refuses to adopt.

Move yours there, or symlink it:

```sh
ln -s ~/.tmux.conf ~/.config/devhub/tmux.conf
```

There need not be one. A profile with no `tmux.conf` starts tmux with DevHub's
settings alone, which is the ordinary case; the log says so whenever a machine's
tmux is put on that footing, so that a file put in the wrong place is findable.

**The running server runs the current config.** tmux reads `-f` once, while a
server starts, and a tmux server outlives the DevHub that started it — so on a
fresh machine, where the dotfiles put `tmux.conf` in place after the first
launch, the server went on running without it until something killed it. DevHub
therefore records which config a server was given, as a digest in the server
option `@devhub-config-digest`, and compares it on every attach: a config that
appeared, or changed, since the server came up is sourced into it then and
there. Editing the file and opening a terminal is all it takes; nothing has to
be killed.

A config tmux will not parse is a refusal that names the file and the line, not
a log entry. tmux runs **none** of a file it cannot parse, so one bad line is a
config that does nothing at all — the one failure that must not be silent.

For a host, the same file is **copied to the host on every connection** —
`~/.devhub-server/tmux/tmux.conf`, beside the tmux it configures — and sourced
from there. On every connection rather than when it changes, because a rule for
when a copy has gone stale is a rule that is wrong the first time somebody edits
their config and reconnects to find nothing changed. Delete the file here and
the copy over there goes with it.

### Commands run in the environment you log in to

`ssh host -- cmd` does not give a command the environment a login gives. sshd
runs a non-login, non-interactive shell: `~/.profile` has not run, and `PATH` is
sshd's default with nothing a person added to theirs. On a Synology that is the
difference between

```
/sbin:/usr/sbin:/bin:/usr/bin:/usr/builtin/sbin:/usr/builtin/bin:/usr/local/sbin:/usr/local/bin
```

and the same list with `~/go/bin`, `~/.local/bin` and `/opt/bin` in front of it,
which is where anything installed without root ends up.

So DevHub reads the login environment once per host and puts it on every command
it runs there. Three attempts, in the order that trusts your own setup first:

1. `$SHELL -lc 'env -0'`
2. `/bin/sh -lc 'env -0'`
3. `/bin/sh -lc 'env'` — for an `env` with no `-0`, busybox's among them. A
   value with a newline in it cannot be told from two variables in this listing,
   so a line that is not `NAME=…` is read as the rest of the value before it.

The first that answers with a `PATH` wins. A host where none of them does is
refused by name: DevHub will not run commands on a machine it could not find out
where the programs are on.

What is _not_ carried across is the part of a login that described the login —
`SSH_TTY`, `SSH_CONNECTION`, `SSH_AUTH_SOCK`, `PWD`, `SHLVL`, `TERM`, `TMUX` —
because each is set correctly by whatever opens the next channel, and a stale one
tells a program it is attached to a terminal that closed. `devhub --metrics`
lists the variable **names** DevHub carries and never their values.

`runtimes.git` and `runtimes.shell` are resolved with `command -v` under that
environment, so what the Settings window shows for a host is an absolute path on
the host. A name that is not found names the host's own search directories, in
the host's own order.

**And nothing of this Mac's goes with them.** `Runtime.environment()` is what a
command on a machine runs in — the frozen launch environment here, the login
environment above there — and it is asked of the machine rather than handed to
it. The tmux server on a host, the PATH its tmux and shell are looked up under,
and the environment its attaching client runs in all come from that one answer.

That is a rule and not a filter, because the filter was the bug. The adapter
used to be given `launchEnvironment(process.env)` — this Mac's — and `ssh.ts`
merges what it is given *over* the login environment, so a host's tmux server
came up with a Mac `PATH` naming directories that are not there, a Mac `TMPDIR`
naming a `/var/folders/…` no host has ever had (so `os.tmpdir()` in a pane
answered with it and `devhub -` and `devhub --wait` both failed with ENOENT),
and `__CFBundleIdentifier` telling programs on a NAS they were inside a macOS
application bundle. A list of variables to strip would be a record of what has
broken so far; the caller simply has no environment to offer now.

### Everything DevHub composes for a host is POSIX `sh`

There is no bash on a Synology, and no guarantee of one anywhere. Every script
`main/runtime/ssh.ts` composes is `sh`: `case`, `[ ]`, `printf`, `command -v`,
`set -C` for an exclusive create, `cd -P && pwd -P` for a realpath. The tmux
unpack is the same rule — a staging directory and a `mv`, not
`tar --strip-components`, which GNU tar and bsdtar have and POSIX does not
require.

## What a machine gets, and what stays here

What a host is given, what it is not, and what it must be told about
itself. Each of these was a live failure before it was a rule.

### Whether it got there is in `devhub --metrics`

    "terminalLauncher": [
      { "machine": "ssh:build.example.com", "installed": false,
        "reason": "…" }
    ]

One entry per machine that has been asked; absent means nothing has asked for
that machine yet, which is a different answer from failed. With
`installed: true` a `reason` is the `devhub` command being there but unable to
reach DevHub's control socket.

### A Workspace's root is canonical on its own machine

`resolve_workspace_path` carries the whole requested location and is answered
on the machine it names: `~` is that machine's home, `realpath` is its
`realpath`, and the folder is stat'ed there. An ssh place used to skip
resolution altogether and become a Workspace with the path as typed. On a NAS
whose `$HOME` is `/home/<user>` and canonically `/volume1/home/<user>`, that
root is not the folder's own name over there, and DevHub's rule that a root
which canonicalises elsewhere is a different directory refused **every** tmux
session it tried to create on the host — every Agent and every workspace
terminal — as a conflict, on a host where nothing was in conflict.

### Scratch stays here

Scratch is today's daily folder on this Mac (see the README's Scratch section).
A host's tmux gets workspace sessions and Agent sessions and nothing else. The
bootstrap config still has to create some session — a tmux server with none
exits — so on a machine that is not this one that anchor (named `scratch`, for
historical reasons) is retired as soon as the session replacing it exists, and
only when its whole marker tuple proves it is DevHub's own.
