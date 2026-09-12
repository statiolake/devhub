# SSH remote development

Open a folder on another machine and work in it as if it were local: the
workbench stays on your Mac, everything it drives — the terminal, the file
system, extensions, language servers — runs over there.

DevHub does this the way VSCodium does, with two pieces that have never met
before they are asked to talk to each other.

* **Open Remote - SSH**, `jeanp413.open-remote-ssh`, vendored as a built-in
  from Open VSX. It is what resolves `ssh-remote://<host>` authorities. See
  `extensions/vendor/README.md`.
* **The remote extension host**, or REH — VS Code's own server, built from the
  same VS Code commit DevHub's client is built from and published on this
  repository's releases. That is `scripts/build_reh.py` and the `reh-*` jobs in
  `.github/workflows/nightly.yml`.

## What happens when you open a host

1. The extension SSHes in and runs a shell script it generates from
   `src/scripts/server-setup.sh` in its own source.
2. That script reads five things out of DevHub's `product.json` — the client's,
   over the SSH connection's near end — and uses them to work out what to
   fetch and where to put it:

   | key | value | what the remote does with it |
   | --- | --- | --- |
   | `serverDownloadUrlTemplate` | see below | the URL, after substitution |
   | `commit` | the VS Code submodule's HEAD | names the install directory, and is checked against the server's own |
   | `version` | `1.136.1` | substituted as `${version}`, if the template asks |
   | `serverApplicationName` | `devhub-server` | the script it runs: `bin/devhub-server` |
   | `serverDataFolderName` | `.devhub-server` | `$HOME/.devhub-server` on the remote |

3. It downloads the tarball, unpacks it with `tar --strip-components 1` into
   `$HOME/.devhub-server/bin/<commit>/`, and starts
   `bin/devhub-server --start-server --host=127.0.0.1 --port=0 ...`.
4. It reads the port the server printed out of the log, forwards it over the
   SSH connection, and the workbench connects.

The server then checks the connecting client's commit against its own and
refuses if they differ. That is the extension's default,
`remote.SSH.serverValidation: strict`, and it is the reason everything below is
keyed on a commit rather than on a version or a date.

## The URL

Stated once, in `apps/desktop/product-overrides.json`:

```
https://github.com/statiolake/devhub/releases/download/reh-${commit}/devhub-reh-${os}-${arch}-${commit}.tar.gz
```

The remote substitutes six names into a template, with one `sed` each:
`${quality}`, `${version}`, `${commit}`, `${os}`, `${arch}`, `${release}`.
DevHub's uses three of them.

`${os}` is `linux`, `darwin`, `alpine` or `freebsd`, decided by `uname -s` on
the remote (and by `/etc/os-release` for Alpine). `${arch}` is `x64`, `arm64`,
`armhf`, `ppc64le`, `riscv64`, `loong64` or `s390x`, from `uname -m`.

`${quality}` and `${release}` are deliberately not in it. DevHub states neither
key, and a missing one is substituted with the string `undefined` or with
nothing at all rather than reported — a URL that is wrong in a way no error
message mentions. `scripts/build_reh_test.py` fails if either appears.

## What is built, where, and when

`scripts/build_reh.py` produces one tarball per target. Inside it, under a
single directory:

```
devhub-reh-linux-x64/
  bin/devhub-server        the launcher; runs ./node ./out/server-main.js
  bin/remote-cli/devhub    the `code` equivalent, for opening files from the
                           remote's own shell
  node                     the prebuilt Node the server runs on
  out/                     the bundled server
  product.json             DevHub's, with the same `commit` the client states
  extensions/              the built-in set, minus the UI-only ones and
                           minus copilot
  node_modules/            the server's production dependencies
```

