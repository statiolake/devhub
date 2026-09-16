# SSH remote development

Open a folder on another machine and work in it as if it were local: the
workbench stays on your Mac, everything it drives — the terminal, the file
system, extensions, language servers — runs over there.

Two pieces make that work, and DevHub owns both of them.

- **The resolver**, `extensions/devhub-remote` — a built-in extension of about
  sixty lines whose whole job is to answer `onResolveRemoteAuthority:ssh-remote`
  with a port. It has no SSH client, no settings and no opinion; it asks DevHub
  and passes the answer on.
- **The remote extension host**, or REH — VS Code's own server, built from the
  same VS Code commit DevHub's client is built from and published on this
  repository's releases. That is `scripts/build_reh.py` and the `reh-*` jobs in
  `.github/workflows/nightly.yml`.

Everything between those two — the connection, the install, the server, the
token and the port — is `main/runtime/remoteServer.ts` and `main/runtime/ssh.ts`,
over the ControlMaster DevHub is already holding for git, terminals and Agents.

## Why DevHub resolves its own authorities

It did not used to. Until this was written the resolver was a vendored copy of
`jeanp413.open-remote-ssh`, and it brought a whole second SSH client with it: a
JavaScript one (`ssh2`, from an unpinned git fork), its own `~/.ssh/config`
parser, its own private-key handling and passphrase prompts, its own generated
bash install script, a port scraped out of the server's log, and a tunnel opened
beside the connection DevHub already had.

So there were two clients talking to one host, and every question either could
answer had two answers free to differ: which `Host` block applies, which key,
whether `ProxyJump` works, what the login environment is. The one that broke in
practice was the install script — it was bash, and a NAS whose `/bin/sh` is
BusyBox with no bash anywhere answered `sh: bash: not found`, which arrived as
`Failed parsing install script output` because none of the markers the script
prints had been printed.

DevHub already knew how to do all of it. It holds a ControlMaster per host, runs
POSIX `sh` over it, reads the host's login environment, fetches payloads here and
delivers them there as bytes on a `tar` stdin (that is the tmux install). What
was missing was two things — installing and starting the server, and a `-L`
forward — and adding them is smaller than keeping a second SSH client correct.

What that costs is upstream's breadth. `ProxyJump`, `ProxyCommand`, passwords
and keyboard-interactive all move to the system `ssh`, which is a gain on
correctness but means a host that only worked because `ssh2` was lenient now
behaves the way `ssh` does. Windows remotes are dropped outright; DevHub did not
support them anyway.

## What happens when you open a host

The workbench opens on `vscode-remote://ssh-remote+<host>/<path>` and waits.
`extensions/devhub-remote` is activated by that authority, parses the host out
of it, and sends one JSON line over DevHub's control socket — the same socket
the `devhub` command and "Install 'devhub' command in PATH" use, found the same
way, from the extension's own global-storage directory:

```json
{ "kind": "resolve-remote", "machine": "ssh:<host>", "attempt": 1 }
```

DevHub answers it in five steps, all over the ControlMaster it already has.

1. **Ask the machine what it is.** `$HOME`, `uname -s`, `uname -m` and `$SHELL`,
   in one command, cached for the life of the connection. A machine that is not
   Linux or macOS is refused by name here.
2. **Install the server, if it is not there.** The question that decides is
   `test -x ~/.devhub-server/bin/<commit>/bin/devhub-server`, so an install that
   has happened is an install that is skipped — whether this DevHub did it, an
   older one did, or somebody unpacked the tarball by hand. Otherwise the
   tarball is fetched **here**, over this Mac's network, and handed to the host
   as bytes on the stdin of a `tar`: a staging directory and a `mv`, not
   `--strip-components`, which POSIX does not require.
3. **Start it, or adopt the one that is running.** A pidfile and the socket
   together answer "is it up"; if it is not, the server is started under `nohup`
   with `--start-server --host=127.0.0.1 --socket-path=… --connection-token-file=…`
   and the script waits for the socket to appear (or for the process to exit,
   which it reports with the log path rather than waiting out the timeout).
4. **Forward it.** `ssh -O forward -L <local port>:<remote socket>` on the master
   that is already up, so no second connection and no reconnect.
5. **Answer** `{ port, connectionToken }`, and the extension returns
   `new vscode.ResolvedAuthority("127.0.0.1", port, connectionToken)`.

The server then checks the connecting client's commit against its own and
refuses if they differ, which is why everything below is keyed on a commit
rather than on a version or a date.

### A socket, not a port

