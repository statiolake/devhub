# CI

Two workflows answer two different questions, and nothing is done twice:

- **CI** (`.github/workflows/ci.yml`), on every push to `main` and every pull
  request: *is this change broken?* It is built to answer as fast as possible.
  It packages nothing anyone downloads.
- **Nightly** (`.github/workflows/nightly.yml`), once a day when `main` has
  moved (or by hand): *build the product.* The remote extension hosts, the
  speech recogniser, the full VS Code bundle, the zip, the tests against that
  packaged app, and the releases.

A third, **VS Code bump** (`.github/workflows/vscode-bump.yml`), opens a pull
request when upstream VS Code has a newer stable release. Its pull requests
carry the `vscode-bump` label and a `bump/vscode-<version>` branch; when the
pull request for a version exists (new, or already open from an earlier run),
the `Close:` job closes every older open pull request with both, comments
"Superseded by #N (VS Code X).", and deletes its branch
(`scripts/vscode_bump_supersede.py`; versions are compared numerically, and a
fork's or unlabelled pull request is never touched). A same-version pull
request is reused, never duplicated: the plan skips a version whose branch
or pull request already exists.

Job names say which stage a job is: `Decide:`, `Build:`, `Test:` or
`Publish:`.

## CI: per push

```
Test: static checks and script tests (Linux) ──────────────┐
Test: desktop typecheck and unit tests (macOS) ────────────┤  in parallel
Build: DevHub.app test build (macOS) ──> Test: app (macOS) ┘
```

| Job | Runner | What it runs | Needs a provisioned VS Code |
| --- | --- | --- | --- |
| `checks` | ubuntu-latest | `pnpm run fmt`, `pnpm run lint`, `bridge:check`, `remote:check` (each extension's build, typecheck, tests, lint, package, reproducibility), `pnpm run test:scripts` | no — the submodule is checked out and patched, which is pure git |
| `test-desktop` | macos-15 | `@devhub/desktop` typecheck and tests (vitest, node-pty under VS Code's Electron), `darwin_bundle_test` | yes: `--for dev` (restores the cache, never saves it) |
| `build-app` | macos-15 | `scripts/build-app.sh --without-reh --without-whisper --no-zip` with the fast VS Code bundle; hands `DevHub.app` on as a tar | yes: `--for all` (saves the cache) |
| `test-app` | macos-15 | the app-level tests against that bundle: today `scripts/smoke_packaged_app.py` | no — it gets the app from `build-app` |

Together the jobs run everything `pnpm run check` runs (which is unchanged: a
developer still runs it whole before pushing), plus a test build and the tests
that start it.

`scripts/test-local.sh` (`pnpm test:local`) runs all of it on one machine,
Linux included, stage by stage — `Test: app` as a smoke test of a source run
under `xvfb-run`, since packaging is macOS-only — so CI is the final check
rather than the place a change is iterated on. The script's header lists the
stages and the job each stands for.

- What needs neither macOS nor a provisioned VS Code runs on Linux, which
  starts in seconds and does not queue behind macOS runners.
- The desktop tests and the app build need a provisioned VS Code but not each
  other, so they run side by side.
- The test build is only what the app tests need: no remote extension hosts,
  no speech recogniser, no zip, and `DEVHUB_FAST_VSCODE_BUNDLE=1` — the
  desktop bundle a developer's `pnpm build` makes rather than the nightly's
  full `core-ci`. `scripts/package-nightly.py` refuses a fast bundle under CI
  unless the run asks for one by name, as this job does.
- `Test: app` is the home of app-level tests. macOS runners have a GUI
  session, so an end-to-end suite (Playwright driving Electron, say) adds its
  steps there, against the bundle `build-app` handed on.
- `concurrency` cancels a branch's older run as soon as a newer commit lands.

## Nightly: the product build

```
Decide ──> Build: REH linux-x64    ─┐
       ├─> Build: REH alpine-x64   ─┤
       ├─> Build: REH linux-arm64  ─┼─> Publish: prebuilt REH (reh release)
       └─> Build: REH alpine-arm64 ─┤
                                    └─> Build: DevHub.app ──> Test: packaged app ──> Publish: nightly release

Decide: tmux ──> Build: tmux linux-x64, linux-arm64 ──> Publish: tmux release
```

- **Decide** stops a scheduled run when `main` has not moved since the last
  nightly (`scripts/nightly-build-needed.sh`). A run started by hand always
  builds.
- **Build: REH \<target>** — one job per remote extension host, all four in
  parallel on ubuntu-latest, each in Docker (`scripts/build_reh.py <target>`,
  see [remote-ssh.md](remote-ssh.md)). Each first asks the `reh` release for
  its server (`scripts/ensure_reh.py --from-release <target>`): the identity
  is a hash of everything the server is made of, so a server already
  published for it is downloaded and verified instead of rebuilt — every
  night after the first one following a VS Code bump, a patch edit or a
  change to the build scripts.

  *Why per server and not per architecture.* `linux-<arch>` and
  `alpine-<arch>` can share one build tree (`npm ci` and the server's part of
  `core-ci`, the long part), and one job per architecture prepares it once and
  then packages both servers one after the other. Per server, each tree is
  prepared twice on separate runners: about double the runner minutes (which
  cost nothing on this public repository), for less wall-clock, because the
  app waits for the *slowest* server — one tree plus one package step instead
  of one tree plus two. The second step is not small for arm64: alpine-arm64's
  `remote/` install and both arm64 start checks run under QEMU. With the tree
  preparation estimated at 25–40 minutes and a package step at 5–15 (20 or
  more for alpine-arm64 under QEMU), that is roughly 30–55 minutes until the
  last server instead of 40–70. Per server also lets a published server skip
  its job by itself, where an architecture's job could skip only when both of
  its servers were published. Carrying a prepared tree between jobs instead
  is not possible: it is over 10 GB in a Docker volume, past the Actions
  cache's limit.
- **Publish: prebuilt REH** uploads to the `reh` release the servers whose
  identity it lacks, and prunes old identities. It runs even if one server
  failed, so the others are not withheld.
- **Build: DevHub.app** (macos-15) needs all four servers: provisions VS Code
  with the full `core-ci` bundle (cached), builds the speech recogniser
  (cached), runs `pnpm run build` — the same entry point a developer uses —
  and hands the zip on.
- **Test: packaged app** (macos-15) unpacks that zip, exactly what will be
  released, and tests it: today the smoke test, and the place for the longer
  end-to-end suite.
- **Publish: nightly release** replaces the rolling `nightly` prerelease, only
  after the tests pass.
- **tmux** is independent of everything above: it is built, once, when the
  version pinned in `scripts/build_tmux.py` has no release yet.

## Shared setup

Nothing is pinned in a workflow that the repository already states:

- `.github/actions/setup-node-pnpm` — Node from `.nvmrc`, pnpm from
  `package.json`'s `packageManager` (through corepack), the pnpm store cached,
  `pnpm install --frozen-lockfile`.
- `.github/actions/provision-vscode` — `scripts/provision-vscode.sh` behind a
  cache of its expensive outputs (`vscode/node_modules`, `out`, `out-build`,
  `out-vscode-min`, `.build`, the toolchain), keyed on the submodule commit,
  its lockfile and Node, DevHub's patches and overlay (`patches/vscode/`,
  `patches/vscode-overlay/`) and the bundle mode (`fast` per push,
  `full` nightly). Only a job that provisions everything the key promises may
  save it; the others restore only.

Every workflow uses both; the bump workflow only the first, because its
script provisions a VS Code no cache can have.

## What runs where, at a glance

| | per push (CI) | nightly |
| --- | --- | --- |
| format, lint, extension checks, script tests | Linux | — |
| desktop typecheck and unit tests | macOS | — |
| VS Code bundle | fast (desktop only) | full `core-ci` |
| remote extension hosts | — (`--without-reh`) | built per target, or downloaded when published |
| speech recogniser | — (`--without-whisper`) | built (cached) |
| zip | — | yes |
| app tests | on the test build | on the unpacked release zip |
| releases | — | `reh`, `nightly`, `tmux-<version>` |
