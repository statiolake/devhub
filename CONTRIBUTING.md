# Contributing to DevHub

DevHub is being built as a local-first personal application. Changes should
preserve the domain model and the ownership seams in the design records before
adding convenience code around an existing implementation.

## Before changing code

Read the relevant sections of [`CONTEXT.md`](CONTEXT.md) and
[`docs/MVP-SPEC.md`](docs/MVP-SPEC.md), and check [`docs/adr/`](docs/adr/) for
the decision a change would touch.
Rust owns application state and decisions; frontend code consumes immutable
snapshots and sends narrow intents through adapters. Provider details do not
cross into product-domain types.

## Local checks

Use the pinned pnpm version from `package.json` and run:

```sh
CI=true pnpm install --frozen-lockfile
CI=true pnpm run check
CI=true pnpm run build
git diff --check
```

Run focused commands while iterating with `CI=true pnpm --filter @devhub/app test`,
`cargo test --workspace --locked`, and `cargo clippy --workspace
--all-targets --all-features --locked -- -D warnings`.

Do not claim hosted CI, macOS artifact generation, signing, or release status
from a local run. The committed `.github/workflows/ci.yml` describes the
non-release hosted verification that will be run in the final wave; it is not
executed as part of local development. Public remotes and publication are
also final-wave actions and are intentionally absent during local work.

## Change boundaries

Keep one coherent change per local commit and include its tests and design
record updates. Do not commit build output, Cargo targets, package-manager
stores, generated Tauri caches, or release artifacts.
