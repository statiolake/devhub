# The `devhub` command in Go

The `devhub` command was TypeScript, run as Node: by the app's own Electron
(`ELECTRON_RUN_AS_NODE=1`) on this Mac, and by a Node DevHub downloaded from
nodejs.org and installed on every SSH host for no other reason. It is now one
static Go binary, in `cli/` at the top of the repository, built from source by
the app build and carried inside the app. No machine needs a Node to run it,
and nothing has to be published for a host to get it.

## What the TypeScript command was

`apps/desktop/src/main/cli/` held the command and the app's side of its
socket in one directory. The client half, the part that ran in the terminal:

| file | lines | what |
| --- | --- | --- |
| `devhubCli.ts` | 718 | argument parsing, the request per command, `--tell` path expansion and `-` text, printing, `--wait` |
| `launch.ts` | 391 | start DevHub when nothing answers (`DEVHUB_LAUNCH_COMMAND`), or say why a host cannot; the `ping` liveness probe |
| `wait.ts`, `stdin.ts`, `goto.ts` | 270 | the `--wait` marker, `devhub -` spooling, `FILE:LINE:COL` |
| `tell/command.ts` | 2590 | the `--tell` vocabulary: its parser (≈1100 lines), its usage text, and `tellCommandFrom` (≈450 lines), which re-validated the parsed command when it arrived over the socket |
| `devhubCliEntry.ts`, `../entryPoint.ts` | — | the bundle's entry point (`build:cli`, esbuild) |

Its features: `devhub` (activate), `devhub <folder|file>`, `devhub -`,
`-g FILE:LINE[:COL]`, `-w/--wait` (an `EDITOR`), `--agent <profile> -- args`,
`--version`, `--metrics`, `--tell <verb> …` (with `--json`, `--as NAME`, and
`-` for text from a pipe), and starting DevHub when it is not running.

What it shared with the app: `protocol.ts` (the request and response types,
and the parser the server runs), `tell/command.ts` (the server's
`TellCommand` type, used by `tell/service.ts`), `resolve.ts`'s `expandPath`,
and `launch.ts`'s `launchCommandFor` and the install hint, which the app uses
to write the launcher. Everything else on the app's side — the control
server, routing, `--wait`'s return, the tell service — never ran in the
command.

## Scope

The Go command does what the client half did, and nothing the app does:

- parse the command line except `--tell`'s words, with the same messages and
  exit statuses (`0`, `1` for a failure DevHub reported, `2` for a command
  line it refused);
- build the request, with `DEVHUB_ORIGIN` and `DEVHUB_MACHINE` carried as
  they arrived and relative paths made absolute where they were typed;
- `devhub -`: spool stdin to a 0600 file and open that;
- `--wait`: make the marker before the open, poll it, fail if DevHub stops
  answering `ping`, send `wait-ended`, print nothing;
- start DevHub when nothing answers on this Mac (`DEVHUB_LAUNCH_COMMAND`), or
  say why it cannot be started from a host;
- print the answer: the sentence, or for `--tell --json`
  `{"ok": true, …data}` indented by two, as before.

**`--tell` is parsed by the app.** The command sends the words after
`--tell`, its cwd and home, and the app runs the parser that already sat
beside the service that executes the verbs. One parser, in one language,
next to the code it feeds; the Go command carries no copy of a 1100-line
vocabulary that changes with every new verb, and `tellCommandFrom` — a
second validation of a parse the app now does itself — is deleted.

Not in scope: `devhub-terminal`, the asking program of the terminal
launcher. It answered VS Code's integrated terminal
(`docs/without-vscode.md`, "What is left to delete"). Its host copy, and so
the host's Node, goes with this change; the local copy (run by the app's
Electron) is left to the workbench dead-code removal.

## Protocol

The socket, the framing (one JSON line each way, then close) and every
request but one are unchanged: `ping`, `activate`, `open`, `wait-ended`,
`version`, `metrics`, `add-agent`, `terminal-profile`.

`tell` changes from a parsed command to the words:

    {"kind":"tell","argv":["agent","send","A1","-"],"cwd":"/w","home":"/h",
     "stdin":"…","origin":"…","machine":"ssh:box"}

and its answer says how the command should print it:

| answer | the command |
| --- | --- |
| `{"ok":true,"message",…,"data",...,"json":true\|false}` | prints `message`, or with `json` the data as before; exit 0 |
| `{"ok":false,"message","json":…}` | as before; exit 1 |
| `{"ok":false,"message","usage":true}` | `devhub: --tell: <message>` and the hint; exit 2 |
| `{"ok":false,"message","stdin":true}` | the words name `-` and no `stdin` was sent: read the pipe (refuse a terminal, exit 2) and ask again with `stdin` |
| `{"ok":false,"message","files":[paths]}` | the words attach files (`--attach`, `attachment add`): read each, here, and ask again with `"files":{path: base64}` (one that is not there, not a regular file, over 10 MB, or 25 MB in all: `devhub: --attach: …`, exit 1) |

**Files are read where the command runs.** `--attach shot.png` on an SSH
host names a file on the host, which the app cannot read; the app makes the
path absolute against the words' `cwd` and `home` (strings, as for every
path) and asks for it, and the command (`cli/attach.go`) sends the bytes.
Asked for, as stdin is, so a command that attaches nothing sends nothing
extra, and the app's parser stays the one place that knows which words are
files. A request may then be up to 36 MB (`MAX_REQUEST_BYTES`; it was 64 KB).
Both may be asked for in turn: the command answers each once.

`--tell help` is answered with the usage text. Asking for stdin rather than
reading it whenever a `-` appears means the command never blocks on a pipe
nobody writes to when `-` was a value and not the text.