The server is started with `--socket-path` and reached with `ssh -L
<port>:<remote socket>`, which OpenSSH has supported since 6.7. The alternative
— `--port=0` and then asking the server which port it picked — has only one
place to read the answer, the server's own log, so the connection would depend
on scraping a line whose format is upstream's to change. A socket path is a name
DevHub chose, so there is nothing to discover and nothing to parse.

### The token file is the single source of truth

A connection token is generated **here** and offered to the start script on
**stdin** — never in the command line, because the composed script is the remote
shell's argv and argv is world-readable in `ps`. The script writes it only if
`~/.devhub-server/.<commit>.token` is not already there, and prints back
whatever the file contains either way.

That read-back is the whole point. A server that is already running was started
against the token in that file, and a DevHub that handed the workbench a fresh
one would fail the handshake with a message that does not say "wrong token" —
`remoteAgentConnection.ts` simply sees a connection that never comes up.

### Reconnecting costs nothing

VS Code calls `resolve()` again on **every** reconnect — that is
`nativeExtensionService.ts` wiring `ConnectionLost` to `_clearResolvedAuthority`
and `onReconnecting` to `_resolveAuthorityAgain` — so the answer has to be cheap
and idempotent on the happy path. It is: DevHub probes the forward it is holding
by connecting to it, and a forward that still answers is re-answered with the
same port and the same token. Without that, closing a laptop lid would restart
the extension host on the far machine, and every language server and every
extension's state with it.

A forward dies with the ControlMaster, and `resumed()` exists to kill a master
that slept through a suspend — so `resumed()` will not drop a master that is
carrying one. The ordering is real: a power event delivered *after* the workbench
has already reconnected through a brand-new forward would otherwise destroy
exactly what the reconnection built. A forward that has stopped answering is not
held for long — the next `resolve()` cancels it, which is what lets a wake go
back to dropping the master.

### Transient or permanent, decided where it happened

A failed resolve has two outcomes, and VS Code picks between them from the error
class the extension throws: `TemporarilyNotAvailable` is retried by its reconnect
loop and by `_resolveAuthorityInitial`'s five attempts, and `NotAvailable` makes
it give up at once and show the sentence.

Which is right is known where the failure happened and nowhere else, so it is
marked there and carried on the failure — never read back out of its wording,
because a rule applied to wording is wrong the first time somebody rephrases a
sentence, and wrong in silence.

| failure | asking again? |
| --- | --- |
| the host is asleep, away, or not answering | yes |
| this Mac cannot reach the release right now | yes |
| anything DevHub did not anticipate | yes |
| no key for the host — DevHub's ssh runs `BatchMode=yes` and has no pane to prompt in | no |
| the host key is not known | no |
| the host is not Linux or macOS | no |
| the release has no server for that `<os>-<arch>` (an HTTP 404, not a network error) | no |
| this is a source build and states no commit | no |

The default is "yes", and deliberately: a resolve that goes on retrying stops on
VS Code's own attempt limit and says so, and one that wrongly gave up needs the
window reopening by hand.

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

## The URL

Stated once, in `apps/desktop/product-overrides.json`:

```
https://github.com/statiolake/devhub/releases/download/reh-${commit}/devhub-reh-${os}-${arch}-${commit}.tar.gz
```

Six names may appear in that template — `${quality}`, `${version}`, `${commit}`,
`${os}` and `${arch}`, `${release}` — and DevHub's uses three. They are
substituted **here**, by `rehDownloadUrl` in `main/runtime/remoteServer.ts`, and
nowhere else: the URL is built on the machine that does the fetching.

`${os}` and `${arch}` come from `uname -s` and `uname -m` on the host, folded to
the names the release uses (`x86_64` and `amd64` both become `x64`; `aarch64`
and `arm64` both become `arm64`). An architecture DevHub does not recognise keeps
its own word rather than being rounded to one that looks close, so the 404 names
the machine it is actually about.

`${quality}` and `${release}` are deliberately not in it. DevHub states neither
key, so either would be substituted with nothing at all rather than reported — a
URL that is wrong in a way no error message mentions.
`scripts/build_reh_test.py` fails if either appears.

## What is built, where, and when

`scripts/build_reh.py` produces one tarball per target. Inside it, under a
single directory:

