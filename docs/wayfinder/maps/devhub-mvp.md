---
id: WF-000
title: Make the DevHub MVP implementation-ready
status: closed
labels:
  - wayfinder:map
tracker: local-markdown
---

## Destination

A product and engineering handoff from which Luna Max implementation agents can build, verify, package, and publish the first usable macOS DevHub product without asking further product questions or silently changing its model.

## Notes

- Domain: macOS desktop developer workbench, embedded OpenVSCode, persistent Agent and terminal runtimes.
- Normative vocabulary starts at [CONTEXT.md](../../../CONTEXT.md).
- Normative product behavior is [MVP-SPEC.md](../../MVP-SPEC.md), with identity/lifecycle algorithms delegated to [IDENTITY-AND-LIFECYCLE.md](../../IDENTITY-AND-LIFECYCLE.md) and the complete user schema delegated to [CONFIGURATION.md](../../CONFIGURATION.md).
- Production work is delegated to `gpt-5.6-luna` with `reasoning_effort=max`; the primary agent orchestrates, reviews, and verifies.
- Wave 0 feasibility gates may block implementation or release, but they do not reopen settled product decisions.

## Decisions so far

- [Set the MVP destination and scope](../tickets/WF-001-mvp-destination-and-scope.md): ship a usable macOS-first Apple Silicon 0.1.0 while preserving explicit phase-two and phase-three seams.
- [Define the domain and navigation model](../tickets/WF-002-domain-and-navigation.md): separate Context, Activity, Surface, Workspace, Repository, and Agent with deterministic selection behavior.
- [Choose the Editor architecture](../tickets/WF-003-editor-architecture.md): embed unmodified upstream OpenVSCode behind an EditorHost and narrow public-API Bridge.
- [Separate Agent and terminal runtimes](../tickets/WF-004-runtime-and-lifecycle.md): Herdr owns Agents; a dedicated tmux server owns Scratch and Workspace terminals.
- [Define configuration and Workspace discovery](../tickets/WF-005-configuration-and-discovery.md): use one dotfile-friendly TOML, native Settings, and config-driven discovery without a registry.
- [Define identity, persistence, and recovery](../tickets/WF-006-identity-persistence-and-recovery.md): persist opaque identities and navigation while providers retain runtime lifetime.
- [Freeze provider and Bridge contracts](../tickets/WF-007-provider-and-bridge-contracts.md): hide providers behind deep ports and freeze the authenticated Bridge v1 schema before parallel consumers.
- [Set interface and quality standards](../tickets/WF-008-interface-and-quality.md): use the approved quiet fixed-light macOS UI with measurable accessibility, performance, and scale gates.
- [Authorize release and execution policy](../tickets/WF-009-release-and-execution.md): public MIT release is authorized only after hard gates; production changes go through Luna Max agents and ownership barriers.
- [Prototype Tauri child Workbench WebViews](../tickets/WF-010-tauri-webview-prototype.md): child WKWebViews, lifecycle, resize, and ordinary shortcuts are feasible; native Command+Q and real Workbench behavior remain Wave 0 proofs.
- [Prove the OpenVSCode Darwin arm64 build](../tickets/WF-011-openvscode-darwin-build.md): pinned upstream source builds and serves authenticated loopback content on Darwin arm64 without source changes.
- [Research Herdr and tmux integration](../tickets/WF-012-herdr-and-tmux-research.md): provider versions, ownership, reconciliation, cleanup, and external-attach boundaries are fixed.

## Not yet specified

None. The route to the destination is fully specified.

## Out of scope

- Second development: Issue and Pull Request Activities, GitHub URL resolution, clone/worktree provisioning, task composer, diff/changed-files Surfaces, and arbitrary Agent executables.
- Third development: SSH and dev-container execution, multiple Workbench Windows, Windows/Linux, certificate signing/notarization, and automatic updates.
- MVP exceptions: OpenVSCode fork, Workbench feature reimplementation, remote/cloud service, multi-user security boundary, Intel artifact, DMG, and first-run wizard.
