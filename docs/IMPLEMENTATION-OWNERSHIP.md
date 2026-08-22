# Implementation ownership and merge barriers

Production tasks use non-overlapping file ownership. Paths below are the intended scaffold contract; R1.1 creates them before parallel implementation.

| Owner task | Exclusive production paths |
| --- | --- |
| R1.1 Repository foundation | root manifests, lockfiles, toolchain files, `.github/workflows/ci.yml`, `src-tauri/tauri.conf.json` |
| R1.2 Domain contracts | `crates/devhub-app-core/src/domain.rs`, `crates/devhub-app-core/src/snapshot.rs`, and their core-crate re-exports in `crates/devhub-app-core/src/lib.rs` |
| R1.3 AppCoordinator and Bridge contracts | `crates/devhub-app-core/src/application/**`, `crates/devhub-app-core/src/ports/**`, `crates/devhub-app-core/src/bridge/**`, `crates/devhub-app-core/src/bin/generate_bridge_contract.rs`, `contracts/bridge/**`, `apps/devhub/src/generated/bridge/**`, `scripts/check-bridge-contract.sh`, `scripts/generate-bridge-contract.sh`, `docs/BRIDGE-PROTOCOL.md` |
| P2.1 ConfigStore | `crates/devhub-app-core/src/config/**`, configuration fixtures |
| P2.2 StateStore | `crates/devhub-app-core/src/state/**`, state fixtures |
| U2.3 App Shell | `src/app/**`, `src/components/shell/**`, `src/components/sidebar/**` |
| U2.4 Settings | `src/settings/**`, `src/components/settings/**` |
| U2.5 Visual foundation | `src/styles/**`, visual fixtures |
| D3.1 WorkspaceDiscovery | `src-tauri/src/discovery/**` |
| D3.2 Repository resolution | `src-tauri/src/repository/**` |
| T3.3 TerminalRuntime | `src-tauri/src/terminal/**`, `src/terminal/**` |
| E3.4 EditorHost | `src-tauri/src/editor/**`, host WRY patch package if gated |
| E3.5 Bridge | `extensions/devhub-bridge/**` |
| A3.6 AgentRuntime | `src-tauri/src/agent/**`, `src/agent/**` |
| I4.x integration | `src-tauri/src/integration/**`, task-specific integration tests only |
| I4.5 Diagnostics | `src-tauri/src/diagnostics/**`, `src/components/errors/**` |
| Q5.3 Brand | `assets/icon-master.svg`, `src-tauri/icons/**` |
| L6.1 Packaging | `.github/workflows/release.yml`, packaging scripts, notices |

`apps/devhub/src/generated/bridge/**` is generator-owned and never edited manually. Rust Bridge types generate the committed TypeScript bindings, JSON Schema, and fixtures in a deterministic check; consumers do not duplicate those contracts. Downstream E3.5 consumes this frozen generated contract and must not regenerate or hand-edit it.

## Merge barriers

1. F0.1–F0.5 evidence accepted before production provider lanes.
2. R1.2 domain snapshot and R1.3 port/intent interfaces, including the Bridge v1 schema and fixtures, accepted before Wave 2 branches.
3. Generated bindings committed and clean before frontend and provider consumers branch.
4. P2.1/P2.2 storage contracts accepted before integrated lifecycle work.
5. Provider contract tests accepted independently before I4 integration.
6. Integration state matrix accepted before quality and release work.

Only the current contract owner changes a shared interface. R1.3 owns the Bridge envelope, message catalogue, ordering, reconnect, acknowledgement, and error semantics; E3.4 and E3.5 only implement that frozen contract. A consumer requesting a change stops, reports the need, and waits for the owner or a sequential follow-up task; it does not patch shared files opportunistically.

P2.1 and P2.2 share a sequential integration owner for their core-crate exports,
`crates/devhub-app-core/src/ports/**`, `crates/devhub-app-core/Cargo.toml`, and
the workspace lockfile. Individual ConfigStore and StateStore lanes do not edit
those shared integration paths concurrently.
