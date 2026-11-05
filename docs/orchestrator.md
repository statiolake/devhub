# The Orchestrator row: the board, escalations and events

One agent can coordinate the others through `devhub --tell` (see the README,
"Orchestrating"). The Orchestrator row gives that agent a place in the window
and gives the person a board of what it needs from them. DevHub supplies the
**mechanism** — the row, the board, escalations, events, the invariant it
reports — and its own short **charter** (what the orchestrator is for, that
it never does hands-on work, that it routes each line to a subagent, and
DevHub's conventions; see "The charter"). Everything else — what the
orchestrator does for the team, how it decides what to escalate and how it
writes — is the person's own, in skills and instructions in the
orchestrator's folder.

```text
┌───────────────┬──────────────────────────┬────────────────────────┐
│ Orchestrator 3│ Board         Events ●   │                        │
│    research ● │ ● 要回答 3               │  the orchestrator      │
│ Scratch       │   #1 本番 invoices …  1m │  agent's own pane      │
│ ▼ payments    │ ● 対応中 2               │  (an ordinary GUI or   │
│    Claude ●   │   #2 決済リトライ …      │   terminal Agent)      │
│ ▼ web-console │                          │                        │
│    Claude ○   │                          │                        │
└───────────────┴──────────────────────────┴────────────────────────┘
```

## The row and the screen

- **The row** is the Sidebar's first, above Scratch. It ends with the number
  of escalations waiting for an answer (the one filled badge in the Sidebar).
  The orchestrator agent's status mark sits before it. The orchestrator agent is
  drawn on this row only, not under its Workspace.
- **The row is its Workspace's row**, the way Scratch's row is Scratch's
  Workspace's (`AppModel.orchestratorWorkspaceId`, `orchestratorWorkspaceId`
  on the wire). The orchestrator's folder is never an ordinary row: its other
  agents — helpers the person or the orchestrator start there — are listed
  under the Orchestrator row with the tree every Workspace's agents use
  (indentation, status marks, unread, the row menu, drag within the row), and
  its `+` starts one there. Selecting one shows its pane as usual. The
  Workspace is labelled `Orchestrator` (the window title, `workspaces`, the
  board's chips), takes no digit (`Cmd+Q 1` is still the first row below
  Scratch), and is walked by `Cmd+Q N`/`]` through its helpers only. Closing
  its last helper lands on the row.
- **Which Workspace that is** is read, never stored: the orchestrator agent's
  Workspace while one is assigned, else the open Workspace on this Mac at
  `[orchestrator] root` (main resolves `~` and symlinks and tells the model,
  `orchestrator_root_resolved`). Never Scratch. So a root that was already
  open as an ordinary row — persisted by the earlier design, or opened by
  hand — becomes the Orchestrator row's on startup with no duplicate, and
  `state.json` is unchanged (an older DevHub reads it as an ordinary row).
- **Changing `root` while one runs** changes nothing at once: the running
  orchestrator's Workspace stays the row's while its agent is assigned. Once
  it has stopped, the Workspace at the new root (if one is open) is the row's,
  and the one at the old root is an ordinary row again. An orchestrator
  started with a `--root` other than the setting is the same: its folder is
  the row's while it runs.
- **Its editor** (the root's VS Code, for skills and `decisions.md`) is the
  Workspace selected: the content area is its workbench, as Scratch's is
  when Scratch is selected, and the Orchestrator row stays the highlighted
  one. It is reached by the row's right-click **Show Editor**, by the Files
  tab's **エディタで開く** (which opens the folder first, unselected, when it
  is not open, rather than sending the file to Scratch), by `devhub <file>`
  inside the root, and by a `devhub:file` link. A click on the row goes back
  to the board.
- **Selecting it** shows the Orchestrator screen: the board on the left, the
  orchestrator agent's pane on the right. It is the Agents view over the whole
  content area (`NavigationContext` `orchestrator`, `SurfaceLayout`
  `orchestrator`): the page divides its own rectangle, so no new
  `WebContentsView`, z-order or keyboard rule was needed. Selecting the
  orchestrator agent any other way (a chord, `focus A`) selects the row.
- **`Cmd+Q Shift+O`** (`toggle_orchestrator`, "Navigate: Orchestrator" in the
  command palette, rebindable like every chord) goes to the screen, and
  pressed again there goes back to where you were — `Cmd+Q Shift+J`'s toggle
  for Scratch, with a way back of its own (`AppModel.togglePlace`). Both
  directions enter Back and Forward's history at once, as a click on the row
  does. With no orchestrator assigned it still opens the screen, which offers
  Start. The bare `Cmd+Q O` stays the pane step.
- Start opens `root` as the row's Workspace (nothing selected), so the
  orchestrator's skills and instructions are an editor click away.
- With no orchestrator, the right half says so and offers **Start
  Orchestrator**, from `[orchestrator]` below (in `~/orchestrator` unless
  `root` says otherwise; the folder is made if it is missing).
- Freezing and Back/Forward are unchanged: its helpers are Agents and its
  editor is a Workspace's workbench, frozen, thawed and entered in the
  history as Scratch's are; an entry for one of them highlights the
  Orchestrator row as its own selection does.
- A restart opens on Scratch rather than on this row: the row is not written
  into `state.json`, so an older DevHub can still read the file.
