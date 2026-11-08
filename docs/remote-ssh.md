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

## The Node DevHub puts on a host

DevHub's own programs on a host — the `devhub` command and the asking program
behind it — run on a Node DevHub installs there, the same way it installs tmux
and bash: nodejs.org's Linux build at the version `apps/desktop/product.json`
pins (`nodeVersion`), checked against the pinned digest
(`nodeDownloadSha256`), fetched on this Mac, cached under DevHub's own data and
unpacked over the connection into `~/.devhub-server/node/<version>`
(`RemoteShellRuntime.terminalLauncher`, `runtime/toolDelivery.ts`). It is
glibc's, so a musl (Alpine) host is refused by name; a `command -v node`
would find whatever a login shell happened to have on its PATH, which is a
different Node on every host and none at all on some.


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

### What is published, and where

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

`linux-x64` and `linux-arm64` are published, each built on a runner of its own
architecture — there is no cross-build. They go to a release named after the
tmux version and nothing else:

```
https://github.com/statiolake/devhub/releases/download/tmux-${tmuxVersion}/devhub-tmux-${os}-${arch}-${tmuxVersion}.tar.gz
```

stated once, in `apps/desktop/product-overrides.json` as
`tmuxDownloadUrlTemplate`, and substituted by DevHub itself rather than by
anything on the host. The three names are its own; `${version}` and
`${commit}`, which mean VS Code's version and commit in VS Code's own
`serverDownloadUrlTemplate`, are deliberately not reused here.

Because the release is keyed on the tmux version, it is built once per bump and
never moved, and a DevHub built months ago goes on installing the version it
was built against. `tmux-decide` in the nightly asks GitHub whether that
release exists and costs a minute on every night it does. A change to the build
that does not move the version — a terminfo entry added, a configure flag
corrected — is republished deliberately: Actions → Nightly → Run workflow, with
`force_tmux` ticked.

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
DevHub installs it on first use and skips the download when the binary is
already there.

### Installing one by hand

For a host with no route to github.com, or to try a build the nightly has not
published. `<version>` is the one the app asks for; `devhub --version` and the
pin at the top of `scripts/build_tmux.py` are the same number.

```sh
# on the host
version=3.7c
mkdir -p ~/.devhub-server/tmux/$version
tar -xzf devhub-tmux-linux-x64-$version.tar.gz \
    --strip-components 1 -C ~/.devhub-server/tmux/$version
~/.devhub-server/tmux/$version/bin/tmux -V     # should print: tmux 3.7c
```

Nothing else about the flow changes: DevHub finds the binary where it would
have put it and does not download.

### Building one locally

```sh
sudo apt-get install -y musl-tools build-essential   # on Ubuntu
scripts/build_tmux.py linux-x64                      # writes dist/devhub-tmux-linux-x64-<version>.tar.gz
```

Only the target that matches the machine: there is no cross-build, and a binary
this machine cannot run is a binary the build cannot ask `-V`. On a Mac,
`scripts/build_tmux.py darwin-arm64` builds and packs the same layout, and the
result **must not be published** — macOS has no static libc, so the binary
links dynamically against libSystem. It exists so that the layout, the terminfo
step and the version pins can be checked without waiting for a runner, and the
build says so on its own output.

## bash for Claude Code

Claude Code will not start without bash or zsh. It takes `$SHELL` if that is a
bash or a zsh, then looks for `zsh` and `bash` on `PATH` and in the usual
directories, and accepts `CLAUDE_CODE_SHELL` only when it names a bash or a
zsh. busybox `sh` is not accepted, so on a Synology NAS — busybox only, no
package manager, no sudo, no internet — a Claude Agent ended at once with the
CLI's "No suitable shell found. Claude CLI requires a Posix shell
environment…", which says nothing its owner could act on.

So DevHub delivers a bash as well, by the same mechanism as tmux
(`main/runtime/toolDelivery.ts`): one static tarball per platform on a release
of this repository, downloaded and cached here per profile (`<userData>/bash/`),
checked against the digest `product-overrides.json` states
(`bashDownloadSha256`), and unpacked on the host from a stream on a `tar`
stdin, never fetched by the host.

```
devhub-bash-linux-x64/
  bin/bash            statically linked (musl), mode 0755
  licenses/bash.txt   GPL-3.0
```

installed at

```
~/.devhub-server/bash/<version>/bin/bash
```