```
devhub-reh-linux-x64/
  bin/devhub-server        the launcher; runs ./node ./out/server-main.js
  bin/remote-cli/devhub    upstream's remote CLI. It is in the tarball because
                           the REH build puts it there, and DevHub does not use
                           it — see "The `devhub` command on a host"
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
directory in the output tree twenty-five minutes in. What it stages is _files_,
not a directory — `gulp.dest` recreates the directory entries its source glob
yielded, so an SDK subtree whose files were all filtered out (or that npm left
as a symlink into `@github/copilot-<os>-<arch>`, which a glob that does not
follow symlinks walks past) reaches `.build` as an empty shell that satisfies
every existence check and carries nothing into the server tree. Two small packages stay — `@github/copilot` (12 KB) and
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

**One architecture at a time.** Each target is a job of its own and the release
is cut from whichever of them succeeded: a leg that fails stays red in the run,
and the other leg's tarball is still published. So a release can exist with
`linux-x64` in it and no `linux-arm64`. That is deliberate — the alternative
withholds a server that built fine from everyone on the architecture that was
never broken. What a host on the missing architecture sees is a 404 on the URL
above, with the `<os>-<arch>` in the filename: `server-setup.sh` reports
`Error downloading server from <url>`, so the name of the missing asset is in
the message rather than left to be guessed at. The fix is to
make the red leg green and rerun the workflow with `force_reh`; the release is
named after the VS Code commit and is added to, not replaced.

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
looking for a `node_modules.asar` that a checkout does not have. But `commit` is also
what names the install directory, what goes in the download URL and what the
remote server checks the connecting client against — so there is nothing to
install and nothing that would accept a connection.

A source run therefore refuses the resolve by name, permanently: the workbench
gets `NotAvailable` with the sentence rather than five attempts at a URL ending
`-undefined.tar.gz`.

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

DevHub looks for `bin/devhub-server` under that exact directory and skips the
download when it finds it. Nothing else about the flow changes: it starts that
server, writes the token file beside it and forwards its socket exactly as if it
had put it there itself.

The commit has to match. There is no override that makes a client of one commit
talk to a server of another — the server checks, and the check is the reason
everything here is keyed on a commit. Build or fetch the right one.

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

## Pointing one host somewhere else

There is no setting for this, per host or otherwise. `serverDownloadUrlTemplate`
in `apps/desktop/product-overrides.json` is a fact about the build — which
release these binaries were made alongside — and a person who could point one
host at a different server could point it at a server of a different commit,
which the server itself would then refuse. A host that needs its own server gets
it installed by hand, above.

The `remote.SSH.*` settings the vendored extension had —
`serverDownloadUrlTemplate`, `serverValidation`, `serverInstallPath`,
`enableDynamicForwarding` and the rest — are gone with it, and nothing in DevHub
reads them.

## Where to look when it does not connect

The sentence the workbench shows is DevHub's own, composed where the failure
happened and passed through the resolver unchanged — the extension adds no
vocabulary of its own, so there is one wording per failure rather than two.

Beyond that, in order:

- **DevHub's log** has a line per resolve naming the host and the attempt
  number, which is the difference between a slow connection and a loop, and a
  line for the failure if there was one.
- **`devhub --metrics`** names the host, whether its runtime is connected, and
  the last thing that went wrong on it.
- **The server's own log on the host**, `~/.devhub-server/.<commit>.log`. When
  the server starts and then exits, the start script says so with that path in
  the message rather than waiting out its timeout.
- **`~/.devhub-server/.<commit>.pid` and `.sock`** on the host say what DevHub
  thinks is running. A socket file with no live pid behind it is what the start
  script removes before starting a new server.

## The integrated terminal of a remote window

A DevHub terminal is a tmux session DevHub owns, and the workbench reaches it
by running a small launcher — `devhub-terminal` — that asks DevHub over its
control socket which session the terminal's directory belongs to and `exec`s
the answer (`main/terminal/launcher.ts`). For a local window all three of those
things are on this Mac. For an ssh window none of them are: the workbench's pty
host runs on the host, so the profile's `path` is a path over there, and the
process it starts can reach neither DevHub's launcher nor DevHub's socket.

Nothing about the protocol changes. What changes is where its two ends are.

- **The launcher is written on the host**, by DevHub, over the connection that
  is already open: `Runtime.terminalLauncher` puts the compiled asking program
  under `~/.devhub/terminal/js/` and the generated script at
  `~/.devhub/terminal/devhub-terminal-<tag>`. The script is the same text as
  the local one, with the host's own paths in it. The `<tag>` is a digest of
  DevHub's control-socket path, so two DevHub profiles on one Mac reaching one
  host do not adopt each other's files.
- **It runs on the REH's own Node**, `~/.devhub-server/bin/<commit>/node` — the
  Node the connection installed, at the commit the client states. A
  `command -v node` would find whatever the login shell's PATH happened to
  have, which is a different Node on every host and none at all on some.
- **DevHub's control socket is reverse-forwarded onto the host**:
  `ssh -O forward -R ~/.devhub/terminal/control-<tag>.sock:<local socket>`,
  added to the ControlMaster that is already up. This is the primary mechanism
  and not a fallback, because it is what lets the launcher, the request and the
  answering side stay one implementation. DevHub removes its own stale socket
  file first — sshd will not bind over one unless the host was configured with
  `StreamLocalBindUnlink yes`, which is the host's business — and then checks
  with one `test -S` that something is actually bound, because `-O forward` can
  report success and leave nothing there.
- **The request says which machine it came from.** `terminal-profile` carries a
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

### How the window learns its launcher

The launcher is a **field of the window configuration**:
`INativeWindowConfiguration.devhubTerminalLauncher`, set per window by
`appController.openEditorView` through `IWindowsMainService.open`, threaded
through `windowsMainService` exactly where `userEnv` is threaded, and read by
the patched `platform.ts` from `window.vscode.context.configuration()`. The
renderer awaits `resolveConfiguration()` before it imports the workbench
(`workbench.ts`, `load`), so the value exists before `platform.ts` is
evaluated, which is what lets `TerminalProfileService` answer it synchronously
in its constructor.

**It used to be an environment variable, and it never arrived.** `preload.ts`
does `Object.assign(process.env, configuration.userEnv)`, which reads like the
window's environment getting `userEnv` merged into it — but the `process` a
sandboxed renderer's preload sees materialises `env` from a snapshot, so that
assignment lands on a copy nothing reads back. Measured on a packaged run:
`configuration.userEnv.DEVHUB_TERMINAL` held the right per-machine path in both
windows and `vscode.process.env.DEVHUB_TERMINAL` was `null` in both, so every
integrated terminal fell back to a bare shell. Nothing upstream notices,
because nothing upstream reads `userEnv` back out of the renderer's
environment.

There is therefore **one channel**, and `DEVHUB_TERMINAL` no longer exists:
`bootstrapShell` does not export it, `loginEnvironment` does not compose it,
and a window that was not told has no launcher. Undefined is safe as the "this
machine has none" answer in a way an absent environment variable was not — a
configuration field nobody set cannot have been answered by something the
process inherited, so there is no path for one machine's launcher to become
another's. The patched profile service refuses to invent one, the reason is on
DevHub's log and in `devhub --metrics`, and the person gets the app's own
alert.

**A task is not a terminal.** The launcher is what a *person* opens — one tmux
session, kept, with its history. A task, a debug console and anything else the
automation path resolves is throwaway: it is created to run one command, it is
read once, and it is thrown away, so joining a tmux session a person is working
in is the wrong answer to every part of that. `terminalProfileResolverService`
therefore skips the DevHub default when `allowAutomationShell` is set and falls
through to the OS default shell — the plain `/bin/zsh -l -c …` VS Code would
have run before DevHub. A `terminal.integrated.automationProfile.<os>` the
person configured still wins; it is answered before this ever comes up. The
interactive default is untouched, which is the whole of the rule: one pty host
in one window runs `tmux attach-session` for the terminal you opened and a bare
login shell for the task that just started.

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

Nothing here can be verified without a reachable host, and a packaged build:
`pnpm dev` states no commit and so refuses the resolve by name. In order:

0. **The authority resolves at all.** The window comes up with `SSH: <host>` in
   the status bar rather than sitting on "Opening Remote…". On the host,
   `~/.devhub-server/bin/<commit>/bin/devhub-server` exists,
   `~/.devhub-server/.<commit>.sock` is a socket and `.<commit>.pid` names a
   live process; on the Mac, `lsof -nP -iTCP@127.0.0.1 -sTCP:LISTEN` shows the
   forwarded port and the `ssh` holding it. Reopening the same host a second
   time must *not* add a second line to `~/.devhub-server/.<commit>.log` — the
   running server is adopted, not restarted.
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
12. **Reconnecting.** `ssh -O exit <host>` from a terminal on the Mac, or a real
    sleep and wake: the workbench notices, reconnects through a fresh
    `resolve()`, and the extension host on the host is the *same process* —
    `.<commit>.pid` has not changed and the log has not grown. A workbench that
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

Scratch is the *app's* terminal, not a folder's, and the app runs on this Mac.
A host's tmux gets workspace sessions and Agent sessions and nothing else. The
bootstrap config still has to create some session — a tmux server with none
exits — so on a machine that is not this one that anchor is retired as soon as
the session replacing it exists, and only when its whole marker tuple proves it
is DevHub's own. A workbench terminal on a host, started in a directory no
Workspace there contains, is refused in words rather than given a Scratch that
does not belong to that machine.
