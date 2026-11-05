# The Orchestrator row: the board, escalations and events

One agent can coordinate the others through `devhub --tell` (see the README,
"Orchestrating"). The Orchestrator row gives that agent a place in the window
and gives the person a board of what it needs from them. DevHub supplies the
**mechanism** — the row, the board, escalations, events — and no rules: what
the orchestrator does, how it decides what to escalate and how it writes, is
the person's own, in skills and instructions in the orchestrator's folder.

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

  | Showing                            | Title                                                           |
  | ---------------------------------- | --------------------------------------------------------------- |
  | the board, or the Files tab's tree | `Orchestrator — DevHub`                                         |
  | an escalation                      | `payments · 本番DBマイグレーション承認 — Orchestrator — DevHub` |
  | an escalation with no Workspace    | `本番DBマイグレーション承認 — Orchestrator — DevHub`            |
  | a file in the Files tab            | `decisions.md — Orchestrator — DevHub`                          |
  | a helper agent under the row       | as any Agent: `helper — Orchestrator — DevHub`                  |

  The Workspace is the escalation's own, else its first agent's (by its
  usual label; not the Orchestrator's own), so the time lands on that
  project. The subject and file name are put on one line and cut near 80
  characters; no thread or answer text is ever in the title. It follows
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

| entry             | role           | written by                                                                                                                                                                                                                 | thread shows                                                                                                |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| an answer         | `human`        | the person, in the board's composer                                                                                                                                                                                        | their Markdown                                                                                              |
| `kind: "held"`    | `orchestrator` | `escalation hold ID [--note TEXT]`: parked while it works on it (e.g. more investigation delegated), from 要回答; `escalation resume ID [--note TEXT]`, off its wait, from 待機中. Never an answer                         | 「オーケストレーターが対応中にしました（{time}）[: note]」                                                  |
| `kind: "wait"`    | `orchestrator` | `escalation wait ID --trigger TEXT [--at DATETIME]` (or `escalation new … --wait TEXT [--at DATETIME]`): parked on an outside condition. The trigger is required and never empty; `--at` (ISO) when it is a time (`dueAt`) | 「オーケストレーターが待機中にしました（{time}）: trigger[（M/D HH:MM まで）]」                             |
| `kind: "direct"`  | `human`        | DevHub: one of its `agents` went from idle (or stopped on a question) to working on the person's message from **that agent's own composer** (the conversation IPC's submit: not `agent send`, not an event or a template)  | 「人が {agent} と直接やりとりしました（{time}）— 内容はエージェントの会話を参照」, with a chip to the agent |
| `kind: "resumed"` | `orchestrator` | DevHub: one of its `agents` went working for any other reason (the orchestrator's `agent send`, an injected event, DevHub's own resume after a usage limit)                                                                | 「{agent} が作業を再開しました（{time}）— 回答待ちは一旦解除」                                              |

The notes (`kind`) have no answer in them: `escalation show` prints them as
notes, and `agent wait --any` does not report them as answered. DevHub
writes `direct` / `resumed` (`OrchestratorService`) only on a 要回答 or 待機中 one; the
orchestrator is told of the person's direct words (`escalation.human_direct`, also for one already 対応中: what was
said may answer or change it), not of `held` (its own) or `resumed` (it
caused it, or hears of it as `agent.turn_ended`).

**A maintenance turn is not work.** A turn that only compacts the
conversation — DevHub's keep-warm `/compact` just before the prompt cache
goes cold (`CacheKeeper`, sent with origin `auto-compact`), or a `/compact`
the person typed — writes no `direct` / `resumed` note, tells no
`escalation.human_direct`, ends no `agent.turn_ended`, keeps the agent's
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
- **Closed** — a toggle in the header shows the last 30.

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
Closed stays), lands on the board instead; so does a file that is gone. The
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

- `escalation.wait_due` — once per wait, when `--at` has passed (a restart
  says it again for a wait still past due). Dropped before delivery when the
  escalation has left 待機中, or waits anew.
- `escalation.waiting_reminder` — every `[orchestrator]
wait_reminder_interval` (default `1h`, at least `1m`; Settings ▸
  Orchestrator ▸ Waiting reminder), one line listing every 待機中
  escalation with its trigger (and how far off its time is). Not sent when
  none waits, or no orchestrator runs. It is one subject: while paused, or
  while the orchestrator is busy, the latest replaces the one pending, so a
  backlog never piles up reminders.