**No Copilot.** DevHub pins `chat.disableAIFeatures: true`, so nothing on a
remote would ever start the agent host, and the `copilot` built-in plus its
native runtime are about 470 MB of an 810 MB tree — the tarball is 103 MB with
them gone and 237 MB with them in. `scripts/build_reh.py` deletes them after
the build rather than asking the build not to make them, because there is
nothing to ask: `copilot` is a local workspace extension in the submodule, not
an entry in `product.json`'s `builtInExtensions`, so the product edit the script
already makes cannot reach it; there is no flag or environment variable for it;
and leaving it uncompiled does not work either, because the last step of every
REH package task walks into the output looking for its SDK and throws when it
is not there. That step is also the reason the script stages the SDK into
`.build` itself before packaging: the compile that is supposed to put it there
did on linux-x64 and did not on linux-arm64, and the only symptom was a missing
directory in the output tree twenty-five minutes in. Two small packages stay — `@github/copilot` (12 KB) and
`@github/copilot-sdk` (736 KB) — because `server-main.js` reads their versions
at startup. The build runs `bin/devhub-server --version` afterwards whenever the
target is one the building machine can execute, so a deletion that broke
startup fails the build rather than the connection.

Published targets are `linux-x64` and `linux-arm64`. Each is built on a runner
of its own architecture, because `vscode/remote/node_modules` holds native
addons — node-pty, `@parcel/watcher`, kerberos, `@vscode/spdlog` — and the
package task ships them as npm installed them, for the machine that did the
installing. Cross-building produces a tarball that unpacks, starts, and then
fails to open a terminal.

`darwin-arm64` is not published yet, for the same reason and one more: it would
have to be built on the macOS job, which already runs for two hours against a
two-hour timeout. SSHing into a Mac is rare enough to wait.

**When**: the server is a function of the VS Code submodule, not of DevHub's
own commits, so it is rebuilt when the submodule moves — roughly monthly —
and not nightly. `reh-decide` in the nightly workflow asks GitHub whether the
release named after the current submodule commit exists, and the whole thing
costs a minute on the nights it does.

**The one thing that does not follow**: a change to `patches/vscode/` that
touches server code does not move the submodule, so it does not change
`${commit}`, so remotes go on using the server already published under that
tag. Rebuild it deliberately — Actions → Nightly → Run workflow, with
`force_reh` ticked.

## Building one locally

```sh
scripts/build_reh.py linux-x64            # writes dist/devhub-reh-linux-x64-<commit>.tar.gz
```

It provisions the submodule first unless you pass `--skip-provision`, and it
edits `vscode/product.json` for the duration of the build and puts it back
afterwards. That edit is not avoidable: esbuild inlines `product.json` into
the server bundle, so a server bundled against the submodule's own file calls
itself `code-server-oss` no matter what the `product.json` next to it says.

On a Mac the Linux tarballs it produces are for inspecting the layout, not for
running: the Node inside is downloaded for the target, but the native addons
beside it are the Mac's. Use CI for anything you intend to connect to. The one
target a Mac builds correctly is `darwin-arm64`, which is also the one CI does
not publish.

The tarballs are around 100 MB: 103 MB for linux-x64, 99 MB for linux-arm64,
94 MB for darwin-arm64.

## A source run cannot connect

`pnpm dev` has no `commit` — deliberately, and it cannot be given one: VS Code
reads `product.commit` as "this is a packaged build" and sends a source run
looking for a `node_modules.asar` that a checkout does not have. But `commit`
is also what the extension puts in the download URL and what the remote server
checks the connecting client against, so a source run asks for
`devhub-reh-linux-x64-undefined.tar.gz` and gets a 404.

**SSH workspaces need a packaged build.** Test them against `pnpm build`'s
`dist/DevHub.app` or a nightly, not against `pnpm dev`. See
`scripts/product_metadata.py` for why the field means what it means.

## Installing a server by hand

For a remote with no route to github.com, or to try a server the nightly has
not published.

