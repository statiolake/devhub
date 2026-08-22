---
id: WF-008
title: Set interface and quality standards
status: closed
parent: WF-000
type: prototype
labels:
  - wayfinder:prototype
blocked_by:
  - WF-002
  - WF-003
---

## Question

What interaction, visual, accessibility, performance, scale, and native macOS quality bar defines a usable first product?

## Resolution

Use one main Workbench Window and singleton Settings Window, a 248-point resizable Sidebar, titlebar Activities, no redundant subtitle/status chrome, stable Workspace/Agent entries, and native macOS confirmation and focus behavior. The visual direction is English-only, fixed light, quiet, compact, and Zenbones-derived. Command+Q is an exact one-second prefix; double Command+Q forwards native Quit to the active Workbench Surface.

Release requires Japanese IME, VoiceOver, reduced motion, keyboard focus, nine Editor WebViews at scale, sixteen Agents, repeated lifecycle recovery, content-free diagnostics, and measured reference-machine budgets.

The accepted behavior and measurements are in [MVP-SPEC.md](../../MVP-SPEC.md), [ACCEPTANCE-METHOD.md](../../ACCEPTANCE-METHOD.md), ADRs [0010](../../adr/0010-use-one-workbench-window-and-one-settings-window.md), [0011](../../adr/0011-reserve-command-q-as-the-only-workbench-prefix.md), [0018](../../adr/0018-set-mvp-quality-budgets.md), [0019](../../adr/0019-use-a-zenbones-derived-product-palette.md), and the local interactive navigation prototype (not part of the public foundation).
