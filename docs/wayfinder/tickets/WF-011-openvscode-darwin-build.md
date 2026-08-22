---
id: WF-011
title: Prove the OpenVSCode Darwin arm64 build
status: closed
parent: WF-000
type: research
labels:
  - wayfinder:research
blocked_by:
  - WF-003
---

## Question

Can a pinned unmodified upstream OpenVSCode release be reproducibly built and launched for Darwin arm64 even though official releases do not publish a macOS asset?

## Resolution

Upstream `openvscode-server-v1.109.5` at commit `4ffe2270acdf711bbefecc3e8c79f4b3631640e5` builds without source changes using Node 22.21.1. The artifact contains arm64 Mach-O Node/native modules, runs `--help`, and passes an authenticated loopback smoke test. GitHub `macos-15` reproduction, app bundling, signing, and real GUI Workbench behavior remain implementation gates.

The public reproduction contract and content-free ledger are [F0.1 OpenVSCode Darwin arm64 provenance](../../F0.1-OPENVSCODE-PROVENANCE.md). Local prototype evidence is intentionally excluded from the public foundation.
