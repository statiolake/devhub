---
id: WF-002
title: Define the domain and navigation model
status: closed
parent: WF-000
type: grilling
labels:
  - wayfinder:grilling
blocked_by:
  - WF-001
---

## Question

What are DevHub's stable domain concepts, ownership rules, and deterministic navigation transitions?

## Resolution

Context, Activity, and Surface are separate concepts. A Workspace is an open folder-root context with an opaque ID; canonical root prevents duplicates. Repository is optional remote identity and may span worktrees. Agent belongs to exactly one Workspace. Global owns folderless Editor and Scratch; each Workspace owns one Editor and tmux Terminal; Agent Surface is per Agent.

Selecting Scratch opens Global Terminal, selecting a Workspace opens its Editor, and selecting an Agent opens that Agent Surface. Editor and Terminal selected from Agent context resolve through the owning Workspace. Empty Agent children are absent rather than disabled.

The canonical vocabulary and full transition matrix are in [CONTEXT.md](../../../CONTEXT.md), [MVP-SPEC.md](../../MVP-SPEC.md), and ADRs [0002](../../adr/0002-separate-navigation-context-activity-and-surface.md) and [0008](../../adr/0008-keep-sidebar-order-stable.md).
