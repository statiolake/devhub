---
id: WF-004
title: Separate Agent and terminal runtimes
status: closed
parent: WF-000
type: grilling
labels:
  - wayfinder:grilling
blocked_by:
  - WF-002
---

## Question

Which provider owns each persistent runtime, and what survives Window Close, Quit, Workspace Close, and Agent exit?

## Resolution

Herdr executes and monitors Agents behind AgentRuntime; its panes and provider IDs never enter the public domain. A dedicated configurable/effective tmux socket owns the non-closeable Scratch session and one session per Workspace. VS Code Integrated Terminal remains upstream behavior and is not DevHub Terminal Activity.

Window Close destroys views but keeps the process and runtimes. Quit stops DevHub and OpenVSCode but leaves Agents and tmux sessions. Agent Stop terminates only that Agent and removes its entry. Workspace Close inspects and, after consolidated confirmation where required, terminates its Agents, tmux session, and Editor Surface using idempotent ordered cleanup.

The detailed lifecycle and socket transition machine are in [IDENTITY-AND-LIFECYCLE.md](../../IDENTITY-AND-LIFECYCLE.md), [PROVIDER-CONTRACTS.md](../../PROVIDER-CONTRACTS.md), and ADRs [0001](../../adr/0001-separate-agent-and-terminal-runtimes.md), [0003](../../adr/0003-hide-herdr-behind-agent-runtime.md), [0006](../../adr/0006-isolate-persistent-terminals-in-a-devhub-tmux-server.md), and [0015](../../adr/0015-confirm-only-resource-destruction.md).