```sh
# on your Mac: the commit DevHub will ask for
commit=$(git -C vscode rev-parse HEAD)

# on the remote
mkdir -p ~/.devhub-server/bin/$commit
tar -xzf devhub-reh-linux-x64-$commit.tar.gz \
    --strip-components 1 -C ~/.devhub-server/bin/$commit
```

The extension looks for `bin/devhub-server` under that exact directory and
skips the download when it finds it. Nothing else about the flow changes.

If the commit has to differ — you are running a DevHub built from a different
submodule than the server you have — say so explicitly rather than renaming the
directory: `"remote.SSH.serverValidation": "force"` rewrites the server's
`product.json` to match the client. It is a way to get connected, not a way to
be sure the two halves agree.

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
`${commit}`, which mean VS Code's version and commit in
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

A static ncurses has the terminfo code compiled in and no terminfo *database* —
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

## Pointing one host somewhere else

`remote.SSH.serverDownloadUrlTemplate` overrides the product's template for
every host. There is no per-host form of it; a host that needs its own server
gets it installed by hand, above.

## Where to look when it does not connect

The extension logs the whole install script and its output to **Output → Remote
- SSH**. Everything the remote decided is in there: the URL it built, whether
the download succeeded, and the server's own log path
(`~/.devhub-server/.<commit>.log`) if it started and then failed.

## The integrated terminal of a remote window

A DevHub terminal is a tmux session DevHub owns, and the workbench reaches it
by running a small launcher — `devhub-terminal` — that asks DevHub over its
control socket which session the terminal's directory belongs to and `exec`s
the answer (`main/terminal/launcher.ts`). For a local window all three of those
things are on this Mac. For an ssh window none of them are: the workbench's pty
host runs on the host, so the profile's `path` is a path over there, and the
process it starts can reach neither DevHub's launcher nor DevHub's socket.

Nothing about the protocol changes. What changes is where its two ends are.

* **The launcher is written on the host**, by DevHub, over the connection that
  is already open: `Runtime.terminalLauncher` puts the compiled asking program
  under `~/.devhub/terminal/js/` and the generated script at
  `~/.devhub/terminal/devhub-terminal-<tag>`. The script is the same text as
  the local one, with the host's own paths in it. The `<tag>` is a digest of
  DevHub's control-socket path, so two DevHub profiles on one Mac reaching one
  host do not adopt each other's files.
* **It runs on the REH's own Node**, `~/.devhub-server/bin/<commit>/node` — the
  Node the connection installed, at the commit the client states. A
  `command -v node` would find whatever the login shell's PATH happened to
  have, which is a different Node on every host and none at all on some.
* **DevHub's control socket is reverse-forwarded onto the host**:
  `ssh -O forward -R ~/.devhub/terminal/control-<tag>.sock:<local socket>`,
  added to the ControlMaster that is already up. This is the primary mechanism
  and not a fallback, because it is what lets the launcher, the request and the
  answering side stay one implementation. DevHub removes its own stale socket
  file first — sshd will not bind over one unless the host was configured with
  `StreamLocalBindUnlink yes`, which is the host's business — and then checks
  with one `test -S` that something is actually bound, because `-O forward` can
  report success and leave nothing there.
* **The request says which machine it came from.** `terminal-profile` carries a
  `machine` field, the `RuntimeId` (`local`, or `ssh:<host>`), baked into the
  launcher as `DEVHUB_TERMINAL_MACHINE`. Without it two hosts with the same
  `/srv/app` are one root to the matcher, and the session it answers with is on
  the wrong computer.

When the forward cannot be made, DevHub says so in its log and in
`devhub --metrics`, and writes the launcher anyway: run from the host it prints
`DevHub is not listening on <socket>`, which is the same fact in the place a
person is looking. There is deliberately no second profile that ships a plain
`tmux attach` command line instead — the session a terminal belongs to depends
on the directory VS Code starts it in, which is not known until the terminal is
created, so a command line composed in advance would be right for one terminal
of the window and wrong for the rest.

### How the window learns its launcher

