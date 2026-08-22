# Local development and verification

This document describes the checks that can be reproduced on a developer
machine. It does not replace the hosted macOS provenance and release gates in
the final implementation wave.

## Prerequisites

- macOS is the supported development host for R1.1.
- Rust `1.97.1`, including `rustfmt` and `clippy`, is selected by
  [`rust-toolchain.toml`](../rust-toolchain.toml).
- Node `22.21.1` is the pinned OpenVSCode/build baseline from
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

The shared shell fixture is
[`contracts/shell-snapshot.v1.json`](../contracts/shell-snapshot.v1.json).
Rust and TypeScript tests both read it so changes to field names, casing, or
native identity values fail at the seam.

## Running the shell

The frontend-only development server is:

```sh
CI=true pnpm --filter @devhub/app dev
```

The native Tauri development command is available through the app package:

```sh
CI=true pnpm --filter @devhub/app tauri dev
```

R1.1 does not yet bundle OpenVSCode, Workspaces, Agents, or persistent
terminals. Their provider adapters and runtime checks are introduced in later
waves; do not substitute prototype behavior for the production shell.

## CI, provenance, and release boundaries

`.github/workflows/ci.yml` is a committed non-release workflow definition. It
specifies the future hosted macOS verification recipe and is intentionally not
treated as evidence until a final-wave hosted run produces recorded results.
The local repository has no remote and should remain that way during product
implementation. Public repository publication, hosted OpenVSCode provenance,
signing, artifact upload, and release tags are separate final-wave actions.
