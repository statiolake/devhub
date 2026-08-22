---
id: WF-007
title: Freeze provider and Bridge contracts
status: closed
parent: WF-000
type: grilling
labels:
  - wayfinder:grilling
blocked_by:
  - WF-003
  - WF-004
  - WF-006
---

## Question

What contracts let EditorHost, AgentRuntime, TerminalRuntime, and frontend consumers be implemented independently without leaking provider models or duplicating state decisions?

## Resolution

Rust owns product state and exposes immutable snapshots and intent commands through one AppCoordinator. Provider adapters remain deep modules. R1.3 owns and freezes shared snapshot/event types and the authenticated Bridge v1 envelope, payload catalogue, ordering, acknowledgement, reconnect, deduplication, and error semantics before EditorHost or Bridge consumers begin.

The contracts and freeze gate are normative in [PROVIDER-CONTRACTS.md](../../PROVIDER-CONTRACTS.md), [BRIDGE-PROTOCOL.md](../../BRIDGE-PROTOCOL.md), [IMPLEMENTATION-OWNERSHIP.md](../../IMPLEMENTATION-OWNERSHIP.md), and ADR [0012](../../adr/0012-keep-application-state-in-rust.md).
