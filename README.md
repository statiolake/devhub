# DevHub

DevHub is a workspace- and agent-centred development environment for macOS,
built terminal-first: every Workspace is its tmux session, and the editor is
Neovim, drawn by DevHub over the terminal it runs in. It is an Electron app of
its own; it used to be built inside a patched VS Code, and that is gone
([docs/without-vscode.md](docs/without-vscode.md)).

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
│ ▼ foo         │  Workspace terminal   │  Agent pane  │
│    Claude 1 ● │  (+ its Neovims)      │              │
│    Codex  2 ○ │                       │              │
│ ▼ bar         │                       │              │
│    Claude 1 ● │                       │              │
└───────────────┴───────────────────────┴──────────────┘
```

There is no activity switcher, no subtitle strip and no status bar. A
Workspace **is** its terminal — its `ws-` tmux session — full width and full
height, with every Neovim in it drawn by DevHub's GUI over its pane; the
sidebar's one control collapses it to an icon rail.

The left pane selects what you are working on, and that is the whole selection:

- select a Workspace → its terminal
- select an Agent → that same terminal, with the Agent's pane beside it on a
  divider you can drag; the ratio is remembered
- a terminal is a tmux session DevHub keeps for that context, so it survives
  quitting the app

A Workspace with no Agents shows no disclosure and no child tree at all.

## Domain

Workspace is the top concept, and it is deliberately none of the things it
resembles:

```text
DevHub Workspace != Git repository
```

A Workspace is a folder root. A
normal clone and each linked worktree are separate Workspaces. Workspaces are
transient: they are what you have open now, discovered by fuzzy-finding
configured source directories rather than kept in a registry.

Internally a Workspace knows its Git remote, so that a future "paste an issue
URL and start working" flow can resolve which checkout to open.

### Scratch

Scratch is **today's daily folder**, and it is an ordinary Workspace: git or
not, with a terminal and Agents like any other. The one thing that is special
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
  (`20260922`), with its Agents and its terminal untouched, and closes like
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

**Editor** — Neovim. A Workspace's editor area is its terminal, and every
Neovim in it — `nvim` typed in any DevHub terminal, `git commit`'s, and the
`devhub-nvim` window files DevHub is asked to open go to — is DevHub's own GUI
drawn over its tmux pane: Neovim's UI protocol drawn natively, with GUI
windows that live inside Neovim windows. See
[`docs/neovim-editor.md`](docs/neovim-editor.md).

**Agents** — an Agent is a tmux session, with no runtime in between. It lives
on DevHub's own tmux socket, carries DevHub's own markers, and is attached by
the same `tmux attach-session` over the same PTY as every Workspace terminal,
so scrollback, copy mode, resize and byte-for-byte input are the terminal's
rather than an imitation of one. See
[`src/main/agent/sessions.ts`](apps/desktop/src/main/agent/sessions.ts).
A Claude Code or Codex Agent can instead be a **GUI Agent**: the same tmux
session runs the CLI in its structured mode, and DevHub draws the
conversation itself. See [`docs/agent-gui.md`](docs/agent-gui.md).

**Terminal** — tmux, DevHub's own: tmux 3.7c inside the app (`out/tmux`,
the same build an SSH host is given), never the `tmux` on your PATH, which
DevHub's panes also find first ([`docs/terminal-mode.md`](docs/terminal-mode.md),
"DevHub's tmux"). One persistent session per Workspace — Scratch is one.
It is what the Workspace shows, so quitting DevHub does not end it. Each tmux server also has an anchor session
named `scratch`, which the bootstrap creates with the server so it carries
DevHub's marker from its first instant; it is not Scratch, nothing accounts
for it, and the startup sweep reaps it like any other session nothing accounts
for (which is also what happens to the old folderless Scratch's terminal).

## Architecture

One Electron app (`apps/desktop`), on npm's Electron at the version
`apps/desktop/package.json` pins. Main is `src/main/main.ts`; the pages are
React, built by Vite; the work that would hold main up runs in utility
processes (the process host, the pty host with node-pty, the Neovim host, the
conversation engine) — see [docs/process-model.md](docs/process-model.md) and
[docs/window-and-pages.md](docs/window-and-pages.md).

DevHub runs only the binaries it bundles or delivers — Neovim, bash, tmux,
the `devhub` command, Electron's Node — never a `node`, `bash` or `tmux` that
happens to be installed; what it does run of the system's or the person's
(`/bin/sh`, ssh, git) is listed with the reason in
[docs/bundled-binaries.md](docs/bundled-binaries.md).

## Lifecycle

Window Close leaves the process, the agents and the tmux sessions running.
Quit stops DevHub but still leaves agents and tmux alive. Closing an Agent
destroys its session; an Agent that exits on its own disappears from the tree
immediately.

`Command+Q` is DevHub's chord prefix: press it twice to quit.

Main's console — every `[devhub] …` line — is also appended to
`<userData>/logs/devhub-main.log` (timestamped; past 5 MB it becomes
`devhub-main.log.1`, one kept). `DevHub: Open Log` in the command palette
(`Cmd+Q :`) opens it in the app macOS uses for `.log` files (Console).

## The `devhub` command

**DevHub: Install 'devhub' command in PATH**, in DevHub's command palette
(`Cmd+Q :`, `install_cli`) whichever editor the Workspace has, writes a
launcher that talks to the
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
devhub --version                     # DevHub, and the commit
```

