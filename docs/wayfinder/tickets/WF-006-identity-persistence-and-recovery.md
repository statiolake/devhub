---
id: WF-006
title: Define identity, persistence, and recovery
status: closed
parent: WF-000
type: grilling
labels:
  - wayfinder:grilling
blocked_by:
  - WF-002
  - WF-004
  - WF-005
---

## Question

Which identities and UI state must DevHub persist, and how should unavailable roots, corrupt state, provider loss, and partial cleanup recover?

## Resolution

StateStore atomically persists schema-versioned Workspace IDs with selected/canonical paths, navigation, order, disclosure, Window/Sidebar geometry, Agent identities and temporary names, provider mappings, effective tmux socket and transitions, plus clean-shutdown metadata and a recoverable backup. Provider runtimes retain their own lifetime and content; live Agent projections are rebuilt from provider events rather than stored as provider truth.

Missing roots remain visible as Unavailable without changing Workspace ID. Provider failures are isolated. Cleanup uses clean/busy/unknown inspection, operation IDs, tombstones, recorded completed steps, deadlines, and idempotent Retry. Corrupt state restores backup or safely starts in Global Context.

The normative rules are [IDENTITY-AND-LIFECYCLE.md](../../IDENTITY-AND-LIFECYCLE.md) and ADRs [0009](../../adr/0009-restore-navigation-without-owning-runtime-lifetimes.md), [0012](../../adr/0012-keep-application-state-in-rust.md), and [0016](../../adr/0016-keep-diagnostics-local-and-content-free.md).