The patched `TerminalProfileService` reads `DEVHUB_TERMINAL` from the
renderer's environment, and a renderer's environment is per window:
`preload.ts` does `Object.assign(process.env, configuration.userEnv)` before
the workbench modules are imported, and `userEnv` is
`{ ...initialUserEnv, ...options.userEnv }` from the `IWindowsMainService.open`
call. So DevHub passes `userEnv: { DEVHUB_TERMINAL: <that machine's launcher> }`
when it opens the window (`appController.openEditorView`), and
`patches/vscode/0003-…` needs no change at all — which is why it has none. A
local window is passed the launcher `bootstrapShell` wrote before any window
existed, which is the same value `process.env` already carried, so nothing
about a local window changed.

A machine whose launcher could not be installed contributes no variable rather
than a path that would not work. That is not a silence: the absent variable is
exactly what makes the patched profile service refuse to invent a terminal, the
reason is on DevHub's log, and the launcher run over there says the same thing
in the terminal tab.

### Agents and terminals on the host

There is one `TmuxTerminalRuntime` per `Runtime`, built on first use and cached
beside `runtimeFor` (`main/shell/terminalRuntimes.ts`). Everything a tmux
adapter does — the socket, the marker protocol, the bootstrap probe, the
inventory, the captures — goes through that machine's `Runtime.exec`, and the
attaching client's PTY through its `spawnPty`. A terminal target carries its
machine (`RuntimeId`), so two hosts with the same `/srv/api` are two sessions
and every consumer takes its adapter from the target rather than from whichever
one it is holding.

* **`$HOME`, `tmux` and the shell are resolved on the machine**, by
  `Runtime.home` and `Runtime.resolveProgram`. A host with no `tmux` makes that
  machine's adapter unavailable, with the sentence naming what was looked for
  and where — git, worktrees and the Issue and pull-request rows on that host
  are unaffected, because none of them needs tmux.
* **The bootstrap config is written on the machine**, exclusively-created
  through `Runtime.writeNewTextFile` (`open(…, "wx")` here, `set -C` there) in
  that machine's `~/.devhub/tmp`. A `-f` path is only meaningful on the machine
  tmux is starting on.
* **One reconcile loop per machine**, at that machine's cadence, and
  `reconcile_agents` carries the machine it is about. A round is one question
  to one tmux server: its session list is complete for that server and says
  nothing about any other, so a round scoped to two machines would report the
  other machine's Agents as ended. The coordinator keeps one in-flight
  reconcile *per scope* — one machine's Agents, or one Agent — so two machines'
  overlapping rounds do not invalidate each other.
* **An Agent launches, is typed into and is read on its Workspace's machine.**
  Its command is resolved there (`Runtime.resolveProgram`), its session is
  created on that machine's tmux, and `send-keys` and `capture-pane` go the
  same way. A failure is the Agent's, reported on its row.
* **At startup**, the Agents restored from the state file reconcile on their own
  machines, and the stray-session sweep runs once per machine that has a
  Workspace on it. A host that is unreachable then is not fatal and adds no
  state: its Workspaces come up with the runtime failure that names the host,
  and the next successful round is when they recover.
* **A machine no Workspace is on any more is let go of** — its tmux adapter, its
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

None of this can be verified without a reachable host, so nothing below has
been. In order, against a host with a DevHub server already installed:

1. `ls -l ~/.devhub/terminal/` on the host after opening an ssh window: the
   launcher is there, mode 0755, and `js/package.json` says `{"type":"module"}`.
2. `~/.devhub-server/bin/<commit>/node --version` runs — the commit is the one
   `devhub --version` prints.
3. `ls -l ~/.devhub/terminal/control-*.sock` is a socket, and
   `printf '{"kind":"terminal-profile","machine":"ssh:<host>","root":null}\n' |
   nc -U ~/.devhub/terminal/control-<tag>.sock` answers a line of JSON. If it
   answers nothing, the forward is the thing that failed; check whether the
   host's sshd left a stale socket, and whether `AllowStreamLocalForwarding` is
   on (some hardened sshd configurations turn it off, and that is a refusal
   DevHub cannot work around).
