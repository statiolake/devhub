---
id: WF-009
title: Authorize release and execution policy
status: closed
parent: WF-000
type: grilling
labels:
  - wayfinder:grilling
blocked_by:
  - WF-001
  - WF-007
  - WF-008
---

## Question

How should production work be divided, verified, and published, and what external mutations are authorized?

## Resolution

Production implementation and corrections are delegated to `gpt-5.6-luna` with `reasoning_effort=max`. The primary agent dispatches non-overlapping ownership lanes, reviews evidence, independently verifies, and returns corrections. Wave 0 proofs precede provider lanes; contract, persistence, integration, quality, and release barriers remain sequential where specified.

The user authorized Git initialization in this directory, a public `statiolake/devhub` repository, MIT License, pushing `main`, tagging and pushing `v0.1.0`, and publishing/downloading the GitHub Release only after every release gate passes.

The executable work graph is [IMPLEMENTATION-PLAN.md](../../IMPLEMENTATION-PLAN.md), with exclusive ownership and barriers in [IMPLEMENTATION-OWNERSHIP.md](../../IMPLEMENTATION-OWNERSHIP.md) and release evidence in [ACCEPTANCE-METHOD.md](../../ACCEPTANCE-METHOD.md).
