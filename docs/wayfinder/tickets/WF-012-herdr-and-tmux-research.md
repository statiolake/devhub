---
id: WF-012
title: Research Herdr and tmux integration
status: closed
parent: WF-000
type: research
labels:
  - wayfinder:research
blocked_by:
  - WF-004
---

## Question

Which Herdr and tmux versions, ownership semantics, reconnection behavior, cleanup rules, and external-attachment constraints must the production adapters honor?

## Resolution

Herdr CLI 0.8.1/protocol 20 and tmux 3.3+ are the accepted baselines. AgentRuntime hides Herdr provider IDs and implements subscribe-buffer-snapshot reconciliation, conditional takeover only without a live DevHub Surface, idempotent termination, natural-exit cleanup, and tombstone retry. TerminalRuntime uses a marked dedicated tmux server, verified deterministic session metadata, external attachment without ownership transfer, and a persisted safe socket-transition state machine.

The normative results are captured in [PROVIDER-CONTRACTS.md](../../PROVIDER-CONTRACTS.md), [IDENTITY-AND-LIFECYCLE.md](../../IDENTITY-AND-LIFECYCLE.md), and ADRs [0001](../../adr/0001-separate-agent-and-terminal-runtimes.md), [0003](../../adr/0003-hide-herdr-behind-agent-runtime.md), and [0006](../../adr/0006-isolate-persistent-terminals-in-a-devhub-tmux-server.md).
