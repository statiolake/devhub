---
id: WF-005
title: Define configuration and Workspace discovery
status: closed
parent: WF-000
type: grilling
labels:
  - wayfinder:grilling
blocked_by:
  - WF-001
  - WF-002
---

## Question

How should personal configuration, native Settings, Workspace discovery, runtime resolution, and dotfiles synchronization work?

## Resolution

`~/.config/devhub/config.toml` is the only user-authored product configuration and is safe to symlink from dotfiles. Native Settings is an equal editor of the same strict schema. Writes preserve the symlink, comments, ordering, permissions, and external-edit conflict semantics. Machine runtime state is separate under Application Support.

Workspace Picker streams config-driven filesystem and command sources, canonicalizes and deduplicates candidates, supports Git repositories/worktrees and arbitrary directories, and isolates source errors. There is no project registry or migration dependency on existing shell tooling.

The exact schema and application boundaries are normative in [CONFIGURATION.md](../../CONFIGURATION.md) and ADRs [0005](../../adr/0005-separate-user-config-from-runtime-state.md) and [0007](../../adr/0007-discover-workspaces-from-configured-sources.md).