Which `-` is text is the app's to say (`readsStdin` in `tell/request.ts`):
`agent send`, `orchestrator emit` and `memo set` take their text
there; `agent new`, `issue assign`, `agent resume` and `orchestrator start`
their `--prompt`; `escalation new` and `ask` their `--body`. So
`devhub --tell memo set issue=acme/app#12 - < next.txt` and
`devhub --tell agent resume issue=acme/app#12 --prompt - <<<'…'` need nothing
new in the Go command: a verb that reads stdin is a line in the app's parser.

**Compatibility.** The command and the app are one build: the launcher on
this Mac execs the binary inside the app it was installed from, and a host
is given the binary of the DevHub that connects to it, keyed by the
binary's digest. So there is no old command talking to a new app, and the
old `tell` form is refused as malformed rather than kept. The vitest suite
and the Go suite read one fixture, `cli/testdata/requests.jsonl`: Go asserts
it sends exactly those lines, the app asserts it accepts each one.

## Delivery: one mechanism for tmux, bash, nvim and the command

`runtime/toolDelivery.ts` carries every tool to hosts. The host receives
the bytes on a `tar` stdin and installs them under
`~/.devhub-server/<tool>/<version>/`, and the binary is asked its version
before and after. That mechanism is the only one, and every tool's bytes
come from inside the app. Nothing is downloaded at runtime.

- **A bundled tarball** (`BundledArchiveDelivery`): tmux, bash, nvim, node,
  rg and fd, from `out/host-tools/<os>-<arch>/`, checked against
  `out/host-tools/manifest.json`. The app build fetched them from their
  pinned releases (`docs/bundled-binaries.md`).
- **The app itself** (`BundledToolDelivery`): the `devhub` command, from
  `Resources/app/out/cli/<os>-<arch>/devhub`, checked against
  `out/cli/SHA256SUMS`, which the build writes beside the binaries. Its
  version directory is the first 12 hex digits of the digest, so two builds
  never share a directory and a rebuild of the same source installs nothing.
  A bare binary rather than a tarball: the install writes it to
  `bin/devhub` through the same staging directory and rename.

`HostTool` is `tmux | bash | nvim | devhub`; `node` and the `nodeVersion`
pins are deleted. Go builds the command with cgo off, so it runs on glibc and
musl alike and the "musl is refused" rule goes.

Nothing about the command needs a published asset: the app carries it.

## Build

`apps/desktop/scripts/build-devhub-cli.mjs` (`build:devhub-cli`, part of
`pnpm --filter @devhub/desktop build`) runs `go build -trimpath
-ldflags='-s -w'` with `CGO_ENABLED=0` for `darwin-arm64`, `linux-x64` and
`linux-arm64` into `out/cli/<platform>/devhub`, and writes `SHA256SUMS`.
`package-nightly.py` copies `out/` whole, so the bundle carries all three.
Go is a build dependency; `cli/go.mod` states its version and CI's
`setup-node-pnpm` action installs it from there.

## Install on this Mac

"DevHub: Install 'devhub' command in PATH" writes the same generated
launcher as before — socket, profile and launch command recorded in it — but
it now `exec`s `out/cli/<this platform>/devhub` from the running app instead
of Electron with a script. The `/devhub` skill names that launcher, as
before.

## On a host

`RemoteShellRuntime.terminalLauncher` installs the `devhub` tool, writes the
`devhub` shim in `~/.devhub/terminal/bin-<tag>/` (socket and machine set,
then `exec` the installed binary), writes the `/devhub` skill, and publishes
the control socket. It no longer writes the asking program, its launcher
script or a `package.json`, and installs no Node. Left behind from earlier
versions and safe to delete by hand: `~/.devhub-server/node/` and
`~/.devhub/terminal/js/`.

## As a pane's `nvim`

Run under the name `nvim` (`cli/nvim.go`), the binary is DevHub's `nvim`
instead: DevHub copies it into the directory in front of every pane's PATH
(`terminalNeovimShim.ts`, `docs/neovim-editor.md` "Neovim in a terminal"),
with `nvim-shim.json` beside it naming DevHub's Neovim and tmux on that
machine. It was a POSIX `sh` script; the Go program starts the Neovim DevHub
attaches to after one `tmux` client instead of a dozen processes, which is
most of the time between Enter and an editor in a DevHub terminal that a
plain terminal does not spend.

## Tests

- `cli/*_test.go` (`pnpm run test:cli`, the `cli` stage of
  `scripts/test-local.sh`, CI's `checks` job): the argument table and every
  refusal, `--goto`, path expansion, the request per command, `--tell`'s
  printing and its `stdin` and `files` round trips (and the files it refuses
  to send), `--wait` against a fake DevHub that
  removes the marker or goes away, start-when-not-running with a fake
  launcher, and the request fixture.
- vitest: the app's half of `tell` (`tell/request.ts`: argv to command,
  paths, `-`, `help`, refusals), the fixture accepted by
  `parseControlRequest`, `BundledToolDelivery`, the host install over a real
  local ssh, the launcher text.
- The smoke test (`scripts/smoke_packaged_app.py`) requires the three
  binaries and `SHA256SUMS` in the packaged layout, and drives the started
  app through the packed binary itself: `--version` and an open.

## Migration

One change, no shims: the TypeScript client (`devhubCli.ts`,
`devhubCliEntry.ts`, `launch.ts`'s client half, `wait.ts`, `stdin.ts`,
`goto.ts`, `tellCommandFrom`, `build:cli`, the host's `build:terminal`
bundle and Node) is deleted in the commit that adds the Go command.
`launchCommandFor` and the install hint move into `install.ts`, the one app
module that uses them. A launcher installed by an earlier DevHub still names
Electron and `devhubCliEntry.js`, which no longer exists, and says so; run
the install command again.
