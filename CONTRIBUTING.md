# Contributing to DevHub

DevHub is being built as a local-first personal application. Changes should
preserve the domain model and the ownership seams in the design records before
adding convenience code around an existing implementation.

## Before changing code

Read [`README.md`](README.md) for the product shape.
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

Run focused commands while iterating, e.g. `CI=true pnpm --filter
@devhub/desktop test`.

`pnpm test:local` (`scripts/test-local.sh`) runs everything CI runs, on this
machine — Linux included: fmt, lint, the extension checks, every typecheck,
vitest, `test:pty` under Electron, the script tests, the VS Code overlay's
tests and the app smoke test (under `xvfb-run` on Linux, against a source run
since the app bundle is macOS-only). Its first stage provisions what the tests
need once (VS Code's `npm ci`, `vscode/out`, Electron, the desktop build;
about 6 GB) and is stamped, so later runs start straight at the checks. Name
stages to run only those (`scripts/test-local.sh --no-provision vitest pty`;
`--help` lists them). Under root the test stages run as an unprivileged
`devhub-test` user, so tests that rely on a permission being refused behave
as on CI. Iterate with it; push and let CI be the final check.

`pnpm run build` reuses the extension build and `node_modules.asar` when their
inputs are unchanged (see README, Development); if a result looks stale, delete
`vscode/.build/extensions.devhub-stamp` or `dist/.cache/asar`.

Types are checked with `tsgo` (pinned `@typescript/native-preview`); if its
result looks wrong, compare with `pnpm --filter @devhub/desktop run
typecheck:tsc` before changing code.

Do not claim hosted CI, macOS artifact generation, signing, or release status
from a local run. Hosted CI is `.github/workflows/ci.yml` (every push: the
checks above, split across Linux and macOS jobs, plus a test build of the app
and the tests that start it) and `.github/workflows/nightly.yml` (the product
build and its releases); [docs/ci.md](docs/ci.md) describes both.

## Change boundaries

Keep one coherent change per local commit and include its tests and design
record updates. Do not commit build output, Cargo targets, package-manager
stores, generated Tauri caches, or release artifacts.