**Only where it is needed, and only for the Agent.** When DevHub starts a
Claude Agent on a host — a terminal one or a GUI one, and when a terminal one
is restarted — it first asks the host, under its login environment, for the
shell Claude Code would find: `$SHELL` if it is a bash or a zsh, else `zsh` or
`bash` by `command -v`, else `/bin`, `/usr/bin`, `/usr/local/bin`,
`/opt/homebrew/bin` (`main/runtime/agentShell.ts`). A host with one is left as
it is and nothing is installed. A host with neither gets the delivered bash,
and that Agent's process — and only it — gets `CLAUDE_CODE_SHELL` and `SHELL`
pointing at it. The login shell, tmux's `default-shell` and every terminal stay
busybox `sh`. A profile that sets either variable itself keeps its own. A found
shell is remembered for the connection; "none" is asked again at the next
Agent's start, so a bash installed meanwhile is used. On this Mac nothing
changes: it has zsh.

**When there is none to be had** — an architecture DevHub publishes no bash for
(only `linux-x64` and `linux-arm64` are), a release that is not there, no route
from this Mac for the download — the Agent does not start, and its row says, in
DevHub's words, which host, why, and the fix: install bash on the host (with
Entware on a Synology, `opkg install bash`, with `/opt/bin` on the login
`PATH`), after which DevHub finds it and uses it instead.

**Published as its own release**, `bash-<version>`, built by
`scripts/build_bash.py` (which reuses `build_tmux.py`'s fetching, pinning,
static-link check and packing) in the nightly's `bash-decide` / `bash` /
`bash-publish` jobs, on the same two runners. The version is bash's release
plus its patch level — every official upstream patch is applied, each pinned by
sha256 — so `5.3.20` is bash 5.3 with patches 001–020, and `bash --version` on
the host says so. Separate from tmux's release so that neither tool's bump
republishes the other. The publish job writes the digests to its summary in the
form `bashDownloadSha256` takes; until they are in `product-overrides.json` the
download is taken unpinned over HTTPS from a tag that never moves.

To build one locally (`sudo apt-get install -y musl-tools build-essential
patch` on Ubuntu): `scripts/build_bash.py linux-x64`. To install one by hand, as
for tmux: unpack `devhub-bash-<platform>-<version>.tar.gz` and move its one
directory to `~/.devhub-server/bash/<version>`.

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

A pane on a host has a `devhub` on its PATH, and it is **DevHub's, not
upstream's**.

Upstream's `bin/remote-cli/devhub` ships in the tarball — `gulpfile.reh.ts`
writes it from `resources/server/bin/remote-cli/code-linux.sh` under
`product.applicationName`, which for DevHub is `devhub` — and it can never work
in a DevHub terminal. It is a client for one environment variable,
`VSCODE_IPC_HOOK_CLI`, and without it it prints *"Command is only available in
WSL or inside a Visual Studio Code terminal."* and exits.

That variable never arrives, for three independent reasons, any one of which
is enough:

1. **A tmux pane does not inherit the pty's environment.** The REH's terminal
   channel creates `VSCODE_IPC_HOOK_CLI` per terminal and hands it to the
   process it spawns — which here is the launcher, not the pane's shell. What a
   pane does inherit is the tmux **server's** environment, the session's own
   `new-session -e` entries — and, for `PATH` specifically, the environment of
   the **client that created the session**, which beats both of the others.
   See "The PATH a pane gets", below.
2. **That server environment is DevHub's**, resolved for the machine and used
   to start the server over SSH — never composed by the REH's pty host.
3. **DevHub strips the whole `VSCODE_*` family** from terminal environments on
   purpose (`main/shell/loginEnvironment.ts`), and `bin/remote-cli` is not on a
   pane's PATH for the same reason.

This is worth stating rather than rediscovering: it is the same fact that makes
the control socket be written *into* the launcher script instead of exported,
and it is why delivering `VSCODE_IPC_HOOK_CLI` into a pane was never the fix.
The check, inside a DevHub terminal on a host, is:

```
printenv VSCODE_IPC_HOOK_CLI; command -v devhub
```

The first is empty. The second is DevHub's shim.

So DevHub ships its own, speaking DevHub's own control protocol over the socket
that is **already** reverse-forwarded onto the host. Nothing new is opened:

- the CLI is bundled the way the asking program is —
  `out/main/cli/devhub-cli.bundle.js`, from the `build:cli` step of
  `pnpm --filter @devhub/desktop build` — and written to
  `~/.devhub/terminal/js/` beside it
- the shim is generated like the launcher, with the host's own three absolute
  facts in it: the REH's `node`, that bundle, and
  `~/.devhub/terminal/control-<tag>.sock`
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
launcher is installed, DevHub also writes the skill's `SKILL.md` to
`~/.devhub/terminal/skill-<tag>/.claude/skills/devhub/` (0700 directory, 0600
file), naming the host's shim by its full path; a Claude Agent there is given
`--add-dir=<that directory>`, and a Codex GUI Agent's `developerInstructions`
point at that `SKILL.md`. A skill that cannot be written is logged and skipped;
the Agents start without it.

Why a reverse-forwarded socket and not upstream's remote CLI path
(`VSCODE_IPC_HOOK_CLI` → server → client window): that path exists only in
terminals the REH's own pty host made (see above), it ends in a workbench
window rather than in DevHub's main process, and an Agent DevHub starts in tmux
— with no workbench window open at all — has no window to go through. The
socket needs only the ssh master DevHub already holds. In a container the same
shim talks to the same kind of socket, made by a relay in `listen` mode under
`docker exec` (`docs/remote-containers.md`), so every machine has one protocol.

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

#### The answer says what to run, and what it needs to run

`terminal-profile` answers with a program, its arguments **and the environment
that program needs**. The third is not decoration. A tmux DevHub shipped to a
host carries its own compiled terminfo database and is told where it is with
`TERMINFO`; nothing else on that machine knows. Every tmux client DevHub starts
itself is given it — but the workbench's integrated terminal is started by VS
Code's pty host from the launcher script, so the answer is the only channel
there is. Without it the client on a bare host refuses with

```
missing or unsuitable terminal: xterm-256color
```

and the tab closes as fast as it opened, which is what a host with no terminfo
database at all did.

It rides in the command line through `env`, because the launcher `exec`s the
answer and a shell takes no assignments in front of an `exec`. `env` execs too,
so the pty still holds the tmux client itself. A machine whose tmux needs
nothing added — this Mac — gets no `env` and the line it always had.

`-`, `--wait` and `--goto` are the same `stdin.ts`, `wait.ts` and `goto.ts` the
local command uses — that is the point of there being one protocol. Two things
the shim says that the local launcher does not have to:

- `DEVHUB_MACHINE=ssh:<host>`, which is which computer the paths typed into
  that pane are paths on. Without it a host's `/srv/app` is matched against a
  Workspace of the same name on this Mac, and the file opens off the wrong disk
- nothing about how to start DevHub, because there is no way to. DevHub runs on
  the machine the window is on, and this socket is forwarded from it. A
  `devhub` there that finds nothing listening says
  `DevHub is not listening on <socket>` — the same sentence the launcher prints
  from the same situation, rather than a second explanation of one fact

A remote `--wait` marker is a path **on the host**, and the workbench is told so
with a `vscode-remote://` URI. Sent as `file:` it would be deleted on this Mac
while the CLI over there polled a file nothing would ever remove, and
`git commit` on the host would hang forever after the tab was closed with no
error anywhere.

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
  launcher installation and its ssh connection together. The sessions over
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
source run started by `apps/desktop/scripts/dev.sh` will do — the latter
installs the server `scripts/build_reh.py` built into its `dist/reh`. In order:

0. **The authority resolves at all.** The window comes up with `SSH: <host>` in
   the status bar rather than sitting on "Opening Remote…". On the host,
   `~/.devhub-server/bin/<key>/bin/devhub-server` and `.devhub-installed`
   exist, `~/.devhub-server/.<key>.sock` is a socket and `.<key>.pid` names a
   live process; on the Mac, `lsof -nP -iTCP@127.0.0.1 -sTCP:LISTEN` shows the
   forwarded port and the `ssh` holding it. Reopening the same host a second
   time must *not* add a second line to `~/.devhub-server/.<key>.log` — the
   running server is adopted, not restarted.
1. `ls -l ~/.devhub/terminal/` on the host after opening an ssh window: the
   launcher is there, mode 0755, and `js/package.json` says `{"type":"module"}`.
2. `~/.devhub-server/bin/<key>/node --version` runs — the key's first half is
   the commit `devhub --version` prints.