Which Workspace a path lands in is decided by the path, never by which window
was focused last: the open Workspace whose root is its nearest ancestor, and
today's Scratch when no open Workspace contains it (see [Scratch](#scratch)). An option `devhub` does
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
devhub --tell workspace open ~/src/app [--worktree BRANCH]   # Cmd+Q f; --worktree: BRANCH's worktree, made from origin's default if need be (no Issue needed: docs/orchestrator.md, "Work with no Issue yet")
devhub --tell workspace close W [--worktree keep|remove] [--agents stop] [--terminals close] [--discard-unsaved]   # Close Workspace; each question the window would ask is a required flag when it applies
devhub --tell profiles                                # agent profiles: id, name, kind, --gui/--tui, the window's default, available (and why not)
devhub --tell agents [--workspace W] [--meta K=V]...  # id, name, kind, status and for how long, open requests, unread, context, meta
devhub --tell agent status A                          # one agent in detail (--json: a stable schema)
devhub --tell agent new --workspace W --profile P --gui|--tui --managed|--unmanaged [--name N] [--prompt TEXT|-] [--meta K=V]...   # Cmd+Q c
devhub --tell agent manage A | agent unmanage A       # under the orchestrator's management, or not
devhub --tell agent keep A --note TEXT | --clear      # leave a managed agent that needs action as it is, for a reason
devhub --tell status ITEM|A                           # one subject's whole state: an item (owner/repo#N, URL) or an agent (--json)
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
the Sidebar unselected
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
"Managed agents"); `agent keep A --note TEXT` leaves one that needs action as it
is, for a reason, until its state changes (kept across restarts); an agent the person starts in the window — New Agent,
Assign Issue — is not, and the orchestrator agent itself never is. The flag
is a field of the agent, kept in `state.json` and under its CLI session in
`session-meta.json` like its metadata, so a restart or a resume keeps it.
`agents`, `agent status` and `sessions` say `managed`, and the Agent row
wears a pale wash of the orchestrator's accent (its tooltip says "Managed by
the orchestrator").

**Metadata.** `agent meta`, and `--meta KEY=VALUE` on `agent new` and
`issue assign`, keep an agent's own pairs — `role=reviewer`, `ticket=123`,
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
orchestrator to one invariant — every open item assigned to you on the
registered Projects (an Issue or a pull request card: one thing to DevHub;
none registered, none) has a working agent, a
要回答 or a 待機中 escalation, and every managed agent is working or on one
of those — and says each subject that
breaks it as a `needs_action` line — the subject and the clause it fails,
`[needs_action] issue=acme/web#123 ws=web — no_agent`, never its state, which
`devhub --tell status <subject>` gives in one call — batched at most every
`delivery_interval` (5m); the person's answers go at once, as typed. At
every start DevHub also gives the orchestrator its own short charter — drive
every assigned item to closed, never do hands-on work (the worker agents
read logs and fix), hand each delivered line to a background fork subagent
and return, keep the invariant, and DevHub's conventions. See
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

