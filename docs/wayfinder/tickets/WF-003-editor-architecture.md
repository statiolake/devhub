---
id: WF-003
title: Choose the Editor architecture
status: closed
parent: WF-000
type: grilling
labels:
  - wayfinder:grilling
blocked_by:
  - WF-002
---

## Question

How should DevHub host a real VS Code-class editor without making Workbench implementation details the product architecture?

## Resolution

Bundle a pinned, unmodified upstream OpenVSCode and Node runtime. One authenticated loopback server provides a stable origin. EditorHost owns process supervision, child WKWebViews, stable shared Editor data storage, Surface identity, focus, visibility, and recovery. A narrow bundled extension uses only public VS Code APIs to report readiness, identity, aggregate dirty state, and folder/new-window requests. Required interception failure blocks release and does not authorize an OpenVSCode fork.

The normative boundary is [MVP-SPEC.md](../../MVP-SPEC.md), [PROVIDER-CONTRACTS.md](../../PROVIDER-CONTRACTS.md), ADRs [0004](../../adr/0004-embed-upstream-openvscode-without-governing-workbench-features.md), [0013](../../adr/0013-run-one-authenticated-openvscode-origin.md), and [0014](../../adr/0014-use-a-narrow-openvscode-bridge.md).
