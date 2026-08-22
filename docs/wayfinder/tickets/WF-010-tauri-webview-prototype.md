---
id: WF-010
title: Prototype Tauri child Workbench WebViews
status: closed
parent: WF-000
type: prototype
labels:
  - wayfinder:prototype
blocked_by:
  - WF-003
---

## Question

Can a Tauri/WRY macOS host manage multiple child WKWebViews with the lifecycle, layout, storage, focus, and keyboard boundary DevHub requires?

## Resolution

The throwaway prototype proved one shell plus two child WKWebViews, resize, hide/show persistence, and ordinary Command shortcuts on a test page. It did not prove real OpenVSCode Workbench behavior, Japanese IME, ten-minute hidden continuity, clean focus recovery, or trusted native double-Command+Q forwarding. The synthetic second Command+Q event is untrusted and cannot ship.

Evidence, exact commands, and non-claims remain in the local feasibility workspace and are intentionally excluded from the public foundation. The unproved items are mandatory Wave 0 gates rather than unresolved product decisions.
