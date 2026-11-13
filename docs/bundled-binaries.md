# The binaries DevHub runs

**The rule: DevHub runs only the binaries it bundles or delivers — never
whatever happens to be installed on this Mac or on a host. Not node, not bash,
not tmux.** (「すべて同梱のバイナリを優先。個別のインストールされた環境依存のものをつかわないでね、nodeやbashすらも」)

A program DevHub carries is always named by a path DevHub computed —
`bundledBash()`, `bundledNeovim()`, `Runtime.tmuxProgram()`, an installed
tool's `program`, `process.execPath` — never by a bare name looked up on a
PATH. What is left is named by a literal, and every such literal is either the
operating system's (the POSIX bootstrap and base utilities, macOS's own tools)
or the person's (their shell, their ssh, their git and its credentials, the
Agent CLIs they chose). The guard test `src/main/bundledBinaries.test.ts`
scans the runtime sources for every literal program in an `argv`, a `file`, a
`spawn`/`execFile`, an array that starts a `-c`, and a script's `#!`, and fails
on one that is not on its list with a reason; it also fails on any
`/usr/bin/env` lookup and on a script that starts `sh`, `bash`, `node`, `tmux`,
`nvim`, `python`, `perl` or `ruby` by name.

## What DevHub carries

| binary | here (this Mac) | on an SSH host |
| --- | --- | --- |
| Electron 43.7.7 (its Node runs main and every utility process: process host, pty host, Neovim host, conversation engine; and the login-environment printer as `ELECTRON_RUN_AS_NODE=1`) | the app | — |
| Neovim 0.12.6 | `out/nvim`: Neovim's release, signed by packaging | delivered from `out/host-tools`, `~/.devhub-server/nvim/<v>` |
| bash 5.3.20 | `out/bash`: DevHub's tools release (`scripts/build_bash.py`); macOS links libSystem only, signed by packaging | delivered from `out/host-tools`, `~/.devhub-server/bash/<v>` (static, musl) |
| tmux 3.7c | `out/tmux`: DevHub's tools release (`scripts/build_tmux.py`); macOS links libSystem only, signed by packaging. `runtimes.tmux` is retired | delivered from `out/host-tools`, `~/.devhub-server/tmux/<v>` (static, musl) |
| Node 26.13.0 (LTS) | — (this Mac's Node is Electron's) | delivered from `out/host-tools`, `~/.devhub-server/node/<v>`, appended to the carried Neovim's `PATH` after the host's own (`docs/remote-neovim-config.md`), for the language servers it starts |
| ripgrep 15.2.0, fd 10.5.1 | — | delivered from `out/host-tools`, `~/.devhub-server/{rg,fd}/<v>` (static, musl), appended to the carried Neovim's `PATH` after the host's own |
| the `devhub` command (Go) | `out/cli/<os>-<arch>/devhub`, exec'd by the launcher | delivered, `~/.devhub-server/devhub/<digest>` |
| libghostty-vt | `out/vt/ghostty-vt.wasm` | — |
| node-pty | its N-API prebuild in `node_modules` | — |
| helpers | `out/native/devhub-exec-clean`, `devhub-footprint`, `devhub-input-source` (C, built by `build:native`) | — |
| speech recogniser (whisper.cpp v1.9.4, ~9 MB) | `Resources/whisper/devhub-whisper{,-server}`; its model is **not** bundled — see below | — |

## Where they come from

All of it is put in the app when the app is built. Nothing is downloaded at
runtime, for this Mac or for an SSH host — with one deliberate exception,
the speech model, below.

- **Built by DevHub, released per architecture.** tmux and bash have no good
  upstream distribution: DevHub needs a static, musl-linked tmux with its own
  terminfo database, and a static bash with every upstream patch.
  `scripts/build_tools.py` builds one architecture's of each, and
  `.github/workflows/tools.yml` builds darwin-arm64, linux-x64 and
  linux-arm64 on native runners and publishes them as one release,
  `tools-<toolsVersion>`. Each asset is `devhub-tools-<toolsVersion>-<os>-<arch>.tar.gz`,
  and `SHA256SUMS` sits beside them. The release is versioned on its own
  (`toolsVersion`, in `apps/desktop/product.json`).
