# Acceptance measurement method

## Reference environments

- Native interaction and performance reference: Apple M4 Pro MacBook Pro, 12 CPU cores, 24 GB memory, macOS 26.5.
- Minimum deployment environment: arm64 GitHub-hosted `macos-15` runner for compilation, tests, native Window and child-WebView automated smoke, bundle launch, OpenVSCode loopback smoke, and artifact inspection.
- Native WKWebView, IME, menu, Dock, and accessibility gates run on the reference Mac because headless CI is not equivalent evidence. macOS 15 still must pass automated native Window/WebView creation, navigation, hide/show, resize, and shutdown tests before the compatibility claim is published.

No serial number, hardware UUID, user name, or other machine identifier is stored in diagnostics or release evidence.

## Timing definitions

- Process-cold: DevHub and managed OpenVSCode processes are absent before measurement; OS filesystem cache is not artificially purged.
- Warm reconstruction: DevHub process or provider data already exists as specified by the scenario, but the main Window has been closed and reconstructed.
- Interactive: the target Surface accepts input and produces its local response, not merely when native chrome appears.
- Each timing scenario runs ten times after one untimed setup run. The stated budget applies to p95; raw samples and reference environment accompany the release record.
- Workspace Picker first-result timing uses the accepted default configuration and current personal source tree, with query input remaining responsive during the full scan.

## Scale and endurance

Eight open Workspaces imply eight Workspace Editor WebViews plus one Global Editor WebView, for nine total. Sixteen live Agents are distributed across at least four Workspaces. The test retains all nine Editor identities, hides at least five for ten minutes, and confirms load identity, Bridge connection, dirty state, and input after return.

Window reconstruction runs ten times and full Quit/relaunch five times while at least two Agents and two tmux Workspace sessions remain active. Provider crash tests independently kill only the managed OpenVSCode child, the Herdr connection/server path, and one owned tmux session, then verify isolation and recovery.

The tmux socket transition suite covers an absent target, wrong-marker conflict, marked-target conflict, preserved unknown sessions, partial old cleanup, crash/relaunch at every persisted transition state, and recreation failure after the new effective name commits. No test may mutate an unmarked session or report the old name effective after the new-name commit.

## Exact UI measurements

Sidebar default width is 248 points, minimum 200, maximum 400, persisted after resize. Below the minimum main-Window width, the Surface may shrink but Sidebar controls must not overlap or disappear. Status symbols retain accessible labels at every supported text zoom.

## File and security acceptance

- OpenVSCode token file is a regular file owned by the current user with mode `0600`.
- Config symlink tests prove that the link inode/path remains and the target is atomically replaced with permissions preserved.
- Runtime-state corruption tests retain the corrupt file for diagnostics, restore the backup when valid, and otherwise start Global Context safely.
- Loopback tests prove no listener on wildcard, LAN, or IPv6 wildcard addresses unless a later explicitly accepted design changes the boundary.
