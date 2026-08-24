# Local development and verification

This document describes the checks that can be reproduced on a developer
machine. It does not replace the hosted macOS provenance and release gates in
the final implementation wave.

## Prerequisites

- macOS is the supported development host for R1.1.
- Rust `1.97.1`, including `rustfmt` and `clippy`, is selected by
  [`rust-toolchain.toml`](../rust-toolchain.toml).
- Node `22.21.1` is the pinned Bridge/OpenVSCode build baseline from
  [`docs/PROVIDER-CONTRACTS.md`](PROVIDER-CONTRACTS.md).
- pnpm `11.20.0` is required by the root `packageManager` field.
- The JavaScript Tauri packages follow their current independent release
  lines: `@tauri-apps/api` `2.11.1` and `@tauri-apps/cli` `2.11.4`. The native
  Rust host remains pinned independently to Tauri `2.11.5` and WRY `0.55.1`.
  These exact pins are intentional rather than an accidental version drift;
  the installed CLI is expected to report `tauri-cli 2.11.4` after the lock is
  refreshed.

The local host may use Corepack or another installation method, but the
reported pnpm version must be `11.20.0` before installing dependencies.

After changing the JavaScript dependency pins, regenerate the lockfile with
`CI=true pnpm install` and then use `CI=true pnpm install --frozen-lockfile`
for verification. The local compatibility checks for this Rust/JavaScript
Tauri release boundary are:

```sh
CI=true pnpm --filter @devhub/app exec tauri --version
CI=true pnpm --filter @devhub/app exec tauri build --debug --no-bundle
```

The first command must report `tauri-cli 2.11.4`; the second runs the pinned
Rust Tauri `2.11.5` and WRY `0.55.1` host together with the frontend build.
Hosted macOS artifact validation remains a later release gate.

### Official VS Code Web (BYO) proof

DevHub can use a separately installed macOS VS Code CLI without bundling it.
Keep server data, CLI data, token, and browser data outside the user's normal
profile during proof:

```sh
code --version
code serve-web --help
DEVHUB_EDITOR_PROVIDER=official-vscode \
DEVHUB_VSCODE_CLI=/absolute/path/to/code \
DEVHUB_VSCODE_SERVER_LICENSE_ACCEPTED=1 \
CI=true pnpm --filter @devhub/app exec tauri dev
```

The native provider probes the CLI version and `serve-web` capabilities before
launch. It requires authenticated HTTP and Workbench WebSocket readiness and
installs the app-owned Bridge VSIX through the public `code
--install-extension` command. Do not add `--accept-server-license-terms`
unless the user has already accepted the official terms and enabled the
explicit consent setting. A Restricted Mode workspace is an expected proof
case: the Bridge manifest advertises untrusted-workspace support, while the
Workbench's own Trust UI remains upstream-owned.

## Deterministic checks

Run these commands from the repository root:

```sh
CI=true pnpm install --frozen-lockfile
CI=true pnpm run fmt
CI=true pnpm run lint
CI=true pnpm run typecheck
CI=true pnpm run test
CI=true pnpm run check
CI=true pnpm run build
git diff --check
```

The root scripts use `pnpm-lock.yaml` and `Cargo.lock`; they do not update
dependency resolution. `pnpm run check` is the compact gate that combines the
format, lint, type, test, and locked Rust checks. `pnpm run build` verifies the
frontend bundle and locked Cargo workspace build.

Useful focused checks are:

```sh
CI=true pnpm --filter @devhub/app test
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
```

The shared App Shell v1 contract is
[`contracts/app-shell/app-shell-v1.schema.json`](../contracts/app-shell/app-shell-v1.schema.json),
with valid and invalid fixtures alongside it. `pnpm run app-shell:check`
verifies the schema, fixtures, and generated TypeScript parser are in sync with
the Rust wire types. Replay cursors are process-event sequences, independent of
snapshot revisions; bounded-history gaps require snapshot replacement. Native
effects and provider payloads advance that cursor internally but are filtered
from the public replay event union.

## Native bootstrap and persistence

The native process uses the canonical macOS paths from the product contract:
user configuration is loaded through `ConfigStore` from
`~/.config/devhub/config.toml`, and runtime state is loaded through
`JsonStateStore` from `~/Library/Application Support/DevHub/state.json`.
Configured Agent Profiles are converted to domain profiles before the single
`AppCoordinator` is hydrated. Workspace discovery, repository resolution, and
provider reattachment remain later-wave adapters; they are not fabricated at
startup. A malformed configuration or an unhydrateable legacy state fails
bootstrap with a typed native/degraded error and never replaces the durable
state with an empty model.

Closing the only window persists the current projection but leaves the
shutdown metadata unclean because macOS may keep the process alive. A system
Quit persists the projection and then marks the state clean. Snapshot writes
occur after releasing the coordinator mutex, and a failed write is returned to
the shell as `persistence_degraded` rather than a false success.

## Running the shell

The frontend-only development server is:

```sh
CI=true pnpm --filter @devhub/app dev
```

The native Tauri development command is available through the app package:

```sh
CI=true pnpm --filter @devhub/app tauri dev
```

The production shell owns the EditorHost/provider boundary. A packaged build
uses the pinned OpenVSCode fallback when its resources are present; a local
macOS setup may select the separately installed official VS Code Web provider
as documented above. Workspaces, Agents, and persistent terminals still
require their respective runtime setup; do not substitute prototype behavior
for the production shell.

## CI, provenance, and release boundaries

`.github/workflows/ci.yml` is a committed non-release workflow definition. It
specifies the future hosted macOS verification recipe and is intentionally not
treated as evidence until a final-wave hosted run produces recorded results.
The local repository has no remote and should remain that way during product
implementation. Public repository publication, hosted OpenVSCode provenance,
signing, artifact upload, and release tags are separate final-wave actions.
