---
id: WF-001
title: Set the MVP destination and scope
status: closed
parent: WF-000
type: grilling
labels:
  - wayfinder:grilling
blocked_by: []
---

## Question

What exactly must the first DevHub product deliver, and which future capabilities must shape—but not enter—the MVP?

## Resolution

Deliver a locally installable, daily-usable macOS 15+ Apple Silicon application as version 0.1.0. It is a new product built in this directory, not a wrapper whose domain model is delegated to VS Code. The MVP includes Global and Workspace contexts, Editor/Agent/Terminal Activities, Scratch, Workspace discovery, persistent runtimes, native Settings, recovery, diagnostics, packaging, and a downloadable public release.

Future phases remain explicit architectural seams and do not inflate MVP acceptance. The complete scope boundary and release gate are normative in [MVP-SPEC.md](../../MVP-SPEC.md) and [IMPLEMENTATION-PLAN.md](../../IMPLEMENTATION-PLAN.md).
