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
  under the Orchestrator row, in their lanes (below, "The orchestrator's
  work in the Sidebar"), and its `+` starts one there. Selecting one shows its pane as usual. The
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
- **Its editor** (the root's Neovim, for skills and `decisions.md`) is the
  Workspace selected: the content area is its editor, as Scratch's is
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
- Back/Forward are unchanged: its helpers are Agents and its editor is a
  Workspace's, entered in the history as Scratch's are; an entry for one of them highlights the
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

## The orchestrator's work in the Sidebar

```text
 Orchestrator        ✓ 1        (folded:  Orchestrator   ✓ 6 1)
   ⌄ ● 要回答           1
       ✓ rounding-migration
   ⌄ △ 要対応           1
       ✓ research          △
   ⌄ ● 対応中           2
       ◌ investigate-500s
       ◌ review-517  PR #517
   › ● 待機中           1
 Scratch
 dotfiles  main
   └ ◌ Claude                   (the person's)
 notes  main
```

Under the Orchestrator row is what the orchestrator is doing, grouped by the
board's lanes (`shell/components/sidebar/orchestratorLanes.ts`). The rest of
the Sidebar is the person's places, as before.

**What is there.** Two kinds of item:

- **its helpers**: the agents in the orchestrator's own folder, the
  orchestrator agent itself apart (it is the row);
- **the managed Workspaces.** *Managed* is one flag, said of agents and of
  Workspaces alike (`Agent.managed`, `Workspace.managed`): the
  orchestrator's work is in it. There is no second notion — "opened by the
  orchestrator" is the same thing, and is how most Workspaces come to be
  managed. A Workspace is managed
  - when the orchestrator's side opens a folder that was not open —
    `devhub --tell workspace open` (a worktree included, `issue=pending`
    work included) or `issue assign`, asked by the orchestrator agent or by
    an agent it manages (the `open_folder` intent's `managed`, applied by
    the coordinator only to a Workspace that open adds);
  - when an agent in it is put under management — `agent new --managed`,
    `issue assign --managed`, `agent manage`, a managed session resumed
    there (`AppModel.setAgentManaged`);
  - by `workspace manage W`, or the row's **Manage with Orchestrator**
    (right-click, or `Cmd+Q Shift+M` with the row or one of its agents
    selected; also in the palette, `Cmd+Q :`).

  `workspace unmanage W` and **Stop Managing** (the same right-click and
  key on a managed Workspace) take it out, **and its agents with it**: a
  Workspace holding a managed agent is managed, so leaving them managed would
  leave it where it was. Scratch and the Orchestrator row's own Workspace are
  rows of their own and never managed. The flag is kept with the Workspace in
  `state.json` (`managed`; an older DevHub ignores the key). A file written
  before Workspaces had the flag needs no migration: a Workspace in it
  holding a managed agent is read as managed (`hydrateModel`), so the
  orchestrator's existing worktrees are under the row at once. The
  `opened_by` key a short-lived DevHub wrote is dropped on load.

What that means:

- **A Workspace nobody put under management stays where it is**, among the
  person's rows: opening a folder that is already open marks nothing. Only
  Scratch's managed agents stay outside the group, with their wash
  (`.agent-row.is-managed`, "Managed agents" below).
- **A managed Workspace stays under the Orchestrator row while it is open**
  — when its last managed agent closes or is taken out of management
  (`agent unmanage` leaves the Workspace as it is), and when the person
  starts an agent of their own in it. It is the orchestrator's piece of work,
  which the person has stepped into; it leaves when it is closed (the
  orchestrator's `workspace close`, or the person's) or when it is
  unmanaged. With no agents left it is in 完了 (below).

**Which lane.** The board's lanes in the board's order, with 要対応 — the
invariant's needs action, which the board lists above its lanes — after
要回答. An item is in the first that holds of it:

| lane   | when                                                                                                                   | heading               |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 要回答 | an open escalation about it is 要回答                                                                                  | accent dot            |
| 要対応 | one of its agents breaks the invariant (`agentStates.needsAction`)                                                     | the needs-action mark |
| 対応中 | an escalation about it is 対応中, or one of its agents is at work (working, background, on a prompt, still being read) | the working dot       |
| 待機中 | an escalation about it is 待機中, or one of its agents is stopped and fine (on a 待機中 escalation, or `agent keep`)   | the idle dot          |
| 完了   | nothing about it is open: no agent left, or its agents idle with nothing waiting on them (their escalation closed)     | tertiary dot          |

An escalation is about an item when its `workspaceId` is the item's
Workspace or one of its agents is the item's. 完了 is the board's word for the
same fact the board files there: nothing open.

**What a heading is.** The board's word, its colour as a dot, and how many
items are in it. A lane with nothing in it has no heading. 待機中 and 完了
start folded, as on the board; what is folded — each lane, and the group as a
whole — is kept for the session (`sessionStorage`; a restart starts afresh).
Folded, the Orchestrator row shows how many items it holds, quiet, before
the badge; the badge (要回答) never folds. The disclosure is the row's own
mark: under the pointer or the keyboard the orchestrator glyph turns into a
chevron, which folds the group. With nothing under it the row is exactly the
row it was: no disclosure, no count, not expandable. The collapsed rail draws
the row alone, its mark carrying the badge.

**What an item is.** A helper is its agent's row. A Workspace with one agent
— almost every worktree the orchestrator makes — is drawn as that agent's
row, with what the Workspace is about (`#128`, `PR #517`) quiet after its
words, the Workspace's tooltip lines after the agent's, and its right-click
adding **Show Editor** and **Close Worktree…**; one with none, or several,
is the Workspace's own row with its agents under it, as anywhere in the
Sidebar. Items wear no managed wash: where they are says it. They are not
dragged (their place is the lane's); agents under a Workspace still are.

**A lane change moves the row, calmly.** One rule each for the eye, the
keyboard and the pointer (`orchestratorGroup.ts`, `useSettledArrangement`):

- **It waits until it stands.** A change of lane, or a new item, is drawn
  once it has stood for 600 ms (`SETTLE_MS`): an agent that has just started
  reads idle, needs action and working within a fraction of a second, and a
  worktree is followed by its agent a moment later; none of that moves a row.
  An item that has gone leaves at once. The rows' own content (status marks,
  words, the badge) is live throughout. The board's first reading is drawn at
  once.
- **It glides.** The row goes to its new place by FLIP (`glide.ts`, 240 ms,
  the standard curve, transform only), and the rows between make room by
  the same glide; a row that passes over others (more than 64 px) dips to
  faint on the way so the words it crosses stay readable (opacity 1, 0.3,
  1). What arrives rises in (`--motion-rise`, 180 ms) once the rows making
  room for it have landed: until then its slot is empty. Only a change of the
  group's shape moves anything: the rail folding, a rename or a Workspace
  opened below are drawn where they land. Reduce Motion: nothing glides.
- **The pointer holds it back.** While the pointer is in the group and in
  use — moved within the last 1.5 s (`POINTER_IDLE_MS`), or a button held —
  what is drawn is what was drawn: each item in the lane it stood in, a new
  one not yet. The change lands when the pointer leaves the group, or rests
  there 1.5 s with no button down. So a row is never taken from under a hand
  on its way to it, and a pointer left lying there does not hide a change.
- **The keyboard follows the row.** The roving tab stop is the row's id, and
  a row drawn anew under another heading takes the keyboard with it; a row a
  fold takes away hands it to the heading (or the Orchestrator row) that
  folded. Nothing is held back for the keyboard.

**Keys.** The headings are tree items (`aria-level` 2, `aria-expanded`), the
items level 3, a Workspace's agents level 4. `↑`/`↓`/`Home`/`End` walk the
rows drawn; `→` opens a folded heading or group, and on an open one enters
its first child; `←` folds an open one, and anywhere else goes to the
parent. Return on a heading folds or opens it. **Digits** (`Cmd+Q 1..9`) are
the person's Workspaces only, counted below Scratch as before: the
orchestrator's come and go, so a digit that pointed at one would point at
another a minute later. They are reached by the row, `Cmd+Q Shift+O`,
`focus`, `devhub:` links and `Cmd+Q N`/`]`, which walk them after the
Orchestrator row's helpers in the order they were opened.

## Escalations

An escalation is a request for a human decision or permission, raised by the
orchestrator when work cannot go on without one. It is a **thread**:

```text
{ id, title, entries: [{ role: orchestrator|human, markdown, at, options?,
                          kind?: direct|resumed|held|wait, agent?, dueAt? }],
  agents: [agent ids], workspaceId?, links: [urls], linkLabels?: {url: label},
  createdAt, updatedAt, closed?: { at, note? } }
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

### Attachments: screenshots from anywhere

`--attach FILE[=CAPTION]` on `escalation new` and `escalation ask` (any
number; PNG, JPEG, GIF, WebP or SVG, checked by their bytes; 10 MB each,
25 MB a command) attaches a picture **on the machine the `devhub` command
runs on** — an SSH host or a container as well as this Mac. The command
reads it there and sends its bytes with the request (the `files` round trip,
`docs/devhub-cli.md`), so nothing in the app reads another machine's disk.
Each is copied into the escalation's folder and the entry ends with a
`## 添付` section: each picture under its caption (or its name), drawn by the
thread's renderer and opened large by the lightbox on a click; `escalation
show` lists them. The card shows the first picture of its latest question —
an attachment, or an image the body named — as a thumbnail at its right
(`firstPicture`, read with `readEscalationEmbed`).

**From a worker.** The orchestrator never does hands-on work, so the
screenshot is a worker's. `devhub --tell attachment add FILE[=CAPTION]...`
keeps it in a shared store, `<userData>/devhub/attachments/<id>/`, and
prints an id (`att-1a2b3c4d`, kept 14 days); the worker puts the id in its
report, and the orchestrator attaches it with `--attach att-1a2b3c4d` (a
caption given there replaces the stored one)
(`main/orchestrator/attachments.ts`). _Why a store by id, not workers
attaching to escalations_: the worker usually takes the screenshot before
the escalation exists, and the orchestrator is the one writing it, so a
handle that outlives the worker's turn (and its worktree) and that any
`--tell` can name is the simplest thing that works in both orders; the
escalation stays one author's, written whole. _Why the bytes go over the
socket_: a worker on a host has its file on the host; the command is the
one thing that runs there and can read it. The `/devhub` skill tells every
agent how.

### Links: `devhub:`

A `--link` can say what it is: `--link URL=LABEL` (or `'URL LABEL'`, needed
when the URL has a `?`: a query's `=` is the URL's). The label is kept by
the link (`linkLabels`) and drawn on its chip, with the short form
(`PR pay#1234`) beside it. `escalation link` takes labels too, and relabels
a link already there.

An escalation (and any agent, in chat) links to places inside DevHub the way
it links to a web page: in `--link`, or as a Markdown link in a body or an
answer. The syntax is `model/devhubLink.ts`'s, each segment percent-encoded
as a URI component (`/` in a path excepted, `:` in a path as `%3A`):

| link                                               | goes to                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `devhub:agent/<id or 4+ prefix>`                   | the agent (`select_context`)                                        |
| `devhub:workspace/<id or name>`                    | the workspace (`select_context`)                                    |
| `devhub:file/<path without its leading />[:L[:C]]` | the file, in the editor of the open workspace whose folder holds it |
| `devhub:escalation/<id>`                           | the Orchestrator row, with the escalation open                      |
| `devhub:orchestrator`                              | the Orchestrator row                                                |
| `devhub:session/<session id>`                      | the agent running that session (resuming one stays `/resume`)       |

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
board's reading view, as one move that selects the row with the escalation
open (`show_orchestrator_view`), so the link is one entry — and never reaches the system browser (main's
`openExternalUrl` refuses a `devhub:` URL). A link whose target is gone is
its text with a quiet 見つかりません, never a broken navigation. External
http(s) links open in the browser as before.

### Writing an escalation: it stands on its own

The person reads escalations, not the orchestrator's chat (the charter's 6),
and reads each one cold: someone seeing it for the first time must be able
to judge it from it alone. "Can I merge PR 1234?" assumes every bit of
context it leaves out. So the body has named sections
(`model/escalationBrief.ts`):

| section               | what                                                                      | required        |
| --------------------- | ------------------------------------------------------------------------- | --------------- |
| `## 背景`             | what this is about, for a newcomer                                        |                 |
| `## やったこと`       | what was done and found                                                   |                 |
| `## 決めてほしいこと` | the one decision or confirmation, as a question, with its options         | `new` and `ask` |
| `## 人に聞く理由`     | why the orchestrator holds it instead of deciding it                      | `new`           |
| `## 推奨`             | the recommended choice, and why                                           |                 |
| `## 確認方法`         | a URL to try, screenshots (`--attach`), PR and Issue URLs, a diff summary |                 |

**It is enforced, not only stated.** `escalation new` (not `--wait`, which
asks nothing yet) and `escalation ask` refuse, with every problem at once
and the template: a body without `## 決めてほしいこと` (also read as
確認してほしいこと, 判断してほしいこと, Decision needed; any heading level,
not inside code); a first question without `## 人に聞く理由` (自分で決めない
理由, Why I'm asking); a `#12`, `PR 1234` or `Issue 56` in the body that no
URL in it or in `--link` points at (`/pull/1234`, `/issues/56`,
`devhub:escalation/12`); and a title that refers to anything by number —
the title says the decision in words, the number is a chip. The card shows
the decision's first line in place of the body's first line.

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

- **依頼** — the person's requests from the header's + (see "Requests"),
  there only while there are any: 送信待ち, 受付待ち, 登録済み.
- **要回答** — ranked: priority first (high, normal, low), then effort
  (quick, normal, deep), then oldest question first, with how long it has
  waited. A ticket asked again after an answer carries 追加の質問.
- **対応中** — answered longest ago first, with how long since the answer.
- **待機中** — parked on an outside condition: each card leads with its
  trigger, and its time (`M/D HH:MM · あと 3日`) when it has one; soonest
  time first, those without one after, then the oldest wait. The person can
  open one and write to it (that moves it to 対応中); there is no button.
- **完了** — closed escalations, the last 30, most recent first.

The board speaks one language, Japanese — the tabs, the lanes, the counts,
the chips on a card (選択肢 3, 優先, 停滞) and each lane's empty line
(対応中のものはありません。) — because the lane names are the CLI's own
vocabulary (`待機中`, `--tell board`), and a lane called 対応中 that says
"Nothing in progress." under itself is two voices in one place. The header's
+, mode control (Full · Saving · Off) and GitHub pill keep English names: they
name a setting and a service, not something the board says.

An escalation's chips — its agents, its Workspace, its links — are all one
look, a hairline pill on no ground: each is a link to somewhere, and that is
all the shape says. What state an agent is in is its mark alone (the status
mark), and what a chip leads to is its glyph (a folder for a Workspace).

待機中 and 完了 fold: the chevron on the left of the heading shows or hides the
lane's cards, with the count kept in the heading. Both start folded, as in
the sidebar; what was folded is kept for the session (`orchestratorMemory.ts`).

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
完了 stays), lands on the board instead; so does a file that is gone. An
escalation open, or a file, is a place in Back and Forward of its own:
opening one is an entry, Back from it is the board (or the tree) as it was
left — its scroll and folded lanes included — and its ‹ is "up to the board",
which is Back when it was opened from that board
(`docs/window-and-pages.md`, Back and Forward). This is kept for the session only; a restart
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
(SVG included) inline. **エディタで開く** opens it in the editor of the
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

The same flag is said of Workspaces (`workspace manage W` / `workspace
unmanage W`, the row's Manage with Orchestrator / Stop Managing): an agent
put under management puts its Workspace there too, and that is what draws
the Workspace under the Orchestrator row ("The orchestrator's work in the
Sidebar", above). `workspaces` says `managed`.

It is kept with the agent in `state.json`, and under its CLI session in
`session-meta.json` with its metadata, so a restart, `agent resume`, Reopen
Closed and `/resume` keep it. `agents` and `sessions` say `managed`,
`agent status` (and `--json` `managed`) too.

**In the Sidebar**, a managed Agent's row outside the Orchestrator row's
group — in Scratch, which is never managed itself — wears a pale wash of the
accent —
the orchestrator's colour — over its whole width (`.agent-row.is-managed`,
`--managed-tint`, light and dark), so the agents the person started
themselves are the plain rows at a glance; hover still shows through it and a
selected row is the selection fill alone. The tooltip says it in words
("Managed by the orchestrator"). Under the Orchestrator row (above) there is
no wash: the place says it. An Agent row also carries small marks after
its words (`AgentMarks`, off the board's `agentStates`), each said in words in
the row's tooltip:

- an hourglass — one of the agents of a 待機中 escalation, stopped but fine
  ("Waiting (#12): <trigger>");
- a warning, in the waiting ink — managed, needing action and not kept:
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

**The population** is every open **item** of the registered Projects
(`[orchestrator.github] projects`) assigned to the viewer — an Issue card or
a pull request card. An Issue and a pull request are one thing here: a pull
request on the board with no Issue is an item as an Issue is, linked,
escalated about and said the same way (`issue=` or `pr=` on its line is the
only difference), and another person's pull request on the board that the
viewer is assigned to review is an item like any other. An item on several
Projects is one item, with a lane on each. **With no Project registered the
population is empty** (`orchestrator status` says so). For each item,
exactly one of these holds:

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
not assigned to the viewer, on no registered Project — or to no item at all,
**whatever it is doing**, for that reason alone: `outside_population
(closed)`, `(unassigned)`, `(not_in_project)`, `(no_item)` — except an
agent whose Issue is still to be filed (`issue=pending`, "Work with no Issue
yet" below), held to the status rule alone. While the
population is not known — GitHub not polled, or its search not read in
full yet — only the status rule applies to agents, and no item is said.

**Linked**, the one rule: an agent is linked to the item its meta `issue=`
names (by URL: an Issue's `/issues/N` or a pull request's `/pull/N`; the one
other value, `pending`, links it to nothing yet). DevHub
writes that pair itself when `issue assign` — or the window's Assign Issue —
starts an agent on an Issue or a pull request (`ISSUE_LINK_KEY`). `agent
meta`, `--meta` and `session meta` set it by hand too — to that URL only, so
an agent started another way can be linked — and it is kept with the agent's
other metadata across restarts and
resumes, and listed by `agent status` as `meta issue=…`. The branch a
Workspace is on links nothing.

**About an item**, for an escalation: one of its links is the item's URL,
or one of its agents — `--agent`, a `devhub:agent/` link, the agents of a
`devhub:workspace/` link or of its `--workspace` — is linked to it.

**Kept**: the orchestrator may decide a managed agent that needs action is to go
on anyway (work outside the population that is still worth doing):
`devhub --tell agent keep A --note TEXT`. It is left out of every delivery while its
state (its status, its item's, its pull request's: what `status` shows)
stays what it was when it was kept; when they change (its item is
assigned or closed, it goes idle after working, …) the keeping ends and it
is said again. `agent keep A --clear` ends it at once. The keeping and its
note are shown by `agent status` (`kept`), `board` and the row's tooltip.
It is kept across restarts, per profile, in
`<userData>/devhub/orchestrator-kept.json` (`keptFile.ts`; written whole and
atomically on every change, moved aside as `.corrupt` and said when it does
not read). What it holds the agent to is its status, its item's state and
its escalations — not its Workspace's pull request, which a restart reads
again later — and after a restart it is judged again only once that is
known again (GitHub's items read, the agent read: not `unknown`), so a
restart or a resume does not end it by itself.

What breaks it now is in `devhub --tell board` (`needs action (N):`,
`--json` `needsAction`: each subject's line, the clause, since when, its
keeping), and each agent's standing in `agent status`
(`invariant`: settled, or the clause it fails; the 待機中 escalation it is
on; its keeping).

### Work with no Issue yet

Some work comes before its Issue: reading error logs to find out what to
write in one. It gets a worktree and an agent like any other, and is linked
to its Issue once there is one.

```sh
devhub --tell workspace open ~/src/app --worktree investigate-api-500s
devhub --tell agent new --workspace ~/src/app_investigate-api-500s --profile claude --gui \
    --managed --meta issue=pending --meta parent=<orchestrator> --prompt -
# … the agent investigates, and files the Issue (gh issue create) …
devhub --tell agent meta A set issue https://github.com/acme/app/issues/130
```

In the window, the Open Workspace picker (`Cmd+Q f`) offers what is typed as
a **New Branch** row beside the repository's branches: the branch, started
from the default, in a worktree of its own; `⌘↵` starts an agent there too,
unmanaged like every agent the window starts.

- **The branch is named by whoever starts the work**, whole, and DevHub
  makes nothing up: `workspace open --worktree` takes any branch, as the
  picker's branch rows always did. It is checked out if it exists (here or
  on a remote) and otherwise started from `origin`'s default branch, as an
  Issue's is. _Why_: the caller knows what the work is, and a name made from
  it is what `git branch`, the Sidebar row and a later pull request show; a
  generated `investigate-<date>-…` would be a second naming rule for the
  window, the CLI and its Go port to share, and git refuses a duplicate
  anyway. The `/devhub` skill suggests `investigate-<a-few-words>`.
- **The folder is `<repo>_<branch>`** (`branchWorktreeDirectory`, `/` and
  other awkward characters as `-`), beside the Issues' `<repo>_<N>`. A
  branch whose name carries an Issue number (`feature/123-x`, `#123`) is
  that Issue's work and goes in `<repo>_123`, as before. _Why_: the folder
  rule already existed for the picker's branch rows; reusing it keeps one
  rule, and a name with no number can never land in an Issue's folder.
- **`issue=pending`** is the one value of the link key that is not a URL
  (`ISSUE_PENDING`). A managed agent carrying it is held to the status rule
  only — working, or one of the agents of a 要回答 or 待機中 escalation — and
  never `outside_population (no_item)`: investigating is what it is for, so
  it is not a stray to be closed. When it stops with nothing settling it, it
  is `idle_no_escalation`, as any managed agent, and the orchestrator's next
  step is the Issue: have the agent file it and link it, or raise an
  escalation with the draft for the person. _Why a value of `issue=` and not
  a new flag or key_: linking the Issue later is then the one call the
  linkage rule already has (`agent meta A set issue <URL>` replaces it), so
  "pending" and "linked" can never both be set or both be stale, and every
  place that keeps metadata (restarts, resumes, `session meta`) keeps it
  with no new code. DevHub reads it as no item — it is never fetched from
  GitHub as a URL. _Why not unmanaged by default_: an agent the orchestrator
  starts is the orchestrator's to watch; unmanaged it would leave no trace
  when it stopped. An unmanaged agent (the window's) is left out anyway.
- **Linked later**, it is an ordinary item's agent: the Issue just filed
  and not on a registered Project yet is `outside_population
(not_in_project)` until it is put on one and assigned — which is the
  person's workflow, said the usual way. Escalations about the agent become
  about the item with it (they are "about" an item through its agents).
- **The branch is not renamed when the Issue is linked.** _Why_: the agent
  is working in it — its shell, its CLI session's folder, maybe a pushed
  branch with a pull request — and the folder cannot follow a rename
  without moving the agent; the Orchestrator links by `issue=`, never by
  the branch, so nothing here needs it. If the team names branches by Issue,
  the agent renames it itself (`git branch -m 130-api-500s`) before pushing:
  the Sidebar then links the Workspace to #130 by the branch, and the folder
  keeps its name, as `worktrees.ts` already has it for `feature/128-wip`.
- **`status`** says it: `linked to no item yet (issue=pending: …)`, and in
  `--json` `"linked": null, "pendingIssue": true`; `agent status` lists
  `meta issue=pending`.

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
  escalations about it (state, trigger, time), and the clause it fails and
  since when;
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
                   "since": "2026-11-05T09:00:00.000Z" },
  "agents": [{ "id": "a1b2c3d4-…", "name": "PR 9 review", "ws": "web", "workspaceId": "…",
               "status": "idle", "managed": true, "linked": "https://github.com/acme/app/pull/9",
               "needsAction": "idle_no_escalation", "kept": null }],
  "escalations": [] }
```

An agent's has `"subject": "agent"`, `agent`, `item` (or null),
`workspace` (the tooltip's facts), `needsAction`, `waiting` and
`escalations`. An item DevHub has not read (on no registered Project) is
refused with what it does read; an agent linked to one stands as
`outside_population (not_in_project)`.

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

| type                      | when                                                                                                                                                                                        | example                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`                    | the orchestrator has just started (or restarted)                                                                                                                                            | `[init] — オーケストレーターが起動しました。devhub --tell board で現状を確認`                                                                                                        |
| `escalation_answered`     | the person answered an escalation (→ 対応中). Sent at once, as its own message: the person's words                                                                                          | `esc=12「本番DBマイグレーション承認」 への人の回答 (選択肢「承認する」):` and, on the next line, `承認する`                                                                          |
| `escalation.human_direct` | the person wrote to an open escalation's agent from its own composer and it went working (要回答 → 対応中). Sent at once, as its own message                                                | `esc=12「本番DBマイグレーション承認」 agent=a1b2c3d4 に人が直接送ったメッセージ:` and, on the next line, what they wrote                                                             |
| `needs_action`            | an item of the population, or a managed agent, breaks the invariant: on every delivery while it does (every `delivery_interval`), unless it is kept (`agent keep`, until its state changes) | `[needs_action] issue=acme/web#123 ws=web — no_agent`, `[needs_action] agent=ab12cd34 (API fix) ws=web — idle_no_escalation`, `[needs_action] agent=… — outside_population (closed)` |
| `waiting.changed`         | a 待機中 escalation may be ready: what it is about changed (`subjects_changed`), or its `--at` came (`due`, once per wait)                                                                  | `[waiting.changed] esc=12 — subjects_changed`, `[waiting.changed] esc=15 — due`                                                                                                      |
| `usage.threshold`         | a plan window's use crossed one of `usage_thresholds` upward (once per threshold per window period; dropped if the window reset first)                                                      | `[usage.threshold] cli=claude window=5-hour pct=82 resets=19:20 — 5時間枠が80%を超えました`                                                                                          |
| `triage`                  | time to rank the open work again: every 30 minutes in full, every hour in saving (see "Triage")                                                                                             | `[triage] — 優先度の見直し: …`                                                                                                                                                       |
| `request`                 | the person sent a request from the board's +. Sent at once, as its own message: the person's words                                                                                          | `req=3 人からの依頼 (…):` and, on the next line, what they wrote                                                                                                                     |
| `timer.elapsed`           | a `[[orchestrator.timers]]` timer, or one `orchestrator timer set` made                                                                                                                     | `[timer.elapsed] sweep`                                                                                                                                                              |
| `custom.*`                | `devhub --tell orchestrator emit --type custom.NAME --text …`                                                                                                                               | `[custom.deploy] — staging に deploy 完了`                                                                                                                                           |

The `needs_action` codes: an item's `no_agent` or `idle_no_escalation`
(`issue=` or `pr=` names it, `ws=` its first agent's Workspace); a managed
agent's `idle_no_escalation` or `outside_population (closed|unassigned|not_in_project|no_item)`
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
- **Re-read before it goes** (`relevant`): a wait no longer 待機中, a window
  reset below its threshold — dropped as `dropped-stale`.
- **The nag** (`standing`): `needs_action` is never pending. Every delivery
  reads the invariant as it stands then and carries one line per subject
  that needs action and is not kept (`InvariantWatch.due`): no grace, no
  "said once", no reminder setting. While any does, a delivery is made every
  `delivery_interval`, so an unresolved subject is said again every 5
  minutes by default; one that settled in between is on none. A delivery
  with nothing to carry is not sent. `orchestrator events` logs each line
  as it goes (`delivered`).
- **Paused** (the mode **off**: `orchestrator mode off` or `pause`, the board's Off): everything
  is held, the person's words too, and GitHub is not polled; pausing sends
  nothing. **Turning on delivers at once** (full or saving: `orchestrator
mode full`, `resume`, the board's Full or Saving): the person's held words, each alone, then what is pending and the
  `needs_action` lines that stand now as one message — also when nothing
  was pending but some subject needs action — whatever the interval, the
  orchestrator's turn or the pickup wait; the interval then counts from
  that delivery. GitHub polls again at once (the rate limit permitting),
  alongside rather than before: the standing lines are read off the last
  reading, and what the catch-up poll finds goes with the next delivery.
- **The preview** (hover or focus the mode control, or the pending count):
  a card with exactly what the next delivery would send now — the person's
  held words, each as its own message, then the batch as `event_prompt`
  renders it (pending lines, stale ones left out, then the standing
  `needs_action` lines, kept ones left out) — and when it goes: now, at the
  interval's end, when the orchestrator's turn ends, not while saving holds
  it for the work in progress, or not while off;
  "Nothing to send" when nothing would. Main composes it with the delivery's
  own `composeDelivery` (`EventDispatcher.preview`, on the board as
  `nextDelivery`), reading only: nothing is marked delivered, logged or
  scheduled.
- **Kept in a log**: `orchestrator events` lists the last ones and what came
  of each (`delivered`, `pending`, `filtered`, `coalesced` into which,
  `dropped-stale`, `overflow`, `dropped` with no orchestrator).

### Modes: full, saving, off

The board header's **Full · Saving · Off** control (a radio group: one tab
stop, the arrows choose), the command palette's **Orchestrator: Full**,
**Orchestrator: Saving (fewer nudges)** and **Orchestrator: Off**
(`orchestrator_full`, `orchestrator_saving`, `orchestrator_off`; palette only,
rebindable like every command) and `devhub --tell orchestrator mode
[full|saving|off]` all set the same mode (`main/orchestrator/mode.ts`).
`orchestrator pause` and `resume` are kept: they are `mode off` and `mode
full`. The Sidebar row's tooltip names the mode; the header shows `auto`
beside it when saving came by itself, and its card says why.

| mode       | what is delivered                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **full**   | everything, as described above: a batch at most every `delivery_interval`, each carrying every `needs_action` subject again (what "on" was)                                                             |
| **saving** | the same, more rarely: at most every **3 ×** `delivery_interval` (`SAVING_INTERVAL_FACTOR`), and **no batch at all while 2 or more tasks are in progress**. The person's words and `init` go as in full |
| **off**    | nothing: everything is held, the person's words too, and GitHub is not polled (what "off" was)                                                                                                          |

- **A nudge** is a batch: the pending lines and the standing `needs_action`
  lines, the message that has the orchestrator prod its agents (or itself)
  on. The person's words are not nudges and go at once in saving too; a
  batch carrying `init` (a start) is not held by the work in progress.
- **Why 3 ×.** Every delivery is one orchestrator turn — reading the batch,
  handing each line to a subagent — and the nag puts an unresolved subject on
  every one, so the interval is what it spends while things stand still.
  Three times the interval cuts that by two thirds and still says an
  unresolved subject again within a quarter of an hour at the default 5m
  (3 minutes at 1m): nothing waits long enough to be forgotten. Four times
  would leave a stuck subject unsaid for 20 minutes, a sizeable piece of a
  5-hour window.
- **A task in progress** is an item under the Orchestrator row in its
  **対応中** lane — the number the Sidebar's 対応中 heading shows (an
  escalation about it 対応中, or one of its agents at work: working,
  background, on a prompt, still being read). Main counts it with the
  Sidebar's own rule (`ipc/orchestratorLanes.ts`, `inProgressCount`), so the
  rule and the heading cannot disagree. With two at work, the orchestrator
  has its hands full and the agents are moving by themselves: a nudge would
  only spend tokens telling it what it is already doing. A batch held this
  way is looked at again on every projection (an agent stopping) and every
  30 s, and goes as soon as fewer than two are in progress; the preview
  says `saving: held while N tasks are in progress`. Turning on into saving
  holds the batch this way too (the person's held words still go).
- **Nothing else changes.** GitHub is polled at its own interval in full and
  saving alike (it costs GitHub quota, not tokens), timers fire as set, and
  no line is dropped: held lines wait, one per subject, and go with the next
  batch. Nothing beyond the interval and the gate was added to saving.
- **Off at every launch.** The mode is not written anywhere — not
  `state.json`, not `escalations.json` — so DevHub always starts off: an
  orchestrator agent restored with its session costs nothing until the
  person turns it on. The pause was never persisted either, so nothing kept
  across launches had to stay. **Start Orchestrator** (the window's, or
  `orchestrator start`) turns an off one to full — starting one is asking it
  to work — and leaves full or saving as they are. The control works with no
  orchestrator running.

**The automatic switch.** While the mode is **full** and any plan window of
the usage readout — Claude's 5-hour or weekly, Codex's when it is read —
stands at `[orchestrator] saving_threshold` (default 80) or more in its
current period, the mode becomes **saving** by itself, and a quiet notice
says why (`Orchestrator switched to saving: Claude's 5-hour window is at 82%
(saving_threshold 80%). …`): a condition toast that hides by itself and
stays in the notice center, taken down when that saving ends.

- **Back to full** when every window is under the threshold again — it
  reset, or reads below — **only if saving was entered automatically**. A
  saving the person chose stays saving. A reading whose reset time has
  passed is the last period's and counts as under; DevHub also looks once
  at the window's reset, in case the readers are slow to say so.
- **Never out of off**, up or down: off is the person's.
- **The person's choice wins.** Choosing full while an automatic saving is
  in force holds full until every window is under again (the next crossing,
  after a reset, switches again). Choosing saving by hand makes it the
  person's: it no longer returns to full on a reset. Turning on as full
  from off while a window is over is saving at once, with the notice — as
  it would have been, had it been full when the window crossed.
- **Why a setting.** The other percents the orchestrator reads off the
  readout are settings (`usage_thresholds`), so this one is too:
  `saving_threshold`, a whole percent from 1 to 100, in Settings ▸ General ▸
  Orchestrator, validated with every other setting; left unset it is 80
  and not written. `100` switches only on a full window.

### Triage: priorities

DevHub asks the orchestrator, on a schedule, to rank its open work again,
and keeps the ranking where DevHub reads it (`main/orchestrator/triage.ts`).

- **The ask** is a `triage` event: `[triage] — 優先度の見直し: …`, every
  **30 minutes in full** and **every hour in saving**, counted from the last
  one — or from when the mode went on, or the orchestrator started (its
  `init` already has it read the board). Never while off. A triage is the
  heaviest turn the orchestrator takes (it reads the board and ranks
  everything), so it is a few times rarer than the nag; twice an hour keeps
  the ranking about as fresh as the work it ranks (agents' turns, reviews,
  CI) changes. In saving it is also how long a line that is not high may
  wait, and an hour is a fifth of the 5-hour window. `orchestrator priority`
  says when the last went and the next is due.
- **The ranking** is `high`, `normal` or `low` per subject, recorded with
  `devhub --tell orchestrator priority set SUBJECT LEVEL [--note WHY]`, the
  subject named as its event line names it: `esc=12`, `issue=OWNER/REPO#N`,
  `pr=OWNER/REPO#N`, `agent=ID` (a unique prefix will do), `req=N`. An
  escalation's priority **is** its rank (`escalation rank --priority`, the
  board's 優先 chip and the 要回答 order), so it has one place; every
  other subject's is kept in `orchestrator-priorities.json` (per profile,
  across restarts, the newest 500). `priority list` (or `--json`) gives them
  all, `priority clear` takes one back. The board shows them calmly: an
  escalation's 優先 chip and order as before, a request's 優先 chip, an
  agent's in its Sidebar tooltip (`priority: high`), and each `needsAction`
  subject's in `board --json`.
- **In saving, only high goes.** A batch carries only the lines about a
  subject ranked **high** — an escalation, an item, an agent or a request
  whose priority is `high`. Every other line — a subject ranked normal or
  low, one not ranked yet, and lines about no subject (timers, the usage
  readout, `custom.*`) — stays pending, one line per subject as always, and
  goes with the next batch that carries `triage` (a triage takes everything
  pending and every standing `needs_action` line with it, so the
  orchestrator ranks with the whole picture), or as soon as the mode is
  full. **High** is the level, not a count: the charter asks the
  orchestrator to keep it for what makes the person or other work wait (a
  person waiting on an answer, a deadline, production, an item blocking
  others), and to keep it to about three. The person's words, requests,
  `init` and `triage` are never held by it. Saving's other rules stand: no
  batch at all while two or more tasks are in progress, a triage's
  included.

### Requests: the board's +

The **+** in the board's header (or `Cmd+Q +`, "Orchestrator: New
Request…" in the palette, which shows the screen first) opens a small
composer under the header — the conversation's box — for asking the
orchestrator for something, such as a task to file. ⌘Return (or 送信)
sends it, Esc closes it and gives the keyboard back to the +.

- **It is the person's words**: a `request` event, delivered at once as its
  own message (`req=3 人からの依頼 (…):` and, on the next line, the text as
  typed), like an answer — held only while the mode is off, and never by
  saving's gates. One sent with no orchestrator running waits for one, and
  goes once it starts, as do the ones kept from before a
  restart.
- **It is on the board at once**, in a **依頼** lane above 要回答 (there only
  while there are requests): **送信待ち** while off (or with no
  orchestrator), **受付待ち** once
  delivered, **登録済み** with where it went once the orchestrator files it
  as a task (an Issue, an agent's work, an escalation) and says so with
  `devhub --tell orchestrator request done N --note "<where>"`. The heading
  counts the open ones; the last three filed stay under them.
- Kept in `orchestrator-requests.json` across restarts; `orchestrator
request list` lists them. It is a request rather than a task item of its
  own: the orchestrator already files work as Issues and agents, and a
  second kind of task would be a second board to keep in step.

### The sources

- **The board** (`orchestratorService.ts`): the answers, the person's direct
  words, `waiting.changed` (`— due`); and the invariant, read off every projection
  and every GitHub poll (`InvariantWatch`); every delivery carries the
  subjects that need action then (above: the nag). `waiting.changed`
  (`— subjects_changed`) compares each 待機中 escalation's subjects' facts
  with the last look (its first look says nothing).
- **GitHub** (`githubItems.ts`): read — never written — one request per
  tick. The population is asked of GitHub directly: one search,
  `is:open assignee:@me archived:false` (100 a page; one page, as a rule),
  giving each open Issue and pull request assigned to the viewer with its
  state, assignees, for an Issue the pull requests that close it, and the
  Projects it is on (`projectItems`) with its lane (Status) on each; an item
  is in the population when one of those is a registered Project. No
  Project is read in full, so a Project of thousands of cards (Done, closed)
  costs nothing more than a small one. The first page of a **pass** also
  carries the extras: the review decision, unresolved conversations and
  checks of the open pull requests the last pass named (`nodes`, at most
  50), the items managed agents are linked to that the search did not give
  (`resource(url:)`, at most 20 — so an agent's closed or unassigned item is
  said as such, and one the search gave on no registered Project as
  `not_in_project`), and a look at each registered Project (its title, or
  that GitHub has none). Only when a pass found what its extras did not
  cover yet (at launch: the pull requests just named) does one request of
  extras alone follow it. **A pass is about one request** — a few points of
  GitHub's 5,000 an hour, at the interval's pace — and further search pages
  (rare) follow at once, one request at a time. With no Project registered
  it does not poll at all. That is what the invariant's population and facts
  are read off (`items`); it says no event itself. A complete pass waits the
  interval, which starts at `[orchestrator.github] interval` and only backs
  off (slower as the rate limit runs down — mid-pass too, the pages then go
  at the interval's pace —, paused until it resets when low, doubling after
  a failure). While paused it does not poll at all. It is never silently
  unread: until the population is known, the board's GitHub card
  ("Reading") and `orchestrator status` ("the population is not known yet:
  …") say what is being read (the search and its page), and the last error
  ("Last error", `last error (since …)`) says where it came from (a Project,
  `searching`, a linked item, `pull request details`, or `GitHub` for the
  whole request) in GitHub's words. A Project GitHub answers as nothing
  without a word (an owner it does not know, a Project the token cannot
  see) is said as such,
  and a missing `read:project` scope (`projectItems` needs it) says to run
  `gh auth refresh -s read:project`. "Last poll" is when the last request
  was sent and how it went (ok, failed, in flight); "Next poll" when the
  next is to be sent — never before the last ("right after this one" while
  one is out). "Assigned to me" is the count once known, else why not: not
  polled, events paused, see Last error, or reading. Nothing is kept on
  disk: it reads state, not diffs, so a restart reads afresh (the
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
delivery_interval = "5m"         # a batch at most this often (the default; at least 10s), each saying every needs_action subject again; the person's words go at once
saving_threshold = 80            # full switches to saving at this percent of any plan window (the default; 1–100), and back after it resets

[orchestrator.github]
projects = ["my-org/7"]          # Projects (v2) boards, OWNER/NUMBER: their open items assigned to me are the population; none: it is empty
interval = "90s"                 # the base interval between passes (~1 request each; at least 30s); it only backs off

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
once as a retired setting; so are `wait_reminder_interval` and
`reminder_interval` (`RETIRED_KEYS`: there is one cadence, `delivery_interval`).
They are in Settings ▸ General ▸ Orchestrator and validated with every other
setting.

## The command line

```sh
devhub --tell board [--json]                         # 要回答, 対応中 (停滞 marked), 待機中, and what needs action now, as data
devhub --tell [--json] status ITEM|A                 # one subject's whole state: an item (owner/repo#N or URL) or an agent
devhub --tell agent manage A | agent unmanage A     # under the orchestrator's management, or not
devhub --tell workspace manage W | workspace unmanage W   # a workspace, the same flag (unmanage: its agents too)
devhub --tell agent keep A --note TEXT | --clear    # leave a managed agent that needs action as it is, for a reason, until its state changes
devhub --tell --json agent status A                 # managed, invariant (settled or the clause, 待機中 escalation, kept)
devhub --tell --json workspace status W             # branch, Issue (state, lanes), PR (state, draft, review decision), conversations, checks
devhub --tell escalation new --title T --body -|TEXT [--agent A]... [--link URL[=LABEL]]... [--option TEXT]... [--workspace W]
                         [--attach FILE|att-ID[=CAPTION]]... [--priority high|normal|low] [--effort quick|normal|deep] [--rank-note TEXT]
devhub --tell escalation rank ID [--priority P] [--effort E] [--rank-note TEXT]   # re-rank; "" clears the note
devhub --tell escalation ask ID --body -|TEXT [--option TEXT]... [--link URL[=LABEL]]... [--attach FILE|att-ID[=CAPTION]]...   # back to 要回答
devhub --tell attachment add FILE[=CAPTION]...      # a worker hands pictures over: an id each, for --attach
devhub --tell link agent A | workspace W | file PATH[:L[:C]] | escalation ID | orchestrator | session S   # a devhub: link
devhub --tell escalation show ID [--json]           # the thread (acknowledges the answer)
devhub --tell escalation list [--state needs_answer|in_progress|waiting|closed] [--json]
devhub --tell escalation close ID [--note TEXT]
devhub --tell escalation link ID [--agent A] [--link URL[=LABEL]]...   # more it is about, after it was raised
devhub --tell escalation hold ID [--note TEXT]      # park it in 対応中 (not an answer)
devhub --tell escalation wait ID --trigger TEXT [--at DATETIME]   # park it in 待機中 on an outside condition
devhub --tell escalation resume ID [--note TEXT]    # off its wait, to 対応中
devhub --tell orchestrator start --root PATH --profile P --gui|--tui [--prompt -|TEXT]
devhub --tell orchestrator status [--json]          # its agent, state, lane counts, mode, GitHub polling
devhub --tell orchestrator stop | restart           # Stop Agent / Restart Session on it
devhub --tell orchestrator mode [full|saving|off]   # the mode, or choose one (off at every launch; see "Modes")
devhub --tell orchestrator priority set SUBJECT high|normal|low [--note WHY]   # triage: esc=N, issue=/pr=OWNER/REPO#N, agent=ID, req=N
devhub --tell orchestrator priority [list] | clear SUBJECT   # the ranking, the last and next triage
devhub --tell orchestrator request list | done N [--note WHERE]   # the person's requests (the board's +)
devhub --tell orchestrator pause | resume          # mode off (GitHub polling suspended) / mode full (delivers at once, as one message)
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
   the person's) or with no item (unless `issue=pending`) is **closed**, not kept
   around: a subagent first asks that agent about unpushed work or an open
   pull request, then `agent stop` (and `workspace close` with its flags named)
   — unless the orchestrator decides it is still worth doing, and says why
   with `agent keep A --note`; never without a reason.
5. **DevHub's conventions**: the item linkage rule (meta `issue=`, an
   Issue's or a pull request's URL, by `issue assign`, never by hand; work
   with no Issue yet: `workspace open --worktree` and `agent new --meta
issue=pending`, linked once the Issue is filed), `--managed` (and `--meta parent=<its id>`) on
   every agent it starts, never approving a permission prompt, never writing
   the person's answer, never taking the screen (`focus` only when asked),
   and holding back on new agents when a plan window runs high
   (`usage.threshold`, `devhub --tell usage`).
6. **The person reads escalations, not the chat**: everything that needs
   them goes in an escalation, and each one stands on its own for a
   first-time reader — the sections of "Writing an escalation", full
   URLs with a line of what each is, screenshots by `--attach` (a worker's
   by `attachment add` and its id), the title reviewed before raising
   (specific, understandable without context, the decision in words), and a
   short bad and good example.

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

The sections are DevHub's (see "Writing an escalation"; two are required);
the rest is a starting point for the orchestrator's own skill. Escalate
only what needs a person's decision or permission, after the read-only
investigation (code, Notion, Slack) is done; when the facts are not enough,
send an agent to dig further instead. Write in the person's language, for an
engineer who does not know the system, the domain or the code: code
snippets, formulas, diagrams (Mermaid, SVG) and tables render as they do in
a chat answer.

```markdown
## 背景 — what this is about, for someone new to it

## やったこと — what has been done and found

## 決めてほしいこと — the one decision, stated as a question, with its options

## 人に聞く理由 — why the orchestrator does not decide it itself

## 推奨 — the recommended option, and why

## 確認方法 — a URL to try, screenshots (--attach), PRs and Issues as full URLs, a diff summary

## 回答の後 — what the orchestrator will have the agents do (optional)
```

```sh
devhub --tell escalation new \
    --title "決済リトライのタイムアウトを 30 秒→60 秒にする修正をマージしてよいか" \
    --body - --agent A --option "マージする" --option "見送る" \
    --link "https://github.com/acme/pay/pull/1234=タイムアウト延長の PR" \
    --attach att-1a2b3c4d --attach out/staging.png=staging での再試行
```

Add `--option` for each choice so the person can answer with one click; free
text is always allowed.
