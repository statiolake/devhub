# Native DevHub for macOS — plan

Goal: a fully native macOS DevHub (Swift; AppKit + SwiftUI; **no TypeScript,
no JavaScript, no Electron, no web views for app UI**) with the same features
and the same level of polish as DevHub's **terminal mode**
(`[general] workbench = "terminal"`, `docs/terminal-mode.md`). macOS only.

This document is the contract for every agent working on `native/`:

1. [Scope](#1-scope) — what is in, what is out.
2. [Feature inventory](#2-feature-inventory) — every feature of terminal mode,
   with its TypeScript source and an acceptance criterion.
3. [Architecture](#3-architecture) — package layout, dependencies,
   concurrency, wire compatibility, testing.
4. [Work packages](#4-work-packages) — 12 packages sized for one agent each,
   with dependencies, parallelism, TS files to port, and acceptance tests.
5. [Conventions for agents](#5-conventions-for-agents).

All TS paths are relative to `apps/desktop/src/` unless they start with
`docs/`, `scripts/` or `extensions/`. Line counts are non-test lines.

---

## 1. Scope

### In scope

Everything DevHub does when `general.workbench = "terminal"`:

- the window, Sidebar (rows, rail, reorder, menus, tooltips, marks, usage
  limits), title bar with Back/Forward, splits and seams;
- the editor area as the Workspace's `ws-` tmux session drawn by DevHub's own
  terminal surface, and the managed Neovim per Workspace (msgpack-rpc) for
  file jumps;
- Workspaces (sources, picker, new project, clone, worktrees, Scratch, close
  flows), Agents (terminal Agents and GUI Agents with the full conversation
  UI), the per-Agent terminal;
- the `devhub` CLI and `devhub --tell`, Finder Open With, the `/devhub` skill;
- chords, command palette, chord help, notices and the notice center,
  Settings window and `settings.toml`, theme from VS Code theme files,
  repository status (git + `gh`), Issue assignment, usage limits, Smart
  Buttons and Agent actions, voice dictation, persistence, tmux runtime,
  logs, navigation history, Dock attention, idle notifications.
- SSH Workspaces **to the extent terminal mode supports them today**: the
  Workspace row exists, its editor area shows "Terminal mode does not support
  SSH Workspaces yet", file jumps to it are refused with the same sentence,
  and its Agents and Agent terminals run on the host's DevHub tmux. That last
  part is a separate late package (WP12) because it needs the SSH runtime.
- Dev container Workspaces: same "not supported yet" editor area. Agents do
  not run in containers in the TS app either (`docs/agent-gui.md`, "Dev
  Containers do not run Agents"), so nothing else is needed.

### Explicitly out of scope

Everything that exists only because of the VS Code workbench:

- the workbench itself, `WorkbenchView`, `workbenchLifecycle.ts` (plans,
  hibernation, awake cap, placeholders asleep/waking/restarting/gave up),
  `workbenchDialogs.ts`, `workbenchUnsaved.ts`, `workbenchManagedSettings.ts`,
  `editorSupervisor.ts`, `appFence.ts`, `browserWindowShim.ts`,
  `main/services/*`, `codeMain.ts`, `main.ts`'s VS Code bootstrap;
- DevHub Vim (`docs/vim.md`, `patches/vscode-overlay`), tidy, Copilot
  (`extensions/devhub-copilot`), the bridge extension, the remote extension
  host / REH (`extensions/devhub-remote`, `scripts/build_reh.py`), `init.ts`
  (`docs/init.md`, runs in the extension host), VS Code's menus/palette,
  integrated Browser, diff/review editors;
- `devhub --install-extension` / `--uninstall-extension` /
  `--list-extensions` (answer with a sentence: "not available in the native
  app", exit 2), `View ▸ Toggle Integrated Terminal`, "Reopen Editor in
  Container / Locally";
- dev-container provisioning (`main/runtime/container.ts`, `worktreeMount.ts`,
  `portForward.ts`, `buildLog.ts`, `containerMigration.ts`) — the TS app needs
  it only for workbenches;
- terraforming phases 2/3 of `docs/terminal-mode.md` (SSH/containers editor
  area) — design only in the TS app too.

`general.workbench`, `workbench_hibernate_minutes` and `workbench_awake_max`
are still **parsed and preserved** (the file is shared with the TS app); the
native app behaves as if `workbench = "terminal"` always, and Settings shows
the hibernation rows with the note "applies to VS Code mode" exactly as the
TS app does in terminal mode.

### Compatibility promise

The native app is a **drop-in replacement on the same profile**: same
`settings.toml` (format-preserving edits), same `state.json` (schema 12, read
and written compatibly), same tmux server (`tmux -L devhub`, same session
names and markers, same bootstrap), same control socket and JSON-line
protocol (`devhub` from either app talks to either app), same agent host
directories (`~/.devhub/agents-<tag>/<id>/`) and journal format, same Neovim
socket paths. Sessions left by one app are adopted by the other.

---

## 2. Feature inventory

IDs are stable; work packages refer to them. "AC" is the acceptance
criterion. Where the TS docs specify the behaviour in detail, the AC is
"matches §X" and the doc section is normative.

### 2.1 Window and layout

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| W-01 | One window; no title text, Sidebar is the drag handle; window close keeps the process, Agents and tmux running; reopen from Dock | `main/shell/shellWindow.ts`, `README.md` Lifecycle | Closing the window leaves `tmux -L devhub ls` unchanged; Dock click reopens it with the same selection |
| W-02 | Pure layout function: window size + arrangement → children (rect, visible, z-order: window page → Sidebar → editor terminals → Agents → Agent terminals → notices → questions → tooltip) | `main/shell/windowLayout.ts` (1019) | Ported as `WindowLayout.compute` in Core; the TS layout tests' cases pass as XCTests |
| W-03 | Arrangements: Workspace full (editor terminal), Split `Cmd+Q Z` (editor left, Agent right, ratio draggable, remembered), Agent alone (editor terminals stay attached, hidden) | `windowLayout.ts`, `docs/terminal-mode.md` table | All three render; split ratio persists across restart (`state.json`) |
| W-04 | Agent terminal placement: right of a full Agent (width share), under the Agent in a split (height share), never with the editor alone; shares clamped 0.15–0.85, default 0.4 | `model/agentTerminal.ts`, `windowLayout.ts` `terminalPlacement` | Matches `docs/window-and-pages.md` §"An Agent's terminal" |
| W-05 | Seams: draggable dividers editor/Agent and Agent/terminal (upright or level), live preview, commit on release (`resize_agent_terminal`, split ratio) | `shellWindow.ts`, `index.html` page seams | Drag moves both panes live at 60 fps; release persists |
| W-06 | Title bar `appearance.title_bar = "shown" | "hidden"` (read at launch): Back/Forward arrows + Sidebar toggle; hidden → drag strip only | `main/shell/shellTitle.ts`, `shell/components/shell/TitleBar.tsx` | Both modes; arrows disabled when nowhere to go |
| W-07 | Keyboard placement: one owner decides which child has keys (`keyboardChild`), re-placed when the answer changes; pointer selection hands keys to the surface, keyboard selection in the Sidebar stays | `shellWindow.placeKeyboardIn`, `docs/window-and-pages.md` §The keyboard | Clicking a row puts keys in the terminal; Return on a focused row keeps keys in the Sidebar |
| W-08 | "Not supported yet" editor area for SSH/dev-container Workspaces | `model/terminalMode.ts`, `main/shell/workbenchAbsence.ts` | Selecting such a Workspace shows the sentence; no terminal view is created |
| W-09 | Window states with no child to show (no Workspace yet, Scratch unavailable with Retry / Locate…) | `shell/AppShell.tsx`, `SurfaceState.tsx` | Scratch folder that cannot be made shows Retry and Locate… |
| W-10 | Dock attention: badge while any Agent is unread and not the selection; critical bounce while unfocused; cleared when looked at | `main/shell/windowAttention.ts` | Unit test of the rule in Core; manual check on macOS |
| W-11 | Idle notifications: working→idle/waiting, debounced, not when the Agent is on screen and the window focused; `general.notify_on_idle`, `notify_sound` | `main/shell/agentNotifications.ts` | Rule unit-tested; `UNUserNotificationCenter` notification shows Agent name + excerpt |
| W-12 | Restart DevHub (relaunch) command / menu | `main/shell/restartDevHub.ts` | Relaunch keeps tmux sessions; app comes back on the same selection |

### 2.2 Sidebar

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| S-01 | Rows: Scratch (fixed entry, "Scratch", folder in tooltip), Workspaces (git repositories with their worktrees grouped under them, plain folders), Agents nested under their Workspace; a Workspace with no Agents has no disclosure | `shell/components/sidebar/Sidebar.tsx`, `model/wire.ts` `drawnWorkspaceOrder`, `model/workspaceOrder.ts` | Same tree as the TS app for the same `state.json` + repos |
| S-02 | Rail (collapsed icon column) via title-bar button / `Cmd+Q B`; resize handle for the expanded width (persisted) | `Sidebar.tsx`, `sidebarRail.test.tsx` | Toggle animates; width persists |
| S-03 | Density `appearance.sidebar_density` | `model/config.ts` AppearanceConfig | Compact/comfortable row heights |
| S-04 | Drag reorder: repository among repositories (taking its worktrees), worktree within its group, Agent within its Workspace; same rule as `Alt+↑/↓` | `shell/components/sidebar/reorder.ts`, `useReorder.ts`, `model/workspaceOrder.ts` | A drop the rule forbids is not offered; order persists |
| S-05 | Keyboard in the Sidebar (`focus_sidebar`): ↑↓, Return selects without leaving, `Alt+↑/↓` moves the row, Escape back to surface | `sidebarKeyboard.test.tsx` | Same keys |
| S-06 | Row context menu (native NSMenu): Workspace — Close Workspace…/Close Worktree…; Agent — Rename…, Mark as Unread, Restart Session, Continue in GUI/terminal, Stop | `shell/components/sidebar/rowMenu.ts`, `main/shell/contextMenu.ts` | Items and enablement as `rowMenu.ts` (minus container items) |
| S-07 | Row tooltip (own panel, enterable, links to GitHub clickable, grace on leave, hidden on scroll/resize/blur/modal) | `shell/components/sidebar/RowTooltip.tsx`, `main/shell/tooltipView.ts`, `shell/tooltip/*` | Pointer can move into the tooltip and click a PR link |
| S-08 | Row facts/description: branch, Issue mark/label, PR mark (draft/open/merged/closed), checks badge, unresolved conversations, location glyph, editor attachment fact, unavailable text, Agent note | `shell/components/sidebar/rowDescription.ts` (684) | Facts identical to TS for the same inputs (port the tests) |
| S-09 | Status marks: unknown, idle, working (ring), waiting, background (four still arcs, quieter yellow), error; unread mark; Workspace activity mark from tmux pane activity (`terminal_idle_seconds`) | `StatusMark.tsx`, `status.ts`, `model/terminalActivity.ts`, `main/terminal/paneActivity.ts` | Marks animate like TS; Workspace row shows working while a non-shell program prints |
| S-10 | Chord digits on rows while the prefix is armed (`Cmd+Q 0…9`) | `chordDigits.test.tsx` | Digits appear after `Cmd+Q`, disappear after the second stroke |
| S-11 | Closing rows: "closing" state with step, close failure surface | `closingExit.ts`, `closingRow.test.tsx` | Row shows progress; failure shows reason + retry |
| S-12 | Usage limits at the foot: one row per CLI (bar of shortest window, %, reset time, strictest-window colour, caption), rail shows bars only, tooltip with every window, "No plan limits" | `UsageLimits.tsx`, `usageRow.ts`, `shell/resetTime.ts`, `shell/usageLevel.ts` | Matches `UsageLimits.tsx` header comment (done in WP11 (UI)) |
| S-13 | Prompt-cache facts on GUI Agent rows (cache keeper state) | `promptCacheFacts.ts` | Same facts |
| S-14 | Remote (SSH) Workspace row: host glyph, health | `remoteWorkspaceRow.test.tsx` | Row draws; health from runtime (WP12) |

### 2.3 Workspaces

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| WS-01 | Workspace = folder root; repository identity from `origin`; clone and each worktree are separate Workspaces | `model/domain.ts` (2350) `Workspace`, `Repository` | Domain types ported with invariants |
| WS-02 | Workspace sources (`[[workspace_sources]]`): filesystem (depth-bounded walk, kinds, hidden, excludes), command (timeout), date (template) | `model/config.ts`, `main/shell/workspacePicker.ts` (462) | Same candidates as TS for the same config |
| WS-03 | Workspace picker `Cmd+Q F`: streamed candidates, pool only grows, local fuzzy filter, "Other…" (NSOpenPanel), Return opens, Cmd+Return opens with an Agent (asks profile), fixed rows New Project / Clone | `shell/components/shell/WorkspacePicker.tsx`, `Picker.tsx`, `model/fuzzy.ts` | Typing never blanks the list; cancelled sources are killed (done in WP11) |
| WS-04 | New Project sheet (path under `projects.directory`) and Clone sheet (repo + destination), failures under the field | `ProjectSheets.tsx`, `main/shell/projects.ts`, `model/projects.ts`, `cloneDestination.ts` | Folder created / cloned and opened; "already exists" keeps sheet (done in WP11) |
| WS-05 | Worktrees: create worktree for a branch (`{repo}_{branch}` folders), list, remove | `model/worktrees.ts`, `main/shell/worktreeFolder.ts`, `main/shell/git.ts` | `git worktree add/remove` invoked as TS does |
| WS-06 | Close Workspace: one confirmation listing busy Agents, running terminal processes (non-shell panes incl. managed Neovim), Agent terminals; dirty worktree → three-way sheet (keep folder / delete anyway / cancel, Cancel default); clean worktree removed without asking | `shell/picker/CloseConfirmationSheet.tsx`, `WorktreeCloseSheet.tsx`, `domain.ts` `WorkspaceClose`, `CLOSE_STEPS` | Matches `docs/window-and-pages.md` §"A close asks once, then acts" (done in WP11 (UI)) |
| WS-07 | Close steps with deadlines (agents, terminals, editor = kill managed Neovim pane + unlink socket, worktree), failures down the one failure path | `appController.ts` close flow, `cleanupDeadline.ts` | A hung step fails with a notice, never hangs the row |
| WS-08 | Selection repair after removal (`repairSelection`): next row of what held it, else previous | `model/appModel.ts` | Port TS cases as tests |
| WS-09 | Scratch: `[scratch] daily` date template (`YYYY YY MM DD MMDD`, `[text]`), validation (`invalid_scratch_daily`), midnight rollover (timer re-aimed on wake), yesterday's stays as ordinary row, cannot close today's, folder created on demand, unavailable row with Retry/Locate… | `model/scratchDay.ts`, `model/dateTemplate.ts`, `main/shell/scratchDay.ts`, `README.md` §Scratch | All README rules covered by tests |
| WS-10 | `devhub <folder>` / Finder / Dock drop opens a Workspace and shows its editor terminal | `main/cli/route.ts`, `main/shell/openFromFinder.ts` | See E-07 |
| WS-11 | Editor terminal per Workspace: the `ws-<digest20>` session attached on surface key `workspace-terminal:<id>`, view made on first show and kept hidden+attached until the Workspace goes | `docs/terminal-mode.md` §"What changes in the window", `ShellWindow.syncEditorTerminalViews` | Switching back is instant (no reattach/reflow) |
| WS-12 | The editor area's shell exiting is the close button: a `ws-` client that ended by itself (`AttachmentManager.onEndedByItself`, never DevHub's own detach) runs the one close flow (its sheet when something blocks); cancelled, failed or Scratch → the terminal starts over in place; a plain detach reattaches; at most 3 restarts in 30 s, then Retry | `main/shell/editorTerminalExits.ts`, `docs/terminal-mode.md` §"The shell exiting is the close button" | `EditorTerminalExitsTests` (done: `Shell/EditorTerminalExits.swift`, `TerminalSurfaces.sessionExists`, `Coordinator.closeUnderway`, `ShellController`) |

### 2.4 Terminal surfaces and tmux runtime

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| T-01 | DevHub's tmux server `-L <tmuxSocketName>`, bootstrap via one-shot config, `scratch` anchor session with marker, user `tmux.conf` sourced (missing/broken config said once), `runtimes.tmux_args` | `main/terminal/tmux.ts` (4219) | Starts/adopts the same server as the TS app |
| T-02 | Session markers (`@devhub-*` options, `DEVHUB_ORIGIN` env), contexts (workspace, agent, terminal), `isMarked`, startup sweep of unaccounted sessions | `tmux.ts`, `main/shell/sessionSweep.ts` | Sweep reaps exactly what TS reaps (fixture-based tests) |
| T-03 | Session names: `ws-<sha256(root)[0:20]>` (32 also recognised), `ag-<agentId>`, `tm-<terminalId>` | `tmux.ts`, `model/agentTerminal.ts` | `TmuxNames` tests (done in WP0) |
| T-04 | Terminal surface: SwiftTerm view running `tmux attach-session` on a PTY; resize → tmux client size; byte-exact input; scrollback via tmux | `main/terminal/{pty,attachments,service,surfaces}.ts`, `shell/surfaces/xtermSession.ts`, `shell/terminal/TerminalSurface.tsx` | vim, htop, tmux copy-mode work; resize reflows |
| T-05 | IME (Japanese input inline, candidate window at cursor), input-source handling for chords | `shell/accessibility/ime.ts`, `main/shell/chordInputSource.ts`, `main/native/inputSource.c` | Kotoeri composition works in terminal and composer; chord prefix works with a Japanese input source active |
| T-06 | Font family/size/line height/margin/scroll sensitivity from `[appearance]`; zoom `Cmd+-`, `Cmd+Shift+-`, `Cmd+Shift+0` (physical keys, only over Agent/terminal panes; offset 9–24 stored in state `terminal.zoom_offset`) | `model/terminalZoom.ts`, `main/shell/terminalZoom.ts`, `model/fontFamily.ts` | Zoom persists across restart; editing the setting moves the zoomed size |
| T-07 | Terminal palette: theme's `terminal.*` + 16 ANSI (editor bg fallback) or `[appearance.terminal_theme.light/dark]` palettes | `model/terminalPalettes.ts`, `shell/terminal/theme.ts` | Colours equal TS's for Dark 2026 / Light 2026 |
| T-08 | Reconnect once on hidden→shown when disconnected; error + Retry otherwise | `docs/window-and-pages.md`, `TerminalSurface.tsx` | Kill the tmux client → showing the pane reconnects once |
| T-09 | Links in terminal output (URLs, `file:line`) open externally / in managed Neovim | `main/shell/externalLinks.ts`, `terminalWiring.ts` | Cmd+click a URL opens browser |
| T-10 | Clipboard (OSC 52 via `@xterm/addon-clipboard` equivalent), copy on select per tmux | `shell/terminal/surfaceBridge.ts` | OSC 52 from tmux sets the pasteboard |
| T-11 | Pane activity loop: once a second list panes, compute working/unread per Workspace and Agent terminal, close `tm-` terminals whose session went | `main/shell/terminalActivityLoop.ts`, `main/terminal/paneActivity.ts`, `tmux.parsePaneActivity` | Port parse tests; one `tmux list-panes -a` per second max |
| T-12 | Login environment import (`general.import_login_environment`), PATH lookup for `runtimes.*` (shell, git, tmux), health in Settings | `main/shell/loginEnvironment.ts` (478), `main/shell/runtimes.ts`, `terminalRuntimes.ts` | Launch from Finder finds Homebrew `tmux`/`nvim` |
| T-13 | `devhub-terminal` helper semantics needed by tmux bootstrap (if any is still referenced by sessions) | `main/terminal/devhubTerminal*.ts`, `launcher.ts`, `command.ts` | Native equivalent is a Swift executable or the CLI subcommand; sessions created by TS still work |

### 2.5 Managed Neovim and file opening

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| E-01 | msgpack encoder/decoder (all types used by Neovim, ext types for Buffer/Window/Tabpage) | `main/editor/msgpack.ts` (388) | Round-trip tests incl. TS's vectors |
| E-02 | msgpack-rpc client over unix socket: requests/responses/notifications, one long-lived connection = death detector | `main/editor/neovimRpc.ts` | Test against a fake server; on macOS CI against real `nvim --headless --listen` if available |
| E-03 | One managed Neovim per Workspace in a **new tmux window** of the `ws-` session (`new-window -P -F '#{pane_id}' -c <root> -- nvim --listen <sock>`), later jumps `select-window` + `select-pane` | `main/editor/managedNeovim.ts` (467), `tmux.editorWindowArgs`, `activatePaneArgs` | §"Where it runs" |
| E-04 | Socket `<userData>/devhub/nvim/<sha256(wsId)[0:12]>.sock`, dir 0700, `sun_path` (104) fallback to `$TMPDIR/devhub-nvim-<uid>/`, too long = failure that says so | `managedNeovim.ts` | §"The socket" |
| E-05 | Open: `nvim_get_mode` (Esc once if blocked), `nvim_exec_lua` drop/edit, cursor clamp, `zv`, `zz`; selection end → cursor at start | `managedNeovim.ts` | §"RPC" |
| E-06 | Lifecycle: alive / adopt via `$TMUX_PANE` after restart / dead-or-stale (drop, unlink, delete wait markers, start new); start waits bounded, "Neovim exited before it opened its socket"; close Workspace kills pane + unlinks; quit only closes RPC | `managedNeovim.ts` | §"Lifecycle", each case tested with a fake |
| E-07 | Routing (`routeOpen`, `routeAgentOpen`): nearest-ancestor open Workspace, else today's Scratch; conversation link → split beside the Agent, editor terminal in front; SSH/container → refused sentence | `main/cli/route.ts`, `resolve.ts`, `canonical.ts`, `openFiles.ts`, `AppController.openRouted` | Table in `docs/terminal-mode.md` §File-open routing |
| E-08 | `--wait`: buffer autocommands delete marker; DevHub deletes markers on server death; `EDITOR="devhub --wait"` works with `git commit` | `managedNeovim.ts`, `main/cli/wait.ts`, `waitReturn.ts` | `git commit` returns after `:bd` / `:q` |
| E-09 | `nvim` binary from login PATH, missing → notice naming `nvim` and dirs searched | `managedNeovim.ts`, `runtimes.ts` | Notice text as TS |
| E-10 | Finder Open With / Dock drop / `open -a DevHub <path>` → same as `devhub <path>` | `main/shell/openFromFinder.ts` | `application(_:open:)` routes; Info.plist declares types (done in WP0) |

### 2.6 `devhub` CLI and control socket

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| C-01 | Control socket `<userData>/devhub/control.sock` (0600 in 0700 dir), stale socket taken over, second instance refused ("another DevHub is already listening…"), one JSON object per line request→response | `main/cli/controlServer.ts` (489), `protocol.ts` (721) | TS CLI works against the native app and vice versa |
| C-02 | Requests: `ping`, `activate`, `open` (paths, goto, wait, stdin, cwd, origin), `wait-ended`, `version`, `metrics`, `tell`, `add-agent`, `install-cli`, `resolve-remote`, `terminal-profile`; extension/devcontainer kinds answered "not available in the native app" | `protocol.ts` | Each kind has a Codable type and a round-trip test with JSON captured from TS |
| C-03 | CLI front end: `devhub`, `<folder>`, `<file>`, `-`, `-w/--wait`, `-g/--goto file:line[:col]`, `--agent <profile> [-- args]`, `--version`, unknown option refused with a sentence; app not running → launch it (`open -b`) and retry | `main/cli/devhubCli.ts` (762), `launch.ts`, `goto.ts`, `stdin.ts`, `wait.ts`, `install.ts` | Same exit codes and messages as TS (port `devhubCli` tests) |
| C-04 | `--tell` parser: help, workspaces, workspace open [--worktree], agents [--workspace], agent new/read/send/interrupt/requests/answer/wait, issue assign, commands, run, focus, notify, terminal open/status/show/close/panes/bring; `--json` | `main/cli/tell/command.ts` (756) | Port `command.test.ts` |
| C-05 | `--tell` service against the model: text and JSON output identical to TS; permission prompts not answerable; answer note "answered via devhub CLI by <agent>"; an agent cannot answer itself; palette commands that ask first still ask | `main/cli/tell/service.ts` (1310) | Port `service.test.ts` |
| C-06 | `terminal panes` (session, window, `%N`, command, `ps` foreground line, cwd, title, active) and `terminal bring %N [--focus]` (`join-pane`, only own Workspace's `ws-` panes; emptied window/session closes) | `tell/service.ts`, `tmux.parseWorkspacePanes` | §"For an Agent" in `docs/window-and-pages.md` |
| C-07 | Install 'devhub' command in PATH (symlink/launcher to `DevHub.app/Contents/Resources/bin/devhub`, profile-named) | `main/cli/install.ts`, `devhubCliEntry.ts` | Palette command installs; `devhub --version` works from a new shell |
| C-08 | `/devhub` skill: written on every start into `<userData>/devhub/agent-skill/` with `bin/devhub` launcher; Claude launched with `--add-dir`; Codex GUI `developerInstructions` | `main/agent/devhubSkill.ts` (285) | Skill text byte-identical to TS's template |

### 2.7 Agents (common, terminal Agents)

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| A-01 | Agent profiles `[[agent_profiles]]` (codex/claude/cursor/custom, command, args, env, presentation), defaults | `model/config.ts`, `domain.ts` `AgentProfile`, `model/claudeDefaults.ts` | Same validation diagnostics |
| A-02 | New Agent sheet `Cmd+Q C`: rows New <Profile> Session + earlier Claude/Codex sessions in the folder (titles, branch, preview), GUI/TUI tag, ⌘ flips, ⌥ opens beside editor, typing filters, sessions read async | `shell/picker/AgentPickerSheet.tsx`, `SessionPicker.tsx`, `sessionRows.tsx`, `main/agent/conversation/resume.ts` | Matches `docs/agent-gui.md` §Resuming (done in WP11 (UI)) |
| A-03 | Terminal Agent = tmux session `ag-<id>` running the CLI, attached by the same surface | `main/agent/sessions.ts`, `main/shell/agentWiring.ts` (1027) | TS-started Agents adopted after switching apps |
| A-04 | Screen detection of status for terminal Agents (Claude, Codex, Cursor manifests + rules, screen freshness) | `main/agent/detect/*` (1063), `screenFreshness.ts`, `activity.ts` | Port screen fixtures tests (`claudeScreens`, `codexScreens`, `cursorScreens`) |
| A-05 | Unread: raised on leaving working, cleared when looked at; `Cmd+Q U` marks unread | `domain.ts`, `appModel.ts` | Rule tests |
| A-06 | Rename `Cmd+Q ,` (sheet), Stop / close `Cmd+Q X` (asks when not idle; always asks when its terminal is open: Move terminal to editor / Stop and close) | `AgentRenameSheet.tsx`, `domain.ts`, `agentReconciler.ts` | §"Stopping an Agent with its terminal open" (done in WP11 (rename sheet)) |
| A-07 | Restart Session `Cmd+Q Shift+R` with resume (Claude `--resume`, Codex `resume <id>`), `withSession` argv composition | `domain.ts` `agentRestart`, `resume.ts` `withSession`, `agentProfileCommand.ts` | Argv equal to TS for each case |
| A-08 | Continue in GUI (terminal Claude/Codex → GUI Agent on same session) and Continue in terminal (mirror) | `docs/agent-gui.md` §Continue, `agentContinuation` | Session continues; old Agent stopped after confirmation if busy |
| A-09 | Agent failure surface (exit code, end of `err`, Retry) | `main/shell/agentFailure.ts`, `shell/agents/AgentFailure.tsx` | Same notice text |
| A-10 | Injection queue: wording sent when the CLI is at a prompt, review sheet (confirm_before_send), cancelled recorded | `main/agent/injection.ts` (318), `InjectionReviewSheet.tsx`, `InjectionStatus.tsx` | Port injection tests (done in WP11 (review sheet)) |
| A-11 | Agent actions `[agent_actions.<trigger>.<id>]`, `Cmd+Q A` sheet, templates with variables | `model/agentActions.ts` (463), `AgentActionsSheet.tsx` | Same built-ins, same template expansion (done in WP11 (sheet)) |
| A-12 | Smart Buttons (commit, push, pull_request, draft_pull_request, unresolved_review_comments, ci_failing, always): shown while idle and condition holds; draggable stack with snap (16px) and remembered position; automatic actions bolt (commit, push, review, CI), once per event | `model/smartButtons.ts` (322), `model/automaticActions.ts`, `shell/agents/SmartButtons.tsx` | README §"Agent actions and Smart Buttons" |
| A-13 | Agent terminal `Cmd+Q V` (`tm-<id>` session in the Workspace folder): start/hide/show, `terminal_needs_agent` / `_view` notices, ends with its session, closed with its Agent, persisted (`terminal`, `terminal_share`, `terminal_stacked_share`), legacy `pane_layout` read | `model/agentTerminal.ts`, `docs/window-and-pages.md` | All rules of that section |
| A-14 | Move Agent terminal to the editor (`move-window` into `ws-` session) | `confirm_stop_agent` `moveTerminal` | Processes keep running in the editor terminal |

### 2.8 GUI Agents: conversation protocol (Core)

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| G-01 | Host script (POSIX sh) in the tmux session: FIFO `in`, journal `out`, `err`, `exit`, `cli` pid, `again`/`again.mark` restart, `version`; dirs `~/.devhub/agents-<profile tag>/<id>/` | `main/agent/conversation/hostScript.ts`, `hostCommand.ts` | Script byte-identical (shared with TS); TS-started GUI Agents adopted |
| G-02 | Journal follower (`tail` from offset), `in.log` replay on restart (no double send, open requests stay open) | `hostLink.ts` (546), `reading.ts` | Replaying fixture journals yields TS's transcript |
| G-03 | Normalized conversation model and the one fold (`applyEvent`) | `model/conversation.ts` (1684) | Port all `conversation` fold tests |
| G-04 | Claude adapter: argv (`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --forward-subagent-text --replay-user-messages --permission-prompt-tool stdio`), `initialize`, decode of every message kind, control requests (interrupt, set model/effort/permission mode, stop_task, mcp status/actions, get_usage), permissions, AskUserQuestion, priority `next` send-now, prompt cache facts | `claude/{adapter,decode,argv,defaults,promptCache}.ts` (5293) | Port adapter tests over `fixtures/*.ndjson` |
| G-05 | Codex adapter: `app-server` JSON-RPC (`initialize`, `initialized`, `account/read`, `thread/start|resume`, `model/list`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/revert`, approvals, requestUserInput, subagent threads, rate limits), vendored protocol types (Apache-2.0 notice kept) | `codex/{adapter,decode,argv}.ts` (8483), `codex/protocol/*` (59 files) | Port adapter tests over `codex/fixtures` |
| G-06 | Status from conversation (connecting→unknown, broken/failed→error, request→waiting, turn→working, held message→waiting, background, idle) | `docs/agent-gui.md` table, `registry.ts` | Table-driven test |
| G-07 | Queued messages: held while busy, edit/remove/send-now (Codex `turn/steer`, Claude `priority: "next"`); unsent draft persisted | `drafts.ts`, §"Messages that wait" | Drafts survive restart |
| G-08 | Rewind to before any user message (Codex `thread/revert`; Claude restart with `--resume-session-at` via `again`) | `resume.ts`, `rewind.test.ts` | Port rewind tests |
| G-09 | Resume an earlier session: listing (Codex `thread/list` on a short-lived app-server; Claude JSONL under `~/.claude/projects`), `/resume` inside a GUI Agent | `resume.ts` (1417) | Port resume tests; `/resume` asks on the questions layer's one session picker (`ModalPresenting.presentSessionPicker` → `SheetFlows.sessionPicker`) |
| G-10 | Restart Session; Asleep after compaction before cache expiry; cache keeper (auto compact `auto_compact_before_cache_expiry`, lead seconds, min tokens) and idle CLI stop | `restartSession`, `cacheKeeper.ts`, `docs/agent-gui.md` §Restarting | Port cacheKeeper tests |
| G-11 | Usage-limit resume (`resume_after_limit`, message), Claude `rate_limit`, Codex `usageLimitExceeded` | `limitResume.ts` | Port limitResume tests |
| G-12 | Elicitation forms (MCP), MCP panel data (status, actions, `mcp login` sign-in with browser redirect) | `elicitation.ts`, `mcpSignIn.ts`, `model/elicitationForm.ts` | Port tests |
| G-13 | Failures (not signed in → Continue in terminal; protocol mismatch; unknown event notice) | `failures.ts`, §"How a failure is shown" | Same texts |
| G-14 | Path links and issue/PR references detection (only existing files; `owner/repo#N`, bare `#N` resolved by Workspace repo) | `pathLinks.ts`, `shell/conversation/{textLinks,issueLinks,pathLinks}` | Port tests |
| G-15 | Tool titles | `toolTitle.ts` | Port tests |
| G-16 | Background tasks list + stop (`stop_task`; Codex `turn/interrupt`), durations from CLI timestamps | §Background tasks | Same stoppable rules/tooltips |
| G-17 | Subagents (cards under the starting call, pane column, maximize, message a Codex subagent) | `shell/conversation/{SubagentMessage,SubagentPanes,subagentColumn}.tsx` | §Subagents, §Messaging a subagent |
| G-18 | Agent records persisted for GUI Agents | `agentRecords.ts` | Round-trip with TS-written state |

### 2.9 GUI Agents: conversation UI (App)

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| U-01 | Transcript: user/assistant entries, streaming, follow-scroll (stick to bottom unless scrolled up), fresh-entry marks, type one step larger than terminal font | `ConversationSurface.tsx`, `EntryView.tsx`, `EntryParts.tsx`, `followScroll.ts`, `freshEntries.ts`, `entryTree.ts` | 10k-entry transcript scrolls smoothly; text selectable across lines and copyable |
| U-02 | Markdown (GFM: headings, lists, tables, task lists, code fences, block quotes, links), math (`$…$`, `$$…$$`) | `Markdown.tsx`, `markdownBlocks.ts`, `mathDelimiters.ts` | Fixture transcripts render equivalently |
| U-03 | Code blocks with syntax highlighting coloured by the theme's tokenColors, copy button | `CodeBlock.tsx`, `highlight.ts` (shiki), `CopyButton.tsx` | Common languages highlighted; copy works |
| U-04 | Tool call rows: state glyph (spinner/done/failed/denied), title, readable view (diff for edits, command output + stderr, saved-output files, images, plan checklist), folded input/output, `Clip` for long views | `EntryParts.tsx`, `Clip.tsx`, `activity.ts` | All kinds in `transcriptFixtures.ts` render |
| U-05 | Diffs (unified, line numbers, add/remove colouring) | `EntryParts.tsx` diff | Edit/MultiEdit/Write/Codex file changes show diffs |
| U-06 | Permission request cards (allow/deny/always as the CLI offers) and question cards (AskUserQuestion / requestUserInput with options, previews, free text), answered state | `RequestCard.tsx`, `elicitationForm.ts` | Keyboard-operable; answered cards read back |
| U-07 | Composer: multi-line, Return sends / Shift+Return newline (keys per §Keys), queued messages list with edit/remove/send now, unsent draft, interrupt (Esc), images by paste/drop with thumbnails | `Composer.tsx`, `messageKeys.ts` | §"Messages that wait", §Images |
| U-08 | Slash command completion and skill tokens | `commandCompletion.ts`, `skillTokens.tsx` | Completion list from CLI's commands |
| U-09 | Model / Effort / Permissions pickers under the composer; Make default (Default mark, ⌥↩) for Claude Code (`~/.claude/settings.json`) and Codex (`$CODEX_HOME/config.toml`, `model` / `model_reasoning_effort`, in `[profiles.<name>]` when a profile is selected, edited in place), with the shadow notice when an argument or a higher layer decides | `SettingPickers.tsx`, `model/{cliDefaults,claudeDefaults,codexDefaults}.ts` | Changes sent as control requests; `CodexDefaultsTests` (done: `SettingPickerModel`, `CodexDefaults.swift`, `CliSettingsFile.swift`) |
| U-10 | Context usage line, background tasks line + list with stop confirmation | `ContextUsage.tsx`, `BackgroundTasks.tsx` | §Context, §Background tasks |
| U-11 | Find in transcript `Cmd+F`: bar with count, Aa, ↑↓, F3/Shift+F3, starts at last match, incremental sliced search, opens folds | `FindBar.tsx`, `findInTranscript.ts`, `transcriptSearch.ts`, `findHighlights.ts` | §Find; million-match query stays responsive |
| U-12 | MCP panel (`/mcp`) | `McpPanel.tsx` | §MCP servers |
| U-13 | Rewind UI (confirm under the message), Continue in terminal button, activity line, status mark | `ActivityLine.tsx`, `StatusMark.tsx` | §Rewinding |
| U-14 | Links in transcript: paths → managed Neovim (E-07), issues/PRs → browser, hover title | `LinkedText.tsx`, `pathLinks.tsx`, `issueLinks.tsx` | Click opens the right target |
| U-15 | Smart Buttons overlay on composer / terminal Agent corner | `SmartButtons.tsx` | See A-12 |
| U-16 | Voice dictation `⌘⇧M` in any send field; the composer's microphone beside Send and the language switch (日本語 / English / Auto) | `useDictation.ts`, `dictation.ts`, `Composer.tsx` `DictationControls`, `main/voice/*` | See X-06 (done in WP11; the composer's buttons drive the same `DictationController`) |

### 2.10 Chords, palette, help, navigation

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| K-01 | Command registry (ids, labels, categories, needs) and default chord table (`Cmd+Q` prefix, second stroke by character, `Shift+[` alias spelling) | `model/commands.ts` (999), `model/chordKeys.ts` | All 38 commands; table identical |
| K-02 | Chord dispatcher in front of every surface (NSEvent local monitor), prefix armed state, `Cmd+Q Cmd+Q` quits (`forward_prefix`), unbound strokes pass to the surface, declined while a question is up | `main/shell/chords.ts` (696), `keyRouter.ts`, `keyboard.ts` | Works over terminal, composer, Sidebar |
| K-03 | `[keybindings]` rebinding with diagnostics (unknown id, duplicate key) | `model/config.ts` KeybindingsSpec | Same diagnostics |
| K-04 | Each command's behaviour: workspace/agent/unread/tab cycles, `Cmd+Q 0…9`, `toggle_workspace_agent`, `toggle_split`, `toggle_scratch` (remembers where you were), `swap_split_focus` (walks editor→Agent→terminal), `toggle_terminal`, `focus_editor`, `focus_sidebar`, `toggle_sidebar`, `add_workspace`, `add_agent`, `open_issue_picker`, `send_agent_action`, `rename_agent`, `close_selection`, `restart_agent`, `close_workspace`, `refresh_repositories`, `mark_agent_unread`, `dismiss_alert`, `show_notifications`, `open_settings`, `open_log`, `show_chord_help`, `open_command_palette`, `navigate_back/forward`, `move_entry_up/down`, `open_tab_picker` | `model/commands.ts` docs, `model/coordinator.ts` | Port `resolveChord` tests |
| K-05 | Command palette `Cmd+Q :`: `Category: Label` with effective chords, only commands `resolveChord` would act on, recent 8 first, fuzzy on title+id | `model/commandPalette.ts`, `CommandPaletteSheet.tsx` | §"Every command, by name" (done in WP11 (UI)) |
| K-06 | Chord help overlay `Cmd+Q ?` rendered from the registry | `ChordHelpSheet.tsx` | Reflects rebinding (done in WP11 (UI)) |
| K-07 | Tab picker `Cmd+Q G` (Return activates, Cmd+Return mounts Agent beside) | `TabPickerSheet.tsx` | — (done in WP11 (UI)) |
| K-08 | Back/Forward history: entry = selection, browser rules, skip closed, 100 max; inputs `Cmd+[`/`Cmd+]` over DevHub's own views, mouse 4/5, swipe, title-bar arrows, `Cmd+Q H/L` | `model/navigationHistory.ts`, `main/shell/historyKeys.ts`, `shell/historyButtons.ts` | Port tests; table in §Back and Forward (terminal surfaces count as DevHub's own except brackets go to the terminal) |
| K-09 | Editing keys on DevHub's own chrome (cut/copy/paste/select all in fields) | `main/shell/editingCommands.ts` | Standard responder chain |

### 2.11 Sheets ("questions" layer)

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| Q-01 | One picker control for every choice (heading band, field, rows, footer, Escape = cancel/back, Ctrl-N/P, arrows, Return, Cmd+Return variants), wizard runner (Escape goes back a step) | `shell/components/shell/{Picker,Wizard,wizardFlow}.tsx`, `shell/picker/*` | All sheets share one SwiftUI/AppKit component (done in WP11) |
| Q-02 | Modal layer over everything; takes tooltip down; keyboard held | `main/shell/pickerView.ts` (403), `layerView.ts` | — (done in WP11) |
| Q-03 | Sheets: workspace picker, agent picker, tab picker, rename, agent actions, injection review, chord help, command palette, close confirmation, worktree close, issue assignment, new project, clone | `shell/picker/*.tsx`, `ProjectSheets.tsx` | Each reachable and keyboard-complete (done in WP11) |
| Q-04 | Issue assignment `Cmd+Q I`: Issue URL → action → clone (search like picker; `--repo`) → branch (worktree `feature/<n>-wip` or root) → agent (New Agent list for that folder, "Just open the editor"); errors under the field | `IssueAssignmentSheet.tsx`, `main/shell/issues.ts`, `main/shell/github.ts` | §Assign Issue in README (done in WP11) |

### 2.12 Notices

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| N-01 | Toast stack over everything: failures and standing conditions (gh missing, machine not answering), actions, auto-hide after `notice_seconds` (paused on hover/keyboard/selection, ≥2 s left), lifetime rule (no immediate repeat) | `shell/toasts/*`, `shell/notices.ts`, `shell/alertLifetime.ts`, `main/shell/toastsView.ts`, `appConditions.ts`, `machineConditions.ts` | §"The notices hide themselves" (done in WP11) |
| N-02 | Notice center `Cmd+Q M`: last 100, newest first, time, kind (Error / Ongoing / Resolved), selectable text, actions while in force, unread until seen, delete / Clear All, arrows, Escape returns keys | `model/noticeCenter.ts`, `model/noticeEpisodes.ts`, `NoticeCenter.tsx` | Same rules (done in WP11) |
| N-03 | Failure routing: page that began it raises once; one audience draws; Settings window draws its own; per-subject scopes (Agent pane, Workspace surface) | `main/shell/publishAudience.ts`, `main/diagnostics/notices.ts`, `shell/failure.ts`, `mainFailureRoot.ts` | One path; no duplicate toasts (done in WP11) |
| N-04 | `dismiss_alert` `Cmd+Q D` | `commands.ts` | — (done in WP11) |

### 2.13 Settings and configuration

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| P-01 | `settings.toml` at `$XDG_CONFIG_HOME/devhub/` or `~/.config/devhub/`; `version = 3`; migration of `settings.local.toml` (tables merged key by key, arrays replaced) → `.migrated`, `config.toml` renamed into place; retired keys notices | `model/config.ts` (2888), `model/settingsMigration.ts` | Port config tests |
| P-02 | TOML 1.0 parser with source locations; validation codes + paths + locations (`ValidationCode`) | `model/config.ts`, `model/tomlDocument.ts` (856) | Same diagnostics for TS's test inputs |
| P-03 | Format-preserving edits (comments, grouping, order kept), revision check (expected vs actual) | `model/tomlDocument.ts` | Edit → diff touches only the key's line |
| P-04 | File watch + reload; refused reload keeps last accepted config; launch refusal → defaults + notice | `main/shell/settingsRefusal.ts`, `ReloadOutcome` | Saving a broken file shows a notice and changes nothing |
| P-05 | Settings window (own NSWindow), sections: **General** (Environment, Notifications, Terminals, Editors incl. "Editor area" note, Appearance, Agents, Scratch, Projects, Sidebar, Agent panes), **Workspaces** (sources collection editor), **Agents** (profiles collection: Profile, Arguments, Environment), **Terminal** (tmux, …), **Actions** (agent actions: Action, Message), **Keyboard** (Prefix, Problems, Commands), **Advanced** (Programs, Diagnostics) | `settings/sections.tsx` (2200+), `Collection.tsx`, `controls.tsx`, `rules.ts`, `main/shell/settingsWindow.ts` (599), `ipc/settings.ts` (542) | Every field of the TS window present; edits write the TOML in place (done in WP11) |
| P-06 | Config keys (all parsed, validated, preserved): `[general]` import_login_environment, notify_on_idle, notify_sound, notice_seconds, terminal_idle_seconds, workbench*, `[runtimes]` shell, git, tmux, tmux_socket_name, tmux_args, `[appearance]` title_bar, mode, theme_dark, theme_light, terminal_font_family, terminal_font_size, terminal_line_height, terminal_scroll_sensitivity, sidebar_density, terminal_margin, terminal_theme(.light/.dark), `[keybindings]`, `[[workspace_sources]]`, `[scratch] daily`, `[projects] directory`, `[agents]` default_presentation, resume_after_limit(_message), auto_compact_*, `[[agent_profiles]]`, `[agent_actions.*.*]` | `model/config.ts` | Round-trip of TS's sample config unchanged |

### 2.14 Theme and appearance

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| H-01 | `appearance.mode` light/dark/auto (follow OS), live switch | `main/shell/appearanceMode.ts` | Toggling macOS appearance recolours everything |
| H-02 | VS Code theme lookup by id or label in built-in theme extensions and `<extensionsDirectory>`; `include` chains; JSON with comments; unavailable → `color_theme_unavailable` once, default worn | `main/shell/colorThemeCatalog.ts` (323), `main/shell/shellTheme.ts` | Finds "Dark 2026"/"Light 2026" with no VS Code installed (themes vendored) |
| H-03 | Colour registry defaults per theme type and VS Code colour transforms (`Color`, `executeTransform`, `toString`) | `model/colorTheme.ts` (529), `model/colorIds.ts`, `model/colorDefaults.generated.ts` | Resolved colours equal TS for 5 sample themes |
| H-04 | Shell anchors (editor bg, side bar, opaque title bar, foreground) and every chrome token derived from the theme | `shell/styles/tokens.css`, `shellTheme.ts` | Native `DevHubTheme` tokens cover every CSS token used |
| H-05 | Fonts: terminal font family list resolution, monospace for sheets | `model/fontFamily.ts` | Missing family falls back like TS |

### 2.15 Repository status, GitHub, usage

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| R-01 | Git: branch, upstream ahead/behind, dirty, default branch, worktrees, remotes; HEAD watcher (git dir + refs, debounce with ceiling, slow safety poll) | `main/shell/git.ts` (1298), `headWatcher.ts`, `main/runtime/gitDirectory.ts` | Branch change visible within 1 s |
| R-02 | GitHub via `gh`: PR for branch (state, draft, checks, unresolved threads count, `100+`), Issue for Workspace, titles on hover; `gh` missing / not signed in conditions | `main/shell/github.ts` (928), `model/github.ts`, `repositoryStatus.ts` (1054), `resolveRemote.ts` | Same facts as TS for the same repo |
| R-03 | Refresh `Cmd+Q R`; cadence | `repositoryStatus.ts`, `main/runtime/cadence.ts` | — |
| R-04 | Project status → Smart Button conditions | `model/projectStatus.ts` | Port tests |
| R-05 | Usage readers: Claude `get_usage` over stream-json, Codex `account/rateLimits/read`; cadence 60/15/5 s by usage; 30 s timeout; merge with GUI Agents' reports | `main/shell/usageReaders.ts` (624), `usageLimits.ts` | Port tests |

### 2.16 Persistence, logs, misc

| ID | Feature | TS source | AC |
| --- | --- | --- | --- |
| X-01 | `state.json` schema 12 at `<userData>/devhub/state.json`: Workspaces, Agents (incl. terminal fields, GUI records), order, selection, paired Agent per Workspace, split ratio, zoom offset, sidebar width/rail; migrations from older versions; refusal of newer versions | `model/persistence.ts` (3098) | Reads every TS fixture; TS reads what native writes |
| X-02 | Main log `<userData>/logs/devhub-main.log`, 5 MB rotation (`.1`), `DevHub: Open Log` opens in Console | `main/diagnostics/mainLog.ts`, `open_log` | — |
| X-03 | Diagnostics/metrics (`devhub` `metrics` request), counters | `main/diagnostics/*` | `metrics` answers with the same shape |
| X-04 | Profiles (`DEVHUB_PROFILE`) | `model/profile.ts` | Done in WP0 (`ProfileLocations`) |
| X-05 | External links open in the default browser | `main/shell/externalLinks.ts` | — |
| X-06 | Voice dictation: `⌘⇧M`, local whisper.cpp server (model bundled), streaming partials, microphone permission, spoken text normalisation | `main/voice/*` (1445), `model/spokenText.ts`, `scripts/build_whisper.py`, `docs/agent-gui.md` §Voice input | Nothing leaves the Mac; same UX (done in WP11) |
| X-07 | Single instance (control socket claim) | `controlServer.ts` | Second launch activates the first |

Inventory size: **157 items** across 16 areas.

### 2.17 Parity audit (final pass)

Every item above checked against the Swift code and against the TS app on
`main` as it is now (`git log 4b3d5c6..origin/main -- apps/desktop`: c91dbf9
the editor area's shell exiting as its close button and b290457 Codex Make
default — ported alongside this pass (feebe01, c1f642b); de04dea then dd7f9c4 terminal mode
local-only — ported here, W-08). SSH and dev containers are not needed in
the native app. The inventory has 156 rows (the "157" above counted the
SHA-256 row of §3.2's table).

Result: **155 done, 0 partial, 0 missing, 1 not needed (S-14)**. "This pass"
marks what the final pass changed to get there; "done*" notes a remaining
difference of form, not of feature.

Known differences that stay, and why:

- The seams and the Sidebar's resize handle take no Tab focus (the window's
  key view loop is the terminals'), so their arrow-key step is reached as
  VoiceOver's increment/decrement only.
- Math is SwiftMath's typesetting in Latin Modern Math rather than KaTeX's
  own fonts and HTML; what SwiftMath cannot parse is drawn as its source,
  as KaTeX draws a formula it cannot parse.
- A recorded question is a view in the transcript, so its words are copied
  whole with the selection around it rather than selected word by word.

| ID | Status | Evidence (native/Sources/…) |
| --- | --- | --- |
| W-01 | done | `DevHubApp/AppDelegate.swift` (no quit on last window, Dock reopen), `MainWindowController.windowShouldClose` |
| W-02 | done | `Core/Layout/WindowLayout.swift`, `Tests/Layout/WindowLayoutTests.swift` |
| W-03 | done | `WindowLayout.swift`, `Shell/ShellController.swift` (toggle_split), split ratio in `Persistence/StateRecords.swift` |
| W-04 | done | `Model/AgentTerminal.swift`, `WindowLayout.swift` terminal placement |
| W-05 | done* | `Views/ShellBackdropView.swift` (drag, live preview, commit); *this pass: the seams are VoiceOver splitters with increment/decrement (`Views/AccessibleRegion.swift`); they take no Tab focus, so the TS separators' arrow keys are reached through VoiceOver only |
| W-06 | done | `ShellBackdropView.swift` title bar (Back/Forward disabled when nowhere to go, Sidebar toggle, tooltips), hidden mode drag strip; this pass: the buttons are VoiceOver buttons |
| W-07 | done | `WindowLayout.keyboardChild`, `MainWindowController.place/firstResponderChanged` |
| W-08 | done (this pass) | main's dd7f9c4: `Model/TerminalActivity.swift` `TerminalMode` (local-only, dev container = local folder, `TERMINAL_MODE_NO_SSH` / `_NO_DEV_CONTAINERS`), `ShellBackdropView.surfaceContent`, `Editor/EditorOpening.swift`; container mark dropped in `Shell/SidebarModel.swift` |
| W-09 | done | `ShellBackdropView.surfaceContent` (Retry / Locate… / Close), `Views/SurfaceStateView.swift` |
| W-10 | done | `Model/Attention.swift` (+ `AttentionTests`), `Platform/Platform.swift` `AppDock` |
| W-11 | done | `Model/Attention.swift` idle rule, `Platform.swift` `Notifications` (UNUserNotificationCenter) |
| W-12 | done | `AppDelegate.relaunch`, `MainMenu.swift` Restart DevHub |
| S-01 | done | `Shell/SidebarModel.swift`, `Views/SidebarView.swift`, `Model/WorkspaceOrder.swift` |
| S-02 | done | `SidebarView.swift` rail + resize handle (width persisted via `Projection.clampSidebarWidth`); this pass: the handle is a VoiceOver splitter (±4pt) |
| S-03 | done | `DevHubTheme.Density`, `SidebarView` row metrics |
| S-04 | done | `SidebarView` drag reorder (useReorder rules), `WorkspaceOrderTests` |
| S-05 | done | `SidebarListView` keys, `Shell/KeyRouter.swift` |
| S-06 | done | `SidebarModel` row menus, `SidebarView` NSMenu (no container items) |
| S-07 | done | `Views/TooltipView.swift`, `MainWindowController.TooltipController` (grace, enterable, links) |
| S-08 | done | `GitHub/RowDescription.swift` (+ `RowDescriptionTests`) |
| S-09 | done | `SidebarView` status marks (ring spin, background arcs, unread), `Model/TerminalActivity.swift`, `Tmux/PaneActivity.swift` |
| S-10 | done | `SidebarModel` digits while armed, `Keyboard/ChordDispatcher.swift` |
| S-11 | done | `SidebarView` closing breathe + exiting ghost rows (`Sidebar.closingExitMs`) |
| S-12 | done | `Views/UsageFooterView.swift`, `Usage/UsageRow.swift`, `Usage/UsageFooter.swift` |
| S-13 | done | `Usage/PromptCacheFacts.swift` |
| S-14 | not needed | SSH is out of scope for this app (user decision); main's dd7f9c4 made terminal mode local-only too |
| WS-01 | done | `Model/Domain.swift`, `DomainTests` |
| WS-02 | done | `Sheets/WorkspacePickerSearch.swift`, `Config/ConfigModel.swift` sources |
| WS-03 | done | `Sheets/SheetFlows.swift` workspacePicker, `Sheets/PickerView.swift`, `Model/Fuzzy.swift`; no SSH row (as main in terminal mode) |
| WS-04 | done | `Git/Projects.swift`, `SheetFlows` New Project / Clone |
| WS-05 | done | `Git/Worktrees.swift`, `Git/WorktreeFolder.swift`, `Git/Git.swift` |
| WS-06 | done | `SheetFlows` close confirmation / worktree close, `Model/Domain.swift` `WorkspaceClose` |
| WS-07 | done | `Controller/AppController.swift` `closeWorkspaceResources` with `CloseDeadline` |
| WS-08 | done | `Model/AppModel.swift` `repairSelection`, `AppModelTests` |
| WS-09 | done | `Model/ScratchDay.swift`, `Model/DateTemplate.swift`, `ScratchRolloverTests` |
| WS-10 | done | `Editor/OpenRouting.swift`, `AppDelegate.application(_:open:)` |
| WS-11 | done | `Shell/ShellLayout.swift` `EditorTerminalsShown`, `MainWindowController.reconcileTerminals` |
| T-01 | done | `Tmux/TmuxTerminalRuntime.swift`, `TmuxRealTests` |
| T-02 | done | `Tmux/TmuxMarkers.swift`, `Tmux/SessionSweep.swift`, `SessionSweepTests` |
| T-03 | done | `Support/TmuxNames.swift` |
| T-04 | done | `Views/TerminalPaneView.swift` (SwiftTerm on the attach transport), `Shell/TerminalSurfaceSession.swift`, `Tmux/TerminalAttachments.swift` |
| T-05 | done | SwiftTerm's NSTextInputClient (marked text overlay at the caret) in the terminal, NSTextView in the composer; `Platform.swift` `TISInputSources` for the chord prefix |
| T-06 | done | `TerminalPaneView.applyStyle`, `Model/TerminalActivity.swift` `TerminalZoom`, zoom offset in state |
| T-07 | done | `Theme/TerminalPalettes.swift`, `TerminalPalettesTests` |
| T-08 | done | `TerminalSurfaceSession.cameOnScreen`, cover with Retry in `TerminalPaneView` |
| T-09 | done | `TerminalPaneView.requestOpenLink` → `ShellController.openExternal` (OSC 8, as xterm's linkHandler) |
| T-10 | done | `TerminalPaneView.clipboardCopy` (OSC 52 to the pasteboard, reads refused) |
| T-11 | done | `Tmux/TerminalActivityLoop.swift`, `PaneActivityTests` |
| T-12 | done | `Support/LoginEnvironment.swift`, `Support/Runtimes.swift`, `Tmux/TerminalRuntimes.swift` |
| T-13 | done | `Tmux/TerminalLauncher.swift`, `TerminalLauncherTests` |
| E-01 | done | `Editor/MessagePack.swift`, `MessagePackTests` |
| E-02 | done | `Editor/NeovimRPC.swift`, `NeovimRPCTests`, `RealNeovimTests` |
| E-03 | done | `Editor/ManagedNeovims.swift` |
| E-04 | done | `ManagedNeovims.swift` socket paths, `ManagedNeovimsTests` |
| E-05 | done | `ManagedNeovims.swift` (get_mode, exec_lua, clamp, zv/zz) |
| E-06 | done | `ManagedNeovims.swift` lifecycle, `ManagedNeovimsTests` |
| E-07 | done | `Editor/OpenRouting.swift`, `Editor/EditorOpening.swift`, `OpenRoutingTests` |
| E-08 | done | `Control/DevhubWait.swift`, `Editor/WaitSelectionReturns.swift` |
| E-09 | done | `Controller/ControllerWiring.swift` nvim lookup + notice |
| E-10 | done | `AppDelegate.application(_:open:)`, `Resources/Info.plist` |
| C-01 | done | `Control/ControlServer.swift`, `ControlServerTests` |
| C-02 | done | `Control/ControlProtocol.swift`, `WireJSONTests`; extension/dev container kinds answered by `ControlServer` refusals |
| C-03 | done | `Control/DevhubArguments.swift`, `DevhubCommandLine.swift`, `DevhubLaunch.swift`, `ArgumentsTests` |
| C-04 | done | `Control/TellCommand.swift` |
| C-05 | done | `Control/TellService.swift`, `TellServiceTests` |
| C-06 | done | `TellService.swift` panes/bring, `Tmux/TmuxTerminalRuntime.swift` |
| C-07 | done | `Control/DevhubInstall.swift`, `MainMenu` Install ‘devhub’ Command… |
| C-08 | done | `Control/DevhubSkill.swift`, `DevhubSkillAndCommandLineTests` |
| A-01 | done | `Config/ConfigModel.swift`, `Conversation/Claude/ClaudeDefaults.swift` |
| A-02 | done | `SheetFlows` agentPicker, `Sheets/SheetRows.swift`, `Conversation/Resume.swift` |
| A-03 | done | `Agents/Terminal/AgentSessions.swift`, `TerminalAgentWiring.swift` |
| A-04 | done | `Agents/Detect/*`, `DetectTests` |
| A-05 | done | `Model/Domain.swift`, `AppModel.swift` |
| A-06 | done | `SheetFlows` rename + stop questions, `Agents/Terminal/AgentReconciler.swift` |
| A-07 | done | `Conversation/SessionArgs.swift`, `Agents/Terminal/TerminalAgentCommand.swift` |
| A-08 | done | `Controller/AppControllerConversations.swift`, `Sheets/SheetRows.swift` |
| A-09 | done (this pass: look) | `Conversation/ConversationViews.swift` `FailureView`: now DevHub's sheet (`PaneSheetChrome.swift`, heading band, code spans, DevHub buttons, keys on the sheet) and the TS banner along the pane's top |
| A-10 | done | `Agents/Terminal/AgentInjectionQueue.swift`, review sheet in `Sheets/SheetViews.swift`, `InjectionStatusView` |
| A-11 | done | `Model/AgentActions.swift`, `SheetFlows` agentActions |
| A-12 | done (this pass: motion) | `Model/SmartButtons.swift`, `Model/AutomaticActions.swift`, `Conversation/SmartButtonsView.swift`: now the drawn bolt with its count, the switches panel (frozen, stays open), lines entering/leaving, snap glide |
| A-13 | done | `Model/AgentTerminal.swift`, `AgentTerminalTests` |
| A-14 | done | `SheetFlows` stop-with-terminal (Move terminal to editor), `TmuxTerminalRuntime.swift` |
| G-01 | done | `Conversation/HostScript.swift`, `HostCommand.swift`, `HostScriptTests` |
| G-02 | done | `Conversation/HostLink.swift`, `Reading.swift`, `HostLinkTests` |
| G-03 | done | `Conversation/ConversationModel.swift`, `ConversationFold.swift`, `ConversationFoldTests` |
| G-04 | done | `Conversation/Claude/*`, `ClaudeAdapterTests1–12` |
| G-05 | done | `Conversation/Codex/*`, `CodexAdapterTests1–4` |
| G-06 | done | `Conversation/Registry.swift`, `Controller/GuiAgents.swift` |
| G-07 | done | `Conversation/AgentConversation.swift` pending + drafts, `ComposerView` pending list |
| G-08 | done | `Conversation/Resume.swift`, rewind in the adapters |
| G-09 | done | `Conversation/Resume.swift`, `ResumeListingTests`, `/resume` sheet |
| G-10 | done | `Conversation/CacheKeeper.swift` |
| G-11 | done | `Conversation/LimitResume.swift`, `AgentConversationLimitTests` |
| G-12 | done | `Conversation/Elicitation.swift`, `ElicitationForm.swift`, `McpSignIn.swift` |
| G-13 | done | `Conversation/Failures.swift` |
| G-14 | done | `Conversation/PathLinks.swift`, `ConversationUI/TextLinks.swift`, `TextLinksTests` |
| G-15 | done | `Conversation/ToolTitle.swift` |
| G-16 | done | adapters' stop_task / turn/interrupt, `ComposerFooterView` with confirmation |
| G-17 | done | `ConversationUI/TranscriptStructure.swift`, `Conversation/FindAndSubagents.swift` |
| G-18 | done | `Conversation/AgentRecords.swift` |
| U-01 | done (this pass: rise) | `Conversation/TranscriptTextView.swift` (one TextKit 2 text), `TranscriptScroller.swift` (follow, Latest / New output); arrivals now rise from `--motion-rise` as they fade (snapshot under a cover), not only fade |
| U-02 | done (this pass: math) | `Markdown/*` GFM parser, `ConversationUI/MarkdownDocumentBuilder.swift`; math now typeset: SwiftMath vendored (`native/Vendor/SwiftMath`, Latin Modern Math), inline on the baseline, display centred and scrolled; source on a parse failure as KaTeX |
| U-03 | done | `Markdown/Highlight/*` (TextMate grammars, Light+/Dark+), `TranscriptBlocks.swift` CodeBlockView with Copy |
| U-04 | done | `ConversationUI/EntryDocumentBuilder.swift`, `TranscriptEmbeds.swift`, Clip with Show all |
| U-05 | done | `EntryDocumentBuilder` diffs, `TranscriptTextView` bands |
| U-06 | done (this pass: record) | `Conversation/RequestCardView.swift`; the answered QuestionRecord is now drawn as the card drew it with the preview beside the options (`QuestionRecordView`, `.questionRecord` embed) |
| U-07 | done | `Conversation/ComposerView.swift`, `ComposerTextView.swift`; this pass: pending items and the command list rise in |
| U-08 | done | `ConversationUI/CommandCompletion.swift`, `CompletionListView` |
| U-09 | done (this pass: list) | `Conversation/SettingMenuView.swift`: DevHub's list over the face with Default / Make default (hover or highlight, click, ⌥↩), replacing the system menu with ⌥ alternates; Codex's defaults too (c1f642b) |
| U-10 | done | `ComposerFooterView` (context, background tasks + stop confirmation) |
| U-11 | done | `FindAndSubagents.swift` FindBarView, `ConversationUI/TranscriptSearch.swift`; this pass: the TS tooltips/labels |
| U-12 | done (this pass: look) | `Conversation/ConversationSheets.swift` `McpPanelView`: now a picker's sheet (rows with status dots, aside, footer note, DevHub buttons) on `PaneSheetChrome.swift`; Escape there no longer stops the turn |
| U-13 | done (this pass: activity) | rewind confirm in `TranscriptEmbeds` ConfirmEmbedView; activity line now fades out after the turn and fades a new phase in |
| U-14 | done | `ConversationUI/PathLinkStore.swift`, `TranscriptTextView` links → `ConversationPane.follow` |
| U-15 | done | `SmartButtonsView` (see A-12) |
| U-16 | done | `Voice/DictationController.swift`, `Core/Voice/*` |
| K-01 | done | `Model/Commands.swift`, `Model/ChordKeys.swift`, `ChordKeysAndCommandsTests` |
| K-02 | done | `Keyboard/ChordDispatcher.swift`, `Shell/KeyRouter.swift` |
| K-03 | done | `Config/ConfigParsing.swift` keybindings diagnostics |
| K-04 | done | `Model/Coordinator.swift`, `Shell/ShellController.swift` perform, `ChordsTests` |
| K-05 | done | `Model/CommandPalette.swift`, `SheetFlows` palette |
| K-06 | done | `SheetViews.swift` ChordHelpView |
| K-07 | done | `SheetFlows` tab picker |
| K-08 | done | `Model/NavigationHistory.swift`, `ChordDispatcher` (brackets, side buttons, swipe), title-bar arrows |
| K-09 | done | `Shell/KeyRouter.swift` `ShellKeys.editingGroups`, `MainMenu.editMenu` |
| Q-01 | done | `Sheets/PickerView.swift`, `Core/Sheets/PickerList.swift`, `Wizard.swift` |
| Q-02 | done | `Sheets/SheetLayer.swift`, `SheetChrome.swift` |
| Q-03 | done | `Sheets/SheetFlows.swift`, `SheetViews.swift` |
| Q-04 | done | `Core/Sheets/IssueFlow.swift`, `Controller/IssueAssignment.swift` |
| N-01 | done | `Notices/NoticeLayer.swift`, `Model/NoticeBoard.swift` |
| N-02 | done | `NoticeLayer.swift` center, `Model/Notices.swift`, `NoticeBoardTests` |
| N-03 | done | `Model/NoticeBoard.swift` audiences |
| N-04 | done | `Model/Commands.swift` dismiss_alert |
| P-01 | done | `Config/ConfigStore.swift`, `SettingsMigration.swift`, `ConfigStoreTests` |
| P-02 | done | `Config/TomlParser.swift`, `ConfigDiagnostics.swift` |
| P-03 | done | `Config/TomlDocument.swift`, `TomlDocumentTests` |
| P-04 | done | `Config/SettingsRefusal.swift`, `ConfigStore` reload |
| P-05 | done | `Settings/*` (seven screens, collections with Move up/down, recorder) |
| P-06 | done | `Config/ConfigModel.swift`, `ConfigParsing.swift`, `ConfigWireTests` |
| H-01 | done | `Theme/AppearanceController.swift`, `Core/Theme/AppearanceMode.swift` |
| H-02 | done | `Theme/ColorThemeCatalog.swift`, vendored `BuiltinThemes` |
| H-03 | done | `Theme/ColorTheme.swift`, `ColorDefaults.generated.swift`, `ColorThemeTests` |
| H-04 | done | `Theme/DevHubTheme.swift`, `ShellStyle.swift` |
| H-05 | done | `Theme/FontFamily.swift`, `ThemeAppKit.swift` |
| R-01 | done | `Git/Git.swift`, `HeadWatcher.swift`, `GitDirectory.swift` |
| R-02 | done | `GitHub/GitHubClient.swift`, `Git/RepositoryStatus.swift` |
| R-03 | done | `Runtime/Cadence.swift`, refresh_repositories |
| R-04 | done | `GitHub/ProjectStatus.swift` |
| R-05 | done | `Usage/UsageReaders.swift`, `UsageLimits.swift`, `UsageReadersTests` |
| X-01 | done | `Persistence/*`, `PersistenceTests` |
| X-02 | done | `Support/MainLog.swift`, `ShellController.openLog` |
| X-03 | done | `Control/Diagnostics.swift`, `DiagnosticsTests` |
| X-04 | done | `Support/ProfileLocations.swift` |
| X-05 | done | `ShellController.openExternal` |
| X-06 | done | `Voice/DictationController.swift`, `Core/Voice/*`; the composer's microphone and language switch (feebe01) |
| X-07 | done | `AppDelegate.launch` (control socket claim, second launch hands over) |

---

## 3. Architecture

### 3.1 Package layout

```text
native/
  Package.swift            swift-tools-version 6.0, Swift 6 language mode, macOS 14+
  Sources/
    DevHubCore/            Foundation only — builds and tests on Linux
      DevHubVersion.swift
      Support/             ProfileLocations, Path, SHA256, ProcessRunner, TmuxNames   (WP0)
                           + Log, FileWatcher, JSONValue, AsyncLineReader, UnixSocket (WP1)
      Config/              TOML parser/document, Config, validation, migration        (WP1)
      Model/               domain, AppModel, intents, coordinator, projection, commands,
                           chords, palette, fuzzy, navigation, notices, order, scratch,
                           smart buttons, agent actions, agent terminal, zoom          (WP2)
      Layout/              WindowLayout (pure), keyboardChild                          (WP2)
      Persistence/         state.json v12                                              (WP2)
      Tmux/                server, bootstrap, markers, sessions, pane activity, sweep  (WP3)
      Agents/Detect/       screen rules + manifests                                    (WP3)
      Agents/Terminal/     injection, activity, reconciler                             (WP3)
      Git/  GitHub/  Usage/                                                            (WP4)
      Conversation/        model + fold, host script, journal, Claude                  (WP5)
      Conversation/Codex/  Codex adapter + protocol types                              (WP6)
      Editor/              msgpack, Neovim RPC, ManagedNeovims, routing                (WP7)
      Control/             wire types, control server, tell parser + service, skill    (WP7)
      Theme/               colour registry, transforms, catalog, palettes              (WP8)
      Markdown/            GFM block/inline parser, highlighter, link detection        (WP10)
      Voice/               whisper server client                                       (WP11)
      Remote/              SSH runtime (late)                                          (WP12)
    DevHubCLI/             `devhub` executable (thin; logic in Core/Control)           (WP7)
    DevHubApp/             AppKit + SwiftUI, macOS only                                (WP9–WP11)
  Tests/
    DevHubCoreTests/       XCTest, runs on Linux and macOS
    DevHubAppTests/        (macOS only, add when needed; declare under #if os(macOS))
  Resources/               Info.plist template, vendored themes (WP8), icons
  Scripts/bundle-app.sh    builds DevHub.app (+ CLI in Contents/Resources/bin)
  docs/PLAN.md             this file
```

`Package.swift` declares the App target (and its dependencies) only inside
`#if os(macOS)`, so Linux never resolves UI dependencies. All of Core is one
target with folders, so packages never need to edit `Package.swift` to add
files; adding a dependency or a target is a coordinated change (see §5).

### 3.2 Dependencies (decided)

| Need | Choice | Licence | Where | Why |
| --- | --- | --- | --- | --- |
| Terminal emulation + view | **SwiftTerm** `migueldeicaza/SwiftTerm` `.upToNextMinor(from: "1.20.0")` | MIT | App | Pure Swift, AppKit `TerminalView`, mature, used by many macOS apps. Behind a `TerminalSurface` protocol so **libghostty** can replace it later (GPU renderer, better fidelity) without touching callers |
| TOML | **own parser** in Core/Config | — | Core | Must keep comments/order for in-place edits and report line/column per diagnostic (port of `tomlDocument.ts`); Swift-only TOML libs either wrap C++ (TOMLKit) or decode only (TOMLDecoder) |
| SHA-256 | own (done) | — | Core | CryptoKit missing on Linux; swift-crypto brings BoringSSL (C) |
| msgpack | own (port `msgpack.ts`) | — | Core | Small, exact control over ext types |
| JSON | Foundation `JSONSerialization` + Codable; a `JSONValue` enum for open shapes | — | Core | Protocol decoders need lossless unknown-field handling |
| Markdown | **own GFM parser** in Core/Markdown (port `markdownBlocks.ts`, add inline) | — | Core | Swift-only constraint rules out cmark-based libs (swift-markdown, MarkdownUI) |
| Syntax highlighting | own tokenizer-based highlighter (Core) coloured by theme `tokenColors`; optional later TextMate-grammar engine on `NSRegularExpression` with vendored grammars | — | Core/App | shiki is JS; Splash is Swift-only syntax |
| Math | **SwiftMath** `mgriebling/SwiftMath` 1.7.3 (MIT, pure Swift, CoreText), **vendored** under `native/Vendor/SwiftMath` with Latin Modern Math (GUST licence) so its fonts are found in `Contents/Resources`; fallback: monospace source | MIT | App | KaTeX is JS |
| CLI argument parsing | own (port `devhubCli.ts`) | — | Core | Exact messages/exit codes |
| Voice | the same whisper.cpp server binary `scripts/build_whisper.py` builds, run as a child process; client in Swift | MIT (whisper.cpp) | App bundle | Same recogniser and model as TS; Apple `SFSpeechRecognizer` (on-device) as an optional fallback |

No other dependencies without updating this table. All are fetched by SwiftPM
from GitHub; the macOS CI job's "Resolve dependencies" step proves it.

### 3.3 Layering and data flow

The TS app is main process (model + services) and renderer pages (React). The
native app keeps the same separation **in one process**, with Core as a
library:

```text
            ┌──────────────────────── DevHubApp (MainActor) ───────────────────────┐
 NSEvent ─▶ │ ChordDispatcher ─▶ intents ─┐        Views (AppKit/SwiftUI) observe   │
 clicks  ─▶ │ views ──────────▶ intents ──┤        AppStore (@Observable, MainActor)│
            └─────────────────────────────┼────────────────────▲─────────────────────┘
                                          ▼                    │ snapshots (Sendable)
            ┌──────────────────────── DevHubCore ──────────────┼─────────────────────┐
            │  Coordinator (actor)  ── reduce(AppModel, Intent) → (AppModel, [Effect])│
            │        │ effects                                                       │
            │        ▼                                                               │
            │  Services (actors): TmuxServer, ManagedNeovims, ConversationRegistry,   │
            │  RepositoryStatus, UsageReaders, ConfigStore, StateStore, ControlServer │
            │        │ observations → intents back into the Coordinator              │
            └────────────────────────────────────────────────────────────────────────┘
```

- **Model is a value.** `AppModel` (struct) + `Intent` (enum) + a pure
  `reduce` mirroring `model/appModel.ts`, `intents.ts`, `coordinator.ts`.
  Effects are data (`enum Effect`) executed by services; results come back as
  intents. This keeps the whole state machine testable on Linux with no
  processes, exactly as the TS model is tested.
- **Projection.** `AppSnapshot` (mirror of `model/wire.ts`) is what the UI
  reads — Sendable value, published via `AsyncStream<AppSnapshot>`; the App's
  `AppStore` (`@Observable @MainActor`) holds the latest and views diff on it.
  Conversations publish separately (`ConversationEvent` stream per Agent, the
  same `applyEvent` fold on both sides, as TS does between main and page).
- **Concurrency.** Swift 6 strict concurrency. Each long-lived service is an
  `actor`; process I/O uses `ProcessRunner` (short) or a streaming child type
  (long-lived: CLI hosts' `tail`, usage readers, Neovim relay later). UI is
  `@MainActor` only. No locks outside tiny `@unchecked Sendable` boxes in
  Support.
- **Layout.** `WindowLayout.compute(input) -> [Child]` and
  `keyboardChild(input)` are pure Core functions (port of
  `windowLayout.ts`); the App's `MainWindowController` is the only code that
  sets frames/visibility/first responder, like `ShellWindow.layout()`.
- **Views.** One `NSWindow`; children are `NSView`s (no nested windows except
  the tooltip `NSPanel`, the Settings window and native menus). AppKit for the
  performance-critical and event-heavy parts (window/layout, Sidebar outline
  with drag, terminal surfaces, transcript list, composer `NSTextView`, chord
  handling); SwiftUI for forms and sheets (Settings, pickers, notice center)
  hosted in `NSHostingView`.
- **Terminal surface.** `protocol TerminalSurface` (attach(target), detach,
  resize, setTheme, setFont, zoom, focus, IME) with `SwiftTermSurface` as the
  implementation: a `TerminalView` whose `TerminalViewDelegate` writes to a
  PTY running `tmux -L <sock> attach-session -t <session>` (forkpty via
  `posix_spawn` + `openpty`). The tmux side (geometry, attach/detach) is in
  Core; only the view is App.
- **Wire compatibility.** Control socket, state file, settings file, tmux
  names/markers, host script and journal are byte-compatible with the TS app
  (§1 Compatibility promise). Tests use fixtures captured from the TS code
  (copy them under `Tests/DevHubCoreTests/Fixtures/` with the TS path noted).

### 3.4 Known platform gotchas

- On Linux, a child spawned from a Swift-concurrency thread may inherit
  blocked signals, so `SIGTERM` does not arrive; `ProcessRunner` falls back to
  `SIGKILL` after 1 s. Long-lived child types must do the same.
- `sun_path` is 104 bytes on macOS (E-04).
- Workspace roots are `realpath(3)`, never `URL.resolvingSymlinksInPath`:
  on macOS the latter strips `/private`, so a root under `/tmp` or `/var`
  came out as `/tmp/…`, and tmux's `createSession` refused it as a root that
  canonicalises elsewhere (`session_unavailable`). The self-test's Scratch is
  named through `/tmp` on purpose.
- SwiftPM resource bundles must be copied to `Contents/Resources` (the bundle
  script does), where `Bundle.module` looks in an `.app`.
- `Cmd+Q` is DevHub's chord prefix: the app menu's Quit has no key
  equivalent; quitting is `Cmd+Q Cmd+Q`.

### 3.5 Testing strategy

- **Core on Linux** in Docker (`swift:6.1-noble`): every package's logic tests
  run here; this is what agents run locally. CI repeats it (`native.yml`
  linux job).
- **macOS CI** (`macos-15`): `swift build` (incl. App), `swift test`, bundle,
  `DevHub --self-test` (window on screen, terminal surface links). Packages
  extend `--self-test` with smoke checks of their own (e.g. tmux attach in a
  temporary `-L` server, Neovim RPC if `nvim` is installed via Homebrew in
  the job).
- **Ported tests**: each package ports the TS unit tests of the files it
  ports (vitest → XCTest), keeping fixture files.
- **Integration tests needing tmux/git/nvim** are marked and skipped when the
  binary is missing (`XCTSkip`); the Docker image has git; the macOS job may
  `brew install tmux neovim`.
- UI: snapshot or XCUITest optional; prefer testable view models in Core.

---

## 4. Work packages

Twelve packages (WP1–WP12) after this one (WP0). Each lists: scope (feature
IDs), TS files to port, dependencies, deliverable tests. Sizes are TS lines
to port (non-test).

### WP0 — Inventory, architecture, skeleton, CI (done)

Package.swift, Core Support (ProfileLocations, Path, SHA256, ProcessRunner,
TmuxNames) with tests, CLI `--version`, App empty window + SwiftTerm link
probe + `--self-test`, `Scripts/bundle-app.sh`, `.github/workflows/native.yml`.

### WP1 — Foundations and configuration (Core) ~4.5k

- Scope: P-01…P-04, P-06, WS-09 (date template, scratch day rules), X-02, T-12
  (login environment + executable resolution), Support additions (Log with
  rotation, FileWatcher (DispatchSource on macOS, polling fallback on Linux),
  `JSONValue`, `AsyncLineReader`, POSIX `UnixSocket` client/server helpers,
  streaming child process with SIGKILL fallback).
- Port: `model/config.ts`, `model/tomlDocument.ts`, `model/settingsMigration.ts`,
  `model/dateTemplate.ts`, `model/scratchDay.ts`, `model/fuzzy.ts`,
  `model/invariant.ts`, `model/sshConfig.ts` (parse only), `main/diagnostics/mainLog.ts`,
  `main/shell/loginEnvironment.ts`, `main/shell/runtimes.ts`, `main/shell/settingsRefusal.ts`.
- **Milestone M1 (first, merge early):** the `Config` Swift types and
  `Config.defaults`, so WP2/WP3/WP4/WP8 can compile against them.
- Depends on: WP0. Parallel with: WP3, WP4, WP5, WP8 (after M1).
- Accept: TS tests for config/tomlDocument/dateTemplate/scratchDay/fuzzy pass
  as XCTests; an edit round-trip keeps a commented sample file byte-identical
  except the edited value; the README sample config loads with no diagnostics.

### WP2 — Model, coordinator, projection, layout, persistence (Core) ~13k

- Scope: WS-01, WS-06 (model side), WS-08, A-05, A-13 (model), K-01, K-03,
  K-04, K-05 (rows), K-08, N-02 (model), W-02, W-04, W-07 (rule), W-10 rule,
  W-11 rule, X-01, S-01 order, S-04 rule, A-11, A-12 (rules), R-04.
- Port: `model/domain.ts`, `appModel.ts`, `intents.ts`, `coordinator.ts`,
  `wire.ts`, `workspaceOrder.ts`, `navigationHistory.ts`, `commands.ts`,
  `chordKeys.ts`, `commandPalette.ts`, `noticeCenter.ts`, `noticeEpisodes.ts`,
  `agentTerminal.ts`, `terminalZoom.ts`, `terminalMode.ts`, `terminalActivity.ts`,
  `agentActions.ts`, `smartButtons.ts`, `automaticActions.ts`, `projectStatus.ts`,
  `worktrees.ts`, `projects.ts`, `profile.ts` (done), `persistence.ts`,
  `main/shell/windowLayout.ts` (as pure Core), the rule halves of
  `windowAttention.ts` and `agentNotifications.ts`.
- Depends on: WP1 M1. Parallel with: WP3–WP8.
- Accept: ported tests for every file above; `state.json` fixtures from
  `persistence` tests load and re-save byte-compatibly (modulo key order if TS
  tolerates it — check `persistence.ts`).

### WP3 — tmux runtime and terminal Agents (Core) ~9k

- Scope: T-01…T-03, T-11, T-13, A-03, A-04, A-06 (stop), A-07 (argv),
  A-10, A-14, sweep, Agent sessions, Workspace session creation, Agent terminal
  sessions, `move-window`/`join-pane` helpers for C-06.
- Port: `main/terminal/tmux.ts`, `paneActivity.ts`, `launcher.ts`, `command.ts`,
  `service.ts` (the session half), `main/agent/{sessions,activity,injection,screenFreshness}.ts`,
  `main/agent/detect/*`, `main/shell/{sessionSweep,agentReconciler,agentProfileCommand,terminalActivityLoop,terminalRuntimes}.ts`,
  `main/runtime/{local,runtime,registry,quote,cadence}.ts` (local runtime only).
- Depends on: WP0 (+ WP1 M1 for config types). Parallel with: WP1, WP2, WP4, WP5, WP8.
- Accept: parse tests and screen fixtures ported; integration test (skipped
  without tmux) starts a private `-L` server, creates `ws-`/`ag-`/`tm-`
  sessions with markers, sweeps, and reads pane activity; argv for every
  profile kind equals TS's.

### WP4 — Git, GitHub, repository status, Issues, usage readers (Core) ~5k

- Scope: R-01…R-05, WS-05 (git side), Q-04 (clone search/worktree logic),
  S-08 facts input, S-12 data.
- Port: `main/shell/{git,github,repositoryStatus,headWatcher,issues,resolveRemote,usageReaders,usageLimits,worktreeFolder,projects}.ts`,
  `main/runtime/gitDirectory.ts`, `model/github.ts`,
  `shell/components/sidebar/{rowDescription,usageRow,promptCacheFacts}.ts` (pure parts).
- Depends on: WP0, WP1 M1. Parallel with: WP2, WP3, WP5, WP8.
- Accept: ported tests; `gh` and `git` outputs parsed from fixtures; integration
  test against a temporary git repo (worktree add/remove, branch change
  detected by the watcher within 1 s).

### WP5 — Conversation core + Claude adapter (Core) ~11k

- Scope: G-01…G-04, G-06, G-07, G-13…G-15, G-18.
- Port: `model/conversation.ts`, `model/elicitationForm.ts`,
  `main/agent/conversation/{hostScript,hostCommand,hostLink,reading,registry,drafts,failures,pathLinks,toolTitle,agentRecords,protocolAdapter,conversation}.ts`,
  `claude/*`, `ipc/conversation.ts` (event wire types).
- Depends on: WP0, WP1 (JSONValue, streaming child). Parallel with WP2–WP4, WP8.
- Accept: fixture journals in `conversation/fixtures/*.ndjson|jsonl` fold to
  the same transcripts as the TS tests assert; host script text identical to
  TS's; replay after restart sends nothing twice.

### WP6 — Codex adapter, resume, rewind, limits, cache keeper, MCP (Core) ~12k

- Scope: G-05, G-08…G-12, G-16, G-17 (model), A-02 (session listing), A-08.
- Port: `codex/*` incl. `codex/protocol/*` (keep Apache-2.0 notice),
  `resume.ts`, `limitResume.ts`, `cacheKeeper.ts`, `mcpSignIn.ts`,
  `elicitation.ts`, rewind/restart parts of `conversation.ts`.
- Depends on: WP5. Parallel with: WP7, WP9.
- Accept: ported adapter/resume/rewind/limitResume/cacheKeeper/mcpSignIn
  tests over the TS fixtures.

### WP7 — Managed Neovim, control socket, `devhub` CLI, tell, skill (Core + CLI) ~8k

- Scope: E-01…E-10 (Core side), C-01…C-08, X-03, X-07.
- Port: `main/editor/*`, `main/cli/*` (minus extension commands),
  `main/cli/tell/*`, `main/agent/devhubSkill.ts`, `main/shell/openFromFinder.ts`
  (routing part), `main/diagnostics/{metrics,counters,rollingTally,rounds}.ts`.
- Depends on: WP2 (model for tell service), WP3 (tmux panes). msgpack/RPC and
  CLI parsing can start immediately (no deps).
- Accept: CLI and tell parser tests ported; JSON request/response fixtures
  from TS round-trip; a fake msgpack-rpc server test covers alive/adopt/stale;
  on macOS CI with Homebrew `nvim`: start a managed server in a private tmux,
  open a file at line 10, `--wait` returns after `:bd`.

### WP8 — Theme and appearance (Core + vendored resources) ~2.5k

- Scope: H-01…H-05, T-07, S-03 tokens.
- Port: `model/colorTheme.ts`, `colorIds.ts`, `colorDefaults.generated.ts`
  (convert to Swift/JSON with a Python script under `native/Scripts/`, no TS
  at runtime), `terminalPalettes.ts`, `fontFamily.ts`,
  `main/shell/{colorThemeCatalog,shellTheme,appearanceMode}.ts`; vendor the
  built-in theme JSON files from `vscode/extensions/theme-defaults` (and the
  other built-in theme extensions the TS catalog lists) into
  `native/Resources/Themes/` with their MIT licence; define `DevHubTheme`
  tokens covering every CSS variable in `shell/styles/tokens.css`.
- Depends on: WP0, WP1 M1. Parallel with everything.
- Accept: resolved palettes (chrome anchors + terminal 16 colours) for Dark
  2026, Light 2026 and 3 more built-in themes equal TS's output (fixture JSON
  generated once from TS and checked in).

### WP9 — App shell: window, layout, Sidebar, terminal surfaces, chords (App) ~10k UI

- Scope: W-01, W-03…W-12, S-01…S-11, S-13, S-14 (draw), WS-11, T-04…T-06,
  T-08…T-10, K-02, K-04 (wiring), K-08 inputs, K-09, E-10 (App side),
  A-06 menu wiring, A-13 UI.
- Port (UI behaviour, not code): `main/shell/{shellWindow,layerView,keyRouter,keyboard,chords,chordInputSource,historyKeys,terminalZoom,editingCommands,contextMenu,tooltipView,windowAttention,menu,shellTitle,terminalWiring,agentWiring}.ts`,
  `shell/AppShell.tsx`, `shell/components/sidebar/*`,
  `shell/components/shell/{TitleBar,SurfaceState,SurfaceViewport}.tsx`,
  `shell/terminal/*`, `shell/surfaces/*`, `shell/pane/*`, `shell/tooltip/*`,
  `shell/styles/*` (as tokens).
- Depends on: WP2, WP3, WP8 (WP4 for facts; can stub). Parallel with: WP6, WP7.
- Accept: on macOS CI `--self-test` extended: private tmux server, a
  Workspace editor terminal attached and resized, Sidebar with Scratch + one
  Workspace + one Agent, `Cmd+Q Z` split, `Cmd+Q V` terminal. Manual parity
  checklist (screenshots vs TS) recorded in the PR.

### WP10 — Conversation UI (App) + Markdown/highlighting (Core) ~11k UI

- Scope: U-01…U-15, G-17 (UI), Markdown/highlight in Core.
- Port: `shell/conversation/*`, `shell/agents/{AgentPane,ConversationPane,AgentsApp,SmartButtons,AgentFailure}.tsx`.
- Depends on: WP5 (WP6 for Codex-specific UI), WP8, WP9 (pane host).
- Accept: every transcript in `transcriptFixtures.ts` / `adapterFixtures.ts`
  renders (snapshot images archived as CI artifacts); find over a synthetic
  1M-match transcript stays responsive; composer keys per §Keys.

### WP11 — Sheets, palette, notices, Settings window, voice (App) ~9k UI (done)

- Scope: Q-01…Q-04, K-05…K-07 (UI), N-01…N-04, P-05, WS-03, WS-04, WS-06 (UI),
  A-02 (UI), A-06 rename, A-10 review, A-11 sheet, X-06, U-16.
- Port: `shell/picker/*`, `shell/components/shell/{Picker,Wizard,wizardFlow,WorkspacePicker,ProjectSheets,AgentProfilePicker,SessionPicker,sessionRows,InjectionStatus,PathLabel}.tsx`,
  `shell/toasts/*`, `shell/notices.ts`, `shell/alertLifetime.ts`,
  `settings/*`, `main/shell/{settingsWindow,pickerView,toastsView,workspacePicker,appConditions,machineConditions,publishAudience}.ts`,
  `main/voice/*`, `shell/conversation/{dictation,useDictation}.ts`,
  `model/spokenText.ts`; whisper binary + model added to the bundle script.
- Depends on: WP1, WP2, WP8, WP9 (modal layer host). Parallel with WP10.
- Accept: every sheet reachable and keyboard-complete; Settings edits write
  the TOML in place (diff test); notices auto-hide/center rules unit-tested in
  Core (`NoticeCenter`, lifetime); dictation records and inserts text on CI
  with a WAV file fed to the client (no microphone).
- Status: Core holds the rules and words (`Sheets/`, `Model/NoticeBoard.swift`,
  `Settings/`, `Voice/`, `Usage/UsageFooter.swift`, with their tests, the
  Settings save checked as an in-place TOML diff); the App draws them
  (`DevHubApp/Sheets`, `Notices`, `Settings`, `Voice`, `Views/UsageFooterView`)
  as the real `ModalPresenting` / `NoticePresenting`, and the runtime
  assembles `GuiAgentWiring.wire`, `GitIssueAssigner` and
  `ControlExtras.native`. The self-test opens the palette, raises and puts
  away a notice, and draws every Settings screen on the live runtime.
  Dictation's stream is tested in Core with a scripted recogniser; feeding a
  WAV file to the App's capture on CI is not done (the CI runner has no
  `dist/whisper`).

### WP12 — SSH Workspaces in terminal-mode scope (Core + App) ~8k

- Scope: S-14 health, W-08 for SSH, Agents and Agent terminals on SSH hosts
  (remote tmux via the mux, `ssh -T` streaming for GUI Agents' journals),
  `~/.devhub-server/tmux/<version>/` install, SSH picker sheets.
- Port: `main/runtime/{ssh,remoteShellRuntime,remoteServer,connectivity,byteStream,tmuxDelivery}.ts`,
  `main/shell/sshHosts.ts`, `model/sshConfig.ts`, `shell/components/shell/SshSheets.tsx`.
- Depends on: WP3, WP5, WP9, WP11. Last; optional for the first release.
- Accept: against a container running sshd on macOS CI (or skipped): open an
  SSH Workspace, start a terminal Agent on the host, adopt it after restart.

### Dependency graph and waves

```text
WP0 ──┬─▶ WP1 ──(M1)──┬─▶ WP2 ───────────┬─▶ WP7 ──┐
      │               ├─▶ WP4 ───────────┤         │
      ├─▶ WP3 ────────┼──────────────────┼─▶ WP9 ──┼─▶ WP10 ─┐
      ├─▶ WP5 ────────┼─▶ WP6 ───────────┘         ├─▶ WP11 ─┼─▶ WP12
      └─▶ WP8 ────────┘                            └─────────┘
```

| Wave | Packages (parallel) | Starts when |
| --- | --- | --- |
| 1 | WP1, WP3, WP4, WP5, WP8 (+ WP7's msgpack/RPC/CLI-parser part) | now (WP3/WP4/WP8 consume WP1 M1 as soon as it lands; until then they may define what they need privately) |
| 2 | WP2, WP6, WP7 (rest) | WP1 M1 (WP2), WP5 (WP6), WP2+WP3 (WP7) |
| 3 | WP9, then WP10 and WP11 in parallel | WP2, WP3, WP8 (WP9); WP9 skeleton + WP5 (WP10); WP9 modal host (WP11) |
| 4 | WP12 | WP9, WP11 |

---

## 5. Conventions for agents

- Work on a branch `native-macos-wpN-<slug>` off `native-macos`; open a PR into
  `native-macos`. CI (`native.yml`) runs on both. Never commit the `vscode`
  submodule pointer; never touch `apps/`, `extensions/`, `scripts/` or the TS
  CI on this branch.
- Stay in your package's folders (§3.1). `Package.swift`, `PLAN.md` and
  `native.yml` changes are coordinated: keep them minimal and say so in the PR.
- No TypeScript or JavaScript in `native/`, including build steps (Python or
  shell scripts for one-time data conversion are fine; their output is
  checked in).
- Swift 6 language mode, strict concurrency clean, no warnings in Core.
- Every ported file names its TS source in its header comment
  (`// Port of apps/desktop/src/model/fuzzy.ts`). Keep the TS file's
  explanatory comments where they explain a decision; they are the spec.
- Tests: port the TS tests of what you port; run
  `docker run --rm -v "$PWD/native":/src -w /src swift:6.1-noble swift test`
  before pushing; macOS-only code under `#if canImport(AppKit)` or in
  `DevHubApp`.
- Wire compatibility (§1) is a test obligation, not a goal: fixtures from the
  TS side, checked in under `Tests/DevHubCoreTests/Fixtures/<area>/`.
- User-facing sentences (notices, refusals, sheet texts) are copied from TS
  verbatim unless they mention VS Code or the workbench.
