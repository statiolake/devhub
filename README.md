# DevHub

DevHub is a personal, macOS-first development workbench. Its long-term model
organizes Workspaces, Agents, Editors, and persistent tmux Terminals in one
native window while keeping provider implementations behind Rust-owned seams.

The repository has completed its contract foundation and the ConfigStore and
StateStore persistence gates. The checked-in shell remains deliberately small:
a Tauri App Shell owns the immutable native snapshot, and a React consumer
renders the fixed Activity chrome. UI and provider implementation continues in
the later waves described in
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md). Current local
execution status is tracked in
[`docs/IMPLEMENTATION-STATUS.md`](docs/IMPLEMENTATION-STATUS.md).

## Local development

The reproducible local toolchain is Rust `1.97.1`, Node `22.21.1` for the
documented build baseline, and pnpm `11.20.0`. The repository's
`rust-toolchain.toml` and root `package.json` pin the Rust and pnpm values;
Corepack or an equivalent pnpm installation must provide the pinned package
manager.

From the repository root:

```sh
CI=true pnpm install --frozen-lockfile
CI=true pnpm run check
CI=true pnpm run build
```

`check` runs frontend formatting, linting, type checking, unit tests, and
locked Rust checks. `build` creates the frontend output and performs a locked
workspace Cargo build. More detailed prerequisites, troubleshooting, and
manual smoke checks are in [`docs/LOCAL-DEVELOPMENT.md`](docs/LOCAL-DEVELOPMENT.md).

The Rust-owned App Shell v1 contract is generated from the native wire types:
[`contracts/app-shell/app-shell-v1.schema.json`](contracts/app-shell/app-shell-v1.schema.json).
Run `pnpm run app-shell:generate` after changing the Rust seam; `pnpm run check`
detects generated-artifact drift.

## CI and release status

The committed [CI definition](.github/workflows/ci.yml) is a non-release
verification recipe. It pins the macOS runner and toolchain versions and uses
frozen/locked local checks. Hosted Actions execution is intentionally deferred
until the final release wave; a checked-in workflow is not hosted evidence.

Git remains local-only during foundation and product implementation. No remote
or publication is required to build DevHub locally. Public repository setup,
hosted provenance, signing, packaging, and release upload are final-wave gates
and must not be inferred from a local green check.

## Design records

- [`CONTEXT.md`](CONTEXT.md) defines the domain vocabulary.
- [`docs/MVP-SPEC.md`](docs/MVP-SPEC.md) is the product contract.
- [`docs/PROVIDER-CONTRACTS.md`](docs/PROVIDER-CONTRACTS.md) freezes external
  provider and toolchain baselines.
- [`docs/IMPLEMENTATION-OWNERSHIP.md`](docs/IMPLEMENTATION-OWNERSHIP.md)
  assigns production seams and review gates.
- [`docs/IMPLEMENTATION-STATUS.md`](docs/IMPLEMENTATION-STATUS.md) records
  locally completed gates and the next implementation wave.

DevHub is distributed under the [MIT License](LICENSE).