[appearance]
theme = "light:DevHub Light,dark:DevHub Dark"
                            # the colour theme DevHub wears: its window, its
                            # terminals and the Neovims it draws. One name for
                            # both appearances, or light:<name>,dark:<name>
                            # (`mode` picks; auto is the OS's). 267 built-in
                            # themes (iTerm2-Color-Schemes, as Ghostty ships
                            # them) or your own [themes.<name>] below.
                            # "Theme: Preview…" wears
                            # one for the session only. docs/themes.md.

[themes."My Theme"]         # a theme of your own: background, foreground and a
background = "#1e1e2e"      # 16-colour palette (ANSI 0-15); cursor, cursor_text,
foreground = "#cdd6f4"      # selection_background, selection_foreground optional.
palette = ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7",
           "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
           "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]

[terminal]
mac_option_is_meta = false  # macOS Option in DevHub's terminals: false types the
                            # layout's characters (≈, @, {); true sends ESC+key for
                            # Alt mappings (Neovim <A-e>, readline, tmux M-); "left"
                            # only the left Option, the right one still composes.
                            # JIS: for \ via Option+¥ use "left" (right Option) or
                            # false.
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

Runtime state lives under Application Support (`<userData>/devhub/state.json`).

## Not now

Issue and Pull Request surfaces, task composer, clone/worktree provisioning,
Dev Containers, SSH, multiple windows, Windows and Linux. They are second and
third development; the seams exist, the features do not.

## Development

pnpm at the version `packageManager` in `package.json` pins (`corepack
enable` picks it up), and Node from `.nvmrc`.

```sh
CI=true pnpm install --frozen-lockfile
pnpm dev             # build apps/desktop and run it
pnpm run check       # format, lint, types, tests
pnpm test:local      # all of CI, locally (Linux too): see CONTRIBUTING.md
```

That is the whole set-up: there is nothing to provision. npm's Electron is
downloaded the first time anything asks `apps/desktop/scripts/electron-path.sh`
for it, and node-pty ships prebuilt binaries.

Type checking and the main-process build use `tsgo` (`@typescript/native-preview`,
TypeScript's Go port), pinned to an exact preview version: it is several times
faster and emits the same output as `tsc` 5.9. `typescript` stays installed for
eslint, vitest and the editor. If `tsgo` misbehaves, `pnpm --filter
@devhub/desktop run typecheck:tsc` runs the same check with `tsc`.

`pnpm dev` runs under the `dev` profile, so a source build and the packaged
DevHub can be open at the same time — which is what makes developing DevHub
inside DevHub possible. `DEVHUB_PROFILE` is the whole switch: unset (every
packaged run) is the default profile, on exactly the locations DevHub has
always used, and any other name derives a complete, disjoint set of them —
`~/Library/Application Support/DevHub Dev/` for the user data,
`~/.config/devhub-dev/` for the settings, the `devhub-dev` tmux socket, its
own control socket, and a `devhub-dev` command in the PATH.
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

From a fresh clone that is the whole procedure: it installs the workspace
(npm's Electron among it), builds DevHub and assembles

```text
dist/DevHub.app
dist/DevHub-darwin-arm64-<date>-<sha>.zip
```

signed ad hoc — enough for macOS to run a modified bundle, not enough to skip
`xattr -d com.apple.quarantine` on a bundle that has travelled; it is not
notarized. The build does not start what it just made: a running DevHub takes
over the machine's tmux socket and its Agents. The check that a bundle which
assembles can also run is `pnpm run smoke`
(`scripts/smoke_packaged_app.py dist/DevHub.app`), which starts the bundle
under a throwaway `smoke` profile, asks it something over its control socket
and opens a file in its editor. CI runs it on every bundle it packages.

What has to be on the machine first: macOS on Apple Silicon, the Xcode command
line tools (`xcode-select --install`), `python3`, Node, and pnpm. The speech
recogniser (`dist/whisper`) is built by `scripts/build_whisper.py` when
missing — it needs cmake — or left out with `pnpm build -- --without-whisper`.
The layout of the bundle is in `scripts/package-nightly.py`.

DevHub's product identity is stated once, in
[`apps/desktop/product.json`](apps/desktop/product.json); the packaged app's
copy adds the version and the commit
([`scripts/product_metadata.py`](scripts/product_metadata.py)).

DevHub is distributed under the [MIT License](LICENSE).