- **The window title** says what the screen shows, for time trackers
  (`main/shell/shellTitle.ts`; the page reports only an escalation id or a
  file path, `reportOrchestratorView`, and main composes the title):

  | Showing                              | Title                                                                   |
  | ------------------------------------ | ----------------------------------------------------------------------- |
  | the board, or the Files tab's tree   | `Orchestrator — DevHub`                                                 |
  | an escalation                        | `payments · 本番DBマイグレーション承認 — Orchestrator — DevHub`         |
  | an escalation, Workspace on an Issue | `payments #123 · 本番DBマイグレーション承認 — Orchestrator — DevHub`    |
  | an escalation, Workspace on a PR     | `payments PR #130 · 本番DBマイグレーション承認 — Orchestrator — DevHub` |
  | an escalation with no Workspace      | `本番DBマイグレーション承認 — Orchestrator — DevHub`                    |
  | a file in the Files tab              | `decisions.md — Orchestrator — DevHub`                                  |
  | a helper agent under the row         | as any Agent: `helper — Orchestrator — DevHub`                          |

  The Workspace is the escalation's own, else its first agent's (by its
  usual label; not the Orchestrator's own), so the time lands on that
  project. That Workspace carries its Issue as everywhere else in the title
  — `#123`, `owner/repo#123` when the Issue is in another repository,
  `PR #130` on a pull request's branch with no Issue, nothing when none is
  known ([window-and-pages.md](window-and-pages.md#the-windows-title)). The
  subject and file name are put on one line and cut near 80 characters; no thread or answer text is ever in the title. It follows
  every open, Back, Forward and tab, and the screen coming back as it was.

## Escalations

An escalation is a request for a human decision or permission, raised by the
orchestrator when work cannot go on without one. It is a **thread**:

```text
{ id, title, entries: [{ role: orchestrator|human, markdown, at, options?,
                          kind?: direct|resumed|held|wait, agent?, dueAt? }],
  agents: [agent ids], workspaceId?, links: [urls], createdAt, updatedAt,
  closed?: { at, note? } }
```

Its state is **read off the thread** (`model/escalations.ts`), never stored,
by **one rule**: it is 要回答 exactly while the last entry is a question, and
待機中 exactly while the last entry is the orchestrator's wait.

| state          | when                                                                                     | lane   |
| -------------- | ---------------------------------------------------------------------------------------- | ------ |
| `needs_answer` | the last entry is a question (the orchestrator's, no `kind`)                             | 要回答 |
| `waiting`      | the last entry is the orchestrator's `kind: "wait"` (its trigger in words, maybe a time) | 待機中 |
| `in_progress`  | anything else is last                                                                    | 対応中 |
| `closed`       | closed (`escalation close`)                                                              | hidden |

Whatever comes after a question or a wait takes it to 対応中, and only another
question (`escalation ask`) brings it back to 要回答, another wait
(`escalation wait`) to 待機中; once the matter is done the orchestrator
closes it. 待機中 is left by `escalation ask` (要回答), the person's answer,
`escalation resume ID [--note TEXT]` (a `held` entry) or one of its agents
going working (a `resumed` / `direct` note, as from 要回答; a maintenance
turn is not work) — all to 対応中 — or a close. (A thread from before may also hold a `taken`
entry, role `human`, from a 対応中にする the window no longer has: it still
counts as "anything else", and shows as the neutral line
「対応中になりました（{time}）[: note]」. Nothing writes one now.) What can
come after a question (`role` is whose
side it is on; only the window writes `human` entries):

| entry             | role           | written by                                                                                                                                                                                                                                        | thread shows                                                                                                |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| an answer         | `human`        | the person, in the board's composer                                                                                                                                                                                                               | their Markdown                                                                                              |
| `kind: "held"`    | `orchestrator` | `escalation hold ID [--note TEXT]`: parked while it works on it (e.g. more investigation delegated), from 要回答, or a note of where the work stands, in 対応中; `escalation resume ID [--note TEXT]`, off its wait, from 待機中. Never an answer | 「オーケストレーターが対応中にしました（{time}）[: note]」                                                  |
| `kind: "wait"`    | `orchestrator` | `escalation wait ID --trigger TEXT [--at DATETIME]` (or `escalation new … --wait TEXT [--at DATETIME]`): parked on an outside condition. The trigger is required and never empty; `--at` (ISO) when it is a time (`dueAt`)                        | 「オーケストレーターが待機中にしました（{time}）: trigger[（M/D HH:MM まで）]」                             |
| `kind: "direct"`  | `human`        | DevHub: one of its `agents` went from idle (or stopped on a question) to working on the person's message from **that agent's own composer** (the conversation IPC's submit: not `agent send`, not an event or a template)                         | 「人が {agent} と直接やりとりしました（{time}）— 内容はエージェントの会話を参照」, with a chip to the agent |
| `kind: "resumed"` | `orchestrator` | DevHub: one of its `agents` went working for any other reason (the orchestrator's `agent send`, an injected event, DevHub's own resume after a usage limit)                                                                                       | 「{agent} が作業を再開しました（{time}）— 回答待ちは一旦解除」                                              |

The notes (`kind`) have no answer in them: `escalation show` prints them as
notes, and `agent wait --any` does not report them as answered. DevHub
writes `direct` / `resumed` (`OrchestratorService`) only on a 要回答 or 待機中 one; the
orchestrator is told of the person's direct words (`escalation.human_direct`, also for one already 対応中: what was
said may answer or change it), not of `held` (its own) or `resumed` (it
caused it itself).

**A maintenance turn is not work.** A turn that only compacts the
conversation — DevHub's keep-warm `/compact` just before the prompt cache
goes cold (`CacheKeeper`, sent with origin `auto-compact`), or a `/compact`
the person typed — writes no `direct` / `resumed` note, tells no
`escalation.human_direct`, does not count as working for the invariant, keeps the agent's
stalled stretch (停滞 is not re-armed), and does not notify
"finished". It is recognised by what started the turn, never by how long
it ran: one predicate, `isMaintenanceTurn` (`model/conversation.ts`), reads
the last top-level message since the last turn's end (a `/compact` command
entry, echoed or drawn at the turn's end), else the oldest message written
and not yet taken (Claude prints no echo of `/compact`, and the turn runs
from its write). The round carries it as the agent's `maintenance`, and every
watcher of work reads the agent at the status it had before such a turn
(`workStatus`). A real turn right after one still counts, with or without an
idle seen between. A compaction the CLI does by itself inside a turn
(Claude's `compacting` / `compact_boundary`, Codex's `contextCompaction`)
is part of that turn: whatever started the turn decides. DevHub's resume
after a usage limit (`after-limit`, the `resume_after_limit_message`) is
work: it goes on with the task the limit stopped, so it is `resumed`.

**Neither is a restore or a resume.** Two working spells look like work and
are not, and are read as maintenance too (`maintenance` on the round):

- **The CLI started again on its session** — `/resume`, Restart Session,
  `agent resume` and Reopen Closed on a session, a wake from sleep, the
  start-up of a rewind — runs a `rewinding` turn until the new CLI answers
  its greeting (`conversationStatus` says `working`, for the spinner).
  `isMaintenanceTurn` is true for it.
- **The past read again after a restart of DevHub.** Attaching again, a GUI
  agent's conversation replays its journal from 0 (`AgentConversation`),
  and its old turns run again on the way: working, then idle. Until it has
  read as far as the journal was long when it attached (`journalSize`, an
  `in.log` already there being what says it is a re-attach), its reading
  is `restoring`, and that is maintenance.

So none of them moves an escalation out of 要回答 or 待機中 (no `resumed` /
`direct` note), counts as working for the invariant, clears an `agent
keep`, ends a stalled stretch or notifies "finished" — and none raises the
unread mark: `setAgentStatus` raises it only when a working spell that was
work ends (`AppModel`), so an agent's read or unread state, kept in
`state.json` with it, is what it was before the restart or the resume. An
agent first seen during one (a restart, a resumed session) has no status to
go back to: it is read as `unknown`, and going on from there is not going
back to work either.

They are kept per profile in `<userData>/devhub/escalations.json`, written
whole and atomically on every change; a file that does not read is moved to
`escalations.json.corrupt` and said, and the board starts empty.

**The person answers in DevHub's window only.** The board's composer is the
one door (`answerEscalation` on the Agents page's bridge); no `devhub --tell`
command and no `TellPorts` member can write a human entry, and
`escalation answer` is refused by name. `service.test.ts` holds both.

### Pictures

An escalation draws what a conversation draws — `svg, `mermaid,
`vega-lite, `html, Marp, and local files as `![alt](path)`, also inside
a table's cells (a screenshot in a comparison table is drawn in place, at
most the cell's width, and opens large on a click; the conversation does the
same). A relative path is relative to the escalation's workspace, else its
first agent's, else the orchestrator's folder, and files are read with the
conversation's own embed readers on this Mac.

`escalation new` and `escalation ask` take the local images (PNG, JPEG, GIF,
WebP, SVG, …) a body names into the escalation's own folder,
`<userData>/devhub/escalations/<id>/`, and point the references at the
copies, the original path kept in the alt text — so an escalation still
shows its screenshots after the worktree that made them is gone
(`main/orchestrator/escalationFiles.ts`). Only files under an open
Workspace or the orchestrator's folder are taken (symlinks followed), at most
10 MB each and 25 MB for a body; a reference that breaks a rule, or names a
file that is not there, refuses the command with the reason. Code spans and
fences are left alone.

### Links: `devhub:`

An escalation (and any agent, in chat) links to places inside DevHub the way
it links to a web page: in `--link`, or as a Markdown link in a body or an
answer. The syntax is `model/devhubLink.ts`'s, each segment percent-encoded
as a URI component (`/` in a path excepted, `:` in a path as `%3A`):

| link                                               | goes to                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `devhub:agent/<id or 4+ prefix>`                   | the agent (`select_context`)                                           |
| `devhub:workspace/<id or name>`                    | the workspace (`select_context`)                                       |
| `devhub:file/<path without its leading />[:L[:C]]` | the file, in the workbench of the open workspace whose folder holds it |
| `devhub:escalation/<id>`                           | the Orchestrator row, with the escalation open                         |
| `devhub:orchestrator`                              | the Orchestrator row                                                   |
| `devhub:session/<session id>`                      | the agent running that session (resuming one stays `/resume`)          |

For example `devhub:agent/3f2a9c1e`, `devhub:workspace/login-fix`,
`devhub:file/Users/me/app/src/a%20b.ts:12:3`, `devhub:escalation/12`, and in
a body `[失敗しているテスト](devhub:file/Users/me/app/test/api.test.ts:40)`.
`devhub --tell link agent A | workspace W | file PATH[:L[:C]] | escalation ID
| orchestrator | session S` prints the canonical link (by id) for something
open, so nobody builds one by hand.

`escalation new` and `escalation ask` check every `devhub:` link, in
`--link` and in the body: one that does not parse, or names nothing open (a
file outside every open workspace, or not there), refuses the command with
the forms that are valid. A `--link` is stored canonically.

They are drawn as compact chips — a glyph per kind and the place's live name
from the snapshot: the agent's display name and status mark, the workspace's
name, the file's basename and `:line`, `#12` and the escalation's title — on
a hairline pill, unlike an underlined link out. A click is an explicit move
(`reason: "explicit"`, a place in Back and Forward at once) through the
intents the window has — `select_context`, the open-file routing
(`openLinkedFile`, which opens only a file inside the workspace named), the
board's own reading view — and never reaches the system browser (main's
`openExternalUrl` refuses a `devhub:` URL). A link whose target is gone is
its text with a quiet 見つかりません, never a broken navigation. External
http(s) links open in the browser as before.

### Ranking

The orchestrator ranks each escalation, when it raises one and again as
things change (`escalation rank`): **priority** — `high` when it blocks
several agents or a deadline, `low` when nobody waits on it, `normal`
otherwise — and **effort**, how quick it is for the person: `quick` when it
can be answered in about a minute from the escalation alone, `deep` when it
needs digging. A short **rank note** says why. All three are kept with the
escalation (`escalations.json`; a file written before them reads as
normal/normal), carried by `escalation list`, `escalation show` and
`board --json`, and drawn on the card: 優先 for high, 低 for low (normal
shows nothing), すぐ答えられる for quick, and the note as a quiet line.
A re-rank reorders 要回答 with a short glide (none under Reduce Motion).
Ranking writes no entry: it is not an answer, and the command line still
cannot write one.

### The board

- **要回答** — ranked: priority first (high, normal, low), then effort
  (quick, normal, deep), then oldest question first, with how long it has
  waited. A ticket asked again after an answer carries 追加の質問.
- **対応中** — answered longest ago first, with how long since the answer.
- **待機中** — parked on an outside condition: each card leads with its
  trigger, and its time (`M/D HH:MM · あと 3日`) when it has one; soonest
  time first, those without one after, then the oldest wait. The person can
  open one and write to it (that moves it to 対応中); there is no button.
- **完了** — closed escalations, the last 30, most recent first.

待機中 and 完了 fold: the chevron on the left of the heading shows or hides the
lane's cards, with the count kept in the heading. 完了 starts folded; what was
folded is kept for the session (`orchestratorMemory.ts`).

Clicking a card opens it in place: the whole thread, drawn by the GUI
conversation's own Markdown renderer (code, tables, KaTeX math, Mermaid, SVG,
Vega-Lite — whatever a chat answer can show), the related agents (a click
shows that agent, to talk to it directly) and links, and the composer: free
Markdown, ⌘Return sends, and the question's options as quick replies. Esc
(in the composer, while it is empty), "← ボード" or the mouse's Back button
over the board goes back to the board; Forward opens again what Back left.
The board and an escalation are two pages of one stack: opening one pushes
it in from the right and going back reverses it (220 ms, transform and
opacity only; under Reduce Motion an instant swap). The left pane's width is
the layout's and never changes with what it shows — a wide code block or
diagram scrolls or scales inside it. Focus goes to the composer (or the
thread) on open and back to the card on return. Sending an answer (⌘Return,
the send button or a quick reply) goes back to the board the same way, with
focus on the next card in 要回答 — or, with none left, on the one just
answered, now in 対応中; a send that fails stays, with the error and the
draft. Jumping to an agent from
an escalation (its chip) is a deliberate move
(`reason: "explicit"`), so Back (prefix+h) returns to the Orchestrator
screen. So is going to a Workspace from an escalation: beside each agent
chip, a folder and the name of that agent's Workspace (and, first, the
escalation's own `workspaceId` when no agent is in it) selects that
Workspace — its editor — and Back comes back to the escalation.

The left pane is where it was left. Whichever way the Orchestrator row is
selected again — Back, its Sidebar row, `focus orchestrator` — the pane
shows the same tab, the same escalation or file over it, its thread scrolled
as it was and the unsent answer still in the composer (per escalation), and
on the Files tab the same folders open (`shell/agents/orchestratorMemory.ts`).
It is shown in place, without sliding in again. An escalation that has left
the board, or was closed since (one already closed when it was read from
完了 stays), lands on the board instead; so does a file that is gone. The
escalation is not a place in Back and Forward of its own: history stays the
selection's (`docs/window-and-pages.md`), and the Orchestrator place
restores what it was showing. This is kept for the session only; a restart
starts on the board.

### ファイル: the orchestrator's folder

The left pane's second tab, ボード | ファイル (the board is the default; the
choice is kept for the session), is the orchestrator's folder — the running
orchestrator's Workspace root, else `[orchestrator] root` — as a tree: where
it keeps what it decided (`decisions.md`) and its skills (`.claude/skills`).
`.git`, `node_modules`, `.DS_Store` and the like are left out, and so is what
the folder's `.gitignore` ignores; dot-folders stay. A file opens over the
tree the way an escalation opens over the board, read-only: Markdown with
the conversation's renderer, other text as a highlighted code block, images
(SVG included) inline. **エディタで開く** opens it in the workbench of the
Workspace that contains it — the Orchestrator row's own — as `devhub <file>` would,
and that too is a place in Back and Forward.

Main reads the folder and watches it
(`main/orchestrator/orchestratorFiles.ts`): the page lists, reads and is told
what changed (debounced), so when the orchestrator writes `decisions.md` the
tree and the open file follow, and the tab shows a dot while the board is in
front. Every path is from the root and confined to it: an absolute path,
`..`, or a symlink that leads out is refused.

### 待機中: parked on an outside condition

Some work waits on something outside DevHub — a date, a reply on Slack, a
deploy. The orchestrator parks such an escalation with `escalation wait ID
--trigger TEXT [--at DATETIME]` (or raises it waiting, `escalation new …
--wait TEXT`, when nothing is asked of the person yet). **The trigger is
required, in natural language**, so whoever reads it later can check it;
`--at` adds a machine time when the condition is one.

One event says a wait may be ready, `waiting.changed`, and its line says
which escalation and which of two things happened, nothing more:

- `— subjects_changed` — what it is about changed: the items it is about
  (their state, lanes, pull request, review decision, conversations,
  checks) or its agents' (see "The invariant"). Its first look says nothing.
- `— due` — once per wait, when `--at` has passed (a restart says it again
  for a wait still past due).

Both of one wait pending are one line (`— due, subjects_changed`). It is
dropped before delivery when the escalation has left 待機中, or waits anew.
On each, the orchestrator reads the trigger (`escalation show`), checks it (with its own tools for Slack
and the like) and resumes, asks or closes it. A condition DevHub cannot see
is given an `--at` to look again: there is no periodic reminder of every
wait. A 待機中 escalation settles the Issue it is about and its agents
(see "The invariant"), and its agents' rows wear an hourglass.
`devhub --tell board` lists them (`waiting (N, soonest first):`, `--json`
`waiting`), and `orchestrator status` counts them.

### 停滞: 対応中 with nobody working on it

A 対応中 escalation is **stalled** when none of its related agents (`agents`,
the orchestrator left out) is working — every one idle, waiting, stopped or
gone, or it names none — and that has held for a grace
(`STALLED_GRACE_MS`, a minute). Working is status `working` or `background`
and not stopping; a maintenance turn (`isMaintenanceTurn`) is not work. The
stretch starts at the latest of: its last entry, the last moment one of its
agents was seen working, the orchestrator's reading of the answer (its
delivery: see "The person's words"), and main's first reading after a start.
It is a mark for the person only — a quiet 停滞 chip on the card,
`stalledSince` on its `EscalationWire`, `[停滞 3m: …]` in `devhub --tell
board` — and no event: its idle managed agents are `needs_action` (below), which
is what the orchestrator hears.

