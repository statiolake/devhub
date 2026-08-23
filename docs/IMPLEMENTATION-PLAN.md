# DevHub MVP Implementation Plan

The completed decision map is [Make the DevHub MVP implementation-ready](wayfinder/maps/devhub-mvp.md). This plan is the normative execution graph produced by that map.

## Execution policy

Beginning with the next newly spawned implementation agent, all production
implementation and production-file corrections are delegated to subagents using
`gpt-5.6-luna` with `reasoning_effort=high`. Sol/root normally routes work,
aggregates audits, and waits; implementation agents own production edits. If
debugging stalls, the cause does not converge, or the same failure repeats, the
implementation agent must immediately send a `HELP:` request containing the
symptoms, latest failure, and hypotheses. Sol begins targeted diagnosis/design
assistance only after receiving that request and does not implement production
code.

The repository is developed local-first. Initial Git history, production builds,
and product verification run in the local checkout. Public repository creation,
hosted CI/CD validation (including the `macos-15` OpenVSCode provenance run),
tag, and release are final-wave activities; postponing them does not weaken any
technical requirement or release gate.

Normative handoff details are in `CONFIGURATION.md`, `IDENTITY-AND-LIFECYCLE.md`, `PROVIDER-CONTRACTS.md`, `IMPLEMENTATION-OWNERSHIP.md`, and `ACCEPTANCE-METHOD.md`. Implementers do not invent alternatives to those contracts.

Throwaway feasibility artifacts stay below `prototypes/` and are never promoted into production by copying structure blindly.

Each task must:

1. read `CONTEXT.md`, `docs/MVP-SPEC.md`, relevant ADRs, and owned module interfaces;
2. state its file ownership before editing;
3. write tests with the implementation;
4. run scoped formatting, lint, tests, and build checks;
5. report evidence, known limitations, and exact changed files;
6. receive primary-agent review before dependent work starts.

Parallel tasks may not share production-file ownership. Interface changes are reviewed and landed before consumers start.

## Wave 0 — feasibility gates

### F0.1 OpenVSCode Darwin arm64

Produce a reproducible build of one pinned upstream stable tag without source modifications. Verify artifact architecture, `--help`, authenticated loopback startup, folderless URL, folder URL, WebSocket connection, and shutdown. Document toolchain, licenses, build cache, and CI feasibility.

The local Apple Silicon feasibility and provenance preparation is the prerequisite
for production implementation. The hosted `macos-15` run is intentionally
deferred to Wave 6 and remains `PARTIAL` until that run completes; a local run
must not be described as hosted evidence.

### F0.2 Real Workbench host

Replace prototype pages with the pinned OpenVSCode build. Verify two child WKWebViews, shared stable origin/storage, separate Workspace identity, hide/show without reload, resize, focus, ten-minute hidden continuity, and hot exit.

### F0.3 Native keyboard and IME

Implement the minimal host key router. Prove trusted ordinary Command shortcuts, Japanese IME composition, and native double-`Command+Q` delivery. Keep any WRY patch minimal, pinned, documented, and covered by a host test harness.

### F0.4 Bridge feasibility

Package a minimal public-API Bridge extension. Prove readiness, identity, dirty state, folder request, new-window request, endpoint loss, and extension-host restart. Failure to intercept a required folder/new-window request blocks release; it does not authorize unsupported MVP behavior or Workbench changes.

### F0.5 Runtime feasibility

Against isolated `devhub-session` and dedicated configured tmux socket servers (default name `devhub`), verify Herdr bootstrap races, protocol mismatch, Codex/Claude profiles, exit latency and pane cleanup, controller detach/takeover, tmux external attach, recreation, and process inspection.

The local portion of Wave 0 is a hard gate: later production waves do not begin
around a failed local invariant. Hosted CI evidence is a final release gate and
is not required to continue local product implementation after local feasibility
preparation has passed.

## Wave 1 — repository and contracts

### R1.1 Repository foundation

Initialize Git; add MIT license, readme, contribution/build instructions, the accepted provider/dependency pins, pnpm workspace, Rust toolchain, Tauri/React skeleton, formatting/linting, unit-test runners, and local smoke checks. Do not create a remote, push, tag, release, or require hosted CI for this task.

### R1.2 Domain contracts

Implement opaque IDs, Workspace/Repository/Agent/Profile models, Navigation Context, Activities, Surface resolution, availability, runtime health, close inspection, error codes, and immutable `AppSnapshot`. Cover the full navigation matrix and Agent-exit fallback with pure tests.

### R1.3 Application coordinator contract

Define intent commands and provider ports. `AppCoordinator` is the only cross-module orchestrator. Freeze snapshot/event versioning and the complete Bridge v1 wire contract in `BRIDGE-PROTOCOL.md` before UI and adapter tasks branch. Contract fixtures generated from the Rust owner are the shared boundary consumed by EditorHost and the Bridge extension.

## Wave 2 — persistence and shell

### P2.1 ConfigStore

Implement the exact `CONFIGURATION.md` TOML schema, defaults, validation locations, comment-preserving edits, symlink-safe atomic writes, external watch/hot reload, last-known-good behavior, edit conflict detection, and executable-path restart semantics.

### P2.2 StateStore

Implement schema-versioned atomic state, backup recovery, clean-shutdown metadata, navigation/sidebar/window persistence, Workspace ID plus selected/canonical path records, the effective tmux socket name, persisted socket-transition state, and provider mappings, plus corruption tests. Cover crash/relaunch at every tmux transition state, target conflicts, unknown sessions, partial cleanup, and recreation retry.

### U2.3 App Shell