3. `ls -l ~/.devhub/terminal/control-*.sock` is a socket, and
   `printf '{"kind":"terminal-profile","machine":"ssh:<host>","root":null}\n' |
nc -U ~/.devhub/terminal/control-<tag>.sock` answers a line of JSON. If it
   answers nothing, the forward is the thing that failed; check whether the
   host's sshd left a stale socket, and whether `AllowStreamLocalForwarding` is
   on (some hardened sshd configurations turn it off, and that is a refusal
   DevHub cannot work around).
4. Opening a terminal in the remote window attaches to a tmux session on the
   _host_ (`tmux -L devhub list-sessions` there shows it, and `ps` on the Mac
   shows no new tmux).
5. Closing the terminal tab leaves the session running and closes the client;
   reopening reattaches to the same session with its scrollback.
6. Two windows on two different hosts with folders at the same path get two
   different sessions.
7. `tmux -L devhub list-sessions` on the host shows a `workspace-…` session for
   the folder and, once an Agent is created from the row, an `agent-…` one
   beside it — and `tmux -L devhub list-sessions` on the Mac shows neither.
8. Creating an Agent from an ssh row starts it on the host: the process is in
   `ps` there and not here, its status leaves "Starting runtime", and text sent
   to it arrives in its pane.
9. `devhub --metrics` names the host with a connected runtime, a median round
   trip and the reconcile interval derived from it. A LAN host should settle at
   the 500 ms floor; a slow one should be visibly slower and should _not_ make
   the local Agents slower.
10. Stopping the host mid-session: the Workspaces on it show the runtime
    failure naming the host, the local Workspaces are unaffected, and bringing
    the host back recovers on the next round with no restart.
11. A host with no `tmux`: git, the branch and the Issue row still work, and
    only the terminal and the Agent refuse, with the sentence naming `tmux` and
    the host.
12. A host with neither bash nor zsh (a Synology NAS): a Claude Agent starts,
    `~/.devhub-server/bash/<version>/bin/bash --version` answers there, and
    `tr '\0' '\n' < /proc/<pid>/environ | grep SHELL` for the CLI shows both
    `SHELL` and `CLAUDE_CODE_SHELL` pointing at it — while a terminal on the
    same host still runs busybox `sh`.
13. **Reconnecting.** `ssh -O exit <host>` from a terminal on the Mac, or a real
    sleep and wake: the workbench notices, reconnects through a fresh
    `resolve()`, and the extension host on the host is the *same process* —
    `.<key>.pid` has not changed and the log has not grown. A workbench that
    came back with a new server is a resolve that was not idempotent, and it
    would take every language server on that machine with it each time a lid
    closed.

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

Three things a host is given, one thing it is not, and one thing it must be
told about itself. Each of these was a live failure before it was a rule.

### The asking program is one file

`devhub-terminal` runs a compiled program that asks DevHub for an argv, and
that program is **one self-contained file**:
`out/main/terminal/devhub-terminal.bundle.js`, produced by the `build:terminal`
step of `pnpm --filter @devhub/desktop build` (esbuild, `platform: node`,
nothing external but `node:*`). `Runtime.terminalLauncher` is given its text
and writes exactly that file, plus a `package.json` saying `{"type":"module"}`
so Node reads it as an ES module, plus the launcher script.

It used to be a *closure*: the compiled entry and every compiled file it
imported, discovered by reading each `.js` as text and following the relative
specifiers. A text scan cannot tell an `import` from the word in a doc comment,
and `launcher.ts` documents its own matcher — so the packaged app refused to
ship the program at all, on this Mac and on every host, and said so once per
window in a log. One file has no graph to walk.

### Whether it got there is in `devhub --metrics`

    "terminalLauncher": [
      { "machine": "local", "installed": true,
        "path": "…/devhub/devhub-terminal", "reason": null },
      { "machine": "ssh:build.example.com", "installed": false,
        "path": null, "reason": "…" }
    ]

One entry per machine a window has been opened on; absent means nothing has
asked for that machine yet, which is a different answer from failed. With
`installed: true` a `reason` is the launcher being there but unable to reach
DevHub's control socket. A window is never refused for this — a folder somebody
can edit is worth more than no folder — so this reading, and not the window, is
where "does this DevHub have terminals, and where" is answered.

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
only when its whole marker tuple proves it is DevHub's own. A workbench
terminal on a host, started in a directory no Workspace there contains, is
refused in words rather than given a session on this Mac's Scratch.
