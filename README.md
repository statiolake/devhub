# DevHub

DevHub is a workspace- and agent-centred development environment for macOS, in
which a real VS Code editor is one surface among several rather than the centre
of the product. It ships that editor: VS Code's own desktop workbench, built
from a pinned submodule, running inside DevHub's window.

```text
DevHub
  ├─ Workspace management
  ├─ Agent orchestration
  ├─ Editor
  ├─ Terminal
  ├─ Issue          (later)
  └─ Pull Request   (later)
```

macOS first, Apple Silicon. This is a personal tool built for one workflow,
so it optimises for that workflow rather than for configurability.

## Shape

One window. A left pane of Workspaces, each with its Agents nested under it,
and one main surface on the right.

```text
┌───────────────┬───────────────────────┬──────────────┐
│           [▥] │                       │              │
│ Scratch       │                       │              │
│               │                       │              │
│ ▼ foo         │       Workbench       │  Agent pane  │
│    Claude 1 ● │                       │              │
│    Codex  2 ○ │                       │              │
│ ▼ bar         │                       │              │
│    Claude 1 ● │                       │              │
└───────────────┴───────────────────────┴──────────────┘
```

There is no title bar, no activity switcher, no subtitle strip and no status
bar. A Workspace **is** its workbench, full width and full height; the sidebar
is what the window is dragged by, and the one control on it collapses the
sidebar to an icon rail.

The left pane selects what you are working on, and that is the whole selection:

- select a Workspace → its workbench
- select an Agent → that same workbench, with the Agent's pane beside it on a
  divider you can drag; the ratio is remembered
- there is no separate Terminal: a terminal is the workbench's own integrated
  terminal, attached to the tmux session DevHub keeps for that context, so it
  survives quitting the app exactly as it always did

A Workspace with no Agents shows no disclosure and no child tree at all.

The workbench never appears in the left pane, because every Workspace has
exactly one and the Workspace node is its entry point.

## Domain

Workspace is the top concept, and it is deliberately none of the things it
resembles:

```text
DevHub Workspace != VS Code window != Git repository
```

A Workspace is a folder root — the same granularity as a VS Code window. A
normal clone and each linked worktree are separate Workspaces. Workspaces are
transient: they are what you have open now, discovered by fuzzy-finding
configured source directories rather than kept in a registry.

Internally a Workspace knows its Git remote, so that a future "paste an issue
URL and start working" flow can resolve which checkout to open.

### Scratch

Scratch is **today's daily folder**, and it is an ordinary Workspace: git or
not, with a workbench and Agents like any other. The one thing that is special
about it is which Workspace it is. The sidebar draws it as its fixed entry 1,
called "Scratch", with the real folder in its tooltip and its accessible name; `Cmd+Q Shift+J` and
`Cmd+Q 1` select it.

- **Which folder.** `[scratch] daily` in `settings.toml`, a path in the same
  date language a `workspace_sources` entry of type `date` takes: `YYYY`,
  `YY`, `MM`, `DD`, `MMDD` (and `HH` `mm` `ss`, which a daily folder cannot
  use), with `[text]` for text used as written. The default is
  `~/junk/YYYYMMDD`. A relative path, an unclosed bracket, a token hiding in a
  word (`summaries` has `mm` in it — write `[summaries]`), or a path that is
  not exactly one folder per day (no date at all, or a time in it) is refused
  as a settings failure (`invalid_scratch_daily` at `scratch.daily`), never
  passed through. `~` is this Mac's home. The folder is made when it is first needed.
- **Midnight.** At local midnight Scratch becomes the new day's folder,
  immediately. Yesterday's stays open as an ordinary row named by its folder
  (`20260922`), with its Agents and its workbench untouched, and closes like
  any row. Nothing running is affected. The timer aims at the next local
  midnight and is re-aimed on wake; a launch works Scratch out from the clock
  and the setting, so a state file from yesterday opens with yesterday's row
  and today's Scratch.
- **The setting it follows.** Scratch is always the folder today's date gives
  under the `[scratch] daily` DevHub is running on, like every other setting:
  a change to `settings.toml`, from the Settings window or from an edit to the
  file, moves Scratch to that folder at once. A settings file refused at launch
  leaves DevHub on the defaults, `~/junk/YYYYMMDD` included; one refused later
  leaves the last accepted settings in effect.
- **Closing.** Today's Scratch cannot be closed; it stops being Scratch at
  midnight instead.
- **Opens.** `devhub <file>` for a file no open Workspace contains,
  `devhub -`, `devhub --wait`, and any request for an empty window go to
  today's Scratch. A terminal or editor that belongs to a Workspace — yesterday's
  Scratch included — keeps sending its opens to that Workspace.
- **A folder that cannot be made** (a file in the way, no permission) leaves
  Scratch as an unavailable row with Retry and Locate…, and the reason is
  reported.

## Subsystems

**Editor** — VS Code's desktop workbench, from the pinned `vscode/` submodule,
built and shipped with DevHub. Each Workspace's workbench is one VS Code window
in every sense the workbench itself can observe, laid into DevHub's single
window as a `WebContentsView`. Extensions, settings, the integrated terminal
and the extension host are the real ones, on disk, with no "remote" semantics
anywhere.
A Workspace's editor area is its workbench. The one on screen starts at
launch and the other local ones after it, one at a time in the background; one
that is not on screen is frozen (its processes stopped, so the Mac compresses
or swaps them out first) unless it is in use, thawed instantly when shown,
asked for or connected to, and discarded after a long while frozen. Files
DevHub is asked to open go to the Workspace's workbench. See
[`docs/terminal-mode.md`](docs/terminal-mode.md) and
[`docs/window-and-pages.md`](docs/window-and-pages.md), "What it costs".