## Managed agents

Every agent carries one flag: **managed by the orchestrator** or not
(`Agent.managed`, a field of its own, not a metadata pair). Only a managed
agent is held to the invariant and said as `needs_action`; the orchestrator
agent itself never is. The flag is set where the agent starts:

- `devhub --tell agent new` and `devhub --tell issue assign` take
  `--managed` or `--unmanaged`, required: a call with neither does nothing
  and says both (`--editor-only` starts no agent and takes neither).
- `agent manage A` / `agent unmanage A` change it later (`agent manage`
  refuses the orchestrator).
- What a person starts in the window — New Agent (`Cmd+Q c`), the Assign
  Issue sheet — is not managed.

It is kept with the agent in `state.json`, and under its CLI session in
`session-meta.json` with its metadata, so a restart, `agent resume`, Reopen
Closed and `/resume` keep it. `agents` and `sessions` say `managed`,
`agent status` (and `--json` `managed`) too.

**In the Sidebar**, an Agent row carries small marks after its words
(`AgentMarks`, off the board's `agentStates`), each said in words in the
row's tooltip:

- the orchestrator's mark — managed ("Managed by the orchestrator");
- an hourglass — one of the agents of a 待機中 escalation, stopped but fine
  ("Waiting (#12): <trigger>");
- a warning, in the waiting ink — managed, needing action past the grace:
  stopped (or outside the population) with nothing settling it ("Needs
  action: <clause>");
- a tick — kept as it is by the orchestrator (`agent keep`; "Kept as it is:
  <note>").

So "stopped and fine" (hourglass) and "stopped and missed" (warning) look
different at a glance.

## The invariant

DevHub states one invariant and reports what breaks it
(`main/orchestrator/invariant.ts`); what the orchestrator does about it is
the orchestrator's.

**The population** is every open **item** assigned to the viewer on GitHub —
an Issue or a pull request, GitHub-wide (`is:open assignee:@me`). An Issue
and a pull request are one thing here: a pull request with no Issue is an
item as an Issue is, linked, escalated about and said the same way (`issue=`
or `pr=` on its line is the only difference), and another person's pull
request the viewer is assigned to review is an item like any other.
`[orchestrator.github] projects` only names the Projects an item's lane is
read from (a fact of the item); it never decides the population. For each
item, exactly one of these holds:

- (a) an agent linked to it is working (`working` or `background`, not
  stopping; a maintenance turn is not work);
- (b) a 要回答 escalation is about it — its agent stopped, waiting for the
  person;
- (c) a 待機中 escalation is about it — parked on an explicit condition.

Otherwise the item **needs action**: `no_agent` (nobody linked) or
`idle_no_escalation` (its agents stopped, with no 要回答 or 待機中 escalation
about it). An item one of whose linked agents is not managed is the
person's own and left out.

**Every managed agent** is working, or is one of the agents of a 要回答 or
待機中 escalation. An idle or waiting one with neither needs action,
`idle_no_escalation` (it ended its turn and nobody picked it up). So does a
managed agent linked to an item outside the population — closed or merged,
not assigned to the viewer — or to no item at all (none linked, or one GitHub
has no item for), **whatever it is doing**, for that reason alone:
`outside_population (closed)`, `(unassigned)`, `(no_item)`. DevHub looks up
each linked item the search did not return by its URL; until it has, and
while the population is not known — GitHub not polled, or the assigned items
not read in full yet — only the status rule applies to agents, and no item
is said.

**Linked**, the one rule: an agent is linked to the item its meta `issue=`
names (by URL: an Issue's `/issues/N` or a pull request's `/pull/N`). DevHub
writes that pair itself when `issue assign` — or the window's Assign Issue —
starts an agent on an Issue or a pull request (`ISSUE_LINK_KEY`); it
is refused to `agent meta`, `--meta` and `session meta` (the linkage is not
set by hand), kept with the agent's other metadata across restarts and
resumes, and listed by `agent status` as `meta issue=…`. The branch a
Workspace is on links nothing.

**About an item**, for an escalation: one of its links is the item's URL,
or one of its agents — `--agent`, a `devhub:agent/` link, the agents of a
`devhub:workspace/` link or of its `--workspace` — is linked to it.

**Kept**: the orchestrator may decide a managed agent that needs action is to go
on anyway (work outside the population that is still worth doing):
`devhub --tell agent keep A --note TEXT`. It is not said again while its
state (its status, its item's, its pull request's: what `status` shows)
stays what it was when it was kept; when they change (its item is
assigned or closed, it goes idle after working, …) the keeping ends and it
is said again. `agent keep A --clear` ends it at once. The keeping and its
note are shown by `agent status` (`kept`), `board` and the row's tooltip.
It lives in the running DevHub: a restart says the agent again.

What breaks it now is in `devhub --tell board` (`needs action (N):`,
`--json` `needsAction`: each subject's line, the clause, since when, when
last said, its keeping), and each agent's standing in `agent status`
(`invariant`: settled, or the clause it fails; the 待機中 escalation it is
on; its keeping).

### `status`: one subject's whole state, in one call

A line never carries state. What a subject is now — everything the
Sidebar's tooltip shows, and more — is one call, `devhub --tell [--json]
status <subject>`, the subject being what a line names it by: an item
(`acme/app#123` — an Issue's or a pull request's number alike — or its URL)
or an agent (its id, a 4+ prefix, or its name). Built from the reading the
invariant was just made from (`OrchestratorService.status`), never fetched
for the call:

- **an item**: its kind, state (`open` / `closed` / `merged`), whether it is
  assigned to the viewer and in the population, its lane on each watched
  Project, its pull request (its own, or the one closing the Issue: state,
  review decision, unresolved conversations, checks), the agents linked to
  it (status, managed, the clause each fails, `agent keep`'s note), the
  escalations about it (state, trigger, time), and the clause it fails,
  since when and when last said;
- **an agent**: the same of the agent and of its item, its Workspace's facts
  as the Sidebar's tooltip has them (`workspace status`'s `review`: Issue,
  pull request, review decision, conversations, checks), the 待機中
  escalation it is on and the escalations it is one of the agents of.

```text
$ devhub --tell --json status acme/app#9
{ "subject": "item",
  "item": { "kind": "pr", "ref": "pr=acme/app#9", "url": "https://github.com/acme/app/pull/9",
            "title": "設定画面", "state": "open", "assigned": true, "inPopulation": true,
            "projects": [{ "project": "acme/7", "lane": "Review" }],
            "pullRequest": { "number": 9, "url": "…", "state": "open",
                             "review": "changes_requested", "unresolved": 2, "checks": "failing" } },
  "needsAction": { "clause": "idle_no_escalation", "line": "pr=acme/app#9 ws=web — idle_no_escalation",
                   "since": "2026-11-05T09:00:00.000Z", "toldAt": "2026-11-05T09:01:00.000Z" },
  "agents": [{ "id": "a1b2c3d4-…", "name": "PR 9 review", "ws": "web", "workspaceId": "…",
               "status": "idle", "managed": true, "linked": "https://github.com/acme/app/pull/9",
               "needsAction": "idle_no_escalation", "kept": null }],
  "escalations": [] }
```

An agent's has `"subject": "agent"`, `agent`, `item` (or null),
`workspace` (the tooltip's facts), `needsAction`, `waiting` and
`escalations`. An item DevHub has not read (not assigned to the viewer and
no agent linked to it) is refused with what it does read.

## Events

Events are how DevHub tells the orchestrator something needs it. Every
source calls one dispatcher (`main/orchestrator/events.ts`), which filters
and batches them, renders `[orchestrator] event_prompt` around them and
queues the message for the orchestrator agent as an ordinary message from the
person — the same queue `devhub --tell agent send` uses. **The person's
words are the exception**: they go at once, as they were typed (below).

A line says **why a subject needs the orchestrator now**, not what happened
to it and not its state: the subject (the ids the next command takes) and a
short code — the invariant's clause it fails, which wait may be ready —
never facts, contents or a suggestion. A subject's state is one call,
`devhub --tell status` (above); details (which check failed and why, what a
review comment says, a CI log) are fetched by the agent responsible for the
work, with its own tools (`gh`), not by the orchestrator.

### The event types

| type                      | when                                                                                                                                                                                                                               | example                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`                    | the orchestrator has just started (or restarted)                                                                                                                                                                                   | `[init] — オーケストレーターが起動しました。devhub --tell board で現状を確認`                                                                                                        |
| `escalation_answered`     | the person answered an escalation (→ 対応中). Sent at once, as its own message: the person's words                                                                                                                                 | `esc=12「本番DBマイグレーション承認」 への人の回答 (選択肢「承認する」):` and, on the next line, `承認する`                                                                          |
| `escalation.human_direct` | the person wrote to an open escalation's agent from its own composer and it went working (要回答 → 対応中). Sent at once, as its own message                                                                                       | `esc=12「本番DBマイグレーション承認」 agent=a1b2c3d4 に人が直接送ったメッセージ:` and, on the next line, what they wrote                                                             |
| `needs_action`            | an item of the population, or a managed agent, breaks the invariant: after a minute's grace, again when its clause or its state changes (the line may be the same: `status` shows what moved), and every `reminder_interval` after | `[needs_action] issue=acme/web#123 ws=web — no_agent`, `[needs_action] agent=ab12cd34 (API fix) ws=web — idle_no_escalation`, `[needs_action] agent=… — outside_population (closed)` |
| `waiting.changed`         | a 待機中 escalation may be ready: what it is about changed (`subjects_changed`), or its `--at` came (`due`, once per wait)                                                                                                         | `[waiting.changed] esc=12 — subjects_changed`, `[waiting.changed] esc=15 — due`                                                                                                      |
| `usage.threshold`         | a plan window's use crossed one of `usage_thresholds` upward (once per threshold per window period; dropped if the window reset first)                                                                                             | `[usage.threshold] cli=claude window=5-hour pct=82 resets=19:20 — 5時間枠が80%を超えました`                                                                                          |
| `timer.elapsed`           | a `[[orchestrator.timers]]` timer, or one `orchestrator timer set` made                                                                                                                                                            | `[timer.elapsed] sweep`                                                                                                                                                              |
| `custom.*`                | `devhub --tell orchestrator emit --type custom.NAME --text …`                                                                                                                                                                      | `[custom.deploy] — staging に deploy 完了`                                                                                                                                           |

The `needs_action` codes: an item's `no_agent` or `idle_no_escalation`
(`issue=` or `pr=` names it, `ws=` its first agent's Workspace); a managed
agent's `idle_no_escalation` or `outside_population (closed|unassigned|no_item)`
(`agent=` names it by its id's first block and name). `unsettled`, the type
before, is a retired event pattern.

**Why this set.** The person asked for lane changes and turn ends not to be
told, and for state over diffs. Everything the invariant covers is said as
`needs_action` (with the clause it fails; the state is `status`) or not at all, so these are gone:
`github.assigned`, `github.unattended` (an Issue of mine with nobody on it
is `needs_action`), `github.lane_changed`, `github.pr_opened`,
`github.pr_ready`, `github.pr_approved`, `github.changes_requested`,
`github.review_comment`, `github.checks`, `github.pr_merged`,
`github.pr_closed` (the line carries the lane, the pull request's state,
review decision, unresolved count and checks), every `agent.*`
(`turn_ended`, `asked`, `permission_requested`, `started`, `exited`,
`failed`: a managed agent that stops with nothing settling it is
`needs_action`, whatever stopped it; an item left with no agent is), every
`workspace.*` (read with `workspace status`), `escalation.stalled` (its idle
agents need action; 停滞 stays a mark on the board) and
`escalation.waiting_reminder` and `escalation.wait_due` (a 待機中 escalation
comes back as `waiting.changed`, by its time or when what it is about
changes; an outside condition DevHub cannot see is given an `--at` to look
again).
`github.review_requested` and `github.reply` went too: another person's pull
request is an item like any other — assigned to the viewer, it is in the
population and said as `needs_action` when nobody settles it — so GitHub itself
says nothing (`github.*` is an emptied family). What stays is what no state
shows: the person's words, a wait's time, a change under a parked subject,
the plan's use, timers and `custom.*`. An `[orchestrator] events` pattern that names a removed type
(or `agent.*`, `workspace.*`) loads, is left out, and is reported once as a
retired setting, the way a retired key is.

### The person's words

`escalation_answered` and `escalation.human_direct` carry what the person
wrote, and are delivered **at once and as their own message** — not batched,
not inside an event line, not inside `event_prompt` — whose first line names
the escalation (and the agent) and whose rest is the person's text exactly as
typed, unquoted and uncut. The orchestrator reads it as the person's own
input: an auto-mode approval classifier treats text quoted inside a prompt
template conservatively and may refuse the external writes the person just
asked for. Several answers are several messages. Only a pause holds them (a
resume sends them first, each alone, before the batch); a busy orchestrator
does not: the message is queued and taken when its turn ends, like the
person's composer. Delivering an answer is the orchestrator's reading of it
(`acknowledged`: `agent wait --any` no longer reports it; 停滞's clock starts).
A message whose text could not be read says so and where to read it
(`agent read A --since …`).

### Delivery: batches, the interval, pause

- **One line per subject**, the latest statement about it replacing the
  older one (a timer is pending once). A subject is an item (Issue or pull
  request), an agent, an escalation, a timer, a usage window, a custom type
  and text.
- **At most once per `[orchestrator] delivery_interval`** (default `5m`) a
  batch goes, as one message: `{EVENT}` the lines (at most
  `MAX_DELIVERY_LINES`, 50, and a last line counting the rest),
  `{EVENT_JSON}` the same as JSON when the template has it; `init_prompt`
  for a batch carrying `init`. The first batch after a quiet spell goes at
  once (after a 300 ms window).
- **Held only by a foreground turn**: the orchestrator `working`, or a
  message of ours still queued for it (`busy` in the controller). Its own
  background work — shells, tasks, subagents it started (`background`) — does
  not hold a delivery: the router is never blocked by the subagents it
  started. After a delivery the next waits up to a minute to see it taken.
- **Re-read before it goes** (`relevant`): a subject settled since, a wait no
  longer 待機中, a window reset below its threshold — dropped as
  `dropped-stale`.
- **Paused** (`orchestrator pause`, the board's Events switch): everything is
  held, the person's words too, and GitHub is not polled. `orchestrator
resume` polls once (the rate limit permitting), then sends the person's
  words, then the rest as one message, at once.
- **Kept in a log**: `orchestrator events` lists the last ones and what came
  of each (`delivered`, `pending`, `filtered`, `coalesced` into which,
  `dropped-stale`, `overflow`, `dropped` with no orchestrator).

### The sources

- **The board** (`orchestratorService.ts`): the answers, the person's direct
  words, `waiting.changed` (`— due`); and the invariant, read off every projection
  and every GitHub poll, its subjects timed by `InvariantWatch`: a subject is
  said once it has needed action for a minute, again when its clause or state changes,
  and every `reminder_interval` while it stays so; a new orchestrator (a
  start, a restart) hears every one again. `waiting.changed`
  (`— subjects_changed`) compares each 待機中 escalation's subjects' facts
  with the last look (its first look says nothing).
- **GitHub** (`githubItems.ts`): read — never written — one request per
  tick: a page (100) of the open items assigned to the viewer (`search`
  `is:open assignee:@me`: Issues and pull requests, each with its state,
  assignees, its lane on each watched Project, and for an Issue the pull
  requests that close it), each linked item the search did not return looked
  up by URL (`resource`), and the review decision, unresolved conversations
  and checks of the pull requests the last reading named (`nodes`). That is
  what the invariant's population and facts are read off (`items`); it says
  no event itself. Typically a few points of GitHub's 5,000 an hour; the
  interval starts at `[orchestrator.github] interval` and only backs off
  (slower as the rate limit runs down, paused until it resets when low,
  doubling after a failure). While paused it does not poll at all. Nothing is
  kept on disk: it reads state, not diffs, so a restart reads afresh (the
  `orchestrator-github.json` an earlier DevHub kept is no longer read).
- **The Workspaces' pull requests** (the Sidebar's repository rounds): an
  agent's facts carry its Workspace's pull request — state, review decision,
  unresolved conversations, checks — as the row's tooltip has it.
- **Timers** (`timers.ts`), **the usage readout** (`usageThresholds.ts`),
  `orchestrator emit`.

### The seam, for new events

A new event is a variant of `OrchestratorEvent`, its line in `linePartsOf`,
its subject in `subjectOf`, and a `dispatch` where it happens; add it to
`EVENT_TYPES` and to the skill's table. State a subject's facts, not a
reason.

### `agent wait --any`

Called by the orchestrator, `agent wait --any` also returns for:

- an escalation the person answered that it has not read — acknowledged by
  `escalation show ID`, or by the answer's delivery.

## Settings: `[orchestrator]`

```toml
[orchestrator]
root = "~/orchestrator"          # the folder it runs in (this is the default): its skills are this folder's
profile = "claude"               # the window's Start; absent: the window's default
presentation = "gui"             # gui | tui; absent: the profile's default
event_prompt = "/make-progress {EVENT}"   # absent: DevHub's default (below)
# init_prompt = "/start-orchestrating {EVENT}"   # absent: event_prompt with init
# events = ["*", "!timer.*"]       # which types reach it (default: all)
usage_thresholds = [80, 95]      # usage.threshold at these percents of a plan window (the default); [] never
delivery_interval = "5m"         # a batch at most this often (the default; at least 10s); the person's words go at once
reminder_interval = "1h"         # a needs_action subject said again this often while it stays so (the default; at least 5m)

[orchestrator.github]
projects = ["my-org/7"]          # Projects (v2) boards, OWNER/NUMBER, an item's lane is read from (never the population)
interval = "90s"                 # the base poll interval (at least 30s); it only backs off

[[orchestrator.timers]]
name = "sweep"                   # timer.elapsed carries it
interval = "30m"                 # at least 10s
```

`root` defaults to `~/orchestrator`. The window's **Start** makes the folder
(and its parents) when it is missing; `orchestrator start --root` on a command
line never does, and refuses a folder that is not there.

`event_prompt` can invoke a skill: `"/make-progress {EVENT}"`; `{EVENT_JSON}`
may be added for a script. Its default, `DEFAULT_EVENT_PROMPT`, says what a
batch is and to hand each line to a new background subagent and return
(「DevHub からの通知です (対象ごとに 1 行)。各行をそれぞれバックグラウンドの fork
サブエージェント (Agent ツールの subagent_type: "fork") に渡して処理し、すぐに戻ってください。」
then `{EVENT}`). The
person's words never go through it. `events` is a list of patterns over the
type — a type (`needs_action`), a family (`escalation.*`) or `*`, each optionally
after `!` to take it out; the last pattern that matches decides, and `init`
always goes. The default is `["*"]`: every kind left is a signal. A pattern
naming a removed type (`agent.turn_ended`, `github.lane_changed`,
`github.reply`, `agent.*`, `github.*`, `workspace.*`, …:
`RETIRED_EVENT_TYPES`) loads, is left out, and is said
once as a retired setting; so is `wait_reminder_interval` (`RETIRED_KEYS`).
They are in Settings ▸ General ▸ Orchestrator and validated with every other
setting.

## The command line

```sh
devhub --tell board [--json]                         # 要回答, 対応中 (停滞 marked), 待機中, and what needs action now, as data
devhub --tell [--json] status ITEM|A                 # one subject's whole state: an item (owner/repo#N or URL) or an agent
devhub --tell agent manage A | agent unmanage A     # under the orchestrator's management, or not
devhub --tell agent keep A --note TEXT | --clear    # leave a managed agent that needs action as it is, for a reason, until its state changes
devhub --tell --json agent status A                 # managed, invariant (settled or the clause, 待機中 escalation, kept)
devhub --tell --json workspace status W             # branch, Issue (state, lanes), PR (state, draft, review decision), conversations, checks
devhub --tell escalation new --title T --body -|TEXT [--agent A]... [--link URL]... [--option TEXT]... [--workspace W]
                         [--priority high|normal|low] [--effort quick|normal|deep] [--rank-note TEXT]
devhub --tell escalation rank ID [--priority P] [--effort E] [--rank-note TEXT]   # re-rank; "" clears the note
devhub --tell escalation ask ID --body -|TEXT [--option TEXT]... [--link URL]...   # back to 要回答
devhub --tell link agent A | workspace W | file PATH[:L[:C]] | escalation ID | orchestrator | session S   # a devhub: link
devhub --tell escalation show ID [--json]           # the thread (acknowledges the answer)
devhub --tell escalation list [--state needs_answer|in_progress|waiting|closed] [--json]
devhub --tell escalation close ID [--note TEXT]
devhub --tell escalation link ID --agent A
devhub --tell escalation hold ID [--note TEXT]      # park it in 対応中 (not an answer)
devhub --tell escalation wait ID --trigger TEXT [--at DATETIME]   # park it in 待機中 on an outside condition
devhub --tell escalation resume ID [--note TEXT]    # off its wait, to 対応中
devhub --tell orchestrator start --root PATH --profile P --gui|--tui [--prompt -|TEXT]
devhub --tell orchestrator status [--json]          # its agent, state, lane counts, pause, GitHub polling
devhub --tell orchestrator stop | restart           # Stop Agent / Restart Session on it
devhub --tell orchestrator pause | resume          # pause suspends GitHub polling; resume catches up and delivers, as one message
devhub --tell orchestrator events [--last N] [--json]   # recent events and what came of them
devhub --tell orchestrator emit --type custom.NAME --text TEXT|-
devhub --tell orchestrator timer list | set NAME INTERVAL | clear NAME   # for this session
devhub --tell usage [--json]                        # each CLI's plan windows (%, reset), as the Sidebar has them, with their age
devhub --tell focus orchestrator                    # the only one that changes the screen
```

`orchestrator start` takes every choice as an argument, `--root` included
(the refusal names `orchestrator.root`); it opens the folder as the
Orchestrator row's Workspace unselected (never as an ordinary row), starts
the agent there unfocused, marks it `role=orchestrator`, and sends it `init`
(or `--prompt`). One orchestrator at a time.

That Workspace is addressed as **`orchestrator`**, as Scratch is `scratch`,
wherever a `<w>` is taken: `workspaces` lists it as `Orchestrator`
(`"orchestrator": true` in `--json`), and `workspace status orchestrator`,
`agent new --workspace orchestrator`, `agents --workspace orchestrator` and
`link workspace orchestrator` reach it; its id and folder work too, and
`issue assign --repo <root> --root` works in it when the root is a clone.
`workspace close orchestrator` is refused, as Scratch's is — the row has no
close, and neither do `Cmd+Q W`, File ▸ Close Workspace or Vim's `:q` in its
editor (`ORCHESTRATOR_CANNOT_CLOSE` in the model).

## The charter: what DevHub asks of the orchestrator

DevHub provides the mechanism and leaves the person's workflow to their
make-progress skill — but a few things are DevHub's own, and DevHub states
them itself, to the orchestrator agent at every start, whatever the person's
skill says (`main/orchestrator/orchestratorCharter.ts`, in Japanese):

1. **Its role**: drive every item (Issue or pull request) assigned to the
   person to closed or merged — another's pull request they are assigned to
   review included; do
   whatever moves their workflow forward, nudging the person included (asking
   them for a review, an answer).
2. **No hands-on work, ever** — the orchestrator and its subagents alike.
   Reading or writing code, fixing, implementing, reading CI logs, review
   comments or diffs in depth, finding why a check failed: that is the
   responsible worker agent's, fetched by it with its own tools (`gh`). The
   lines DevHub delivers and the facts the CLI gives (`status`: lane, PR state,
   review decision, unresolved count, checks, an agent's status) are for
   routing only. A subagent decides who should act and what to ask them, and
   hands it over — `agent send`, `issue assign`, `agent resume`, an
   escalation — and that is all it does.
3. **The router rule**: for each line delivered, start a background **fork**
   subagent (the Agent tool's `subagent_type: "fork"`) to handle it (an
   escalation, a look at the state, the next step) and return at once. A
   fork inherits the router's whole conversation, so past decisions carry
   over without being copied into its prompt, and its tool output stays out
   of the router's context: only its final message comes back, a short
   summary of what it decided and handed to whom — what accumulates in the
   router. Decisions meant to outlast a compaction still go to files
   (`decisions.md` in the root). A Codex orchestrator has no fork: an
   ordinary subagent given the relevant past decisions. The router never
   blocks, or every item's progress waits on it. DevHub delivers while those
   subagents run (only a foreground turn holds a batch). The person's words
   arrive as their own messages and are their instructions. `DEFAULT_EVENT_PROMPT`
   says the same in one line.
4. **The invariant** (see "The invariant"), as what the orchestrator
   maintains, and how to answer a `needs_action` subject: a subagent first
   reads its whole state with one `devhub --tell --json status <subject>`, then has the agent ask the person for a review, has it
   look deeper, raises an escalation, parks it with `escalation wait`, or
   stops it. A managed agent outside the population (its item closed or not
   the person's) or with no item is **closed**, not kept
   around: a subagent first asks that agent about unpushed work or an open
   pull request, then `agent stop` (and `workspace close` with its flags named)
   — unless the orchestrator decides it is still worth doing, and says why
   with `agent keep A --note`; never without a reason.
5. **DevHub's conventions**: the item linkage rule (meta `issue=`, an
   Issue's or a pull request's URL, by `issue assign`, never by hand), `--managed` (and `--meta parent=<its id>`) on
   every agent it starts, never approving a permission prompt, never writing
   the person's answer, never taking the screen (`focus` only when asked),
   and holding back on new agents when a plan window runs high
   (`usage.threshold`, `devhub --tell usage`).

How it is given: Claude (terminal and GUI) gets it appended to the system
prompt — `--append-system-prompt`, after the profile's own, which is kept
(Claude honours only the last one, so the two are joined) — on the
orchestrator agent's argv only (`withOrchestratorSkill`); a Codex GUI thread
gets it as a paragraph of `developerInstructions`
(`codexOrchestratorInstructions`). A Codex terminal orchestrator gets
neither (DevHub has no channel into it), nor does one DevHub did not start.
The person's make-progress need not repeat any of it: `/devhub-orchestrator`
leaves these to the charter and is about the team's own rules.

## `/devhub-orchestrator`: writing the person's make-progress skill

What the orchestrator does on each event is the person's own skill in
`root` (say `/make-progress`, invoked by `event_prompt = "/make-progress
{EVENT}"`). DevHub does not ship one — workflows differ — but it gives
the orchestrator agent, and no other agent, a skill for **writing** one:
`/devhub-orchestrator` (`main/orchestrator/orchestratorSkill.ts`).

- **What it says** (in Japanese): what a delivery carries (the person's
  words at once and alone; the rest as one batch per `delivery_interval`,
  one line per subject, the subject and a code (the state is `status`); `{EVENT}` and the optional
  `{EVENT_JSON}`; held only by a foreground turn and a pause; the `events`
  filter), the event types (its table is tested against `EVENT_TYPES`), the
  invariant as DevHub reports it, what each lane asks of the orchestrator
  (要回答 waits, 対応中 is relayed to the agent and closed, 待機中 always has
  its trigger in words (and `--at` for a date) and is checked on
  `waiting.changed`), the escalation principles and
  template below, the CLI it uses, and an interview: the team's lanes,
  existing skills, review and "done", what it may decide alone (and where
  decisions are recorded), events, timers, naming and meta. Then it drafts
  make-progress — a dispatcher on each line's `[type]`, a playbook per
  event, escalation rules, a reconcile on `init` — shows it, and writes it to
  `<root>/.claude/skills/<name>/SKILL.md` (plus an `AGENTS.md` pointer for
  Codex). It never writes `settings.toml`: it gives the person the
  `[orchestrator]` lines to add, or to set in Settings.
- **Where it is**: rewritten on every start at
  `<userData>/devhub/orchestrator-skill/.claude/skills/devhub-orchestrator/SKILL.md`
  (`~/Library/Application Support/DevHub/…` on a Mac), beside `/devhub`'s
  `agent-skill`, naming the same `devhub` launcher.
- **How it is given**: when the agent being launched, restarted or starting a
  thread is the orchestrator — the one the row is assigned to, or the new
  agent `orchestrator start` (and the window's Start) is making — Claude gets
  a second `--add-dir=<userData>/devhub/orchestrator-skill` (and the charter,
  above), and a Codex GUI thread the charter and one more paragraph in
  `developerInstructions` pointing at the SKILL.md. Every other agent gets only `/devhub` (`isOrchestratorAgent`,
  `orchestratorSkill` in `shell/agentWiring.ts`).
- **From outside DevHub**: `devhub --tell skill --orchestrator` prints it
  (`--json`: `{ text, cli, skillFile }`) for an orchestrator DevHub did not
  start (Claude Desktop).

To get a make-progress skill, start the orchestrator and ask it:
「/devhub-orchestrator で make-progress を作りたい」. It interviews, drafts,
writes the skill into `root`, and tells you the settings lines.

## A recommended escalation template

Not enforced — a starting point for the orchestrator's own skill. Escalate
only what needs a person's decision or permission, after the read-only
investigation (code, Notion, Slack) is done; when the facts are not enough,
send an agent to dig further instead. Write in the person's language, for an
engineer who does not know the system, the domain or the code, and make it
self-contained: code snippets, formulas, diagrams (Mermaid, SVG) and tables
render as they do in a chat answer.

```markdown
## 背景 — what this is about, for someone new to it

## 現状 — what has been done and found (with the evidence)

## 決めてほしいこと — the one decision, stated as a question

## 選択肢 — each with pros, cons; and the recommendation, with why

## 回答の後 — what the orchestrator will have the agents do

## 参考 — PRs, Issues, documents, runbooks
```

Add `--option` for each choice so the person can answer with one click; free
text is always allowed.
