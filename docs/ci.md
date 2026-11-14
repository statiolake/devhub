# CI

Two workflows answer two different questions, and nothing is done twice:

- **CI** (`.github/workflows/ci.yml`), on every push to `main` and every pull
  request: *is this change broken?* It is built to answer as fast as possible.
  It packages nothing anyone downloads.
- **Nightly** (`.github/workflows/nightly.yml`), once a day when `main` has
  moved (or by hand): *build the product.* The speech recogniser, the zip, the
  tests against that packaged app, and the release.

Neither touches the `vscode` submodule: DevHub has no VS Code to build
(`docs/without-vscode.md`). Every job's set-up is `pnpm install`.

Job names say which stage a job is: `Decide:`, `Build:`, `Test:` or
`Publish:`.

## CI: per push

```
Test: static checks and script tests (Linux) ──────────────┐
Test: desktop unit tests (macOS) ──────────────────────────┤  in parallel
Build: DevHub.app test build (macOS) ──> Test: app (macOS) ┘
```

| Job | Runner | What it runs |
| --- | --- | --- |
| `checks` | ubuntu-latest | `pnpm run fmt`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run test:scripts` |
| `test-desktop` | macos-15 | `@devhub/desktop` tests: vitest, and node-pty under DevHub's own Electron; the real-Neovim tests run the bundled Neovim (`build:binaries`) |
| `build-app` | macos-15 | `scripts/build-app.sh --without-whisper --no-zip`; hands `DevHub.app` on as a tar |
| `test-app` | macos-15 | the app-level tests against that bundle: today `scripts/smoke_packaged_app.py`, which makes the app answer on its control socket and open a file in its editor — the Neovim inside the bundle, run by the tmux inside it — runs that Neovim and that tmux, and checks that the app's tmux server is the bundled tmux and that a pane's `tmux` runs it |

Together the jobs run everything `pnpm run check` runs, plus a test build and
the tests that start it.

`scripts/test-local.sh` (`pnpm test:local`) runs all of it on one machine,
Linux included, stage by stage — `Test: app` as a smoke test of the packaged
layout (`package-nightly.py --layout-only`) under `xvfb-run`, since the bundle
is macOS-only — so CI is the final check rather than the place a change is
iterated on. The script's header lists the stages and the job each stands for;
its `stability` stage is the nightly's visual-stability job.

- `concurrency` cancels a branch's older run as soon as a newer commit lands.
- `Test: app` is the home of app-level tests. macOS runners have a GUI
  session, so an end-to-end suite adds its steps there, against the bundle
  `build-app` handed on.

## Nightly: the product build

```
Decide ──> Build: DevHub.app ──> Test: packaged app ──> Publish: nightly release
       └─> Test: visual stability (Linux)
```

and, on a `tools-<toolsVersion>` tag (`tools.yml`):

```
Check the tag ──> Build: tools darwin-arm64, linux-x64, linux-arm64 ──> Publish: tools release
```

- **Decide** stops a scheduled run when `main` has not moved since the last
  nightly (`scripts/nightly-build-needed.sh`). A run started by hand always
  builds.
- **Build: DevHub.app** (macos-15): builds the speech recogniser (cached),
  runs `pnpm run build` — the same entry point a developer uses — and hands
  the zip on.
- **Test: packaged app** (macos-15) unpacks that zip, exactly what will be
  released, and tests it: today the smoke test.
- **Publish: nightly release** replaces the rolling `nightly` prerelease, only
  after the tests pass.
- **Test: visual stability (Linux)** (ubuntu-latest) builds the desktop app
  and runs the visual-stability suite (`apps/desktop/test/stability`,
  [`visual-stability.md`](visual-stability.md)) under Xvfb: every scenario
  recorded frame by frame at 6x and 1x CPU throttling and checked for
  intermediate forms. What it recorded is uploaded as `visual-stability`.
  It is nightly rather than per push — about fourteen minutes of recording
  on top of the build (the scenarios in motion, the pointer and startup
  timings included; about 860 s on a 4-core Linux machine) — and it does
  not hold the release back. There is no per-push subset: the cheapest
  scroll check alone (`--only scroll-burst`, about 90 s) needs the whole
  app built and Xvfb, so it stays with the rest.
- **Tools** (`.github/workflows/tools.yml`) is a workflow of its own. It runs
  when a tag `tools-<toolsVersion>` is pushed, and builds DevHub's tools
  release (`scripts/build_tools.py`: tmux and bash) on macos-15, ubuntu-latest
  and ubuntu-24.04-arm. It publishes the three tarballs and their `SHA256SUMS`
  as release `tools-<toolsVersion>`, and its summary prints the
  `toolsDownloadSha256` that `apps/desktop/product.json` takes.

The `devhub` command a host is given is not a release: it is built from
`cli/` (Go) by the app build and carried inside the app
(`docs/devhub-cli.md`). Every job that builds the app gets Go from
`cli/go.mod` through `setup-node-pnpm`; `checks` runs `pnpm run test:cli`.

Every binary the app bundles and does not compile itself is fetched by one
step, `build:binaries` (`apps/desktop/scripts/fetch-binaries.mjs`): the tools
release, Neovim, Node, ripgrep and fd, each pinned in `apps/desktop/product.json`
by URL and sha256. It unpacks this machine's Neovim, tmux and bash into
`out/nvim`, `out/tmux` and `out/bash`, and keeps every Linux host's tools,
compressed, in `out/host-tools`. The downloads are cached in
`~/.cache/devhub/downloads`, which `setup-node-pnpm` restores (keyed on
`product.json`). No job installs a tmux, a bash or a Neovim; the tests run the
bundled ones.

## Shared setup

Nothing is pinned in a workflow that the repository already states:
`.github/actions/setup-node-pnpm` takes Node from `.nvmrc`, pnpm from
`package.json`'s `packageManager` (through corepack), caches the pnpm store
and runs `pnpm install --frozen-lockfile`. Electron is npm's, at the version
`apps/desktop/package.json` pins, downloaded on first use.
