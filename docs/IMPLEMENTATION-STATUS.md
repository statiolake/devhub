# DevHub implementation status

This file is the canonical local execution tracker. The Wayfinder map records
completed product decisions; this tracker records which implementation gates
have actually landed. Status changes require the checks named by the relevant
gate, not just source-code presence.

## Completed locally

| Gate | Result | Local commit or evidence |
| --- | --- | --- |
| OpenVSCode provenance preparation | Prepared; hosted run deferred | `d73e575` |
| R1.1 Repository foundation | Complete | `ad77d14`, `b026279` |
| R1.2 Domain contracts | Complete | `5b46e5e` |
| R1.3 Coordinator and Bridge contracts | Complete; current hardening complete | `CI=true pnpm run check` (generated checks, 128 core tests, 29 frontend tests, 6 native-shell tests) |
| P2.1 ConfigStore | Complete | `feat: add durable config and state` (this tracker revision) |
| P2.2 StateStore | Complete; hydration/native persistence integration complete | `CI=true pnpm run check` and concurrent temp-home/native lifecycle tests (this tracker revision) |
| U2.4 Settings Window | Complete | Rust-owned ConfigStore Settings projection, singleton window/menu, five sections (General, Workspaces, Agents, Runtimes, Appearance), strict generated contracts, targeted IPC, AppAppearance propagation, dev fixtures, and accessibility basics; `CI=true pnpm run check` (49 frontend tests, 133 core tests, 14 native tests), `CI=true pnpm run build`, and `CI=true pnpm --filter @devhub/app exec tauri build --debug --no-bundle` all pass (this tracker revision) |
| U2.5 Visual foundation | Complete | `CI=true pnpm run check`, deterministic visual fixtures, and production fixture-bundle scan (this tracker revision) |
| D3.1 WorkspaceDiscovery | Complete | Cancellable filesystem and command sources with deterministic traversal, source-local visited state, Git repository/worktree matching, canonical dedupe, fuzzy projection, bounded/redacted events, operation-scoped sequencing, and isolated diagnostics; `CI=true CARGO_NET_OFFLINE=true pnpm run check` (50 native tests, 133 core tests, 49 frontend tests), `CI=true CARGO_NET_OFFLINE=true pnpm run build`, `CI=true CARGO_NET_OFFLINE=true pnpm --filter @devhub/app exec tauri build --debug --no-bundle`, native clippy, and `git diff --check` pass (this tracker revision) |

P2.1 provides the versioned TOML model, defaults and strict validation,
comment-preserving conflict-safe writes, symlink-safe atomic replacement,
last-known-good reload behavior, runtime projections, redaction, and the
ConfigStore port. P2.2 provides schema-versioned runtime state, atomic and
backup recovery, quarantine, lifecycle restoration records, persisted tmux
socket transitions, redaction, and the StateStore port. Its current
integration hydrates the sole Rust AppCoordinator from canonical ConfigStore
and StateStore paths, serializes snapshot persistence without holding the
coordinator mutex over I/O, and preserves launch-time Agent profile metadata.
U2.4 projects that Rust-owned configuration through a strict Settings contract
and targeted Settings-webview IPC, with a native Settings window/menu,
AppAppearance propagation, deterministic development fixtures, and accessible
five-section navigation. TerminalRuntime inspection and tmux socket recreation
remain Wave 3 provider-deferred; this gate does not claim those operations are
complete.

## Partial gates

| Gate | Result | Remaining scope |
| --- | --- | --- |
| U2.3 App Shell | Partial | Native App Shell structure, navigation, immutable state/error handling, persistence, accessibility basics, and visual fixtures are complete. Context menus, confirmation sheets, and real provider surfaces remain for later integration waves. |

## Next

1. D3.2 Repository resolution: resolve Git common directories and normalized
   remotes without conflating Repository identity with Workspace identity.

The latest local validation also includes `CI=true pnpm run build` and
`CI=true pnpm --filter @devhub/app exec tauri build --debug --no-bundle`.

## Later waves

- Wave 3: D3.2 repository resolution, then T3.3 TerminalRuntime, E3.4
  EditorHost, E3.5 Bridge extension, and A3.6 AgentRuntime providers.
- Wave 4: workspace, agent, app lifecycle, keyboard, and diagnostics
  integration.
- Wave 5: accessibility/IME, performance/endurance, brand, security, and
  notices.
- Wave 6: packaging, public repository setup, and version `0.1.0` release.

The repository remains local-only with no Git remote. Hosted CI, hosted
OpenVSCode provenance, signing, publication, and release validation are
explicitly deferred to Wave 6 and are not implied by local green checks.

See [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) for gate definitions and
[IMPLEMENTATION-OWNERSHIP.md](IMPLEMENTATION-OWNERSHIP.md) for file ownership
and merge barriers.