**Agents** — an Agent is a tmux session, with no runtime in between. It lives
on DevHub's own tmux socket, carries DevHub's own markers, and is attached by
the same `tmux attach-session` over the same PTY as every Workspace terminal,
so scrollback, copy mode, resize and byte-for-byte input are the terminal's
rather than an imitation of one. See
[`src/main/agent/sessions.ts`](apps/desktop/src/main/agent/sessions.ts).
A Claude Code or Codex Agent can instead be a **GUI Agent**: the same tmux
session runs the CLI in its structured mode, and DevHub draws the
conversation itself. See [`docs/agent-gui.md`](docs/agent-gui.md).
From the editor, **Send to Agent…** (the context menu, the Command Palette,
`Cmd+Alt+K`) puts the selection, with a reference to its file and lines, in
the input box of one of the Workspace's Agents, shown beside the editor — see
[Send the editor's selection to an Agent](docs/agent-gui.md#send-the-editors-selection-to-an-agent).

**Terminal** — tmux. One persistent session per Workspace — Scratch is one.
The workbench's own integrated terminal is attached to that same session, so
quitting DevHub does not end it. Each tmux server also has an anchor session
named `scratch`, which the bootstrap creates with the server so it carries
DevHub's marker from its first instant; it is not Scratch, nothing accounts
for it, and the startup sweep reaps it like any other session nothing accounts
for (which is also what happens to the old folderless Scratch's terminal).

## Architecture

VS Code is **consumed, never edited**. The whole of the integration is three
kinds of thing, and each has a rule:

- **Two entry points, copied.** `apps/desktop/src/main/main.ts` and
  `codeMain.ts` are adapted copies of upstream's `src/main.ts` and
  `src/vs/code/electron-main/main.ts`. Each carries a header listing every
  substitution it makes, so a VS Code bump is "re-apply exactly this list"
  rather than a diff nobody can read.
- **Composition, everywhere else.** DevHub subclasses and registers VS Code's
  own main-process services (`src/main/services/`), replaces the `BrowserWindow`
  constructor VS Code reaches for, and fences the process-wide `electron.app`
  calls a workbench is not entitled to make
  ([`shell/appFence.ts`](apps/desktop/src/main/shell/appFence.ts)).
- **Patches, only for what none of that can reach.**
  [`patches/vscode/`](patches/vscode) is the exception, and every patch states
  its own reason in its body. Each one is a hook upstream offers no other way
  to reach, and the set is kept as small as that allows. A patch changes only
  files upstream has; whole files DevHub adds to the tree (the Vim engine, the
  status bar hover) live as plain files under
  [`patches/vscode-overlay/`](patches/vscode-overlay), at the path they take in
  `vscode/`. `scripts/apply-vscode-patches.sh` puts both on the submodule
  (resetting vscode/ first, and doing nothing when the tree is already current); after editing either in `vscode/`,
  `scripts/vscode-submodule.sh export` writes the change back to the half it
  belongs to.

DevHub's own integration ships as a built-in extension,
[`extensions/devhub-bridge`](extensions/devhub-bridge), so that its workbench
defaults are in effect and cannot be uninstalled. It carries the workbench
defaults and the `devhub.installCli` palette command, and nothing else: the
websocket protocol it once spoke to a web-era editor server is gone.

GitHub Copilot is built in too, but only completions and Next Edit Suggestions.
Chat stays off. [`extensions/devhub-copilot`](extensions/devhub-copilot) runs
the Copilot language server and hands its suggestions to the editor's own
inline suggestion UI, so NES looks the way it does with the official extension.
It is off in every window until turned on there (**Copilot: Enable in This
Window** or its status item), and off means no language server at all; nothing
remembers it across a reload. Its README explains what that takes.

## Lifecycle

Window Close leaves the process, the agents and the tmux sessions running.
Quit stops DevHub but still leaves agents and tmux alive. Closing an Agent
destroys its session; an Agent that exits on its own disappears from the tree
immediately.

`Command+Q` is the only key DevHub takes from the workbench, as a prefix:
press it twice to quit. Everything else is forwarded to VS Code.

Main's console — every `[devhub] …` line, including each workbench lifecycle
transition and why a hidden one stays up or a discard was called off — is also appended to
`<userData>/logs/devhub-main.log` (timestamped; past 5 MB it becomes
`devhub-main.log.1`, one kept). `DevHub: Open Log` in the command palette
(`Cmd+Q :`) opens it in the app macOS uses for `.log` files (Console).

## The `devhub` command

`DevHub: Install 'devhub' command in PATH` writes a launcher that talks to the
running app over a unix socket in its user-data directory: `/usr/local/bin/devhub`,
or `~/.local/bin/devhub` when `/usr/local/bin` is not writable (a profile's own
DevHub installs `devhub-<profile>`). Run the command again after moving or
updating DevHub. DevHub also rewrites one on every start for its own agents, at
`devhub/agent-skill/bin/devhub` in its user-data directory
(`devhub --tell --json skill` prints its path as `cli`). A tool DevHub did not
start (Claude Desktop, a script) can run either by its full path, and needs
neither on its PATH. Everything the
command does happens inside the app: there is one instance, one extensions
directory and one editor, and a second process doing any of this behind the
first one's back is the state the single-instance design exists to prevent.

```sh
devhub <folder>                      # open it as a Workspace and show it
devhub <file>                        # open it in the Workspace that contains it
devhub -                             # open what is piped in, the way 'code -' does
devhub -w|--wait <file>              # ...and wait for its editor to close
devhub -g|--goto <file:line[:col]>   # ...with the cursor there
devhub --agent <profile> [-- <args>] # start an Agent in this directory's Workspace
devhub --install-extension <id|vsix> [--force]
devhub --uninstall-extension <id> [--force]
devhub --list-extensions [--show-versions]
devhub --version                     # DevHub, VS Code, and the commit
```

Which Workspace a path lands in is decided by the path, never by which window
was focused last: the open Workspace whose root is its nearest ancestor, and
today's Scratch when no open Workspace contains it (see [Scratch](#scratch)). The extension options
are VS Code's own `ExtensionManagementCLI`, run against the running app's
extension management service, so the gallery (Open VSX), the allow-list and the
built-in protections are the ones the app itself uses. An option `devhub` does
not know is refused with a sentence — it is never quietly treated as a path.

### `devhub --tell`: DevHub's own operations, by name

`devhub --tell <subcommand>` asks the running app to do what its window does,
through the same code the window uses. Text by default; `--tell --json` prints
data for scripts and agents. `devhub --tell help` lists everything.

**From outside DevHub.** `devhub --tell skill` prints the `/devhub` skill
(SKILL.md, for this DevHub's `devhub`; `--json` gives `{ text, cli }`): an agent
DevHub did not start (Claude Desktop, another tool) can read this to learn the
CLI. Such a caller has no workspace, agent or terminal of its own: it passes
`--workspace` where one is taken, the `terminal` commands refuse it, and
`agent wait --any` with no ids waits on every GUI agent. `--as NAME` (right
after `--tell`) names it — what it has read for `wait --any`, and who
"answered via devhub CLI by NAME"; without it every outside caller is one
reader, `external`. Inside DevHub `--as` is refused: the caller is its agent.

```sh
devhub --tell skill                                   # the /devhub SKILL.md, for agents DevHub did not start
devhub --tell skill --orchestrator                    # the /devhub-orchestrator SKILL.md (writing make-progress), for an orchestrator DevHub did not start
devhub --tell workspaces                              # open workspaces: id, folder, branch, worktree, Issue, PR, unresolved conversations, CI, agents
devhub --tell workspace status W                      # one workspace's Issue (lanes), PR (draft, review decision), unresolved conversations, CI counts, as of when (--json: under "github", null when unknown)
devhub --tell workspace open ~/src/app [--worktree 123-fix-login]   # Cmd+Q f
devhub --tell workspace close W [--worktree keep|remove] [--agents stop] [--terminals close] [--discard-unsaved]   # Close Workspace; each question the window would ask is a required flag when it applies
devhub --tell profiles                                # agent profiles: id, name, kind, --gui/--tui, the window's default, available (and why not)
devhub --tell agents [--workspace W] [--meta K=V]...  # id, name, kind, status and for how long, open requests, unread, context, meta
devhub --tell agent status A                          # one agent in detail (--json: a stable schema)
devhub --tell agent new --workspace W --profile P --gui|--tui --managed|--unmanaged [--name N] [--prompt TEXT|-] [--meta K=V]...   # Cmd+Q c
devhub --tell agent manage A | agent unmanage A       # under the orchestrator's management, or not
devhub --tell agent keep A --note TEXT | --clear      # leave an unsettled managed agent as it is, for a reason
devhub --tell agent rename A NAME | agent rename A --clear   # the row menu's Rename… (--clear: DevHub's label again)
devhub --tell agent meta A [set KEY VALUE | unset KEY]      # an agent's own key/value pairs
devhub --tell issue actions                           # Issue actions: id, label, wording (and none)
devhub --tell issue assign <url> --repo PATH --branch 123-fix-login-timeout|--root
              --profile P --gui|--tui --action ID|none --managed|--unmanaged
              [--name N] [--prompt TEXT|-] [--meta K=V]... [--offline]   # Cmd+Q i
devhub --tell issue assign <url> --repo PATH --branch NAME|--root --editor-only [--offline]
devhub --tell agent read A [--last N] [--since CURSOR] [--full]   # a GUI agent's transcript, with a cursor; long entries clipped and marked
devhub --tell agent read A --entry ID                 # one entry, whole (moves no cursor)
devhub --tell agent send A TEXT|-                     # held until its turn ends, like the composer
devhub --tell agent interrupt A
devhub --tell agent requests A                        # open questions (and permission prompts, read-only)
devhub --tell agent answer A REQUEST --option N... | --text T
devhub --tell agent answer A REQUEST --q 1 --option N... [--text T] --q 2 ...   # every question of a request at once
devhub --tell agent wait A [--until idle|waiting|any] [--timeout S]
devhub --tell agent wait --any|--all [A...] [--workspace W] [--until ...] [--timeout S]
devhub --tell agent stop A | agent restart A          # Stop Agent, Restart Session (no sheet: the command is the decision)
devhub --tell sessions [--workspace W | --folder PATH | --all] [--profile P] [--limit N] [--meta K=V]...   # earlier sessions, as the agent picker lists them, with their meta, folder and whether it is open (--all: every folder's, newest first)
devhub --tell session meta SESSION [set KEY VALUE | unset KEY]   # a stopped session's own key/value pairs
devhub --tell agent resume SESSION [--workspace W | --folder PATH] [--profile P] [--name N]   # one of them, in a new GUI agent (its meta and name given back), in its own folder: opened unfocused if closed, a gone worktree checked out again
devhub --tell commands | run <command-id>             # the command palette
devhub --tell focus A|W | notify TEXT
devhub --tell usage [--json]                          # each CLI's plan limits as the Sidebar shows them: per window % and reset, or no plan limits; last read and why not since (never reads itself)
devhub --tell orchestrator events [--last N] [--json]  # the orchestrator's recent events, one line each: delivered, pending, filtered, coalesced, dropped-stale
devhub --tell orchestrator emit --type custom.NAME --text TEXT|-   # a custom event, through the same filter and coalescing
devhub --tell orchestrator timer list | set NAME INTERVAL | clear NAME   # its timers (timer.elapsed), changed for this session
devhub --tell terminal open [--command C] [--focus]  # your own terminal, beside your pane (Cmd+Q v)
devhub --tell terminal status | show                 # open/visible/focused, tmux handle, every tmux pane and where
devhub --tell terminal close
```

`W` is a workspace's id, folder, name or `scratch`; `A` is an agent's id, a
unique prefix of it, or its name. The `terminal` commands are about the
asking agent's own terminal only — one per agent, a tmux session of its own
on the workspace's machine, drawn with its pane (right of it, or under it
beside the editor; never with the editor alone, and `visible` says so) — and
print the handle (`tmux` binary, `-S` socket, session, pane) an agent drives it with
(`send-keys -l`, `capture-pane -p`). See `docs/window-and-pages.md`. `issue assign` does what the Assign Issue
sheet does, with every answer given: the clone (`--repo`), a worktree of
`--branch` or the clone itself (`--root`; with `--branch`, switched to it),
the profile and its mode, and the Issue action (or `none`), whose wording
is sent as the agent's first message with no review sheet. `--name` names
the agent from the start, as `agent new --name` does (left out: DevHub's
label); the sheet does not ask for a name.
Both fetch `origin` once, first — before the Issue's branch is looked for,
a pull request's head is found or a new branch's base is chosen — and every
later step reads what that fetch left. A fetch that fails stops the
assignment with git's reason; the sheet then offers the copy on this
machine, and the command line takes it only with `--offline`.

**No defaults on the command line.** A `--tell` command that starts or
creates something takes every choice as a required argument — `agent new`:
`--workspace`, `--profile`, `--gui|--tui`, `--managed|--unmanaged`; `issue
assign`: `--repo`, `--branch|--root`, `--profile`, `--gui|--tui`,
`--action`, `--managed|--unmanaged` — because it is
called by agents, and what an agent gets must not move with the person's
settings or with which item is listed first. A call missing one does
nothing and names each missing flag with its values, from the same data
as `profiles` and `issue actions` (`--profile is required: claude, codex
(see devhub --tell profiles)`). `agent resume` opens the session where it
ran (its folder, or its worktree), so it needs `--profile` only when two
profiles run that session's CLI, and is always GUI. `workspace open` opens
the path, or with `--worktree` that branch's worktree: no setting is read.
The defaults left are fixed numbers (`agent read --last 20`, `agent wait
--timeout 300`, `sessions --limit 20`) and the caller's own workspace for
`sessions` and `agent resume` (`agent resume` then looks through every
folder's, as `sessions --all`; when more than one clone could check a gone
worktree out again it opens nothing and lists them for `--folder`). The
window keeps its settings-based defaults.

**`workspace close`** is the window's Close Workspace by the same intents,
with its sheets' questions as flags, each required only when it applies:
`--worktree keep|remove` for a worktree DevHub deletes on close (`remove`
on a dirty one is the sheet's Delete the worktree), `--agents stop` for
busy agents, `--terminals close` for running terminals, `--discard-unsaved`
for unsaved editors (named in the refusal). A call missing one closes
nothing and lists every open question with its values. Scratch and the
caller's own workspace are refused. Nothing is drawn and nothing is
focused; if the closed workspace was selected, the window selects the next
row by its own rule, as when a person closes it.

**No `--tell` command takes the window.** Only `focus` (and an explicit
`--focus`, as on `terminal open`) changes the selected Workspace or Agent,
what is shown, where the keyboard is, or brings DevHub to the front: what
`workspace open`, `agent new`, `issue assign` or `agent resume` make appears in
the Sidebar unselected, its workbench starting in the background
(`open_folder` / `create_agent` with `focus: "none"`). `run` runs
only the palette commands that move nothing (`refresh_repositories`,
`mark_agent_unread`). A person is doing something else.

**No `--tell` command puts a picker or a sheet up in the window.** Where the
window would ask, the command takes the answer as an argument; a palette
command that would open a picker or ask (`run add_agent`,
`run close_workspace`) is refused naming the `--tell` command to use. In the
window GUI or TUI has one default: the profile's `presentation`, else
`[agents] default_presentation` — what the agent picker's row shows for New
Agent and Assign Issue alike.

**Managed agents.** An agent is under the orchestrator's management when
it was started with `--managed` (or `agent manage A` said so later; `agent
unmanage A` takes it out). Only a managed agent's state is the
orchestrator's to hear of and keep settled (`docs/orchestrator.md`,
"Managed agents"); `agent keep A --note TEXT` leaves an unsettled one as it
is, for a reason, until its facts change; an agent the person starts in the window — New Agent,
Assign Issue — is not, and the orchestrator agent itself never is. The flag
is a field of the agent, kept in `state.json` and under its CLI session in
`session-meta.json` like its metadata, so a restart or a resume keeps it.
`agents`, `agent status` and `sessions` say `managed`, and the Agent row
carries the orchestrator's mark.

**Metadata.** `agent meta`, and `--meta KEY=VALUE` on `agent new` and
`issue assign`, keep an agent's own pairs — `role=reviewer`, `issue=123`,
`parent=<agent id>` — with it in `state.json` across restarts. A key is a
letter and up to 31 of `A-Z a-z 0-9 _ . -`, a value one line of up to 256
characters, 32 pairs an agent. They are in `agents --json` / `agent status
--json`, filter `agents --meta`, and show quietly in the Agent row's tooltip.
They outlive the agent: whenever they change, and when it is closed, DevHub
writes them (and the agent's name) down under its CLI session in
`session-meta.json` beside `state.json` (versioned, replaced whole by a
rename; the 500 most recently changed sessions, each forgotten after 180
days untouched). `sessions --meta K=V` finds past sessions by them,
`sessions --json` lists each session's `meta` (and `liveAgentId`, the agent
running it now), `session meta SESSION [set | unset]` tags a stopped one, and
`agent resume` — or the window's resume picker, Reopen Closed, `/resume` —
gives the new agent the session's pairs and given name back.

**Long entries.** `agent read` clips an entry at 2,000 characters and shows a
tool call's title without its output; such a line ends `(truncated, N chars;
devhub --tell agent read A --entry ID)`, and `--json` has `truncated: true`
and `length`. `--full` reads every entry whole, `--entry ID` one; `--entry`
leaves what the caller has read (`agent wait --any`) as it was.

Two things are deliberately not reachable from a command line. A **permission
prompt** (may this tool call run?) is the person's, in DevHub: `agent requests`
lists it as "answer in DevHub" and `agent answer` refuses it. Only questions —
Claude's AskUserQuestion, Codex's requestUserInput — can be answered, every
question of one request in one call (`--q` by index, id or header, each with
its own `--option`s and `--text`; `agent requests` lists them so, and a
question left out is refused), and the
answer carries a note, "answered via devhub CLI by <agent>", that Claude keeps
in the target's transcript. An agent cannot answer its own question.

**Orchestrating.** One ordinary agent can drive the others with these
commands. The Sidebar's **Orchestrator** row (above Scratch) gives one such
agent a screen of its own — a board of escalations the person answers, and
events DevHub sends it — with `devhub --tell
escalation`, `board` and `orchestrator` to drive it. The orchestrator ranks
each escalation (`escalation new|rank --priority high|normal|low --effort
quick|normal|deep --rank-note TEXT`), and 要回答 is sorted by priority, then
effort, then age. An escalation is 要回答 only while a question is its last
entry: the person's answer, the orchestrator's `escalation
hold ID [--note TEXT]`, or one of its agents going back to work moves it to
対応中 until `escalation ask` asks again. One waiting on something outside
(a date, a reply) is parked in 待機中 with `escalation wait ID --trigger
TEXT [--at DATETIME]`, its trigger always in words; the orchestrator hears of
it again at its time or when what it is about changes. DevHub holds the
orchestrator to one invariant — every open Issue assigned to you on the
watched boards has a working agent, a 要回答 or a 待機中 escalation, and every
managed agent is working or on one of those — and says each subject that
breaks it as an `unsettled` line of facts, batched at most every
`delivery_interval` (5m); the person's answers go at once, as typed. At
every start DevHub also gives the orchestrator its own short charter — drive
every assigned Issue to closed, never do hands-on work (the worker agents
read logs and fix), hand each delivered line to a background subagent and
return, keep the invariant, and DevHub's conventions. See
[`docs/orchestrator.md`](docs/orchestrator.md). `agent status` gives one agent's
state in one call: kind, profile, workspace, status and since when (as DevHub
saw it), the turn, last activity, open questions and permission prompts
(these as "answer in DevHub" only), entries the caller has not read and the
cursor, context use, the prompt cache, and why it exited or broke;
`agents --json` carries the same as each row's `state`. `agent wait --any`
returns as soon as one of the agents (by default every GUI agent but the
caller, or those of `--workspace`) has something the caller has not read: its
turn over with output after the caller's last `agent read`, or a request not
yet shown by `read` or `requests`, or a new failure — with which, why, the
cursor, and the `--since` to read from. The app keeps, per caller (an agent,
or the terminal it runs in), what `agent read` last showed it; that reading is
the one acknowledgement, so whatever happens between `wait`, `read` and
`send` is reported by the next wait rather than missed. `agent wait --all`
waits until every one is in the state (terminal agents too). `agent stop` and
`agent restart` are the row's Stop Agent (Retry Stop after a failed one) and
the menu's Restart Session: the window's confirmation is not shown — a busy
agent's turn stops, and an open terminal goes to the editor, the sheet's
first choice — but what the window refuses is refused, and an agent cannot
stop or restart itself. `sessions` lists what the agent picker offers to
resume (id, profile, when, title or agent name, branch or worktree), and
`agent resume` goes on with one the picker's way: here, or in its own
worktree, opened or checked out again.

**The `/devhub` skill.** Every agent DevHub starts on this Mac gets `/devhub`,
a skill that teaches it this command: open a workspace and an agent, hand an
Issue to a new agent with a descriptive branch name, watch the others with
`agent wait` / `agent read`, and answer their questions — delegating rather
than doing the work itself. DevHub writes the skill on every start into its
user-data directory (`devhub/agent-skill/`), beside a `bin/devhub` launcher for
this instance; nothing in `~/.claude` or `~/.codex` is touched. Claude (terminal
and GUI) is launched with `--add-dir=<that directory>`, from which Claude Code
loads `.claude/skills/devhub` as `/devhub`. A GUI Codex thread is started with
`developerInstructions` that point `/devhub` and `$devhub` at the same
SKILL.md. Terminal Codex agents and agents on SSH hosts do not get it.

## Configuration

One file: `settings.toml` in `~/.config/devhub/` (or
`$XDG_CONFIG_HOME/devhub/`). DevHub reads it and DevHub writes it — Settings
edits it in place, keeping the comments, grouping and order that are in it.

It was two files for a while, a shared `settings.toml` symlinked out of
dotfiles plus a `settings.local.toml` beside it. The dotfiles side generates
the file now, so the two layers were two answers to one question. A
`settings.local.toml` still on disk is folded in on the first start — tables
merged key by key, arrays replaced whole, exactly the rule that used to combine
them at read time — and then renamed to `settings.local.toml.migrated`. An
older `config.toml` is renamed into place the same way.

```toml
version = 3

[general]
notice_seconds = 8          # DevHub's own notices (a failure, `gh` missing) hide
                            # after this long into Notifications (Cmd+Q m); not
                            # while the pointer or keyboard is on one or its words
                            # are selected. 0: they stay. Settings > General.
terminal_idle_seconds = 5   # a Workspace row wears the Agents' working mark while a
                            # command (not the shell) in one of its tmux panes is
                            # printing, and their unread mark once it exits or prints
                            # nothing for this long while you are elsewhere — until
                            # you look at that pane. 0: only exiting counts. No ✓.
                            # Settings > General. See src/main/terminal/paneActivity.ts.
workbench_discard_minutes = 60  # a Workspace's editor that is not on screen is
                            # frozen at once (SIGSTOP) unless it is debugging,
                            # running a task or a terminal command, or talking
                            # over the network; this long frozen, it is closed
                            # (renderer, extension host, language servers) and
                            # reopens where it was, unsaved editors included (hot
                            # exit), on Enter. Agents and tmux stay. Never SSH or
                            # dev container editors. 0: never closed.

[appearance]
theme_dark = "Dark 2026"    # the VS Code colour theme DevHub wears in the dark
theme_light = "Light 2026"  # and the light appearance (`mode` picks; auto is the
                            # OS's): its window, its Agent panes (with
                            # terminal_theme = "vscode") and every editor, which is
                            # told to wear the same one — an editor's own theme
                            # picker or `workbench.colorTheme` does not override it.
                            # A built-in theme or one from an installed extension,
                            # by the name the picker shows or its id. Unset: VS
                            # Code's defaults. Settings > General > Appearance.
                            # Settings > General > Colour themes installs more
                            # from Open VSX into DevHub's own library (and its
                            # editors); "Theme: Preview…" wears one for the
                            # session only. The theme is published to the
                            # programs in DevHub's terminals (DEVHUB_THEME,
                            # DEVHUB_FZF_COLORS, ~/.local/state/devhub/theme.json,
                            # User DevhubTheme in the managed Neovim):
                            # docs/window-and-pages.md, Terminal programs.

[terminal]
mac_option_is_meta = false  # macOS Option in DevHub's terminals: false types the
                            # layout's characters (≈, @, {); true sends ESC+key for
                            # Alt mappings (Neovim <A-e>, readline, tmux M-); "left"
                            # only the left Option, the right one still composes.
                            # JIS: for \ via Option+¥ use "left" (right Option) or
                            # false. Not VS Code's
                            # terminal (terminal.integrated.macOptionIsMeta).
                            # Settings > Terminal. See docs/terminal-mode.md.

[scratch]
daily = "~/junk/YYYYMMDD"   # today's Scratch folder, in the date-source tokens

[projects]
directory = "~/dev/new"     # where New Project starts and the first folder Clone offers;
                            # absolute or ~/, no date tokens. Unset, it is the first
                            # folder source's path (or ~), and Clone offers the parents
                            # of what the sources find

[agents]
default_presentation = "tui" # how an Agent is shown when its profile does not say:
                            # "tui", the CLI in a terminal, or "gui", DevHub's
                            # conversation view. A kind without a GUI (cursor, custom)
                            # is a terminal either way. Settings > General.

[[agent_profiles]]
id = "claude"
display_name = "Claude"
kind = "claude"             # codex | claude | cursor | custom
presentation = "gui"        # optional override of [agents] default_presentation
                            # (gui for claude and codex only). Unset, the default.
                            # ⌘Return in New Agent, or in Assign Issue, opens one the
                            # other way. Both list "New Claude Session" first, then
                            # the earlier Claude and Codex sessions that ran in the
                            # folder, to go on with (--resume / thread resume).
                            # Assign Issue creates the Issue's worktree (or takes the
                            # existing folder) first, asks with New Agent's list for
                            # that folder, and opens it as a Workspace only with the
                            # agent; cancelling there leaves the worktree on disk. Its list also has
                            # "Just open the editor": the Workspace and editor, no agent.
                            # A GUI Agent runs its CLI in structured mode (`claude -p`
                            # stream-json, `codex app-server`) under a small host in its
                            # tmux session, so it outlives a DevHub restart like a TUI one.
                            # See docs/agent-gui.md.
```

### Agent actions and Smart Buttons

`[agent_actions.<trigger>.<id>]` is what DevHub says to an Agent on your
behalf: the wording is yours, what fires it is DevHub's. `issue` fires when an
Agent is started on an Issue. Every other trigger is a **Smart Button**: a
small button on an Agent's pane — on a GUI Agent's composer, in a terminal
Agent's bottom right corner — shown only while the Agent is idle and the
trigger's condition holds for the Workspace's repository, and gone on its own
when it stops holding. Pressing one queues the filled-in wording for the Agent,
exactly as the Agent actions sheet (`Cmd+Q Shift+A`) does; the sheet lists
every action whatever its `button` says. The buttons stand in a compact stack,
translucent until pointed at. Drag the box by its handle anywhere in the pane
(the place is remembered per kind of pane); brought within 16px of the input
box's top or right edge it snaps to it and stays anchored there as the input
box grows. Double-click the handle to put it back.

| Trigger                      | Shown when                                                                      | Variables                                 | Ships as                |
| ---------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------- |
| `issue`                      | (assigning an Issue; not a button)                                              | `ISSUE_URL`, `ISSUE_NO`                   | Work on the Issue       |
| `commit`                     | there are uncommitted changes                                                   | —                                         | Commit the changes      |
| `push`                       | the branch has commits its upstream does not                                    | `BRANCH`                                  | Push the commits        |
| `pull_request`               | a branch that is not the default one has no pull request (pushed or not)        | `BRANCH`                                  | Open a pull request     |
| `draft_pull_request`         | the branch's pull request is a draft                                            | `PR_URL`, `PR_NO`, `BRANCH`               | Get the draft PR ready  |
| `unresolved_review_comments` | its pull request is open or a draft and has unresolved review conversations     | `PR_URL`, `PR_NO`, `UNRESOLVED`, `BRANCH` | Address review comments |
| `ci_failing`                 | its pull request is open or a draft and CI is failing                           | `PR_URL`, `PR_NO`, `BRANCH`, `FAILING`    | Fix CI                  |
| `always`                     | the Agent is idle (no other condition; shown even if the repository is unknown) | —                                         | OK                      |

`always` buttons are hidden while a turn is running like the rest, and are never automatic (an always-true condition would fire on every idle). Hide the built-in OK button with `button = false` under `[agent_actions.always.send_ok]`, or write your own `[agent_actions.always.<id>]`.

`UNRESOLVED` reads `100+` when there were more threads than one page, and a
variable with nothing known stays as written. A trigger DevHub does not know is
refused.

**Automatic actions.** The bolt beside a Smart Button switches its action to
automatic for that one Agent (the header's bolt lists every action that can
be, with when it fires, for those whose button is not on screen yet): from
then on it is sent on its own at the moment its button would appear, as
though pressed — review comments arriving on the pull request are answered
without anybody pressing _Address review comments_. Only `commit`, `push`,
`unresolved_review_comments` and `ci_failing` actions can be automatic
(opening a pull request or readying a draft is a decision about when the work
is done). Every switch starts off, the choice is the Agent's and lasts for
this run of DevHub, and an automatic action's bolt is lit in the accent. Each
event is sent once: a condition starting to hold (CI going red again after a
run that passed, a pull request of its own), or for review comments more
unresolved threads than before — not every turn while the threads stay
unresolved. What was already on screen when it was switched on, and what you
sent yourself with the button, is not sent again. Nothing is sent while the
Agent is busy or has something waiting; the event waits until it is idle. With
no button offered and nothing switched on, the box shows only while the pane
is pointed at.

```toml
[agent_actions.ci_failing.fix_ci]   # a built-in: only what you change
button = false                      # not drawn as a Smart Button (default true);
                                    # still in the Agent actions sheet
confirm_before_send = true          # review the wording first (default false for
                                    # Smart Buttons, true for issue and your own)

[agent_actions.issue.issue_assignment]  # the Issue flow's action: its wording
confirm_before_send = false         # is the new agent's first message; true
                                    # (default) shows it for review first

[agent_actions.unresolved_review_comments.answer_reviewers]
display_name = "Answer the reviewers"
template = "{{PR_URL}} のレビューコメント {{UNRESOLVED}} 件に対応して。"
enabled = true                      # false hides a built-in without deleting it
order = 0                           # its place among the trigger's actions
```

The workbench's own settings are VS Code's, on disk under the app's user-data
directory. Runtime state lives separately under Application Support.

### `init.ts`: your own commands

`init.ts` beside `settings.toml` (`~/.config/devhub/init.ts`; a profile's own
config directory, `~/.config/devhub-dev/init.ts`, for another profile) is a
TypeScript file that defines commands, and only commands:

```ts
import * as vscode from "vscode";
import { defineCommand } from "devhub";

defineCommand(
  "user.copyFileName",
  async () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc) await vscode.env.clipboard.writeText(doc.fileName);
  },
  { title: "Copy File Name" },
);
```

Keys stay in `keybindings.json`, `:` commands in `devhub.vim.exCommands`, both
naming the `user.*` id. It runs in the local extension host at startup and
again when it is saved, without a reload. See [docs/init.md](docs/init.md).

## Not now

Issue and Pull Request surfaces, task composer, clone/worktree provisioning,
Dev Containers, SSH, multiple windows, Windows and Linux. They are second and
third development; the seams exist, the features do not.

## Development

pnpm at the version `packageManager` in `package.json` pins (`corepack
enable` picks it up). The Node the VS Code build requires is fetched into a
gitignored toolchain directory by provisioning; the machine default is not
used for it.

```sh
CI=true pnpm install --frozen-lockfile
pnpm run provision   # submodule, toolchain, patches, compile + bundle, Electron
pnpm dev             # build apps/desktop and run it
pnpm run check       # extension checks, format, lint, types, tests
pnpm test:local      # all of CI, locally (Linux too): see CONTRIBUTING.md
```

Type checking and the main-process build use `tsgo` (`@typescript/native-preview`,
TypeScript's Go port), pinned to an exact preview version: it is several times
faster and emits the same output as `tsc` 5.9. `typescript` stays installed for
eslint, vitest and the editor. If `tsgo` misbehaves, `pnpm --filter
@devhub/desktop run typecheck:tsc` runs the same check with `tsc`.

`pnpm build` skips what has not changed and says so, one line per step
(`reused …` / `rebuilt … (why)`): `compile-extensions-build` is stamped in
`vscode/.build/extensions.devhub-stamp` over the VS Code commit, the patches,
`vscode/extensions` sources, `builtInExtensions` and the Node version;
`node_modules.asar` is cached in `dist/.cache/asar/<key>/` over the production
closure's package files, the packer script and the Node version (delete either
to force a rebuild). The zip uses `zip -1` (`--zip-level 0-9|ditto`, or
`DEVHUB_ZIP_LEVEL`): about 2.5x faster than `ditto` for roughly 10% more bytes.
CI starts clean, so these only ever miss there.

Provisioning is idempotent and stamped over the submodule commit _and_ the
patches, so a bump or a patch edit recompiles and nothing else does. `--force`
redoes every step. The two VS Code trees are stamped separately and built only
for whoever needs them: `--for dev` compiles `vscode/out` (`npm run compile`,
what `pnpm dev` runs on), `--for app` bundles `vscode/out-vscode-min` (what the
packaged app ships), `--for all` (the default, `pnpm run provision`) does both.
`pnpm build` asks for `app` only; `pnpm dev` warns when `vscode/out` is behind
the patches and names `scripts/provision-vscode.sh --for dev`.

`vscode/` is not edited by hand and never needs resetting by hand. Every
provision (and so every `pnpm build`) resets it to the pinned commit plus the
current `patches/vscode/` and `patches/vscode-overlay/`, from whatever the
previous build, a `git pull` of new patches or a submodule bump left there: a
tree that already is that is left untouched (nothing rewritten, so no
recompile), anything else (an earlier apply, a file a build copied in) is taken
off and redone without asking, and ignored build output (`node_modules`,
`out*`, `.build`) is never touched. Every reset keeps the tree it replaced as a
commit in `vscode/` (`git -C vscode log -g refs/devhub/vscode-before-reset`),
so it can be looked at or restored. If you do edit `vscode/` to try a change,
run `scripts/vscode-submodule.sh export` (writes it into the patches and the
overlay) before the next build: a build discards whatever was not exported,
leaving only that backup.

Locally the bundle is the fast one (`DEVHUB_FAST_VSCODE_BUNDLE=1`, the default
unless `CI` is set): the desktop bundle alone, without `--mangle-privates`, and
an esbuild transpile into `vscode/out-build` for the main-process bundle instead
of `npm run compile` — about 2 minutes after a patch edit where it was 5, and
one bundle's memory (about 5 GB) where `core-ci`'s three parallel bundles passed 16.
`DEVHUB_FAST_VSCODE_BUNDLE=0` runs upstream's `npm run core-ci` exactly as the
nightly does; under CI a fast bundle is refused unless the run asks for one
by name (`DEVHUB_FAST_VSCODE_BUNDLE=1`), as the per-push test build does.

`pnpm dev` also builds the remote extension host for this Mac's CPU
(`linux-arm64` or `linux-x64`) when it is missing or stale — in Linux
containers, the way VS Code builds its own: the first time an hour or more on
Apple Silicon, then minutes; needs Docker. Without Docker, or if the build fails, it warns and starts anyway
(remote windows won't work until `scripts/build_reh.py <target>` succeeds).
`DEVHUB_SKIP_REH_BUILD=1 pnpm dev` skips it. The other three servers are listed,
not built; see [docs/remote-ssh.md](docs/remote-ssh.md).

The server builds are cached: finished tarballs per identity under
`~/.cache/devhub/reh`, and a Linux build tree per architecture in the Docker
volume `devhub-reh-work-<arch>`, so a patch-only change skips `npm ci` and
returning to a built identity builds nothing. `scripts/build_reh.py
--prune-cache [--keep N]` cleans the first, `--reset-work` the second; see the
build section of [docs/remote-ssh.md](docs/remote-ssh.md).

`pnpm dev` runs under the `dev` profile, so a source build and the packaged
DevHub can be open at the same time — which is what makes developing DevHub
inside DevHub possible. `DEVHUB_PROFILE` is the whole switch: unset (every
packaged run) is the default profile, on exactly the locations DevHub has
always used, and any other name derives a complete, disjoint set of them —
`~/Library/Application Support/DevHub Dev/` for the editor's user data and
extensions, `~/.config/devhub-dev/` for the settings, the `devhub-dev` tmux
socket, its own control socket, and a `devhub-dev` command in the PATH.
`src/model/profile.ts` derives all of it from the one name.

A new profile's first launch copies the default profile's `settings.toml` in,
so it starts configured rather than empty, and says so in the log. It is a
copy: the two are meant to drift. One setting a profile does not take from that
copy is
`runtimes.tmux_socket_name`: a second DevHub on the first one's tmux server
would manage the first one's sessions, so the profile's socket wins and the
override is logged.

## Building the app

```sh
pnpm build
```

From a fresh clone that is the whole procedure: it installs the workspace,
provisions the VS Code submodule (checkout, the Node the submodule's build
pins, `npm ci`, DevHub's patches, the bundled VS Code, Electron) and assembles

```text
dist/DevHub.app
dist/DevHub-darwin-arm64-<date>-<sha>.zip
```

signed ad-hoc — enough for macOS to run a modified bundle, not enough to skip
`xattr -d com.apple.quarantine` on a bundle that has travelled. The build does
not start what it just made: a running DevHub takes over the machine's tmux
socket and its Agents, and nobody asks for that by typing `pnpm build`. The
check that a bundle which assembles can also run is `pnpm run smoke`
(`scripts/smoke_packaged_app.py dist/DevHub.app`), which starts the bundle
under a throwaway `smoke` profile and asks it something over its control
socket. CI runs it on every bundle it packages.

What has to be on the machine first: macOS on Apple Silicon, the Xcode command
line tools (`xcode-select --install`), `python3`, Node, and pnpm (`corepack
enable` gives the version `package.json` pins). The machine's
own Node version does not matter — the one VS Code's build insists on is
fetched into `vscode-toolchain/`. Anything else missing, `pnpm build` produces
rather than complains about. That includes the four remote extension hosts in
`dist/reh`: any that is missing or stale is taken from the local server cache
(`~/.cache/devhub/reh`), else downloaded — verified — from the prebuilt servers
the nightly publishes on the `reh` release when one matches this checkout's
identity, else built with `scripts/build_reh.py <those targets>`, announced up
front (in Linux containers; the first build of each architecture's tree takes an
hour or more on Apple Silicon, see [docs/remote-ssh.md](docs/remote-ssh.md); log
in `dist/reh-build.log`). Each server says which of the three it came from, and a
failed download only falls back to the build. `DEVHUB_REH_SOURCE=build pnpm
build` never downloads; `DEVHUB_REH_SOURCE=download` fails rather than build
(`scripts/ensure_reh.py --no-download` / `--download-only` on their own). A
build needs **Docker**; without it the build
stops and names the missing targets. `pnpm build -- --without-reh` skips them
for a bundle that opens no remote window. Under CI (`CI` set) nothing is built:
the nightly downloads the servers its own jobs built.

The first build is roughly **40–60 minutes**, nearly all of it VS Code's `npm
ci` and its two compiles. Those are stamped, so a later build that changes only
DevHub's own code is **about a minute**, and a submodule bump or a patch edit
puts the long part back.

The nightly workflow runs this same `pnpm build`; what it adds is a cache of
the provisioned submodule, the tests against the packaged zip, and publishing
it. The per-push CI builds a stripped-down test build instead
(`--without-reh --without-whisper --no-zip`); see [docs/ci.md](docs/ci.md)
for which checks run where.

DevHub's product identity is stated once, in
[`apps/desktop/product-overrides.json`](apps/desktop/product-overrides.json),
and merged into `product.json` by
[`scripts/product_metadata.py`](scripts/product_metadata.py) for both the source
run and the packaged app.

DevHub is distributed under the [MIT License](LICENSE).