Implement one main Window, titlebar Activities, stable Sidebar, Surface viewport, focus model, context menus, loading/disabled/error states, and confirmation sheets against fake provider ports.

### U2.4 Settings Window

Implement the singleton General, Workspaces, Agents, Runtimes, and Appearance sections using ConfigStore intents and runtime health snapshots. Runtimes shows configured/resolved/effective values and the confirmed `Apply socket change…` flow when a tmux socket-name change is pending.

### U2.5 Visual foundation

Implement tokens, typography, spacing, focus, reduced motion, VoiceOver labels, and the approved responsive Sidebar behavior. Add deterministic visual fixtures for every navigation state.

The production KeyRouter timeout is exactly 1000 ms. The throwaway prototype's recorded 900 ms remains historical evidence and is not copied into production.

## Wave 3 — independent provider lanes

### D3.1 WorkspaceDiscovery

Implement cancellable streaming filesystem and command sources, exclusions, canonicalization, nested Git/worktree matching, deduplication, fuzzy projection, and source-isolated errors.

### D3.2 Repository resolution

Resolve Git common directory and normalized remotes asynchronously without turning Repository identity into Workspace identity.

### T3.3 TerminalRuntime

Implement the dedicated tmux server, deterministic verified sessions, Scratch, Workspace terminals, PTY/xterm framing, resize/detach, recreation, external attach compatibility, busy inspection, idempotent termination, target preflight, and the resumable old-socket cleanup/new-socket activation state machine.

### E3.4 EditorHost

Implement OpenVSCode token/data/port management, process supervision, child WebView lifecycle, stable data store, layout, origin/capability isolation, recovery, and host navigation handling using the Wave 0 proof.

### E3.5 Bridge extension

Implement and bundle the versioned Bridge protocol and dirty/open request integration. Keep all editor content and upstream feature control out of scope.

### A3.6 AgentRuntime

Implement Herdr bootstrap/health, profile validation, hidden provider mappings, subscribe-buffer-snapshot reconciliation, launch, terminal control, status projection, exit cleanup tombstones, conditional takeover, and idempotent termination.

## Wave 4 — integrated lifecycle

### I4.1 Workspace operations

Connect Workspace Picker, canonical uniqueness, open/focus, unavailable recovery, busy inspection, consolidated confirmation, ordered cleanup, partial failure, and fallback navigation.

### I4.2 Agent UX

Connect Profile selection, instance naming/rename, creation navigation, xterm Surface, accessible statuses, stop confirmation, natural exit, aggregation, and runtime degradation.

### I4.3 App lifecycle

Connect Window Close/reconstruction, Dock activation, Quit/relaunch, provider detach, OpenVSCode shutdown, exact navigation restoration, missing runtime reconciliation, and repeated lifecycle tests.

### I4.4 Keyboard routing

Land the proven native KeyRouter and menu policy. Verify main versus Settings Window behavior and every reserved/passed-through shortcut.

### I4.5 Diagnostics

Add content-free structured logging, rotation, local crash records, Error Surface details, runtime recheck, log-folder access, and redacted diagnostics copy.

## Wave 5 — product quality

### Q5.1 Accessibility and IME

Audit keyboard traversal, focus restoration, VoiceOver, text zoom, reduced motion, semantic status, UTF-8 paths, and Japanese IME across all Surfaces.

### Q5.2 Performance and endurance

Measure the agreed startup and switching budgets. Run eight-Workspace, sixteen-Agent, nine-Editor, ten-minute-hidden, lifecycle repetition, and independent-provider-crash matrices. Fix regressions at their owning module.

### Q5.3 Brand assets

Create and review one vector App Icon master, render every macOS size, verify 16 px legibility, generate ICNS, and validate bundle presentation.

### Q5.4 Security and notices

Audit loopback binding, tokens, file modes, WebView capabilities, logging redaction, navigation, downloads, dependencies, licenses, and bundled OpenVSCode/Node provenance.

## Wave 6 — release

### L6.1 Packaging

Produce the ad-hoc-signed Apple Silicon app, zip, checksum, notices, install instructions, clean-machine launch smoke, hosted F0.1 provenance run, and release workflow on `macos-15`.

### L6.2 Public repository

Create public `statiolake/devhub`, push reviewed `main`, and verify branch CI. Do not publish user config, tokens, runtime state, build caches, or prototype binaries.

### L6.3 Version 0.1.0

Create and push `v0.1.0`, wait for GitHub Actions, inspect logs and checksums, download the published artifact, install and launch it, execute the critical smoke path, and confirm the final Release URL.

## Critical smoke path

1. Launch from Applications into Global Scratch Terminal.
2. Open Workspace Picker and open a normal Git checkout.
3. Use Workspace Editor and normal OpenVSCode shortcuts.
4. Open Workspace Terminal, create tmux panes, and switch back without loss.
5. Create Codex and Claude Agents, interact, switch among Agent/Editor/Terminal, and observe status.
6. Close the main Window while work continues and reconstruct it from Dock.
7. Quit and relaunch; confirm Agents and tmux survived and navigation restored.
8. Stop one Agent and close one busy Workspace through confirmations.
9. Edit symlinked TOML externally and observe live configuration.
10. Exercise one runtime failure and recovery without losing unrelated Surfaces.

## Definition of done

- Every requirement in `docs/MVP-SPEC.md` is either covered by automated evidence or an explicit Apple Silicon release-gate record.
- All formatting, lint, unit, integration, bundle, and release workflows pass.
- No accepted invariant is implemented twice in conflicting layers.
- No provider identity leaks into product contracts.
- No production code was authored or corrected by the primary agent.
- The public `v0.1.0` artifact has been downloaded and smoke-tested after publication.