On each, the orchestrator checks the triggers (with its own tools for Slack
and the like) and resumes, asks or closes those that are met.
`devhub --tell board` lists them (`waiting (N, soonest first):`, `--json`
`waiting`), and `orchestrator status` counts them.

### 停滞: 対応中 with nobody working on it

A 対応中 escalation is **stalled** when none of its related agents (`agents`,
the orchestrator left out) is working — every one idle, waiting, stopped or
gone, or it names none — and that has held for a grace
(`STALLED_GRACE_MS`, a minute: the orchestrator's time to relay the answer
and set an agent going). Working is status `working` or `background` (a
background task runs for it; the rule `agent.turn_ended` goes by,
`agentAtWork`) and not stopping; a maintenance turn
(`isMaintenanceTurn`) is not work (`workStatus`, as everywhere). The stretch
starts at the latest of: its last entry, the last moment one of its agents was
seen working, the orchestrator's reading of the answer, and main's first
reading after a start. It is computed from live state
(`orchestratorService.ts`, `#stalledSince`), never stored.

- **No noise over an unread answer.** While the last entry is the person's
  answer and the orchestrator has not read it, it is not stalled —
  `escalation_answered` already says so. The clock starts at that reading.
  `escalation_answered` carries the answer itself (see "The person's words"
  below), so its **delivery is the reading** (`#deliveredRead`); one cut at
  the cap is read by `escalation show` (by the orchestrator itself:
  `acknowledge`), which always also counts.
  Chosen over merging both into one line: one message is one thing to do
  (read the answer), and a second one only comes if, a minute after reading
  it, nobody has been set going.
- **Once per stretch**: `escalation.stalled` is sent once for each stretch;
  one of its agents working (a real turn), or a new entry (an answer, a
  question and its answer), ends it, and the next stretch is told again.
- **Marked** on the board (a quiet 停滞 chip on the card, `stalledSince` on
  its `EscalationWire`) and in `devhub --tell board` (`[停滞 3m: …]` on the
  line; `--json`: `inProgress[].stalledSince`).

## Events

Events are how DevHub tells the orchestrator something happened. Every
source calls one dispatcher (`main/orchestrator/events.ts`), which filters,
coalesces and batches them, renders `[orchestrator] event_prompt` around
them and queues the message for the orchestrator agent as an ordinary
message from the person — the same queue `devhub --tell agent send` uses.

### The line format

Each subject is **one line** (see Delivery below): a stable `[type]`
token, then `key=value` ids that go straight into the next command
(`ws=` → `workspace status`,
`agent=` → `agent …` as a unique id prefix, `since=` → `agent read
--since`, `req=` → `agent answer`, `esc=` → `escalation show`), then `—` and
a short summary (Japanese; excerpts are cut to about 150 characters). Only
what is needed to act or to fetch more is on the line: the orchestrator
pulls the details itself. `{EVENT}` holds these lines.

**The person's words** are the exception: `escalation_answered` carries the
answer and `escalation.human_direct` the message the person sent the agent,
quoted right under the event's line (`humanBlock` in `events.ts`), so the
orchestrator never has to run a command to read them — a shell call Claude
Code's auto mode may hold for permission even when writes are allowed.

```
[escalation_answered] esc=12「本番DBマイグレーション承認」 agent=a1b2c3d4 (API fix) — 人が回答しました (本文は下の > 行)
  回答 1/2 (選択肢「承認する」):
> 承認する
  回答 2/2:
> ただし金曜の夜は避けて
```

- Every line of the person's text is `> ` and the line (a blank one a bare
  `>`); DevHub's own lines under an event start with two spaces (what each
  quote is, the quick reply picked as `(選択肢「…」)`, where to read the
  rest); an event's line starts with `[`. So nothing the person writes can
  look like a new event or close anything: a line of theirs starting with
  `[` or a code fence is still `> …`. Every line break a reader might honour
  (CR, LS, PS, NEL, VT, FF) starts a new quoted line; other control
  characters are dropped (`quoteLines`).
- A quick reply is sent as the option's words; when the answer is exactly
  one of the question's options, it is labelled with it.
- At most `HUMAN_TEXT_CAP` (4000) characters per event, every answer
  together; past it the text is cut and the last line says
  `…（続きは devhub --tell escalation show 12）` (`agent read A --since S`
  for `human_direct`).
- Answers pending for one escalation fold into its one line, every one in
  order (`回答 1/2`, `回答 2/2`); so do one agent's `human_direct` messages.