- **Upstream, where it distributes well.** Neovim from Neovim's releases. Node
  from nodejs.org's official LTS tarballs, for Linux hosts only. ripgrep and
  fd from their static musl releases.
- **Built with the app.** The `devhub` command (Go, `cli/`) is cross-compiled
  by every app build (`build:devhub-cli`) and stays out of the tools
  release. It talks to the app it came with over the app's socket, and its
  version on a host is that build's digest, so it is part of the build,
  not a separately versioned tool. Building it from source for all three
  platforms takes seconds and needs nothing outside the repository. The
  libghostty-vt module, the native helpers and the speech recogniser's
  programs are built with the app as before.

### The one exception: the speech model

Voice input (`docs/agent-gui.md`, "Voice input") reads a Whisper model of
466 MiB (`ggml-small.bin`; 547 MiB for `large-v3-turbo`) — when it was
bundled, half the app. It is the one thing DevHub downloads while it runs,
and it is held to the same rules as everything above:

- **Only on an explicit opt-in.** Voice input is off by default
  (`[voice] enabled = false`). Turning it on — Settings → General → 音声入力,
  or the first press of the composer's microphone — first shows what would
  be downloaded: the model, its size, the host (`huggingface.co`), where it is
  kept, and that it runs on the Mac afterwards with no audio leaving it.
  Nothing is fetched unless the person chooses ダウンロード; キャンセル leaves voice
  input off. A model already on disk is not downloaded again.
- **Pinned.** `product.json` holds each model's URL and hash
  (`whisperModels`): the SHA-1 whisper.cpp's `models/README.md` publishes, the
  one hash upstream states (a pin may add `sha256`, and every hash a pin
  states is checked). `scripts/build_whisper.py` reads the same pins.
- **Verified before use.** The download goes to `<file>.part`, resumes from
  there after a failure (`Range`), and is hashed when complete; a file that
  does not match is deleted, never loaded. A verified model is recorded
  beside it (`<file>.verified.json`: the hash it matched, its size and time),
  so a later launch knows it is the checked file without hashing it again.
- **Kept in the profile.** `<userData>/devhub/whisper/` — on a Mac,
  `~/Library/Application Support/DevHub/editor/devhub/whisper/`. Turning voice
  input off offers to delete the models; Settings deletes one on request,
  asking first.

It is fetched by main with Electron's `net.fetch`
(`src/main/voice/modelDownload.ts`, `voiceSetup.ts`); the recogniser itself
still has no network code (`-DWHISPER_CURL=OFF`). For working on DevHub, a
model beside the programs — `scripts/build_whisper.py --model NAME` into
`dist/whisper`, or the directory `DEVHUB_WHISPER_DIR` names — is used
instead, and nothing is downloaded; packaging never bundles one.

`product.json` pins every downloaded asset: `<tool>Version`, and per
`<os>-<arch>` its URL (`<tool>DownloadUrls`) and sha256
(`<tool>DownloadSha256`) for `tools`, `nvim`, `node`, `rg` and `fd`, plus the
`tmuxVersion` and `bashVersion` the tools release must hold. One step,
`build:binaries` (`apps/desktop/scripts/fetch-binaries.mjs`), downloads all
of them into `~/.cache/devhub/downloads`, checks each against its pin, and
lays out:

```
out/nvim, out/tmux, out/bash      this machine's, unpacked (darwin-arm64 in the app)
out/host-tools/linux-x64/         tmux, bash, nvim, node, rg, fd: one .tar.gz each, as published
out/host-tools/linux-arm64/       the same
out/host-tools/manifest.json      per tool: version, binary path; per platform: file, sha256, directory
```

A warm cache builds without a network. `runtime/toolDelivery.ts`
(`BundledArchiveDelivery`) sends a host the tarball for its architecture
from `out/host-tools`, after checking it against the manifest
(`docs/remote-ssh.md`).

## The inventory

Every place DevHub starts a program at runtime, with its category:
**(a)** switched to a bundled/delivered binary, **(b)** bundled newly,
**(c)** inherently the system's or the person's, and why.