4. Opening a terminal in the remote window attaches to a tmux session on the
   *host* (`tmux -L devhub list-sessions` there shows it, and `ps` on the Mac
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
   the 500 ms floor; a slow one should be visibly slower and should *not* make
   the local Agents slower.
10. Stopping the host mid-session: the Workspaces on it show the runtime
    failure naming the host, the local Workspaces are unaffected, and bringing
    the host back recovers on the next round with no restart.
11. A host with no `tmux`: git, the branch and the Issue row still work, and
    only the terminal and the Agent refuse, with the sentence naming `tmux` and
    the host.

## Clipboard

Copying in tmux's copy-mode — on the host as much as on the Mac — reaches the
Mac's clipboard through **OSC 52**, `ESC ] 52 ; c ; <base64> BEL`. It is the
only route there is over SSH: the host has no `pbcopy`, and DevHub's pane is
reading a byte stream, not a shared selection. DevHub's terminal answers the
sequence the way VS Code's integrated terminal and Ghostty do — it puts the
text on the clipboard. It answers a *query* (`ESC ] 52 ; c ; ? BEL`) with
nothing at all: that one asks the terminal to send the clipboard's contents
back down the stream, to a program that over SSH is running on somebody else's
machine.

Two things have to be true on the tmux side, and both already are:

* `set-clipboard` must be `on`. It is a server option, and tmux's own default
  is `external`, which only forwards a sequence a program inside a pane wrote —
  copy-mode's own copy is not forwarded. So this line is needed:

  ```tmux
  set -s set-clipboard on
  ```

* the terminfo entry for the *outer* terminal's `TERM` must carry the extended
  capability `Ms`, or tmux will not emit OSC 52 whatever `set-clipboard` says.
  DevHub attaches with `TERM=xterm-256color` (`main/terminal/pty.ts`, and the
  `export TERM` in the ssh launcher). macOS's own `xterm-256color` has
  `Ms=\E]52;%p1%s;%p2%s\007`, and so does the copy in the tmux tarball: the
  entries are taken out of ncurses 6.6 with `infocmp -x` and compiled with
  `tic -x`, and both flags are what keeps a user-defined capability like `Ms`
  from being dropped on the way (`scripts/build_tmux.py`). Checked in ncurses
  6.6, `Ms` is present on `xterm`, `xterm-256color`, `tmux` and
  `tmux-256color`, and absent from `screen` and `screen-256color`. Only the
  outer `TERM` — the one the tmux *client* was started with — decides this, so
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
settings alone, which is the ordinary case; the log says so once per machine so
that a file put in the wrong place is findable.

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

What is *not* carried across is the part of a login that described the login —
`SSH_TTY`, `SSH_CONNECTION`, `SSH_AUTH_SOCK`, `PWD`, `SHLVL`, `TERM`, `TMUX` —
because each is set correctly by whatever opens the next channel, and a stale one
tells a program it is attached to a terminal that closed. `devhub --metrics`
lists the variable **names** DevHub carries and never their values.

`runtimes.git` and `runtimes.shell` are resolved with `command -v` under that
environment, so what the Settings window shows for a host is an absolute path on
the host. A name that is not found names the host's own search directories, in
the host's own order.

### Everything DevHub composes for a host is POSIX `sh`

There is no bash on a Synology, and no guarantee of one anywhere. Every script
`main/runtime/ssh.ts` composes is `sh`: `case`, `[ ]`, `printf`, `command -v`,
`set -C` for an exclusive create, `cd -P && pwd -P` for a realpath. The tmux
unpack is the same rule — a staging directory and a `mv`, not
`tar --strip-components`, which GNU tar and bsdtar have and POSIX does not
require.