- `{EVENT_JSON}` has them in full: `answers` (`text`, `option`) and `answer`
  (all the text, a blank line between) for `escalation_answered`; `messages`
  and `message` for `human_direct`; and `truncated` — whether `{EVENT}` cut
  them.
- **Delivery is the reading.** An `escalation_answered` that went out with
  its answers whole acknowledges them: 停滞's grace starts at delivery, and
  `agent wait --any` stops reporting the answer as unread (the orchestrator's
  `TellMemory`, through the `acknowledged` port). A cut one stays unread
  until `escalation show`, which still acknowledges as before.

| type                                              | when                                                                                                                                                                                                                                  | example                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`                                            | the orchestrator starts (`init_prompt` if set)                                                                                                                                                                                        | `[init] — オーケストレーターが起動しました。devhub --tell board で現状を確認`                                                                                      |
| `escalation_answered`                             | the person answered an escalation                                                                                                                                                                                                     | `[escalation_answered] esc=12「本番DBマイグレーション承認」 — 人が回答しました (本文は下の > 行)`, the answer quoted under it                                      |
| `escalation.human_direct`                         | the person talked directly to an open escalation's agent, from its composer, and it went working (要回答 → 対応中)                                                                                                                    | `[escalation.human_direct] esc=12「本番DBマイグレーション承認」 agent=a1b2c3d4 since=e39 — 人がエージェントと直接やりとりしました。…`, the message quoted under it |
| `escalation.stalled`                              | a 対応中 escalation none of whose agents has worked for the grace (see 停滞); `agents=none` when it names none (`escalation link` it)                                                                                                 | `[escalation.stalled] esc=12「本番DBマイグレーション承認」 agents=a1b2c3d4,c3d4e5f6 idle 3m — 対応中だが動いているエージェントがいない`                            |
| `escalation.wait_due`                             | a 待機中 escalation's `--at` time came: once per wait                                                                                                                                                                                 | `[escalation.wait_due] esc=12「本番DBマイグレーション承認」 — 待機条件の時刻になりました: 11/10 以降に再開`                                                        |
| `escalation.waiting_reminder`                     | every `wait_reminder_interval` (1h): every 待機中 escalation and its trigger, one line; not sent when none waits                                                                                                                      | `[escalation.waiting_reminder] 待機中 2 件 — esc=12「…」: Bob から Slack で返事が来たら / esc=15「…」: 11/10 以降 (あと 3日)`                                      |
| `github.assigned`                                 | the viewer was assigned to a card                                                                                                                                                                                                     | `[github.assigned] #200「検索の改善」 — me にアサイン https://github.com/acme/app/issues/200`                                                                      |
| `github.lane_changed`                             | a card of the viewer's moved lane (Status)                                                                                                                                                                                            | `[github.lane_changed] #123「API整理」 In Progress → In Review ws=api-refactor https://github.com/acme/app/issues/123`                                             |
| `github.unattended`                               | an open Issue on a board, assigned to the viewer, has no live DevHub agent linked to it (a state, said on every poll and the baseline; see below)                                                                                     | `[github.unattended] #200「検索の改善」 lane=Todo — 自分にアサインされているがエージェントがいない https://…/issues/200`                                           |
| `github.pr_opened`                                | a PR linked to the viewer's Issue, or by the viewer, appeared                                                                                                                                                                         | `[github.pr_opened] PR #130「ログイン修正」 — me が draft で作成 (#123) https://github.com/acme/app/pull/130`                                                      |
| `github.pr_ready`                                 | a watched PR left draft                                                                                                                                                                                                               | `[github.pr_ready] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 (API fix) — ready for review になった https://…/pull/130`                                   |
| `github.pr_approved` / `github.changes_requested` | the viewer's PR was approved / changes were requested (by someone other than the viewer)                                                                                                                                              | `[github.changes_requested] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 — bob が変更を要求 https://…/pull/130`                                             |
| `github.review_comment`                           | new review comments or threads on the viewer's PR, by others (never the viewer's own; counts are others' only)                                                                                                                        | `[github.review_comment] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 (API fix) — alice から新規2件 (未解決 2) https://…/pull/130`                          |
| `github.review_requested`                         | the viewer's review was requested on a PR on the boards                                                                                                                                                                               | `[github.review_requested] PR #9「キャッシュ」 — carol からレビュー依頼 https://…/pull/9`                                                                          |
| `github.reply`                                    | the author replied or pushed on a PR the viewer reviewed (a push whose head commit is the viewer's is not said)                                                                                                                       | `[github.reply] PR #9「キャッシュ」 — carol が返信2件・新しいコミット https://…/pull/9`                                                                            |
| `github.checks`                                   | the viewer's PR's CI finished                                                                                                                                                                                                         | `[github.checks] PR #130「ログイン修正」 ws=login-fix — CI 失敗 (2/5) https://…/pull/130`                                                                          |
| `github.pr_merged` / `github.pr_closed`           | a watched PR was merged / closed unmerged                                                                                                                                                                                             | `[github.pr_merged] PR #130「ログイン修正」 ws=login-fix — マージされた https://…/pull/130`                                                                        |
| `workspace.opened` / `workspace.closed`           | a Workspace opened / closed                                                                                                                                                                                                           | `[workspace.opened] ws=api — 開いた /src/api`                                                                                                                      |
| `workspace.issue_assigned`                        | DevHub's Issue assignment made a Workspace and agent                                                                                                                                                                                  | `[workspace.issue_assigned] #123 ws=123-api agent=a1b2c3d4 (Claude) — DevHub で Issue をアサイン https://…/issues/123`                                             |
| `workspace.branch_changed`                        | a Workspace's branch changed                                                                                                                                                                                                          | `[workspace.branch_changed] ws=login-fix 12-login → 13-other`                                                                                                      |
| `workspace.pr_linked`                             | a PR appeared for a Workspace's branch                                                                                                                                                                                                | `[workspace.pr_linked] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 (API fix) — このブランチの PR https://…/pull/130`                                       |
| `agent.turn_ended`                                | an agent is truly done: settled into `idle`, no background shell, task or subagent left running (`background` waits)                                                                                                                  | `[agent.turn_ended] agent=a1b2c3d4 (API fix) ws=login-fix since=e39 — 「テストを追加しました。残りは…」`                                                           |
| `agent.asked`                                     | an agent asked a question (AskUserQuestion)                                                                                                                                                                                           | `[agent.asked] agent=c3d4e5f6 req=q7 — 「マイグレーションの順番」ほか1問`                                                                                          |
| `agent.permission_requested`                      | an agent waits on a permission prompt (FYI: only the person approves)                                                                                                                                                                 | `[agent.permission_requested] agent=e5f6a7b8 req=p1 — 権限確認「rm -rf build」 (FYI: 承認できるのは人だけ)`                                                        |
| `agent.started` / `agent.exited`                  | an agent started / is gone                                                                                                                                                                                                            | `[agent.exited] agent=a1b2c3d4 (API fix) ws=login-fix — 終了した`                                                                                                  |
| `agent.failed`                                    | an agent's pane shows a failure                                                                                                                                                                                                       | `[agent.failed] agent=a1b2c3d4 (API fix) ws=login-fix — 失敗: conversation_host_lost`                                                                              |
| `timer.elapsed`                                   | a timer fired                                                                                                                                                                                                                         | `[timer.elapsed] tick`                                                                                                                                             |
| `usage.threshold`                                 | a CLI's plan window crossed a `usage_thresholds` percent upward: once per threshold per window period, again after it resets; one line per CLI and window (the latest), dropped as stale if the window has reset below it by delivery | `[usage.threshold] cli=claude window=5-hour pct=82 resets=19:20 — 5時間枠が80%を超えました`                                                                        |
| `custom.NAME`                                     | `orchestrator emit`                                                                                                                                                                                                                   | `[custom.deploy] — staging に deploy 完了`                                                                                                                         |

Nothing is ever said about the orchestrator itself (its own agent and its
Workspace): the dispatcher drops such an event as `self`.

**`{EVENT_JSON}`** is an escape hatch for scripts: the same events as a JSON
array, each `{ "type": …, …its fields }`. It is rendered **only when the
template contains it**, so it costs nothing otherwise.

### Delivery: one line per subject, batching, pause

**A delivery is not a history: it lists what currently needs attention, one
line per subject.** The pending buffer holds action items, not a log.

- **Subjects** (`subjectOf`): a pull request or Issue (`repo#number`), an
  agent, a Workspace, an escalation, a timer, a custom type and text, `init`.
  While pending, a subject is **one line**, however many events said
  something about it. A new event folds into its subject's line, by facet
  (`facetOf`, `merge`):
  - review comments add their counts up and merge the authors; `reply` adds
    up too;
  - a lane is first `from` → last `to`, and **dropped** when that is no move
    (In Progress → In Review → In Progress); a branch the same; an assignment
    taken back cancels out;
  - checks, reviews (approved / changes requested) and the rest are the
    latest: CI failed → passed is one line, passed;
  - a merge or a close (and an agent's exit, a Workspace's close) replaces
    whatever else was pending about its subject;
  - an agent's repeated `turn_ended` keep the latest excerpt and the first
    unread `since`; so does `escalation.human_direct` per agent (its subject
    is the escalation, so it shares a line with an `escalation_answered`);
    a timer has at most one pending event;
  - different statements about one subject share its line, the latest
    leading it with its `[type]`, the others after `／ [type] …`, without the
    ids the line already has: `[github.pr_approved] PR #130「ログイン修正」 —
bob が承認 ／ [github.pr_ready] ready for review になった https://…/pull/130`.
    `{EVENT_JSON}` carries them as the line's `also`.
- **Stale items are dropped before delivery.** Each pending item is re-read
  against live state when the message is rendered (`relevant`, in
  `orchestratorService.ts`) and dropped as `dropped-stale` if its subject no
  longer needs attention: a `turn_ended` whose agent is at work
  again — `working` or `background` (its real end will be said; its output
  stays readable with `agent read`) — or is gone; an `agent.asked` or `permission_requested` whose agent no
  longer waits on it; an `escalation_answered` or
  `escalation.human_direct` whose escalation is closed; an
  `escalation.stalled` whose stretch is over (an agent of it works again, a
  new entry, back in 要回答, closed); an `escalation.wait_due` whose
  escalation has left 待機中 or waits anew; an
  `escalation.waiting_reminder` none of whose escalations still waits; a
  `github.unattended`
  whose Issue was closed, or has had an agent linked to it, since.
- **Never said twice.** What the last delivery said about a subject is not
  delivered again (`repeat`) unless something about that subject has been
  heard since — the same CI result on the same commit. Events that add news each time (`init`,
  `escalation_answered`, `escalation.human_direct`,
  `escalation.waiting_reminder` — one subject, so a backlog (or a pause)
  holds the latest only —
  review comments, replies, `github.unattended` — its source says it once
  per stretch of being unattended —
  turns, timers, `custom.*`)
  are never repeats.
- **Batching.** Lines wait while the orchestrator is mid-turn (working, on a
  question, or with something of ours still queued for it) or paused, and go
  out together as **one** message once it can take one. A batch waits 300 ms
  for more, and after a delivery the next one waits (up to a minute) to see
  the last one taken. However long the backlog, the message has one line per
  subject, at most 50 (`MAX_DELIVERY_LINES`); the rest are counted on a last
  line, `…ほか N 件 (devhub --tell orchestrator events で確認)`, and logged as
  `overflow`.
- **Filter**: `[orchestrator] events` (below). Filtered events are kept in
  the log as `filtered`.
- **Pause** (the switch in the board's header, or `orchestrator pause`)
  holds everything and **suspends GitHub polling**: a paused orchestrator
  spends no API quota. **Resume** polls GitHub once at once (unless the rate
  limit says to wait for its reset), waits for that poll (at most 20 s), and
  delivers everything — what was held and what changed on GitHub during the
  pause, as the net change — as one message. The header shows how many lines
  are pending, beside the switch. Pending events live in memory: a quit drops
  them, and the next start's `init` sends the orchestrator to the board
  anyway. With no orchestrator assigned, an event is dropped.
- **The header** says it calmly: the switch is labelled only "Events" (its
  knob says on or off), and GitHub polling is a `GitHub` pill with a dot —
  green active, grey suspended by the pause, hollow idle (no orchestrator,
  or no `[orchestrator.github] projects`), amber backing off (the last poll
  failed or GitHub reported a problem, or the rate limit is under half or
  100 left: `githubHealth` in `model/orchestratorSettings.ts`). Hovering or
  focusing it opens a small card, which the pointer can move into: the
  boards (`OWNER/NUMBER`, each a link to its GitHub page, with what its last
  full pass counted: items, assigned to me, unattended), the state and
  why, the last and next poll, and the rate limit left — what
  `orchestrator status` prints (and `--json` carries as `github`: `boards`
  with `items` / `assigned` / `unattended`, `unattended`, `notes`,
  `lastAt`, `nextAt`, `rateLimit`, `problem`).
- `devhub --tell orchestrator events [--last N] [--json]` lists the last
  events (200 are kept) and what came of each: `delivered`, `pending`,
  `filtered`, `coalesced` (into which), `dropped-stale` (with why: no longer
  needs attention, or no net change), `repeat`, `overflow`, `dropped`, `self`
  — and then why the last GitHub look said nothing of some cards: a board's
  baseline pass (no `github.assigned` / `lane_changed` from it), an Issue of
  the viewer's that has an agent (which, where), a closed one, an unattended
  one already said (`--json`: `githubNotes`).

### The sources

- **The board** (`orchestratorService.ts`): `init`, `escalation_answered`,
  `escalation.human_direct`, `escalation.stalled`,
  `escalation.wait_due`, `escalation.waiting_reminder`.
- **GitHub** (`githubEvents.ts`), while an orchestrator runs and
  `[orchestrator.github] projects` names a board. Scope: the cards on those
  Projects (v2) boards that relate to the viewer — assigned to them, authored
  by them, their review requested — and the PRs linked to those Issues
  (GitHub's closing references). A card that related to the viewer stays
  watched for the session, so an Issue that `request-review` unassigned and
  moved to In Review still reports its lane. DevHub only **reads** the board.
  - **One batched GraphQL request per tick**, never two in flight, no `gh`
    subcommands (the token is `gh auth token`'s, as for the Workspace
    watcher, through the same client): `viewer { login }`, `rateLimit { cost
remaining limit resetAt }`, a page of 100 items per board (item id,
    content type/number/url/title, Status, assignees, author, an Issue's
    linked PRs), `search(is:pr is:open review-requested:@me)`, and
    `nodes(ids:)` for the watched PRs (up to 30: state, isDraft,
    reviewDecision, latest reviews, the last 10 reviews and 5 comments with
    their totals, review threads and how many are unresolved, the head
    commit's oid, author and committer login, and checks rollup). Typically
    **2–6 points** a tick.
  - **The viewer's own activity is never an event.** The viewer's agents post
    with the same GitHub identity, so a review, comment or push of theirs is
    left out of `github.review_comment`, `github.pr_approved` /
    `github.changes_requested` and `github.reply`: the counts (`新規2件`,
    `返信2件`) are of others' activity only, and when only the viewer's is
    new there is no event at all. The viewer's comment in the same tick as
    someone else's neither hides it nor is said later (new is by time, the
    viewer's left out after; a pending review counts once submitted). Review
    threads carry no author in the query, so a new thread counts only in a
    look with no review by the PR's author or the viewer (who could have
    opened it); otherwise the count is others' `COMMENTED` reviews. A push is
    the viewer's when the new head commit's author (else committer) login is
    theirs — the pusher is not in the API, and only the head commit is read,
    so a push of others' commits topped by one of the viewer's is not said.
  - A board bigger than a page is read a page a tick and diffed when the
    whole of it has been read.
  - **Interval**: starts at `interval` (default 90s, at least 30s) and only
    backs off: ×1.5 under 50% of the hourly limit left, ×2 under 25%, ×4
    under 10%, **paused until `resetAt`** when fewer than max(100, 20×cost)
    points remain; doubling after each failure, up to 15 minutes.
  - **Polling follows the pause**: `active` while the orchestrator runs,
    `suspended` while its events are paused (no requests at all; the last
    reading — boards, watched set, PR details, viewer, review requests — is
    kept), `idle` with no orchestrator or no `projects` (memory forgotten).
    The board's header and `orchestrator status` show which. A resume polls
    at once and diffs against what was kept: the net change is said, flips in
    between are not.
  - **Kept across restarts**: the last reading is stored per profile in
    `<userData>/devhub/orchestrator-github.json` (versioned; written after
    each successful poll, debounced 5 s, atomically through a temporary file
    and a rename; flushed when the source stops). When the source starts for
    an orchestrator it loads it and the first poll is diffed against it — so
    what changed while DevHub was down is said. **A new orchestrator in the
    same profile diffs too** (stopping one forgets the memory, never the
    file): it inherits the team's boards, and what moved since is exactly
    what it needs to hear.
  - **Baseline** (the first reading says nothing) when there is no stored
    snapshot, when it does not read or is of another version, when
    `[orchestrator.github] projects` changed since it was stored, when the
    viewer's login is another, or when it is **older than 7 days**
    (`STALE_SNAPSHOT_MS`; a resume after a pause that long is a baseline too)
    — what changed in a week is history, not news. A board's first full pass
    and a PR's first details are a baseline as well.
  - Where the Workspace watcher (the Sidebar's branch → PR, `workspace
status`) has the PR or Issue open, its Workspace and agent go on the
    line as `ws=` and `agent=`.
  - **`github.unattended`** (`unattended.ts`) is level-triggered: edge events
    can be missed (the baseline, an assignment before the orchestrator
    existed, a failed poll), a state cannot. On **every successful poll —
    the baseline included** — and whenever the Workspaces or agents move (a
    projection, a repository-status round), each card that is an **Issue,
    assigned to the viewer, open**, with **no linked live agent**, is said
    once. The lane decides nothing (`lane=` is information); a closed Issue
    is done. **Linked** (`linkedAgent`, the one definition): an open
    Workspace whose checked-out branch names the Issue (`123-fix-login` in
    the repository it numbers Issues in — the link DevHub's Issue assignment
    makes, and the Sidebar shows) and that has at least one agent not
    stopped or stopping; or a live agent whose meta `issue=` names it, by
    URL, or by number (`123`, `#123`) in its Workspace's repository. The
    orchestrator is never the linked agent. A Workspace whose branch no
    repository round has read yet links nothing: should it be on the Issue,
    the stale check at delivery drops what is still waiting. **Once per
    episode**: an Issue
    said is not said again until it has been attended (an agent linked) or
    closed, and then is unattended again; a start or restart of the
    orchestrator says every one again, so right after `init` it hears the
    whole list — any assignment missed before included. Stale-dropped when,
    by delivery, it was closed or an agent got linked. The current list is
    `devhub --tell board` (`--json`: `unattendedIssues`, null when GitHub is
    not polled); `orchestrator status` counts, per board, its items, those
    assigned to the viewer, and the unattended ones.
- **Workspaces and agents** (`liveEvents.ts`), read off the projection the
  window draws (the Sidebar's repository status included) while an
  orchestrator runs; the first projection is a baseline.
  `workspace.issue_assigned` is said by DevHub's Issue assignment itself.
  `turn_ended` is said when the agent is **truly done**: armed once it is
  seen at work — `working`, or `background` (its turn is over but a
  background shell, task or subagent it started still runs) — and said when
  it settles into `idle` for 1.5 s. `working → background → idle` and
  `background → working → idle` are each one `turn_ended`, at the idle; an
  agent that keeps something running in the background (a dev server) says
  none until it stops. One rule (`agentAtWork` / `agentTurnDone` in
  `model/domain.ts`) also decides the person's "Finished" notification
  (`agentNotifications.ts`), the stale drop at delivery and
  `escalation.stalled`. A maintenance turn neither arms nor ends one. It
  carries the id of the message that began the turn as `since` and the start
  of the last reply.
- **Timers** (`timers.ts`): `[[orchestrator.timers]]` are the defaults;
  `orchestrator timer set NAME INTERVAL | clear NAME` changes them for the
  session, and a settings change moves the ones nobody set by hand.
- **Usage** (`usageThresholds.ts`): `usage.threshold`, read off the
  Sidebar's usage readout each time it changes (DevHub's own readers and the
  GUI Agents' reports). It asks no CLI anything; `devhub --tell usage` shows
  the same readout.
- **`orchestrator emit --type custom.NAME --text TEXT|-`**: anything else
  (a script, a hook), through the same filter and coalescing.

### The seam, for new events

`main/orchestrator/events.ts` is the one place events go through:

1. add a variant to `OrchestratorEvent` (`{ type: "github.x", … }`) and to
   `EVENT_TYPES`;
2. word its line in `eventLine` (and, if it should fold, `coalesceKey` and
   `merge`);
3. call `orchestrator.events.dispatch(event)` where it happens.

The dispatcher does the rest: the filter, coalescing, pause, batching, the
prompt, delivery and the log. The `/devhub-orchestrator` skill's table is
tested against `EVENT_TYPES`. A loop-style orchestrator that waits instead
(`agent wait --any`) is woken by the board's own news below; an event that
should wake it too needs a reason there as well.

### `agent wait --any`

Called by the orchestrator, `agent wait --any` also returns for:

- an escalation the person answered that it has not read — acknowledged by
  `escalation show ID`.

The same read-tracking as the rest of `wait --any` (`TellMemory`): it stays
reported until it is read, so nothing between two waits is missed.

## Settings: `[orchestrator]`

```toml
[orchestrator]
root = "~/orchestrator"          # the folder it runs in (this is the default): its skills are this folder's
profile = "claude"               # the window's Start; absent: the window's default
presentation = "gui"             # gui | tui; absent: the profile's default
event_prompt = "このイベントが発生したのでハンドリングしてください。{EVENT}"
# init_prompt = "/start-orchestrating {EVENT}"   # absent: event_prompt with init
# events = ["*", "!agent.permission_requested"] # which types reach it (default below)
usage_thresholds = [80, 95]      # usage.threshold at these percents of a plan window (the default); [] never
wait_reminder_interval = "1h"    # escalation.waiting_reminder this often (the default; at least 1m)

[orchestrator.github]
projects = ["my-org/7"]          # Projects (v2) boards, OWNER/NUMBER; none: no GitHub events
interval = "90s"                 # the base poll interval (at least 30s); it only backs off

[[orchestrator.timers]]
name = "sweep"                   # timer.elapsed carries it
interval = "30m"                 # at least 10s
```

`root` defaults to `~/orchestrator`. The window's **Start** makes the folder
(and its parents) when it is missing; `orchestrator start --root` on a command
line never does, and refuses a folder that is not there.

`event_prompt` can invoke a skill: `"/make-progress {EVENT}"`; `{EVENT_JSON}`
may be added for a script. `events` is a list of patterns over the type — a
type (`agent.turn_ended`), a family (`github.*`) or `*`, each optionally after
`!` to take it out; the last pattern that matches decides, and `init` always
goes. The default is everything but the chatter:

```toml
events = ["init", "escalation_answered", "escalation.human_direct",
  "escalation.stalled", "escalation.wait_due", "escalation.waiting_reminder", "github.*", "workspace.issue_assigned", "workspace.pr_linked", "agent.turn_ended",
  "agent.asked", "agent.exited", "agent.failed", "usage.threshold", "timer.*", "custom.*"]
```

(so `agent.started`, `workspace.opened`, `workspace.closed`,
`workspace.branch_changed` and `agent.permission_requested` are left out).
They are in Settings ▸ General ▸ Orchestrator and validated with every other
setting.

## The command line

```sh
devhub --tell board [--json]                         # 要回答, 対応中 (停滞 marked), 待機中 as data
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

## `/devhub-orchestrator`: writing the person's make-progress skill

What the orchestrator does on each event is the person's own skill in
`root` (say `/make-progress`, invoked by `event_prompt = "/make-progress
{EVENT}"`). DevHub does not ship one — workflows differ — but it gives
the orchestrator agent, and no other agent, a skill for **writing** one:
`/devhub-orchestrator` (`main/orchestrator/orchestratorSkill.ts`).

- **What it says** (in Japanese): what a delivery carries (`init`, one message
  per delivery that may batch several events, the line format, `{EVENT}` and
  the optional `{EVENT_JSON}`, coalescing, held mid-turn and while paused,
  the `events` filter), the event types (its table is tested against
  `EVENT_TYPES`), what each lane asks of the orchestrator (要回答 waits, 対応中 is
  relayed to the agent and closed, 停滞 is acted on, 待機中 always has its
  trigger in words (and `--at` for a date) and is checked on each
  `waiting_reminder`, then resumed, asked or closed; a related agent that
  goes working takes an escalation out of 要回答 until it is asked again, and
  on `escalation.human_direct` it reads what the person said in the event
  (the rest, when cut, with `agent read --since`), then closes the escalation, asks again with what is
  still open, or relays the decision to other agents), the escalation
  principles and template below, how to keep work moving (no idle agent
  without a reason, `agent read --since`, permission prompts are the
  person's, no `focus` unasked), the CLI it uses, and an interview: the
  team's lanes, existing skills, review and "done", what it may decide alone
  (and where decisions are recorded), events, timers, naming and meta.
  Then it drafts make-progress — a dispatcher on each line's `[type]`, a playbook per
  event, the no-idle rule, escalation rules, a reconcile on `init` — shows it,
  and writes it to `<root>/.claude/skills/<name>/SKILL.md` (plus an
  `AGENTS.md` pointer for Codex). It never writes `settings.toml`: it gives
  the person the `[orchestrator]` lines to add, or to set in Settings.
- **Where it is**: rewritten on every start at
  `<userData>/devhub/orchestrator-skill/.claude/skills/devhub-orchestrator/SKILL.md`
  (`~/Library/Application Support/DevHub/…` on a Mac), beside `/devhub`'s
  `agent-skill`, naming the same `devhub` launcher.
- **How it is given**: when the agent being launched, restarted or starting a
  thread is the orchestrator — the one the row is assigned to, or the new
  agent `orchestrator start` (and the window's Start) is making — Claude gets
  a second `--add-dir=<userData>/devhub/orchestrator-skill`, and a Codex GUI
  thread one more paragraph in `developerInstructions` pointing at the
  SKILL.md. Every other agent gets only `/devhub` (`isOrchestratorAgent`,
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