### Shells and interpreters

| what | where | | why |
| --- | --- | --- | --- |
| Claude Agents' `CLAUDE_CODE_SHELL`, here | `LocalRuntime.claudeShell` | **(b)** | was: nothing set, so Claude Code took `$SHELL` (zsh) or the PATH's bash. Now `out/bash/bin/bash`, for the Agent's process only. `SHELL` is not set: tmux gives a pane its `default-shell` as `SHELL` whatever the session's environment says, and Claude Code reads `CLAUDE_CODE_SHELL` first |
| Claude Agents' `CLAUDE_CODE_SHELL`, on a host | `RemoteShellRuntime.claudeShell` | **(a)** | was: the host's bash or zsh when it had one, the delivered bash only when it had neither. Now always the delivered bash; the probe of the host's shells is deleted |
| `sh -c` (the Neovim keeper, a host's Neovim socket directory, the Agent session readers in `resume.ts`, `find -exec sh`) | `managedNeovim.ts`, `neovimMachines.ts`, `resume.ts`, `remoteShellRuntime.ts` | **(a)** | were the PATH's `sh`; now `/bin/sh` by path, like every other script |
| `/bin/sh` — the GUI Agent host and its `STREAM`/`WRITE`/`RESTART`/`SENT_LOG`/`ENDING` scripts, `pathLinks`, `embedFiles`, tool installs, every host command, popups, the `devhub` launchers (`#!/bin/sh`) | many | **(c)** | the POSIX bootstrap: the one shell every macOS and Linux (busybox included) has at that path, and the only one a host has before DevHub has delivered anything. The scripts are POSIX `sh` and exec DevHub's own binaries by path |
| node | — | — | no system `node` runs anywhere: the login-environment printer and every utility process are Electron's Node; the `devhub` command is Go |
| bash | — | — | no runtime script runs bash or has a `#!/usr/bin/env bash`; only build and development scripts do (`scripts/*.sh`, `apps/desktop/scripts/dev.sh`, which a checkout's launcher starts), and those are not part of the app |
| the person's login shell (`$SHELL -i -l -c`) to import their environment | `loginEnvironment.ts`; on a host `$SHELL -lc 'env -0'` (then `/bin/sh -lc`) | **(c)** | the environment being read *is* their shell's: their PATH for their own tools (git, gh, the Agent CLIs). The printer is Electron (`ELECTRON_RUN_AS_NODE`), not a node |
| a pane's shell (`runtimes.shell`, tmux's `default-shell`), a popup's shell, Neovim's `:!` | tmux, `POPUP_SCRIPT`, Neovim | **(c)** | the person's interactive shell (zsh) in their panes is theirs |

### Bundled programs, by path

| what | where | |
| --- | --- | --- |
| Neovim: the keeper's `nvim --headless --listen`, the shim's `nvim --embed`, the shim's tty-key reader `nvim -l` | `managedNeovim.ts`, `cli/nvim.go`, `terminalNeovimTtyKeys.ts` | bundled/delivered, by absolute path (`nvim-shim.json`) |
| tmux, the server and every client (node-pty, `tmux -C`, bounded commands) | `terminal/tmux.ts`, `ptyHost/`, `surfaces.ts` | bundled (`terminal/bundledTmux.ts`) / delivered, by absolute path |
| a pane's `tmux` (typed, a binding's `run-shell`, `copy-pipe`, a popup's) | `paneTmuxScript`, beside the `nvim` shim and first on every pane's PATH | bundled/delivered, by absolute path (`docs/terminal-mode.md`, "DevHub's tmux") |
| the `devhub` command | the launcher (`cli/install.ts`), a host's shim (`terminal/launcher.ts`); copied as a pane's `nvim` (`terminalNeovimShim.ts`) | bundled/delivered |
| `devhub-exec-clean`, `devhub-footprint`, `devhub-input-source`, `devhub-whisper{,-server}` | `cleanSpawn.ts`, `taskManagerReading.ts`, `inputSourceHelper.ts`, `voice/` | bundled |

### The system's (category c)

| program | where | why |
| --- | --- | --- |
| `rm`, `mv`, `test`, `sleep` as argv; `cat`, `tail`, `wc`, `mkfifo`, `kill`, `mkdir`, `chmod`, `mktemp`, `stty`, `printf`, `head`, `ls`, `id`, `uname`, `tar`, `env -0`, `awk`, `sed`, `sort`, `find`, `stat`, `date`, `readlink` inside the scripts | `neovimMachines.ts`, `cliSettingsFile.ts`, `conversation.ts` (`sleep` as a placeholder CLI), the host scripts, the shim | POSIX base utilities, on whichever machine the runtime is. A host's layout is not known, so they are named, not pathed; DevHub relies on their POSIX behaviour only (and handles the GNU/BSD/busybox differences in `stat`, `date`, `sleep 0.1`) |
| `ps` | `tmux.ts` (an Agent pane's process tree, here or on a host), `resume.ts`'s pane script (else `/proc`) | POSIX base utility |
| `/bin/ps` | `taskManagerReading.ts` (this Mac's Task Manager) | macOS's own, by path |
| `lsof` | `resume.ts` (Codex's open rollout files where there is no `/proc`) | macOS base system (`/usr/sbin/lsof`); Linux reads `/proc` |
| `/usr/sbin/sysctl`, `/usr/bin/vm_stat` | `diagnostics/systemMemory.ts` | macOS's own memory readings |
| `/usr/bin/open -a DevHub.app` | `cli/install.ts`'s launch command | macOS's launcher, starting the app itself |
| Electron's `shell.openExternal` / `openPath` | links, files | the system's handler for a URL or file, by design |

### The person's (category c)

| program | where | why |
| --- | --- | --- |
| `ssh` (`sshPath`, default `ssh` on the login PATH) | `runtime/ssh.ts` | the person's keys, agent, `~/.ssh/config`, ProxyJump, FIDO support; a bundled ssh would not read them as theirs does |
| `git` (`runtimes.git`) | `shell/git.ts`, `repositoryStatus.ts` | the person's repositories, config, hooks, signing and credential helpers |
| `gh` | `shell/github.ts` | the person's GitHub sign-in |
| the Agent CLIs (`claude`, `codex`, a profile's `command`), their usage readers, MCP sign-in | `agentWiring.ts`, `hostCommand.ts`, `usageReaders.ts`, `mcpSignIn.ts` | the programs the person chose and keeps up to date; DevHub runs them by the path it resolved |
| a picker's command source (`[[workspace_sources]] command`) | `workspacePicker.ts` | the person's own command, by their configuration |

## What is not DevHub's to fix here

- **The Agent CLIs' own interpreter.** Claude Code installed with `npm i -g`
  is a node script (`#!/usr/bin/env node`): it runs the machine's node, which
  DevHub cannot replace. Its native build (`claude install`, under
  `~/.local/bin/claude`) needs none. Codex is a native binary.
- **Codex's shell.** Codex runs its commands in the person's login shell, and
  reads no `CLAUDE_CODE_SHELL`; DevHub sets nothing for it.
- **Neovim plugins.** What the person's Neovim config starts is theirs. On a
  host, DevHub runs lazy.nvim's own build step for the specs that declare
  one; what that step runs is the plugin's (`docs/remote-neovim-config.md`). The
  vscode-incremental-diff plugin's bundled JS server needs a `node`; its Go
  port is a separate task.

## Checked

`src/main/bundledBinaries.test.ts` (the guard, which also fails on a runtime
source that names a download URL), `runtime/toolDelivery.test.ts` (the
bundle a host is given, and this build's `out/host-tools` against
`product.json`), `runtime/bundledBash.test.ts`
(the bundled bash is the pinned version and is what a local Claude Agent
gets), `runtime/agentShell.test.ts` and the host install in `ssh.test.ts`; the
smoke test (`scripts/smoke_packaged_app.py`) requires `out/bash/bin/bash` in
the packaged layout and runs it with an empty environment, requires every
host tool for both Linux architectures in `out/host-tools` and matching its
manifest, and requires
`out/tmux/bin/tmux`, runs it, and checks that the app's tmux server is that
binary and that a pane's `tmux` runs it.
