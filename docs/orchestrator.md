# The Orchestrator row: tasks, escalations and events

One agent can coordinate the others through `devhub --tell` (see the README,
"Orchestrating"). The Orchestrator row gives that agent a place in the window
and gives the person a board of what it needs from them. DevHub supplies the
**mechanism** — the row, the board of tasks, escalations, events, the
invariant it reports — and its own short **charter** (what the orchestrator is for, that
it never does hands-on work, that it routes each line to a subagent, and
DevHub's conventions; see "The charter"). Everything else — what the
orchestrator does for the team, how it decides what to escalate and how it
writes — is the person's own, in skills and instructions in the
orchestrator's folder.

```text
┌───────────────┬──────────────────────────┬────────────────────────┐
│ Orchestrator 3│ Board         Events ●   │                        │
│    research ● │ ● 回答待ち 3             │  the orchestrator      │
│ Scratch       │   #1 本番 invoices …  1m │  agent's own pane      │
│ ▼ payments    │ ● 処理中 2               │  (an ordinary GUI or   │
│    Claude ●   │   #2 決済リトライ …      │   terminal Agent)      │
│ ▼ web-console │                          │                        │
│    Claude ○   │                          │                        │
└───────────────┴──────────────────────────┴────────────────────────┘
```

## The row and the screen

- **The row** is the Sidebar's first, above Scratch. It ends with the number
  of open questions — escalations waiting for the person's answer, on every
  task — the one filled badge in the Sidebar.
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
  (`main/shell/shellTitle.ts`; the page reports only a task id or a
  file path, `reportOrchestratorView`, and main composes the title):

  | Showing                            | Title                                                                   |
  | ---------------------------------- | ----------------------------------------------------------------------- |
  | the board, or the Files tab's tree | `Orchestrator — DevHub`                                                 |
  | a task                             | `payments · 本番DBマイグレーション承認 — Orchestrator — DevHub`         |
  | a task, Workspace on an Issue      | `payments #123 · 本番DBマイグレーション承認 — Orchestrator — DevHub`    |
  | a task, Workspace on a PR          | `payments PR #130 · 本番DBマイグレーション承認 — Orchestrator — DevHub` |
  | a task with no agent               | `本番DBマイグレーション承認 — Orchestrator — DevHub`                    |
  | a file in the Files tab            | `decisions.md — Orchestrator — DevHub`                                  |
  | a helper agent under the row       | as any Agent: `helper — Orchestrator — DevHub`                          |

  The Workspace is that of the task's first open bound agent (by its usual
  label; not the Orchestrator's own), so the time lands on that project. That Workspace carries its Issue as everywhere else in the title
  — `#123`, `owner/repo#123` when the Issue is in another repository,
  `PR #130` on a pull request's branch with no Issue, nothing when none is
  known ([window-and-pages.md](window-and-pages.md#the-windows-title)). The
  task's title and the file name are put on one line and cut near 80 characters; no question or answer text is ever in the title. It follows
  every open, Back, Forward and tab, and the screen coming back as it was.

## The orchestrator's work in the Sidebar

```text
 Orchestrator        ✓ 1        (folded:  Orchestrator   ✓ 6 1)
   ⌄ ● 回答待ち         1
       ✓ rounding-migration
   ⌄ ● 処理中           2
       ◌ investigate-500s
       ◌ review-517  PR #517
   ⌄ ● 待機             2
       ✓ research          △
       ✓ docs-pass
   › ● 完了             1
 Scratch
 dotfiles  main
   └ ◌ Claude                   (the person's)
 notes  main
```

Under the Orchestrator row is what the orchestrator is doing, grouped by the
status of its tasks, in the board's order (`shell/components/sidebar/orchestratorLanes.ts`). The rest of
the Sidebar is the person's places, as before.

**What is there.** Two kinds of item:

- **its helpers**: the agents in the orchestrator's own folder, the
  orchestrator agent itself apart (it is the row);
- **the managed Workspaces.** _Managed_ is one flag, said of agents and of
  Workspaces alike (`Agent.managed`, `Workspace.managed`): the
  orchestrator's work is in it. There is no second notion — "opened by the
  orchestrator" is the same thing, and is how most Workspaces come to be
  managed. A Workspace is managed
  - when the orchestrator's side opens a folder that was not open —
    `devhub --tell workspace open` (a worktree included, for work with no
    Issue yet too) or `issue assign`, asked by the orchestrator agent or by
    an agent it manages (the `open_folder` intent's `managed`, applied by
    the coordinator only to a Workspace that open adds);
  - when an agent in it is put under management — `agent new --managed`,
    `issue assign --managed`, `agent manage`, a managed session resumed
    there (`AppModel.setAgentManaged`);
  - by `workspace manage W`, or the row's **Manage with Orchestrator**
    (right-click, or `Cmd+Q Shift+M` with the row selected; also in the
    palette, `Cmd+Q :`). With one of its agents selected the same key is
    that agent's Manage with Orchestrator ("Managed agents").

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

**Which status.** The board's statuses in the board's order. An item is
under the first that holds of the tasks its agents are bound to (for a
Workspace, also the open tasks one of whose bound agents ran there):

| status   | when                                                                                                   | heading      |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------ |
| 回答待ち | one of those tasks has an open escalation                                                              | accent dot   |
| 処理中   | one is 処理中, or one of its agents is at work (working, background, on a prompt, still being read)    | working dot  |
| 待機     | one is 待機, or one of its agents needs action with no task (stopped, bound to nothing: the △ says so) | idle dot     |
| 完了     | nothing about it is open: its tasks are done, or it has none and nothing about it needs action         | tertiary dot |

**要対応 is a mark, not a place.** A task nobody moves, or an agent with no
task, wears the △ (the needs-action mark) on its row, wherever the row
stands: it is a flag on the work, not a fourth status, so a row does not
jump to another heading because it needs action — `agentStates.needsAction`,
and the clause in its tooltip. Moving rows between headings only for a
status change keeps the glide (below) for what the work is.

**What a heading is.** The board's word, its colour as a dot, and how many
items are in it. A status with nothing in it has no heading. 完了 starts
folded, as on the board; what is folded — each lane, and the group as a
whole — is kept for the session (`sessionStorage`; a restart starts afresh).
Folded, the Orchestrator row shows how many items it holds, quiet, before
the badge; the badge (open questions) never folds. The disclosure is the row's own
mark: under the pointer or the keyboard the orchestrator glyph turns into a
chevron, which folds the group. With nothing under it the row is exactly the
row it was: no disclosure, no count, not expandable.

**In the rail.** Compact mode's rail draws the group row for row, so every
row stands at the same y in the rail as in the Sidebar it grows into under
the pointer (and as in the docked column): a hand that went for a row in the
rail finds it under it once the rail has grown. The Orchestrator row is its
mark, carrying the badge. A heading is quiet, because it is not somewhere to
go: its lane's colour as a small dot on a hairline across the column ("the
rows below are this lane"), a ring when the lane is folded. An item is its mark, as a top-level row
is in the rail: an agent's status mark (spinner, check, unread dot), a
Workspace's icon; the orchestrator's own marks (⏳, △) are its tooltip's to
say there, as a top-level agent's are its tooltip's. Every one has the same
tooltip, the same click and the same keys as in the Sidebar (a heading folds
its lane; →/← fold and walk; a click on a heading leaves the floating
Sidebar open). Folds are the same state in both, so a folded lane or a
folded group is the one row in both, and a lane change glides in the rail as
it does expanded. `orchestratorLanes.test.tsx` ("the rail and the expanded
Sidebar") holds the rows and the stylesheets to it: the same rows in the same
boxes for every fold, and no rail-only rule that says anything vertical of a
row's boxes.

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

## Tasks

A **task** is DevHub's internal ticket for one piece of the orchestrator's
work (`model/tasks.ts`). It has no thread and no body: it says what the work
is, what it is about, who works on it and what is next.

```text
{ id, title, status: waiting|in_progress, waitNote?, checkAt?,
  links: [urls], linkLabels?: {url: label},
  agents: [{ agentId, name, profileId, kind, presentation, machine, folder,
             branch?, sessions: [ids, newest last], startedAt, seenAt, stoppedAt? }],
  memo?: { text, at }, priority?: high|normal|low, priorityNote?,
  request?: { text, at, sentAt? }, createdAt, updatedAt, done?: { at, note? } }
```

- **Links** are 0..n URLs: Issues and pull requests (what the invariant and
  staleness read), or anything else (a Notion page, a Slack thread), each
  with an optional label (`--link URL=LABEL`). A task with no link is fine:
  work with no Issue yet (investigating to write one), or a request.
- **Agents** are the ones bound to it, with the CLI sessions they ran, so
  `agent resume task=12` brings the same agent back on the same
  conversation (below). This absorbs what the work records were. **An agent
  is bound to at most one open task**: binding it moves it off any other.
  A done task keeps its agents, as history.
- **One memo** (500 characters at most): what the orchestrator will do next
  with it. `task edit T --memo` replaces it.
- **A priority**, with a short note why: what triage sets and saving reads.
- **Done** once the orchestrator completes it (`task done T [--note]`); an
  open question on it is withdrawn with it (`タスク完了で取り下げ`).

**Its status** is one of three while it is open, plus done:

| status   | stored as                             | when                                                                                         |
| -------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| 回答待ち | — (derived: never stored)             | an escalation on it is open. The stored status cannot disagree with the questions it has     |
| 処理中   | `in_progress`                         | the orchestrator or its agents are on it                                                     |
| 待機     | `waiting`, with `waitNote`, `checkAt` | parked on purpose: what it waits for in words, and maybe a time to look again (`--check-at`) |
| 完了     | `done`                                | completed                                                                                    |

The orchestrator sets 待機 and 処理中 itself (`task status T
waiting|in_progress`). DevHub moves the stored status in exactly two
places, as bookkeeping and never as a decision: **the person's answer** sets
it to 処理中 (the answer is work to carry out), and **a bound agent going to
work** moves a 待機 one to 処理中 (`TaskStore.agentWorking`). `--check-at`
only wakes the orchestrator (`task.changed — due`); it decides nothing.
**Nothing ever proceeds by a time limit**: an open question waits for the
person however long it takes.

**要対応** is not a status: it is a flag the invariant puts on a task that
nobody moves (below), drawn as the △ on its card and its agents' rows.

**Who makes them.** The orchestrator, freely (`task new`, `task done`):
the charter asks it for one task per piece of work, before it starts the
agents. `agent new --task T` and `issue assign --task T` bind from the
start; `issue assign` without `--task` binds to the open task that links the
item, else makes one linked to it (and says so). The person makes one with
the board's **+** (a 待機 task holding their words: "Requests" below).

**Kept** per profile in `<userData>/devhub/orchestrator-tasks.json`, tasks
and escalations together, written whole and atomically on every change; a
file that does not read is moved to `.corrupt` and said, and the board
starts empty.

**From the design before tasks** — `escalations.json`,
`orchestrator-work.json`, `orchestrator-memos.json`,
`orchestrator-priorities.json`, `orchestrator-requests.json` and
`orchestrator-kept.json` — the first load with no tasks file converts them
once (`model/taskMigration.ts`) and renames each to `*.migrated`; there is
no shim, and nothing reads the old files again. Each escalation becomes a
task under its own number: 要回答 → 回答待ち (its latest question open, under
the same number), 対応中 → 処理中, 待機中 → 待機 (the trigger as the wait's
note, `dueAt` as `checkAt`), closed → done. An answered question is kept
answered, an unanswered one that is no longer asked is withdrawn; an earlier
question of a thread asked again is a past escalation of its own on the
task (numbered after every old one), with the answer given before the next
question — a follow-up is a new escalation, and that is what it was. The
notes of a thread (held, resumed, direct) are not carried over.
Each work record's agents join the task that links their item (or the task
their agent is on), else a task of their own; a memo or a priority lands on
its subject's task (a memo with none makes a 待機 task for its item; a
priority with none is dropped); a request becomes a task, done once it was
filed. An agent ends on one open task at most. `agent keep` has no
counterpart and is dropped.

## Escalations

An escalation is **one question and its answer**, on one task (`model/escalations.ts`):

```text
{ id, taskId, title, question: { markdown, at, options? },
  links: [urls], linkLabels?: {url: label}, createdAt,
  answer?: { markdown, at, option?, direct?: { agentId, sentAt, note? } },
  withdrawn?: { at, note? } }
```

It is `open` until the person answers it (`answered`: in the window, or
directly to an agent of its task, which `escalation resolve ID [--note]`
records as `answer.direct` — below) or the orchestrator takes it back
(`withdrawn`, `escalation withdraw ID [--note]`, or the task done). An answered or withdrawn one is never asked again: **a follow-up is a
new escalation** on the same task. Answered and withdrawn ones are kept, in
`orchestrator-tasks.json`, for the orchestrator (`escalation show` /
`escalation list`, `task show`) and for what it learns from the person's
past decisions — but the window draws only the open ones: the person is
never shown past questions. While one is open its task is 回答待ち. A task
may have more than one open; each is answered on its own.

**The person answers in DevHub's window only.** The board's composer is the
one door (`answerEscalation` on the Agents page's bridge); no `devhub --tell`
command and no `TellPorts` member can write an answer, and
`escalation answer` is refused by name. `service.test.ts` holds both. The
one port that closes a question as answered, `resolve`, carries no words:
it closes it with what the person told an agent directly, as DevHub read
it (below).

**When the person writes to an agent directly.** When the person's own
composer sets working an agent the orchestrator is responsible for — a
**managed** one, or one **bound to an open task**, whether or not a question
is open — the orchestrator is told (`task.human_direct`, with what they
wrote). It is the person's decision, given past the orchestrator, and the
message says what to tidy up (`directTidyLines`):

- **The escalation.** If it answers or overrides an open question on that
  task, the orchestrator closes it with `escalation resolve ID --note "人が
agent=… に直接指示: …"` — never `withdraw`, which would say the
  orchestrator took it back.
- **The task.** Its memo (the next step) and status follow the instruction;
  if the direction changed, its title and links too.
- **An agent with no task** (a managed one) is bound to the open task it
  belongs to, or given a new one.
- **The other agents of the task**: stopped or redirected where the
  instruction conflicts with what they are doing.
- **The record.** It is noted as an escalation answer is (the memo's
  決めたこと, `decisions.md` when it reaches other work).
- **Not twice.** The agent has it already: the orchestrator does not send it
  again.

Which agents: the orchestrator itself, an agent that is neither managed nor
bound to an open task, and a maintenance turn (below) tell nothing. **A
burst is one message**: the person's messages to one agent are gathered
until 10 seconds pass with no more (`DIRECT_QUIET_MS`), at most 30 seconds
after the first (`DIRECT_BURST_MS`), and go as one `task.human_direct` with
every text in the order sent (`personMessages`: the person's messages from
the one that started the burst on, so messages queued into one turn are
all there; each is told once). Then it goes as the person's words always
do: at once, as its own message, never held — off and saving included.

**`escalation resolve`: settled by the person directly.** It closes an open
escalation as **answered** — by the person, with their own words — not as
withdrawn: `answer.markdown` is what they told the agent, as DevHub read it
off that agent's conversation, and `answer.direct` says so (`agentId`, its
`sentAt`, the orchestrator's `note`). The command carries an id, `--note`
and `--agent` (which agent's instruction, when several), never words, and it
is refused unless DevHub told the orchestrator a `task.human_direct` with
words since the question was asked — on that task, or to an agent bound to
it now — in this run (`OrchestratorService.resolve`, at most the last 50
kept). So the orchestrator still cannot write an answer: it can only point
at one the person gave. Its task goes 処理中, as an answer leaves it. The
board shows the escalation closed (state `answered`); `escalation show`
heads it `settled by the person directly … what they told agent=…`; and an
answer kept before `direct` existed reads exactly as it did, so the decision
memory (`escalation list --state answered`, decisions.md) reads both alike.

**A maintenance turn is not work.** A turn that only compacts the
conversation — DevHub's keep-warm `/compact` just before the prompt cache
goes cold (`CacheKeeper`, sent with origin `auto-compact`), or a `/compact`
the person typed — tells no `task.human_direct`, does not move a 待機 task
to 処理中, does not count as working for the invariant, and does not notify
"finished". It is recognised by what started the turn, never by how long it
ran: one predicate, `isMaintenanceTurn` (`model/conversation.ts`), reads the
last top-level message since the last turn's end (a `/compact` command
entry, echoed or drawn at the turn's end), else the oldest message written
and not yet taken (Claude prints no echo of `/compact`, and the turn runs
from its write). The round carries it as the agent's `maintenance`, and
every watcher of work reads the agent at the status it had before such a
turn (`workStatus`). A real turn right after one still counts, with or
without an idle seen between. A compaction the CLI does by itself inside a
turn (Claude's `compacting` / `compact_boundary`, Codex's
`contextCompaction`) is part of that turn: whatever started the turn
decides. DevHub's resume after a usage limit (`after-limit`) is work.

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

So none of them moves a task, counts as working for the invariant or
notifies "finished" — and none raises the unread mark: `setAgentStatus`
raises it only when a working spell that was work ends (`AppModel`), so an
agent's read or unread state, kept in `state.json` with it, is what it was
before the restart or the resume. An agent first seen during one has no
status to go back to: it is read as `unknown`, and going on from there is
not going back to work either.

## Pictures, attachments and links

### Pictures

An escalation draws what a conversation draws — `svg, `mermaid,
`vega-lite, `html, Marp, and local files as `![alt](path)`, also inside
a table's cells (a screenshot in a comparison table is drawn in place, at
most the cell's width, and opens large on a click; the conversation does the
same). A relative path is relative to the Workspace of the task's first bound
agent, else the orchestrator's folder, and files are read with the
conversation's own embed readers on this Mac.

`escalation new` takes the local images (PNG, JPEG, GIF,
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

`--attach FILE[=CAPTION]` on `escalation new` (any
number; PNG, JPEG, GIF, WebP or SVG, checked by their bytes; 10 MB each,
25 MB a command) attaches a picture **on the machine the `devhub` command
runs on** — an SSH host or a container as well as this Mac. The command
reads it there and sends its bytes with the request (the `files` round trip,
`docs/devhub-cli.md`), so nothing in the app reads another machine's disk.
Each is copied into the escalation's folder and the question ends with a
`## 添付` section: each picture under its caption (or its name), drawn by the
conversation's renderer and opened large by the lightbox on a click; `escalation
show` lists them.

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
(`PR pay#1234`) beside it. `task link` takes labels too, and relabels
a link already there.

A task or an escalation (and any agent, in chat) links to places inside DevHub the way
it links to a web page: in `--link`, or as a Markdown link in a body or an
answer. The syntax is `model/devhubLink.ts`'s, each segment percent-encoded
as a URI component (`/` in a path excepted, `:` in a path as `%3A`):

| link                                               | goes to                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `devhub:agent/<id or 4+ prefix>`                   | the agent (`select_context`)                                        |
| `devhub:workspace/<id or name>`                    | the workspace (`select_context`)                                    |
| `devhub:file/<path without its leading />[:L[:C]]` | the file, in the editor of the open workspace whose folder holds it |
| `devhub:task/<id>`                                 | the Orchestrator row, with the task open                            |
| `devhub:escalation/<id>`                           | the Orchestrator row, with its task open                            |
| `devhub:orchestrator`                              | the Orchestrator row                                                |
| `devhub:session/<session id>`                      | the agent running that session (resuming one stays `/resume`)       |

For example `devhub:agent/3f2a9c1e`, `devhub:workspace/login-fix`,
`devhub:file/Users/me/app/src/a%20b.ts:12:3`, `devhub:task/12`, and in
a body `[失敗しているテスト](devhub:file/Users/me/app/test/api.test.ts:40)`.
`devhub --tell link agent A | workspace W | file PATH[:L[:C]] | task T |
escalation ID | orchestrator | session S` prints the canonical link (by id) for something
open, so nobody builds one by hand.

`escalation new`, `task new` and `task link` check every `devhub:` link, in
`--link` and in the body: one that does not parse, or names nothing open (a
file outside every open workspace, or not there), refuses the command with
the forms that are valid. A `--link` is stored canonically.

They are drawn as compact chips — a glyph per kind and the place's live name
from the snapshot: the agent's display name and status mark, the workspace's
name, the file's basename and `:line`, `#12` and the task's title — on
a hairline pill, unlike an underlined link out. A click is an explicit move
(`reason: "explicit"`, a place in Back and Forward at once) through the
intents the window has — `select_context`, the open-file routing
(`openLinkedFile`, which opens only a file inside the workspace named), the
board's reading view, as one move that selects the row with the task
open (`show_orchestrator_view`), so the link is one entry — and never reaches the system browser (main's
`openExternalUrl` refuses a `devhub:` URL). A link whose target is gone is
its text with a quiet 見つかりません, never a broken navigation. External
http(s) links open in the browser as before.

**A person copies one** from the Sidebar: an Agent's or a Workspace's row
menu has Copy Link (the canonical `devhub:agent/<id>`,
`devhub:workspace/<id>`) and Copy Markdown Link
(`[<display name>](devhub:agent/<id>)`), and `Cmd+Q Y` / `Cmd+Q Shift+Y`
(`copy_link` / `copy_markdown_link`, also in the command palette) copy the
same for what is selected — on the Orchestrator row, the task open over the
board (`devhub:task/<id>`), else `devhub:orchestrator`; nothing on Scratch,
whose folder is today's. Main writes the clipboard and says so in a quiet
notice that takes itself down (`AppController.copyDevhubLink`).

**And opens one from outside DevHub** — pasted into Slack, Notes or a
browser, or `open devhub:agent/3f2a9c1e`. The packaged app declares the
`devhub` scheme in its `Info.plist` (`CFBundleURLTypes`,
`scripts/darwin_bundle.py`'s `url_types`, added by `package-nightly.py`
only) and, as the default profile, claims it with
`app.setAsDefaultProtocolClient`; a source run (`DEVHUB_PROFILE=dev`)
claims nothing. macOS hands the URL to the running app as `open-url` (a
launch by link included, before `ready`); elsewhere a second launch's
command line carries it through the single-instance lock.
`main/shell/openFromUrl.ts` queues them until DevHub is ready and follows
them one at a time (`AppController.openDevhubUrl`): the window comes to the
front, and the link is followed by the same function a chip is
(`model/devhubLinkNavigation.ts`), so it is an explicit move Back returns
from. From outside, `devhub://agent/<id>` and a trailing `/` are read as the
canonical link (`parseExternalDevhubUrl`); inside DevHub `//` is still
refused. A link that does not read, or names nothing open, is one notice
(`link_unavailable`) saying why.

A link to an Agent that has been **closed** reopens it, directly, when it is
on Recently Closed and its session can be resumed — what the link asks for,
and undone by closing it again — through the same reopen `Cmd+Q Shift+T`
makes (`model/recentlyClosed.ts`, `closedAgentLink`; one closed with its
Workspace brings the Workspace back). A closed Agent's entry remembers its
id (`agent_id`) for this. Reopened, it is a new Agent with a new id, so the
pair is kept in `state.json` (`agent_aliases`) and the old link goes on
leading to it, across restarts and further closes. One that cannot be
resumed, or that DevHub no longer remembers, is said to be gone.

### Writing an escalation: it stands on its own

The person reads escalations, not the orchestrator's chat (the charter's 8),
and reads each one cold and alone: they may not know the task, its history
or where it stands, and the window shows them no past question or answer.
So each escalation says, in itself, what is to be decided with the
background needed for it (restated, even what an earlier question or the
task already said), the options and what each leads to, and the
orchestrator's recommendation — and never points outside itself as if the
reader had been there (「前回の件」, 「先ほどの」, 「上記タスクで」). "Can I
merge PR 1234?" assumes every bit of context it leaves out. So the body has named sections
(`model/escalationBrief.ts`):

| section               | what                                                                      | required |
| --------------------- | ------------------------------------------------------------------------- | -------- |
| `## 背景`             | what this is about, all a newcomer needs (warned of when absent)          |          |
| `## やったこと`       | what was done and found                                                   |          |
| `## 決めてほしいこと` | the one decision, as a question, its options and what each leads to       | yes      |
| `## 人に聞く理由`     | why it is not the orchestrator's: what cannot be undone or reaches others | yes      |
| `## 推奨`             | the recommended choice, and why (warned of when absent)                   |          |
| `## 確認方法`         | a URL to try, screenshots (`--attach`), PR and Issue URLs, a diff summary |          |

**It is enforced, not only stated.** `escalation new` refuses, with every problem at once
and the template: a body without `## 決めてほしいこと` (also read as
確認してほしいこと, 判断してほしいこと, Decision needed; any heading level,
not inside code); a body without `## 人に聞く理由` (自分で決めない
理由, Why I'm asking), or one whose reason names nothing — empty, a few
characters, or a stock phrase such as 念のため, 確認のため, 人の判断が必要,
just in case (`genericReason`) — the refusal saying what a reason names:
what cannot be undone, destroys or reaches others, or why the decision is
the person's own, and that a choice which can be corrected later is not
asked at all (the charter's 7); a `#12`, `PR 1234` or `Issue 56` in the body that no
URL in it or in `--link` points at (`/pull/1234`, `/issues/56`,
`devhub:escalation/12`, `devhub:task/12`); and a title that refers to anything by number —
the title says the decision in words, the number is a chip.

**And warned of, where it cannot be sure** (`briefWarnings`): the
escalation is raised, and the command's answer ends with a `Warning:` for
a body with no `## 背景` (Background) or no `## 推奨` (おすすめ,
Recommendation), and for words that point outside the brief — 前回, 先ほど,
先程, さっき, 例の件, 上記のタスク / 上記の件 / 上記の質問, 以前の質問 /
前の回答, as discussed earlier, previous escalation (not inside code; 上記
alone is not, since 「上記の案 A」 points inside). The orchestrator withdraws it
and asks again in full, or leaves it. The card shows
the decision's first line in place of the body's first line.

### The board

The board is the tasks, grouped by status, the questions to the person
first:

- **回答待ち** — tasks with an open question: priority first (high, normal,
  low), then the oldest open question, with how long it has waited. The
  card leads with the question itself.
- **処理中** — priority first, then the least recently touched.
- **待機** — each card leads with what it waits for, and its time
  (`M/D HH:MM · あと 3日`) when it has one; soonest time first, those
  without after. It folds.
- **タスクなし** — only while there is any: a managed agent bound to no
  task, or an Issue or pull request of the person's that no task links,
  each with the △ and how long. The orchestrator is asked to give each one a
  task (`needs_action … — no_task`).
- **完了** — done tasks, the last 30, most recent first, with their result
  note. Folded at start.

A card shows the task's number and title, the △ when it needs action (its
clause in the tooltip), its open questions (each with its choices count),
what it waits for, its memo (or the done note), its priority (優先 for high,
低 for low), 古いかも when it may be stale, its links as chips and its
agents as chips with their status marks, and the first picture of its
latest open question as a thumbnail at its right (`firstPicture`, read with
`readEscalationEmbed`).

The board speaks one language, Japanese — the tabs, the statuses, the counts,
the chips on a card (選択肢 3, 優先, 古いかも) and each lane's empty line
(処理中のものはありません。) — because the status names are the CLI's own
vocabulary (`--tell board`). The header's +, mode control (Full · Saving ·
Off) and GitHub pill keep English names: they name a setting and a service,
not something the board says.

A task's chips — its agents, their Workspaces, its links — are all one
look, a hairline pill on no ground: each is a link to somewhere, and that is
all the shape says. What state an agent is in is its mark alone (the status
mark), and what a chip leads to is its glyph (a folder for a Workspace).

待機 and 完了 fold: the chevron on the left of the heading shows or hides the
lane's cards, with the count kept in the heading. 完了 starts folded; what
was folded is kept for the session (`orchestratorMemory.ts`).

**A task, opened.** Clicking a card opens the task in place: its title and
status, its links and agents (a click shows that agent, to talk to it
directly; beside it, a folder and its Workspace's name selects that
Workspace), what it waits for, its memo, then **each open question** in
full — drawn by the GUI conversation's own Markdown renderer (code, tables,
KaTeX math, Mermaid, SVG, Vega-Lite — whatever a chat answer can show) —
each with its own composer under it: free Markdown, ⌘Return sends, and the
question's options as quick replies. Only the open questions are drawn:
an answered or withdrawn one is not shown anywhere on the board, the card
or the task (each open question stands on its own, so none needs the past
to be read). Esc (in a composer, while it is empty), "← ボード" or the mouse's Back
button over the board goes back to the board; Forward opens again what Back
left. The board and a task are two pages of one stack: opening one pushes it
in from the right and going back reverses it (220 ms, transform and opacity
only; under Reduce Motion an instant swap). The left pane's width is the
layout's and never changes with what it shows — a wide code block or
diagram scrolls or scales inside it. Focus goes to the first composer (or
the task) on open and back to the card on return. Sending an answer
(⌘Return, the send button or a quick reply) goes back to the board the same
way when no question is left open on the task, with focus on the next card
in 回答待ち — or, with none left, on the one just answered, now in 処理中; a
send that fails stays, with the error and the draft. Jumping to an agent or
a Workspace from a task is a deliberate move (`reason: "explicit"`), so Back
(prefix+h) returns to the task.

The left pane is where it was left. Whichever way the Orchestrator row is
selected again — Back, its Sidebar row, `focus orchestrator` — the pane
shows the same tab, the same task or file over it, scrolled as it was and
each unsent answer still in its composer (per escalation), and on the Files
tab the same folders open (`shell/agents/orchestratorMemory.ts`). It is
shown in place, without sliding in again. A task that is gone lands on the
board instead; so does a file that is gone. A task open, or a file, is a
place in Back and Forward of its own: opening one is an entry, Back from it
is the board (or the tree) as it was left — its scroll and folded lanes
included — and its ‹ is "up to the board", which is Back when it was opened
from that board (`docs/window-and-pages.md`, Back and Forward). This is kept
for the session only; a restart starts on the board.

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

### 待機: parked on an outside condition

Some work waits on something outside DevHub — a date, a reply on Slack, a
deploy, a review. The orchestrator parks such a task with `task status T
waiting --note TEXT [--check-at DATETIME]` (or makes it parked, `task new …
--status waiting --note …`). The note says in natural language what it
waits for, so whoever reads it later can check it; `--check-at` adds a time
to look again.

One event says a 待機 task may be ready, `task.changed`, and its line says
which task and which of two things happened, nothing more:

- `— subjects_changed` — what it is about changed: its linked items (their
  state, lanes, pull request, review decision, conversations, checks) or its
  agents' (see "The invariant"). Its first look says nothing.
- `— due` — once per wait, when `--check-at` has passed (a restart says it
  again for a wait still past due).

Both of one wait pending are one line (`— due, subjects_changed`). It is
dropped before delivery when the task has left 待機, or waits anew. On
each, the orchestrator reads the task (`task show`), checks the condition
(with its own tools for Slack and the like) and resumes it (`task status T
in_progress`), asks or completes it. **The time is a reason to look, never
a reason to decide**: a task waiting on the person is 回答待ち, which has no
time at all. A 待機 task is settled for the invariant, and its agents' rows
wear an hourglass. `devhub --tell board` lists them (`waiting (N, soonest
first):`, `--json` `waiting`), and `orchestrator status` counts them.

### May be stale: DevHub's own re-check

DevHub marks an open task **may be stale** by itself, with no tokens, from
what it already reads (`main/orchestrator/staleness.ts`, worked out on every
reading of the invariant and before each triage):

| reason                                 | read off                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| a linked pull request merged or closed | a link of the task is a pull request DevHub has read — GitHub's items, or a bound agent's Workspace pull request — and it is merged or closed |
| a linked Issue closed                  | the same, for an Issue                                                                                                                        |

- **Where the items come from.** The GitHub poll reads by URL the Issues and
  pull requests the open tasks link (`taskItemLinks`, in the same request
  as the population), so a merged one is seen within a poll.
- **Shown quietly.** A `古いかも` chip on the card, with the reasons in its
  tooltip and under the title in the task's own view; `mayBeStale` (since
  when, the reasons) on its `TaskWire`; `may be stale: …` under it in
  `devhub --tell board` and `task show`. It only marks: the task is not
  changed.
- **Seen closing, it is said** (`task.obsolete`): when an item a task links
  was seen open and is now closed or merged, the orchestrator is told at
  once in every mode — off too, where the linked items are still read every
  20 minutes — to verify, then `task done T --note` (its open questions are
  withdrawn with it), withdraw only the question that no longer stands, or
  write in the memo why the task is still needed. Once per item closing;
  `allDone` when every item it links is closed now. One already closed when
  DevHub first read it (a restart) says nothing: the mark and the triage
  have it.
- **Every triage re-checks.** The `triage` line is followed by one indented
  line per open task — `task=12「…」 処理中 — 古いかも: PR acme/pay#12
はマージ済み` — and asks the orchestrator to confirm each still holds,
  and to complete it, relink it, or keep it with a reason in its memo
  (charter section 8). One already marked when the last triage went says
  `(前回の triage から: この triage で解決する)` and is to be resolved in that
  triage.

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
- **The person hands an existing agent over** from its row's menu,
  **Manage with Orchestrator** (**Stop Managing** on a managed one), where
  a Workspace's is, ahead of Copy Link; or `Cmd+Q Shift+M` with the agent
  selected (`toggle_workspace_managed`: the selected agent, else its
  Workspace, the small thing first as `Cmd+Q X`; in the palette as "Manage
  the selected Agent or workspace with the Orchestrator, or stop managing
  it"). Neither is ever offered on the orchestrator agent itself, and main
  refuses it too. The flag moves as `agent manage` moves it — the agent's
  Workspace goes under management with it — and the orchestrator is told
  (below).

**Handing over is a takeover, not a flag.** `agent manage` is the
orchestrator's own word and tells it nothing; a managed agent with no task
would only show up as `no_task` on the next batch. So the window's
Manage with Orchestrator sends the orchestrator **`agent_managed`**, a
message of its own, at once — the person's act, delivered like their words
(not inside `event_prompt`, not held by saving or by a turn):

    人がエージェント agent=a1b2c3d4 (API fix, ws=web, branch=fix/login) をあなたの管理下に移しました。devhub:agent/a1b2c3d4-…
    状態: idle。人からの最後の依頼:「ログインの 500 を直して」。どのタスクにも紐づいていません。
    引き取ってください: 中身を devhub --tell agent read a1b2c3d4 で確かめ、合う開いたタスクがあれば devhub --tell task bind <タスク> a1b2c3d4、なければ devhub --tell task new --title … --status in_progress で作って task bind a1b2c3d4 し、次の一手を決める。

— its name, Workspace and branch, its link, its status, the person's last
message to it (`agent read`'s, cut at 200 characters) and the task it is
bound to, if any. Off, or with no orchestrator, it is dropped: the agent is
`no_task` on the board, and said so when the mode goes on or one starts.

**Stop Managing** sends **`agent_unmanaged`** the same way: the agent is the
person's again — not to be sent to or resumed — and, when it is bound to a
task, `task unbind T A` and a decision about the task (another agent,
待機, or done). A task's bound agents count for `idle` whether or not they
are managed, so this one is never dropped: it goes at once in every mode,
off included (what the person did, `by_person`); with no orchestrator it
waits until one runs, and is dropped as stale if the agent was handed over
again meanwhile (`OrchestratorService.handedOver`,
`AppController.handAgentOver`).

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

- an hourglass — bound to a 待機 task ("Task #12 (待機): <title>");
- a warning (△), in the waiting ink — managed and needing action: its task
  is 処理中 with nobody moving it, or it is bound to no task ("Needs action:
  <clause>").

So "stopped and fine" (hourglass) and "stopped and missed" (△) look
different at a glance. The tooltip also names the task it is bound to and
its status.

## The invariant

DevHub states one invariant, about tasks, and reports what breaks it
(`main/orchestrator/invariant.ts`); what the orchestrator does about it is
the orchestrator's.

**Every open task** is settled in exactly one way:

- **回答待ち** — an escalation on it is open: it waits for the person;
- **待機** — parked by the orchestrator on purpose, with what it waits for;
- **処理中**, and one of its bound agents is at work (`working` or
  `background`, not stopping; a maintenance turn is not work).

Otherwise it **needs action** (要対応, the flag on the task): `no_agent` (処理中
with no bound agent open) or `idle` (its bound agents all stopped).

**Work outside tasks** is said so that it gets one:

- **a managed agent** (the orchestrator is never one) bound to no open task:
  `no_task`, whatever it is doing. The charter asks the orchestrator to give
  it a task (`task new`, `task bind`), or to stop it once it has asked the
  agent about unpushed work;
- **an item of the population** that no open task links: `no_task`. The
  population is every open **item** of the registered Projects
  (`[orchestrator.github] projects`) assigned to the viewer — an Issue card
  or a pull request card, one thing here (another person's pull request the
  viewer is assigned to review included); an item on several Projects is one
  item, with a lane on each. **With no Project registered the population is
  empty** (`orchestrator status` says so). An item an unmanaged agent was
  started on (its meta `issue=` names it: the window's Assign Issue writes
  it) is the person's own, and left out. A task links an item by its URL,
  whatever follows the number (`/pull/9/files` is `/pull/9`).

While the population is not known — GitHub not polled, or its search not
read in full yet — no item is said; tasks and agents still are.

There is nothing to keep: a managed agent the orchestrator means to leave
as it is gets a task and the task is parked (`task status T waiting --note
…`). `agent keep` is gone, and refused by name with that advice.

What breaks it now is in `devhub --tell board` (`needs action (N):`,
`--json` `needsAction`: each subject's line, the clause, since when), on
the board (the △ on a card, the タスクなし lane), and each agent's standing in
`agent status` (`invariant`: settled, or the clause it or its task fails;
the task it is bound to).

### Work with no Issue yet

Some work comes before its Issue: reading error logs to find out what to
write in one. It is a task with no link yet, with a worktree and an agent
bound to it like any other, and the Issue is linked once there is one.

```sh
devhub --tell workspace open ~/src/app --worktree investigate-api-500s
devhub --tell task new --title "API 500 エラーの調査" --status in_progress   # task=12
devhub --tell agent new --workspace ~/src/app_investigate-api-500s --profile claude --gui \
    --managed --task 12 --meta parent=<orchestrator> --prompt -
# … the agent investigates, and files the Issue (gh issue create) …
devhub --tell task link 12 https://github.com/acme/app/issues/130
```

In the window, the Open Workspace picker (`Cmd+Q f`) offers what is typed as
a **New Branch** row beside the repository's branches: the branch, started
from the default, in a worktree of its own; `⌘↵` starts an agent there too,
unmanaged like every agent the window starts.

- **The branch is named by whoever starts the work**, whole, and DevHub
  makes nothing up: `workspace open --worktree` takes any branch, as the
  picker's branch rows always did. It is checked out if it exists (here or
  on a remote) and otherwise started from `origin`'s default branch, as an
  Issue's is. The `/devhub` skill suggests `investigate-<a-few-words>`.
- **The folder is `<repo>_<branch>`** (`branchWorktreeDirectory`, `/` and
  other awkward characters as `-`), beside the Issues' `<repo>_<N>`. A
  branch whose name carries an Issue number (`feature/123-x`, `#123`) is
  that Issue's work and goes in `<repo>_123`, as before.
- **A task with no link is settled like any other** — its agent working, or
  the task parked or asking — so investigating is never a stray to be
  closed. _Why a task and not a marker on the agent_ (the `issue=pending`
  of before): the task is where the work is tracked anyway; linking the
  Issue later is `task link`, and the agent, its sessions and its memo stay
  where they were.
- **Linked later**, the Issue just filed and not on a registered Project yet
  is simply not in the population; the task is settled by its status, as
  before.
- **The branch is not renamed when the Issue is linked.** _Why_: the agent
  is working in it — its shell, its CLI session's folder, maybe a pushed
  branch with a pull request — and the folder cannot follow a rename
  without moving the agent; the Orchestrator links by the task, never by
  the branch. If the team names branches by Issue, the agent renames it
  itself (`git branch -m 130-api-500s`) before pushing.

### `status`: one subject's whole state, in one call

A line never carries state. What a subject is now is one call, `devhub
--tell [--json] status <subject>`, the subject being what a line names it
by: a task (`task=12`, or `#12`), an item (`acme/app#123` — an Issue's or a
pull request's number alike — or its URL) or an agent (its id, a 4+ prefix,
or its name). Built from the reading the invariant was just made from
(`OrchestratorService.status`), never fetched for the call:

- **a task**: the task as the board has it (status, links, agents, memo,
  priority, wait, questions and answers, may be stale), the clause it fails
  and since when, its linked items as DevHub read them (state, assigned, in
  the population, lanes, pull request: state, review decision, unresolved
  conversations, checks) and its agents (status, managed, the clause each
  fails);
- **an item**: its kind, state, whether it is assigned to the viewer and in
  the population, its lane on each watched Project, its pull request, the
  open tasks that link it, and the clause it fails;
- **an agent**: its status and management, the task it is bound to (id,
  title, status), and the clause it or its task fails.

```text
$ devhub --tell --json status task=12
{ "subject": "task",
  "task": { "id": 12, "title": "設定画面のレビュー対応", "status": "in_progress",
            "links": ["https://github.com/acme/app/pull/9"], "agents": [{ "agentId": "a1b2c3d4-…", … }],
            "memo": { "text": "CI が通ったらレビュー依頼", "at": … }, "escalations": [], … },
  "needsAction": { "clause": "idle", "line": "task=12「設定画面のレビュー対応」 ws=web — idle",
                   "since": … },
  "items": [{ "kind": "pr", "ref": "pr=acme/app#9", "state": "open", "assigned": true, "inPopulation": true,
              "projects": [{ "project": "acme/7", "lane": "Review" }],
              "pull": { "number": 9, "state": "open", "review": "changes_requested", "unresolved": 2, "checks": "failing" } }],
  "agents": [{ "id": "a1b2c3d4-…", "name": "PR 9 review", "ws": "web", "status": "idle", "managed": true,
               "needsAction": "idle" }] }
```

An item DevHub has not read (on no registered Project, linked by no task)
is refused with what it does read.

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

| type                  | when                                                                                                                                                                           | example                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                | the orchestrator has just started (or restarted)                                                                                                                               | `[init] — オーケストレーターが起動しました。devhub --tell board で現状を確認`                                                                                                             |
| `escalation_answered` | the person answered an escalation (its task → 処理中). Sent at once, as its own message: the person's words                                                                    | `task=7「本番DB移行」 esc=12「本番DBマイグレーション承認」 への人の回答 (選択肢「承認する」):` and, on the next line, `承認する`                                                          |
| `task.human_direct`   | the person wrote from its own composer to a managed agent, or one bound to an open task, and it went working. A burst is one; sent as its own message, with what to tidy up    | `task=7「本番DB移行」 agent=a1b2c3d4 に人が直接送ったメッセージ:`, what they wrote, then `整理してください (人の判断です。…):` and its lines                                              |
| `needs_action`        | a task, a managed agent or an item of the population breaks the invariant: on every delivery while it does (every `delivery_interval`)                                         | `[needs_action] task=7「本番DB移行」 ws=web — idle`, `[needs_action] agent=ab12cd34 (API fix) ws=web — no_task`, `[needs_action] issue=acme/web#123 — no_task`                            |
| `task.changed`        | a 待機 task may be ready: what it is about changed (`subjects_changed`), or its `--check-at` came (`due`, once per wait)                                                       | `[task.changed] task=12「リリース日」 — subjects_changed`, `[task.changed] task=15「…」 — due`                                                                                            |
| `task.obsolete`       | an Issue an open task links closed, or a pull request it links merged or closed — seen happen (once per item closing). Never held: off included, alone                         | `[task.obsolete] task=7「ログイン修正」 — もう要らないかもしれません: Issue acme/web#123 がクローズされた (リンクしたものはすべて閉じた)。devhub --tell --json status task=7 で確かめ、…` |
| `usage.threshold`     | a plan window's use crossed one of `usage_thresholds` upward (once per threshold per window period; dropped if the window reset first)                                         | `[usage.threshold] cli=claude window=5-hour pct=82 resets=19:20 — 5時間枠が80%を超えました`                                                                                               |
| `triage`              | time to rank the open tasks again and re-check them (listed under it, the maybe-stale ones with why): every 30 minutes in full, every hour in saving (see "Triage")            | `[triage] — 見直し: …` and, on the lines under it, `  task=12「…」 処理中 — 古いかも: PR acme/pay#12 はマージ済み`                                                                        |
| `request`             | the person sent a request from the board's + (it is a 待機 task already). Sent at once, as its own message: the person's words                                                 | `task=3「請求書 CSV の文字化け」 人からの依頼 (…):` and, on the next line, what they wrote                                                                                                |
| `agent_managed`       | the person handed an existing agent to the orchestrator from the window (Manage with Orchestrator, `Cmd+Q Shift+M`). Sent at once, as its own message, in every mode (off too) | `人がエージェント agent=a1b2c3d4 (API fix, ws=web, branch=fix/login) をあなたの管理下に移しました。devhub:agent/…` and its status, last request, task, what to do                         |
| `agent_unmanaged`     | the person took it back (Stop Managing). Sent at once, as its own message, in every mode; waits with no orchestrator                                                           | `人がエージェント agent=a1b2c3d4 (…) をあなたの管理から外しました。人が自分で進めます。…` and `task unbind` for its task                                                                  |
| `timer.elapsed`       | a `[[orchestrator.timers]]` timer, or one `orchestrator timer set` made                                                                                                        | `[timer.elapsed] sweep`                                                                                                                                                                   |
| `custom.*`            | `devhub --tell orchestrator emit --type custom.NAME --text …`                                                                                                                  | `[custom.deploy] — staging に deploy 完了`                                                                                                                                                |

The `needs_action` codes: a task's `no_agent` or `idle` (`task=` names it
by its number and title, `ws=` its first agent's Workspace); a managed
agent's `no_task` (`agent=` names it by its id's first block and name); an
item's `no_task` (`issue=` or `pr=`). Every subject is keyed on its task
where it has one: the dispatcher coalesces, logs and drops stale lines per
task.

**Why this set.** The person asked for lane changes and turn ends not to be
told, and for state over diffs. Everything the invariant covers is said as
`needs_action` (with the clause it fails; the state is `status`) or not at
all, so `github.*`, `agent.*` and `workspace.*` are emptied families: a
managed agent that stops is its task's `idle`, an item left with nobody is
`no_task`, a merged pull request is a 待機 task's `task.changed` or a mark
of may-be-stale. `waiting.changed` and `escalation.human_direct` are now
`task.changed` and `task.human_direct`. What stays is what no state shows:
the person's words, a wait's time, a change under a parked task, the plan's
use, timers and `custom.*`. An `[orchestrator] events` pattern that names a
removed type (`waiting.changed`, `escalation.human_direct`, `agent.*`,
`github.*`, `workspace.*`, `unsettled`, …: `RETIRED_EVENT_TYPES`) loads, is
left out, and is reported once as a retired setting, the way a retired key
is.

### The person's words

`escalation_answered` and `task.human_direct` carry what the person
wrote, and are delivered **at once and as their own message** — not batched,
not inside an event line, not inside `event_prompt` — whose first line names
the task and the escalation (or the agent) and whose rest is the person's text exactly as
typed, unquoted and uncut. The orchestrator reads it as the person's own
input: an auto-mode approval classifier treats text quoted inside a prompt
template conservatively and may refuse the external writes the person just
asked for. Several answers are several messages; a burst of direct
messages to one agent is one message, every text in order, and after the
words, past a blank line, the tidy-up it asks for (`整理してください …`). Nothing holds them, off
included: someone answered, and the work they unblock goes on. With no
orchestrator running they wait, in order, until one starts (as a request
does). A busy orchestrator does not hold them either: the message is queued
and taken when its turn ends, like the person's composer. Delivering an answer is the orchestrator's reading of it
(`acknowledged`: `agent wait --any` no longer reports it).
A message whose text could not be read says so and where to read it
(`agent read A --since …`).

The person's acts on an agent — `agent_managed` and `agent_unmanaged`
("Managed agents") — go the same way: at once, as a message of their own,
in full and saving alike. Off is the difference: an agent handed over is
dropped (the board says `no_task`), one taken back waits, as a request does.

### Delivery: batches, the interval, pause

- **One line per subject**, the latest statement about it replacing the
  older one (a timer is pending once). A subject is a task, an agent with
  no task, an item with no task, a timer, a usage window, a custom type and
  text.
- **At most once per `[orchestrator] delivery_interval`** (default `5m`) a
  batch goes, as one message: `{EVENT}` the lines (at most
  `MAX_DELIVERY_LINES`, 50, and a last line counting the rest),
  `{EVENT_JSON}` the same as JSON when the template has it; `init_prompt`
  for a batch carrying `init`. The first batch after a quiet spell goes at
  once (after a 300 ms window).
- **Timers and waits' times go on time** (`[[orchestrator.timers]]`, a
  `timer set` timer, a 待機 task's `--check-at`): each as a message of its own when it comes, not with a
  batch and not held by the interval (see "Saving: state changes and
  nudges"). Off turns them off: one that comes due while off is dropped.
- **Held only by a foreground turn**: the orchestrator `working`, or a
  message of ours still queued for it (`busy` in the controller). Its own
  background work — shells, tasks, subagents it started (`background`) — does
  not hold a delivery: the router is never blocked by the subagents it
  started. After a delivery the next waits up to a minute to see it taken.
- **Re-read before it goes** (`relevant`): a task no longer 待機 (or waiting
  anew), a window reset below its threshold — dropped as `dropped-stale`.
- **The nag** (`standing`): `needs_action` is never pending. Every delivery
  reads the invariant as it stands then and carries one line per subject
  that needs action (`InvariantWatch.due`): no grace, no
  "said once", no reminder setting. While any does, a delivery is made every
  `delivery_interval`, so an unresolved subject is said again every 5
  minutes by default; one that settled in between is on none. A delivery
  with nothing to carry is not sent. `orchestrator events` logs each line
  as it goes (`delivered`).
- **Paused** (the mode **off**: `orchestrator mode off` or `pause`, the board's Off): everything
  is held but the person's answers, their requests too, and GitHub is not
  polled; pausing sends nothing. The timers are off with it: a timer or a
  task's `--check-at` that comes due while off is dropped (`dropped`, reason
  `off`), never sent later. **Turning on delivers at once** (full or saving: `orchestrator
mode full`, `resume`, the board's Full or Saving): the person's held requests, each alone, then what is pending and the
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
  `needs_action` lines) — and when it goes: now, at the
  interval's end, when the orchestrator's turn ends, when saving holds every
  line `saving: N reminders wait for the next triage`, or not while off;
  "Nothing to send" when nothing would. Main composes it with the delivery's
  own `composeDelivery` (`EventDispatcher.preview`, on the board as
  `nextDelivery`), reading only: nothing is marked delivered, logged or
  scheduled.
- **Kept in a log**: `orchestrator events` lists the last ones and what came
  of each (`delivered`, `pending`, `filtered`, `coalesced` into which,
  `dropped-stale`, `overflow`, `dropped` with no orchestrator, or with
  reason `off` for a timer that came due while off).

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

| mode       | what is delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **full**   | everything, as described above: a batch at most every `delivery_interval`, each carrying every `needs_action` subject again (what "on" was)                                                                                                                                                                                                                                                                                                                                                               |
| **saving** | the same, more rarely: at most every **3 ×** `delivery_interval` (`SAVING_INTERVAL_FACTOR`). **State changes** about the work always go; **nudges** go only when high, and while 2 or more tasks are in progress only about those tasks (below). What the person did goes at once, alone (`by_person`); a task that may no longer be needed (`task.obsolete`), `init` and `triage` go with the next batch, never held                                                                                     |
| **off**    | **what the person did** (`by_person`: `escalation_answered`, `task.human_direct`, `request`, `agent_managed`, `agent_unmanaged`) at once, as in full; **a task that may no longer be needed** (`task.obsolete`) at once, alone; everything else is held. GitHub is not searched; only the items the open tasks link are read, every 20 minutes (`OFF_LINKED_INTERVAL_MS`), so `task.obsolete` can fire. Timers are off: one that comes due (a task's `--check-at` too) is dropped, not sent on turning on |

- **A batch** is the pending lines and the standing `needs_action` lines,
  the message that has the orchestrator act on its agents (or itself). In
  saving each line is a **state change** or a **nudge** (the next section),
  and only the nudges are throttled. The person's words are not batches and
  go at once in saving too.
- **Why 3 ×.** Every delivery is one orchestrator turn — reading the batch,
  handing each line to a subagent — and the nag puts an unresolved subject on
  every one, so the interval is what it spends while things stand still.
  Three times the interval cuts that by two thirds and still says what
  happened to the work within a quarter of an hour at the default 5m (3
  minutes at 1m): nothing waits long enough to be forgotten, and an agent
  that stopped is picked up within that. Four times would leave it unsaid for
  20 minutes, a sizeable piece of a 5-hour window.
- **A task in progress** is a task whose status is **処理中** — the board's
  処理中 lane, read off the task itself, so the gate and the board cannot
  disagree.
- **What the person did is one class, `by_person`**, never held or dropped
  in any mode: their answer, their words to an agent directly, their
  request from the board's +, an agent they handed over or took back —
  every event the window's own acts cause (the person closes no task from
  the window; a Workspace's agents are handed over one by one, as
  `agent_managed` each). They go at once, each as a message of its own.
  Only with no orchestrator running do they wait (an answer, an agent taken
  back) or go to the next start's board (an agent handed over: `no_task`;
  a request is kept on its task).
- **A task that may no longer be needed is one class, `obsolete`**
  (`task.obsolete`, below), never held: with the next batch in full and
  saving, at once and alone while off. Closing a finished task costs one
  turn; leaving it open costs every later delivery and triage.
- **Nothing else changes.** GitHub is polled at its own interval in full and
  saving alike (it costs GitHub quota, not tokens), timers fire as set, and
  no line is dropped: held lines wait, one per subject, and go with the next
  triage or with full. Nothing beyond the interval and the gate was added
  to saving.
- **Off at every launch.** The mode is not written anywhere — not
  `state.json`, not `orchestrator-tasks.json` — so DevHub always starts off: an
  orchestrator agent restored with its session costs nothing until the
  person turns it on. The pause was never persisted either, so nothing kept
  across launches had to stay. **Start Orchestrator** (the window's, or
  `orchestrator start`) turns an off one to full — starting one is asking it
  to work — and leaves full or saving as they are. The control works with no
  orchestrator running.

### Saving: state changes and nudges

Saving is there to spend fewer tokens on reminders, never to leave the work
waiting on the orchestrator. So it tells two kinds of line apart
(`main/orchestrator/mode.ts`: `SAVING_CLASSES`, `savingClassOf`,
`savingHolds`), and throttles only the second:

- **On time** — an explicit timer and a wait's time: the person's
  `[[orchestrator.timers]]` (what they have the orchestrator do on a clock,
  such as reading Slack), a timer the orchestrator set (`orchestrator timer
set`, "re-read the thread in 30 minutes"), and the time it gave a 待機
  task (`task status T waiting --check-at`). **Sent at its time, alone** — its one line in `event_prompt`
  as a message of its own, like the person's words: never batched, never
  held by the interval, the pickup wait, the priority gate or the tasks in
  progress, in full and saving alike (`onTime`). What the orchestrator
  wakes for often touches other people (a Slack thread, someone's
  question), so a late wake-up has consequences outside DevHub. Off drops
  it (below).

- **A state change** — something happened to work in progress, or to work
  waiting on the orchestrator: an agent finished its turn or stopped, is on
  a prompt (a question, a permission), errored; its item's pull request was
  merged or closed, got a review, its checks failed or passed; a 待機 task's
  subjects moved; a managed agent is working outside any task. **Always delivered** in
  saving, with the next batch at saving's interval, whatever the subject's
  priority and however many tasks are in progress.
- **A nudge** — a reminder or chatter: a subject said again with nothing new
  about it ("still idle"), an item nobody has made a task for, the usage
  readout, `custom.*`. **Goes only when its task is ranked high**; the rest
  waits, one line per subject, for the next triage (hourly in saving) or for
  full.
- **By the person** — their answers, their words to an agent directly,
  their requests, an agent handed over or taken back: at once, as messages
  of their own, in every mode (`by_person`).
- **Obsolete** — a task that may no longer be needed (`task.obsolete`):
  with the next batch, never held by the gate; alone at once while off.
- **Never held** — `init` and `triage`, as in full. A batch carrying `init`
  or `triage` takes everything pending and standing with it, so the
  orchestrator ranks with the whole picture.

Every kind of line the dispatcher handles, explicitly:

| kind                               | class        | what it is                                                                                                                                                                                      |
| ---------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escalation_answered`              | by person    | the person's answer                                                                                                                                                                             |
| `task.human_direct`                | by person    | the person wrote to a managed agent, or one bound to an open task                                                                                                                               |
| `request`                          | by person    | the person's request from the board's +                                                                                                                                                         |
| `agent_managed`, `agent_unmanaged` | by person    | the person handed an agent over, or took it back                                                                                                                                                |
| `task.obsolete`                    | obsolete     | an item an open task links, seen open, closed or merged: the task may be done                                                                                                                   |
| `init`                             | never held   | the orchestrator started                                                                                                                                                                        |
| `triage`                           | never held   | time to rank the open tasks; takes everything with it                                                                                                                                           |
| `needs_action` task                | state change | an open task newly needing action, or whose state moved since its line last went: its agents stopped, one is on a prompt or errored, its linked item or pull request moved, its questions moved |
| `needs_action` agent `no_task`     | state change | a managed agent bound to no open task, newly or with its state moved: work going on outside any task                                                                                            |
| `needs_action` item `no_task`      | nudge        | an item of the population nobody made a task for: new work                                                                                                                                      |
| `needs_action` said again          | nudge        | any `needs_action` subject standing as it stood when its line last went (the nag)                                                                                                               |
| `task.changed` `subjects_changed`  | state change | what a 待機 task is about moved (CI, a review, a merge, its agents)                                                                                                                             |
| `task.changed` `due`               | on time      | the time the orchestrator gave a 待機 task (`--check-at`) came; with `subjects_changed` folded in, still on time                                                                                |
| `timer.elapsed` from `timer set`   | on time      | a timer the orchestrator set itself (`source: "session"`): its own wake-up                                                                                                                      |
| `timer.elapsed` from the settings  | on time      | one of the person's `[[orchestrator.timers]]`: what they set the orchestrator to do on a clock (reading Slack, which affects other people)                                                      |
| `usage.threshold`                  | nudge        | the plan's use: status                                                                                                                                                                          |
| `custom.*`                         | nudge        | what a script says: not DevHub's to judge                                                                                                                                                       |

- **Said again.** A `needs_action` line is standing, not an event, so what
  is new about it is read off its state: since when its subject has needed
  action, its clause and its facts (its agents' status, its item's and pull
  request's state, review, unresolved count and checks, its task's open
  questions; `InvariantWatch.print`). The dispatcher remembers each subject's state as
  its line last went; the same state again is a nudge, a moved one (an agent
  that stopped again, checks that failed) a state change. A subject that
  settled is forgotten, so its next breach is new.
- **Two or more tasks in progress.** The intent is not to pile new work on an
  orchestrator that already has its hands full. So while
  `SAVING_BUSY_TASKS` (2) or more tasks are in progress, saving also holds
  the nudges about **other** work — starting an item, pushing a task that
  is not in progress — high ones included. A nudge about a 処理中 task goes
  when high, as with fewer. What
  the in-progress agents themselves do is a state change and is never held:
  an agent in progress that stops is delivered with the next batch, so it
  does not sit waiting for the orchestrator.
- **The preview** shows only what would go; with nothing to send and lines
  waiting it says `saving: N reminders wait for the next triage`.
- **Off turns the timers off.** A timer keeps its schedule while off, but
  each firing is dropped (`orchestrator events`: `dropped`, reason `off`),
  and turning on sends nothing about the ones missed: the next firing goes
  on its time — the settings' timers and `timer set`'s alike, which repeat.
  A task's `--check-at` is one-shot: one that came while off is dropped as
  well (not re-armed, not sent on turning on), and `orchestrator timer list`
  shows it under **Expired while off** (task, title, its time) for as long
  as that wait stands, so the orchestrator can see it missed it and look at
  the task itself. A wake-up for something outside DevHub (a
  Slack thread at 15:00) is worth little hours late, and the person turned
  the orchestrator off. What moved about a wait's subjects
  (`subjects_changed`) is a state change, and waits like everything else.
- **What the person did goes while off**, as in full (`by_person`): their
  answers and direct words, their requests, an agent handed over or taken
  back. The person is at the window, and acted; holding it would leave the
  orchestrator a step behind them.
- **A task that may no longer be needed goes while off**, alone
  (`task.obsolete`). To see one while off, the GitHub source reads only the
  items the open tasks link (by URL, `MAX_LINKED_ITEMS` a request, the next
  ones the time after) every **20 minutes** (`OFF_LINKED_INTERVAL_MS`):
  within the half hour, at one request where full makes about thirteen
  (every 90 s). No search, no Project, no pull request details; a low rate
  limit is waited out. What it reads stands over the last search's word on
  the same item until the next complete pass. Agents' Workspace pull
  requests come from the Workspace watcher as always.

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

DevHub asks the orchestrator, on a schedule, to rank its open tasks again
(`main/orchestrator/triage.ts`).

- **The ask** is a `triage` event: `[triage] — 見直し: …`, every **30
  minutes in full** and **every hour in saving**, counted from the last one
  — or from when the mode went on, or the orchestrator started (its `init`
  already has it read the board). Never while off. A triage is the heaviest
  turn the orchestrator takes (it reads the board and ranks everything), so
  it is a few times rarer than the nag; twice an hour keeps the ranking
  about as fresh as the work it ranks changes. In saving it is also how long
  a line that is not high may wait, and an hour is a fifth of the 5-hour
  window. `board --json` (`triage`) says when the last went and the next
  is due.
- **The re-check.** Under the `triage` line, one line per open task with
  its status, the ones DevHub marks as maybe stale with why: the
  orchestrator confirms each, and completes, relinks or keeps it (see "May
  be stale"). Agents and items with no task (the board's タスクなし) are to be
  given one.
- **The ranking** is the task's priority, `high`, `normal` or `low`, with a
  short note why: `task edit T --priority high --priority-note "…"` (`""`
  clears the note). It is kept with the task, so it has one place: the
  board's 優先 / 低 chips and the order of 回答待ち and 処理中, `task show`,
  `board --json`, and the Sidebar tooltip of its agents.
- **In saving, only high nudges go.** State changes go whatever their
  priority ("Saving: state changes and nudges"); a nudge goes only when its
  task is ranked **high**. Every other nudge — about a task ranked normal or
  low, an item or agent with no task, and nudges about no subject (timers,
  the usage readout, `custom.*`) — stays pending, one line per subject as
  always, and goes with the next batch that carries `triage`, or as soon as
  the mode is full. **High** is the level, not a count: the charter asks the
  orchestrator to keep it for what makes the person or other work wait, and
  to keep it to about three. The person's words, requests, `init` and
  `triage` are never held by it.

### Requests: the board's +

The **+** in the board's header (or `Cmd+Q +`, "Orchestrator: New
Request…" in the palette, which shows the screen first) opens a small
composer under the header — the conversation's box — for asking the
orchestrator for something. ⌘Return (or 送信) sends it, Esc closes it and
gives the keyboard back to the +.

- **It makes a task at once**: a 待機 task whose title is the request's
  first line and which keeps the words as typed (`request`), on the board in
  待機 straight away. There is no second kind of item to keep in step.
- **It is the person's words**: a `request` event, delivered at once as its
  own message (`task=3「…」 人からの依頼 (…):` and, on the next line, the
  text as typed) — in every mode, off included (what the person did,
  `by_person`), and never by saving's gates. One sent with no orchestrator running
  waits for one, and goes once it starts, as do the ones kept from before a
  restart (a task's request without `sentAt`).
- **The orchestrator takes it from there**: `task edit` to retitle it, `task
link`, agents bound to it, `task status T in_progress`, `task done`.

### Resuming the agent that did the work

Work comes back: a pull request gets review comments, CI fails after a
merge, the person answers a question the work stopped on. The agent that did
it has the context — its conversation, its folder, its branch — so it is
that agent the orchestrator brings back, not a new one.

**The task holds it.** Each task keeps the agents bound to it, managed
Claude and Codex ones, after they stop and across restarts: each agent's
id, name, profile, machine (`local` or `ssh:<host>`), folder, branch, the
CLI sessions it ran (newest last, at most 10) and when it was last seen and
stopped (`TaskStore.observe`, on every save of the state, with the session
the session-meta keeper knows each runs; at most 8 agents a task). An agent
that goes on with a recorded session (`agent resume`, Reopen Closed,
`/resume`) takes its entry's place under its new id — the same conversation
is the same agent.

**The verb.** `devhub --tell agent resume task=<T>|<agent> [--prompt
TEXT|-]` brings back the task's latest bound agent — or one of a task's
stopped agents by its id, a 4+ prefix or its name — on its latest session,
in its own folder on its own machine (an SSH host's included; a worktree
that is gone is checked out again, as for a session), through the existing
resume path: a GUI agent, its name, metadata and management given back,
bound to the task again. `--prompt` is its first message, the task's memo
after it. A session id still works as before. When it cannot, it says so
and does nothing, and the charter tells the orchestrator to start a new
agent then (`agent new --task T`): no agent bound to the task; the agent is
open now (nothing to resume: `agent send`); it stopped before its CLI named
a session; it ran a CLI DevHub cannot resume, or a profile that is gone;
its CLI no longer has the session in that folder.

### Choosing the model

An agent the orchestrator starts runs on the model its work needs, not
always the profile's (often the strongest and dearest): `agent new`, `issue
assign` and `agent resume` take `--model <name>` — Claude's aliases
`haiku`, `sonnet`, `opus`, or a full model id, passed through as it is
(`model/agentModel.ts`). Only a Claude profile takes it; any other kind is
refused, saying so, before anything starts (Codex has a `--model` of its
own, but not these names, and a GUI Codex agent's model is chosen over its
app-server: no mapping is safe).

The model goes into the agent's profile snapshot as Claude's one
`--model`, **in place of** any `--model` the profile's arguments carry
(never a second one beside it). So a restart of DevHub and Restart Session,
which start the snapshot again, keep it. It is also written down under the
agent's CLI session in `session-meta.json` (beside its metadata and
management) whenever it differs from the profile's own, and a launch that
resumes that session — `agent resume` (by session or `task=T`), the picker's
earlier sessions, Reopen Closed, Continue in GUI / in terminal — is started
on it again; the task keeps it too (`TaskAgent.model`). `agent resume
--model` is the one way to change it: a stronger model for an agent that
failed or looped on a cheaper one.

It is shown where the agent is: `agents` (`model <m>`), `agent status` (its
model, and whether it is the profile's or chosen over it; `--json`
`model` and `profileModel`), `profiles` (each Claude profile's own
`model`). In the window a quiet badge follows an agent row's words — and a
word after the agent's chip on the board — only when its model differs from
its profile's; the row's tooltip says `Model: <m>`. The charter (10, below)
says which model fits which work.

### Memos

Each task has one short memo: what the orchestrator means to do next with
it. It is there because, busy with everything else, the orchestrator tends
to forget what it meant to have an agent do next; it writes the memo when it
sets the work aside or hands it off, and the memo comes back to it wherever
it lists or shows that task.

```sh
devhub --tell task edit 12 --memo "CI が通ったら、人にレビュー依頼を出させる"
devhub --tell task edit 12 --clear-memo
```

- **One memo, plain text** (light Markdown at most), up to 500 characters:
  the refusal says to keep it to the next step. Setting it replaces it (`-`
  reads it from stdin); it keeps only when it was last set.
- **It flows in where the orchestrator lists or shows the task:** `board`
  puts it under the task's line, `board --json` carries it on each task,
  `task show`, `task list`, `status task=T` and `agent status` of a bound
  agent each end with it.
- **Not on every delivered line**: the charter has the subagent that
  handles a line read the task first (`status`), which carries it.
- **Passed to the agent that picks the work up.** `agent resume`, `agent new
--task` and `issue assign` with `--prompt` put the task's memo after the
  prompt, whole.
- **The person reads it on the board**, read-only, as light Markdown: on the
  card and in the task's view.
- `memo set` / `memo list` / `memo clear` are gone, and refused by name with
  `task edit`'s form.

### The sources

- **The board** (`orchestratorService.ts`): the answers, the person's direct
  words, `task.changed` (`— due`); and the invariant, read off every projection
  and every GitHub poll (`InvariantWatch`); every delivery carries the
  subjects that need action then (above: the nag). `task.changed`
  (`— subjects_changed`) compares each 待機 task's subjects' facts with the
  last look (its first look says nothing).
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
  50), the items the open tasks link that the search did not give
  (`resource(url:)`, at most 20 — so a task's merged pull request or closed
  Issue is seen), and a look at each registered Project (its title, or
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
  `escalation show ID` or `task show T`, or by the answer's delivery.

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
type — a type (`needs_action`), a family (`task.*`) or `*`, each optionally
after `!` to take it out; the last pattern that matches decides, and `init`
always goes. The default is `["*"]`: every kind left is a signal. A pattern
naming a removed type (`agent.turn_ended`, `github.lane_changed`,
`waiting.changed`, `escalation.human_direct`, `agent.*`, `github.*`,
`workspace.*`, …:
`RETIRED_EVENT_TYPES`) loads, is left out, and is said
once as a retired setting; so are `wait_reminder_interval` and
`reminder_interval` (`RETIRED_KEYS`: there is one cadence, `delivery_interval`).
They are in Settings ▸ General ▸ Orchestrator and validated with every other
setting.

## The command line

```sh
devhub --tell board [--json]                         # 回答待ち (the open question first), 処理中, 待機, and what needs action now, as data
devhub --tell [--json] status task=T|ITEM|A          # one subject's whole state: a task, an item (owner/repo#N or URL) or an agent
devhub --tell task new --title T [--link URL[=LABEL]]... [--status waiting|in_progress] [--note TEXT] [--check-at DATETIME]
                       [--memo TEXT] [--priority high|normal|low]   # one piece of work; starts 待機 unless --status says so
devhub --tell task edit T [--title T] [--memo -|TEXT | --clear-memo] [--priority P] [--priority-note WHY]
devhub --tell task status T waiting|in_progress [--note TEXT] [--check-at DATETIME]   # 待機 with what it waits for, or 処理中
devhub --tell task link T URL[=LABEL]... | task unlink T URL...   # what it is about
devhub --tell task bind T A... | task unbind T A    # its agents (an agent is on one open task)
devhub --tell task done T [--note TEXT]             # completed; an open question on it is withdrawn
devhub --tell task show T [--json]                  # the task, its agents, memo and every question with its answer
devhub --tell task list [--all] [--json]            # the open tasks (--all: done ones too)
devhub --tell agent new … --managed --task T        # an agent bound to a task from the start (memo after --prompt)
devhub --tell issue assign URL … --managed [--task T]   # bound to T, else the open task linking the item, else a new one
devhub --tell agent manage A | agent unmanage A     # under the orchestrator's management, or not
devhub --tell workspace manage W | workspace unmanage W   # a workspace, the same flag (unmanage: its agents too)
devhub --tell --json agent status A                 # managed, its task, invariant (settled or the clause)
devhub --tell --json workspace status W             # branch, Issue (state, lanes), PR (state, draft, review decision), conversations, checks
devhub --tell escalation new --task T --title T --body -|TEXT [--link URL[=LABEL]]... [--option TEXT]... [--review]
                         [--attach FILE|att-ID[=CAPTION]]...   # one question; its task is 回答待ち until answered
devhub --tell escalation show ID [--json]           # the question and its answer (acknowledges the answer)
devhub --tell escalation list [--state open|answered|withdrawn] [--task T] [--json]
devhub --tell escalation withdraw ID [--note TEXT]  # the question no longer stands
devhub --tell escalation resolve ID [--note TEXT] [--agent A]  # the person settled it by telling an agent directly
devhub --tell attachment add FILE[=CAPTION]...      # a worker hands pictures over: an id each, for --attach
devhub --tell link agent A | workspace W | file PATH[:L[:C]] | task T | escalation ID | orchestrator | session S   # a devhub: link
devhub --tell agent resume task=T|AGENT [--prompt -|TEXT] [--model M]   # bring back the task's agent, on its conversation (see "Resuming")
devhub --tell agent new … --model haiku|sonnet|opus|ID   # the agent's model over the profile's (Claude only; see "Choosing the model")
devhub --tell orchestrator start --root PATH --profile P --gui|--tui [--prompt -|TEXT]
devhub --tell orchestrator status [--json]          # its agent, state, task counts, mode, GitHub polling
devhub --tell orchestrator stop | restart           # Stop Agent / Restart Session on it
devhub --tell orchestrator mode [full|saving|off]   # the mode, or choose one (off at every launch; see "Modes")
devhub --tell orchestrator pause | resume          # mode off (GitHub search suspended; linked items every 20m) / mode full (delivers at once, as one message)
devhub --tell orchestrator events [--last N] [--json]   # recent events and what came of them
devhub --tell orchestrator emit --type custom.NAME --text TEXT|-
devhub --tell orchestrator timer list | set NAME INTERVAL | clear NAME   # for this session; list also shows --check-at expired while off
devhub --tell usage [--json]                        # each CLI's plan windows (%, reset), as the Sidebar has them, with their age
devhub --tell focus orchestrator                    # the only one that changes the screen
```

**Gone, and refused by name with what to use instead**: `escalation ask`,
`hold`, `wait`, `resume`, `close`, `rank`, `link` (a follow-up is a new
escalation; waiting, links and priority are the task's), `escalation
answer` (the person answers in DevHub only), `agent keep` (bind it to a
task and park the task), `memo set|list|clear` (`task edit --memo`),
`orchestrator priority` (`task edit --priority`) and `orchestrator request`
(the + makes a task).

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
   arrive as their own messages and are their instructions. So does an
   agent the person handed over (`agent_managed`: adopt it — `task bind` to
   a matching open task, else `task new` and `task bind`, then decide its
   next step) or took back (`agent_unmanaged`: never send to or resume it
   again, `task unbind` it and decide about its task). `DEFAULT_EVENT_PROMPT`
   says the same in one line.
4. **The invariant** (see "The invariant"), as what the orchestrator
   maintains — every open task 回答待ち, 待機 or 処理中 with an agent at work —
   and how to answer a `needs_action` subject: a subagent first reads its
   whole state with one `devhub --tell --json status <subject>`, then has an
   agent go on (`agent send`, `agent resume`), asks the person
   (`escalation new`), parks the task with what it waits for (`task status T
waiting --note`), or completes it. An agent or an item with no task
   (`no_task`) is given one (`task new`, `task bind`); one not worth going on
   with is closed: a subagent first asks the agent about unpushed work or an
   open pull request, then `agent stop` (and `workspace close` with its
   flags named). `task.changed` is a 待機 task that may be ready; a time is a
   reason to look, never to decide.
5. **DevHub's conventions**: a task before the work (`task new`, linked to
   its Issue or pull request), agents bound from the start (`agent new
--task`, `issue assign --task`; `task bind` for one already running);
   work with no Issue yet is a task with no link, linked once the Issue is
   filed; `--managed` (and `--meta parent=<its id>`) on every agent it
   starts, never approving a permission prompt, never writing the person's
   answer, never taking the screen (`focus` only when asked), and holding
   back on new agents when a plan window runs high (`usage.threshold`,
   `devhub --tell usage`).
6. **Tasks: one per piece of work, held until done** — its status kept
   (処理中, or 待機 with what it waits for), its memo kept (what is next, set
   whenever the work is set aside or handed off; it shows in board, task
   show and status, and is carried after a `--prompt`), the same work
   resumed on the same agent (`agent resume task=T --prompt …`; a new agent
   only for new work or when `agent resume` says it cannot), and `task done`
   with the result.
7. **What it decides itself, and what it asks** — two kinds of decision:
   - **Reversible: decided, not asked.** Which design or implementation,
     naming, the order of work, which agent does what, how tests or commits
     are split, an internal value. It decides on the person's past
     decisions (`decisions.md`, their past answers, their skill), the
     easier one to undo when nothing says; notes what it chose and why in a
     line or two in the task's memo (「決めたこと: … (…)」, kept when the memo
     is rewritten; `decisions.md` too when it holds beyond the task); and
     shows the result in the task's review (below).
   - **Irreversible, destructive or outward: asked, and waited for.**
     Deleting data or branches, force-pushes and rewritten history, merges,
     releases, deploys or production changes that reach others, messages to
     people, spending money, permissions or visibility, anything not easily
     undone — and what only the person knows or may allow. What the person
     explicitly handed over beforehand (their skill, a past answer) it may
     do within that.
   - **Work with a deliverable ends in a review** — anything the person
     would look at: code, UI, docs, a release candidate, a report. Its
     task closes only through an escalation raised with `--review`,
     「この成果物で完了としてよいか」, answered 完了 or 直してほしい (the
     details in the answer). 完了: `task done`. 直してほしい: the fixes, then
     a new review — one question, one answer, each time. A task with no
     deliverable may still close with `task done --note`. See "How the
     person sees what was decided".
8. **The person reads escalations, not the chat; one question each, and
   wait for the answer**: only what the 7 says to ask, one escalation
   per question, on its task; **never proceed on something the person is
   to decide without their answer — no deadline or time is a reason to**;
   the answer arrives as their words and the task is 処理中 again; a
   follow-up is a new escalation, one that no longer stands is withdrawn.
   Each is answerable alone, by someone who may not know the task, its
   history or its progress and is shown no past question: the decision
   with its background restated, the options and what each leads to, the
   recommendation, and no 「前回の件」 or 「上記タスクで」 pointing outside it — the sections of
   "Writing an escalation", full URLs with a line of what each is,
   screenshots by `--attach` (a worker's by `attachment add` and its id),
   the title reviewed before raising (specific, understandable without
   context, the decision in words), and a short bad and good example.
   `## 人に聞く理由` names what cannot be undone or whom it reaches, and
   `## やったこと` carries what was decided along the way.
9. **Triage and requests** (see "Triage: priorities" and "Requests"): each
   open task re-checked and ranked (high only for what makes someone wait,
   about three), the maybe-stale ones resolved, tasks given to the work
   that has none; what saving still delivers and what off drops; the
   person's request is a 待機 task to retitle and take forward.
10. **Choosing each agent's model** (see "Choosing the model"): `--model
haiku` for mechanical, well-specified, low-risk work (lookups, reading
    and summarising logs or CI output, small renames, format or lint fixes,
    simple doc edits, checking a status); `sonnet` for ordinary
    implementation with a clear spec (a bug with a known cause, tests,
    routine features, docs, straightforward reviews); `opus` for design and
    ambiguous work (hard debugging with an unknown cause, cross-cutting
    refactors, UI and taste, security-sensitive changes, the final review of
    a deliverable). The stronger one when unsure; a cheaper agent that fails
    or loops is resumed or restarted on a stronger `--model`; the choice is
    noted in a line of the memo only when it is not obvious; and it is a
    reversible decision (7), never asked.

How it is given: Claude (terminal and GUI) gets it appended to the system
prompt — `--append-system-prompt`, after the profile's own, which is kept
(Claude honours only the last one, so the two are joined) — on the
orchestrator agent's argv only (`withOrchestratorSkill`); a Codex GUI thread
gets it as a paragraph of `developerInstructions`
(`codexOrchestratorInstructions`). A Codex terminal orchestrator gets
neither (DevHub has no channel into it), nor does one DevHub did not start.
The person's make-progress need not repeat any of it: `/devhub-orchestrator`
leaves these to the charter and is about the team's own rules.

### How the person sees what was decided

**Through a review that ends the task.** Work with a deliverable — code,
UI, docs, a release candidate, a report, anything the person would look
at — is not done until the person says so: the orchestrator raises a
review, an ordinary escalation asking 「この成果物で完了としてよいか」, with
`--review`. It stays one question and one answer: 完了 closes the task
(`task done`); 直してほしい (what to fix in the answer) sends the fixes to
the task's agent, and the fixed result is a **new** review. There is no
informational kind that is closed by "seen": the review is a real
question, the task 回答待ち until it is answered.

A review stands on its own like any escalation, and is written so that
someone who knows nothing of the task can judge the deliverable from it
alone:

```markdown
## 背景 — what was made, and why (restated)

## やったこと — what the orchestrator decided on the way, a line each with why

## 実行結果 — test results, real output or an excerpt (screenshots: --attach)

## 確認方法 — how to try it; the PR and commits as full URLs

## 既知の制限 — what it does not do, known issues

## 決めてほしいこと — この成果物で完了としてよいか (完了 / 直してほしい)

## 人に聞く理由 — 成果物のレビュー: whether it is done is the person's

## 推奨
```

`--review` is read by the command line only and is not stored (the
escalation is an ordinary one in `orchestrator-tasks.json`): its
`## 人に聞く理由` may simply name the review (成果物のレビュー, review — not
refused as generic), its options are 完了 / 直してほしい when none are
given, and it is warned of — not refused — when it carries no evidence: no
`--attach`, no picture or code block in the body, no `## 実行結果`
(テスト結果, 出力, 動作確認, Evidence, Results) section.

**A task with no deliverable** (an investigation that ends in an answer, a
clean-up) may close with `task done T --note "<結果>。決めたこと: …"`: the
board's 完了 lane lists it, the card showing the note.

The memo (`task edit T --memo`) holds 「決めたこと」 while the work is under
way, so the board shows it on the card before the review.

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
  invariant as DevHub reports it, what each task status asks of the
  orchestrator (回答待ち waits for the person, 処理中 is relayed to its
  agents and completed, 待機 always has what it waits for in words (and
  `--check-at` for a time) and is checked on `task.changed`), the
  escalation principles and
  template below, the CLI it uses, and an interview: the team's lanes,
  existing skills, review and "done", what it may decide alone beyond the charter's 7 (and where
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
only what cannot be undone, destroys or reaches others, or is the person's
own (the charter's 7: what can be corrected later is decided, not asked),
after the read-only
investigation (code, Notion, Slack) is done; when the facts are not enough,
send an agent to dig further instead. Each is read alone: restate the
background, say what each option leads to, never point at an earlier
question or the task's state. Write in the person's language, for an
engineer who does not know the system, the domain or the code: code
snippets, formulas, diagrams (Mermaid, SVG) and tables render as they do in
a chat answer.

```markdown
## 背景 — what this is about: all that someone new to the task, its history and progress needs

## やったこと — what has been done and found, and what the orchestrator decided on the way (a line each, with why)

## 決めてほしいこと — the one decision, stated as a question, with its options and what each leads to

## 人に聞く理由 — what about it cannot be undone, destroys or reaches others, or why it is the person's own

## 推奨 — the recommended option, and why

## 確認方法 — a URL to try, screenshots (--attach), PRs and Issues as full URLs, a diff summary

## 回答の後 — what the orchestrator will have the agents do (optional)
```

```sh
devhub --tell escalation new --task 12 \
    --title "決済リトライのタイムアウトを 30 秒→60 秒にする修正をマージしてよいか" \
    --body - --option "マージする" --option "見送る" \
    --link "https://github.com/acme/pay/pull/1234=タイムアウト延長の PR" \
    --attach att-1a2b3c4d --attach out/staging.png=staging での再試行
```

Add `--option` for each choice so the person can answer with one click; free
text is always allowed.
