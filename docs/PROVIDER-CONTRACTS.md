# Provider and dependency contracts

## Pinned development baseline

| Dependency | MVP baseline | Contract |
| --- | --- | --- |
| OpenVSCode Server | `openvscode-server-v1.109.5`, commit `4ffe2270acdf711bbefecc3e8c79f4b3631640e5` | bundled, unmodified upstream source |
| OpenVSCode build Node | `22.21.1` from the pinned `.nvmrc` | exact build runtime |
| Herdr | CLI `0.8.1`, protocol `20`; integration reference commit `5203a5dc0f39a082938ea0f9836d6257ea7e155f` | external runtime with capability check |
| tmux | minimum `3.3`, reference `3.7b` | external runtime with marker/capability smoke |
| Git | system/configured Git; reference `2.55.0` | external optional metadata provider |
| zsh | `/bin/zsh`; reference `5.9` | default login shell |
| Rust | `1.97.1` | exact value in `rust-toolchain.toml`; matches host prototype evidence |
| pnpm | `11.20.0` baseline | exact Corepack packageManager value |
| Tauri | `2.11.5` feasibility baseline | exact production pin after Wave 0 |
| WRY | `0.55.1` feasibility baseline | exact upstream or narrow host fork pin after Wave 0 |

F0.1 records the complete Darwin build command, lockfile hashes, produced bundle hash, Node binary provenance, and licenses before R1.1 begins. A different dependency version requires rerunning its affected feasibility gates, not an informal upgrade.

## OpenVSCode contract

The process must support host, stable port, connection-token file, server-data directory, extensions directory, telemetry disablement, folderless Workbench, and canonical folder Workbench URLs. Readiness requires an authenticated HTTP response and successful Workbench WebSocket, not merely an open TCP port.

DevHub stops only the child it launched after verifying process identity. A process listening on the persisted port without the expected token/readiness identity is a port conflict.

## Herdr contract

Startup requires CLI version `0.8.1`, protocol `20`, and the capabilities used by snapshot, subscriptions, workspace/tab/pane lifecycle, `agent.start` for `codex` and `claude`, and terminal session control. Protocol or missing-capability mismatch blocks mutations and disables Agent functionality with diagnostics.

`AgentRuntime` exposes only connect/feed, launch, attach Surface control, and idempotent terminate operations. It hides provider identities and owns subscribe-buffer-snapshot reconciliation, 50 ms invalidation coalescing, provider mappings, controller release, conditional takeover, natural-exit cleanup, and tombstone retry.

Profiles pass a supported kind and arguments. Profile environment is applied to the hidden provider workspace/tab shell environment. Arbitrary commands are rejected by schema version 1.

## tmux contract

Startup verifies version/capability, socket marker, and session metadata before mutation. A second DevHub launch focuses the existing app instance; it does not create a second independent owner. External `tmux -L <effective-name> attach` is supported and defaults to `tmux -L devhub attach`; Settings displays the effective name when a configured change is pending. External attachment never transfers ownership.

PTY clients attach, resize, and detach without killing sessions. DevHub uses normal tmux output and does not parse terminal content for product state.

## Release authorization

On 2026-08-22 the user explicitly approved creating public `statiolake/devhub`, applying the MIT License, pushing `main`, pushing tag `v0.1.0`, and publishing/downloading the GitHub Release. These actions are in scope for the final goal after all release gates pass. Failure of a gate does not authorize publication of an incomplete release.
