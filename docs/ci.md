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
| `test-desktop` | macos-15 | `@devhub/desktop` tests: vitest, and node-pty under DevHub's own Electron |
| `build-app` | macos-15 | `scripts/build-app.sh --without-whisper --no-zip`; hands `DevHub.app` on as a tar |
| `test-app` | macos-15 | the app-level tests against that bundle: today `scripts/smoke_packaged_app.py`, which makes the app answer on its control socket and open a file in its editor (tmux and Neovim from Homebrew) |

Together the jobs run everything `pnpm run check` runs, plus a test build and
the tests that start it.

`scripts/test-local.sh` (`pnpm test:local`) runs all of it on one machine,
Linux included, stage by stage — `Test: app` as a smoke test of the packaged
layout (`package-nightly.py --layout-only`) under `xvfb-run`, since the bundle
is macOS-only — so CI is the final check rather than the place a change is
iterated on. The script's header lists the stages and the job each stands for.

- `concurrency` cancels a branch's older run as soon as a newer commit lands.
- `Test: app` is the home of app-level tests. macOS runners have a GUI
  session, so an end-to-end suite adds its steps there, against the bundle
  `build-app` handed on.

## Nightly: the product build

```
Decide ──> Build: DevHub.app ──> Test: packaged app ──> Publish: nightly release

Decide: tmux ──> Build: tmux linux-x64, linux-arm64 ──> Publish: tmux release
Decide: bash ──> Build: bash linux-x64, linux-arm64 ──> Publish: bash release
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
- **tmux** is independent of everything above: it is built, once, when the
  version pinned in `scripts/build_tmux.py` has no release yet.
- **bash** is the same again for the static bash Claude Code gets on a host
  with neither bash nor zsh (`scripts/build_bash.py`, release
  `bash-<version>`). Each publish job writes the tarballs' digests to its
  summary in the form `apps/desktop/product.json` takes them
  (`tmuxDownloadSha256`, `bashDownloadSha256`).

The Node DevHub installs on a host for its `devhub` command is nodejs.org's
own release, pinned by version and digest in `apps/desktop/product.json`
(`nodeVersion`, `nodeDownloadSha256`); nothing builds it.

## Shared setup

Nothing is pinned in a workflow that the repository already states:
`.github/actions/setup-node-pnpm` takes Node from `.nvmrc`, pnpm from
`package.json`'s `packageManager` (through corepack), caches the pnpm store
and runs `pnpm install --frozen-lockfile`. Electron is npm's, at the version
`apps/desktop/package.json` pins, downloaded on first use.
