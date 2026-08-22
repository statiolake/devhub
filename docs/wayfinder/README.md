# Local Markdown tracker

This directory is the canonical local tracker for the completed DevHub MVP Wayfinder effort.

- One Markdown file is one issue; its frontmatter `id` is the issue identity.
- The file under `maps/` carrying `wayfinder:map` is the parent map.
- Child issues live under `tickets/` and name their parent by ID.
- `blocked_by` is the local fallback for native dependency edges.
- `status: open` plus an empty `assignee` is unclaimed. An open issue is on the frontier when every `blocked_by` issue is closed.
- Resolution lives only in the child ticket. The map contains a linked one-line gist.
- Assets are linked rather than copied into the tracker.

This map has no open decision tickets or remaining fog. Production execution is intentionally not represented as Wayfinder decision tickets; its ordered slices and merge barriers are normative in [IMPLEMENTATION-PLAN.md](../IMPLEMENTATION-PLAN.md) and [IMPLEMENTATION-OWNERSHIP.md](../IMPLEMENTATION-OWNERSHIP.md).
