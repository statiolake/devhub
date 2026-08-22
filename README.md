# DevHub

DevHub is a personal, macOS-first development workbench. Its long-term model
organizes Workspaces, Agents, Editors, and persistent tmux Terminals in one
native window while keeping provider implementations behind Rust-owned seams.

The repository is currently in the R1.1 foundation stage. The checked-in shell
is deliberately small: a Tauri App Shell owns the immutable native snapshot,
and a React consumer renders the fixed Activity chrome. Workspace discovery,
configuration, persistence, provider adapters, terminals, and OpenVSCode
surfaces arrive in later implementation waves described in
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md).

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

The Rust-owned shell snapshot crosses the Tauri seam through the canonical
fixture at [`contracts/shell-snapshot.v1.json`](contracts/shell-snapshot.v1.json),
which is consumed by both Rust and TypeScript tests.

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

DevHub is distributed under the [MIT License](LICENSE).
