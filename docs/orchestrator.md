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
│ Scratch       │ ● 要回答 3               │  the orchestrator      │
│ ▼ payments    │   #1 本番 invoices …  1m │  agent's own pane      │
│    Claude ●   │ ● 対応中 2               │  (an ordinary GUI or   │
│ ▼ web-console │   #2 決済リトライ …      │   terminal Agent)      │
│    Claude ○   │ ● 不明 1                 │                        │
│               │   docs-writer  idle 3m   │                        │
└───────────────┴──────────────────────────┴────────────────────────┘
```

## The row and the screen

- **The row** is the Sidebar's first, above Scratch. It ends with the number
  of escalations waiting for an answer (the one filled badge in the Sidebar)
  and, quieter, the number of agents in 不明 while an orchestrator runs. The
  orchestrator agent's status mark sits before them. The orchestrator agent is
  drawn on this row only, not under its Workspace.
- **Selecting it** shows the Orchestrator screen: the board on the left, the
  orchestrator agent's pane on the right. It is the Agents view over the whole
  content area (`NavigationContext` `orchestrator`, `SurfaceLayout`
  `orchestrator`): the page divides its own rectangle, so no new
  `WebContentsView`, z-order or keyboard rule was needed. Selecting the
  orchestrator agent any other way (a chord, `focus A`) selects the row.
- `root` opens as an ordinary Workspace row (nothing selected), so the
  orchestrator's skills and instructions are an editor click away.
- With no orchestrator, the right half says so and offers **Start
  Orchestrator**, from `[orchestrator]` below (in `~/orchestrator` unless
  `root` says otherwise; the folder is made if it is missing).
- A restart opens on Scratch rather than on this row: the row is not written
  into `state.json`, so an older DevHub can still read the file.

## Escalations

An escalation is a request for a human decision or permission, raised by the
orchestrator when work cannot go on without one. It is a **thread**:

```text
{ id, title, entries: [{ role: orchestrator|human, markdown, at, options? }],
  agents: [agent ids], workspaceId?, links: [urls], createdAt, updatedAt,
  closed?: { at, note? } }
```

Its state is **read off the thread** (`model/escalations.ts`), never stored:

| state          | when                                 | lane   |
| -------------- | ------------------------------------ | ------ |
| `needs_answer` | the last entry is the orchestrator's | 要回答 |
| `in_progress`  | the last entry is the person's       | 対応中 |
| `closed`       | closed (`escalation close`)          | hidden |

So the person's answer moves it to 対応中 by being an answer, and a follow-up
question on the same ticket (`escalation ask`) moves it back to 要回答. Once
the answer has been used up the orchestrator closes it.

They are kept per profile in `<userData>/devhub/escalations.json`, written
whole and atomically on every change; a file that does not read is moved to
`escalations.json.corrupt` and said, and the board starts empty.

**The person answers in DevHub's window only.** The board's composer is the
one door (`answerEscalation` on the Agents page's bridge); no `devhub --tell`
command and no `TellPorts` member can write a human entry, and
`escalation answer` is refused by name. `service.test.ts` holds both.

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
- **不明** — see below.
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
an escalation (its chip, or a row in 不明) is a deliberate move
(`reason: "explicit"`), so Back (prefix+h) returns to the Orchestrator
screen.

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
Workspace that contains it — the root's own row — as `devhub <file>` would,
and that too is a place in Back and Forward.

Main reads the folder and watches it
(`main/orchestrator/orchestratorFiles.ts`): the page lists, reads and is told
what changed (debounced), so when the orchestrator writes `decisions.md` the
tree and the open file follow, and the tab shows a dot while the board is in
front. Every path is from the root and confined to it: an absolute path,
`..`, or a symlink that leads out is refused.

### 不明: agents nobody accounts for

不明 lists the agents that are **idle for longer than a minute**
(`UNACCOUNTED_GRACE_MS`), are not the orchestrator, are not stopping, and are
named by no open (要回答 or 対応中) escalation. It is computed from live state
on every reading and never stored, so nobody clears it: it empties when the
agent is given work or an escalation names it. The minute is the grace for an
agent that has just finished or just started — long enough for the
orchestrator to read it and hand it its next task, short enough that a
forgotten agent shows up the same minute. "Idle since" is main's own reading
of each snapshot.

It should normally be empty. Each agent that enters it is sent to the
orchestrator as an `unaccounted` event, once per stretch of idleness.

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

| type | when | example |
| --- | --- | --- |
| `init` | the orchestrator starts (`init_prompt` if set) | `[init] — オーケストレーターが起動しました。devhub --tell board で現状を確認` |
| `escalation_answered` | the person answered an escalation | `[escalation_answered] esc=12「本番DBマイグレーション承認」 — 人が回答しました (escalation show で読む)` |
| `unaccounted` | an agent entered 不明 | `[unaccounted] agent=e5f6a7b8 (調査) ws=docs idle 1m` |
| `github.assigned` / `github.unassigned` | the viewer was assigned to / taken off a card | `[github.assigned] #200「検索の改善」 — me にアサイン https://github.com/acme/app/issues/200` |
| `github.lane_changed` | a card of the viewer's moved lane (Status) | `[github.lane_changed] #123「API整理」 In Progress → In Review ws=api-refactor https://github.com/acme/app/issues/123` |
| `github.pr_opened` | a PR linked to the viewer's Issue, or by the viewer, appeared | `[github.pr_opened] PR #130「ログイン修正」 — me が draft で作成 (#123) https://github.com/acme/app/pull/130` |
| `github.pr_ready` | a watched PR left draft | `[github.pr_ready] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 (API fix) — ready for review になった https://…/pull/130` |
| `github.pr_approved` / `github.changes_requested` | the viewer's PR was approved / changes were requested | `[github.changes_requested] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 — bob が変更を要求 https://…/pull/130` |
| `github.review_comment` | new review comments or threads on the viewer's PR | `[github.review_comment] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 (API fix) — alice から新規2件 (未解決 2) https://…/pull/130` |
| `github.review_requested` | the viewer's review was requested on a PR on the boards | `[github.review_requested] PR #9「キャッシュ」 — carol からレビュー依頼 https://…/pull/9` |
| `github.reply` | the author replied or pushed on a PR the viewer reviewed | `[github.reply] PR #9「キャッシュ」 — carol が返信2件・新しいコミット https://…/pull/9` |
| `github.checks` | the viewer's PR's CI finished | `[github.checks] PR #130「ログイン修正」 ws=login-fix — CI 失敗 (2/5) https://…/pull/130` |
| `github.pr_merged` / `github.pr_closed` | a watched PR was merged / closed unmerged | `[github.pr_merged] PR #130「ログイン修正」 ws=login-fix — マージされた https://…/pull/130` |
| `workspace.opened` / `workspace.closed` | a Workspace opened / closed | `[workspace.opened] ws=api — 開いた /src/api` |
| `workspace.issue_assigned` | DevHub's Issue assignment made a Workspace and agent | `[workspace.issue_assigned] #123 ws=123-api agent=a1b2c3d4 (Claude) — DevHub で Issue をアサイン https://…/issues/123` |
| `workspace.branch_changed` | a Workspace's branch changed | `[workspace.branch_changed] ws=login-fix 12-login → 13-other` |
| `workspace.pr_linked` | a PR appeared for a Workspace's branch | `[workspace.pr_linked] PR #130「ログイン修正」 ws=login-fix agent=a1b2c3d4 (API fix) — このブランチの PR https://…/pull/130` |
| `agent.turn_ended` | an agent's turn ended | `[agent.turn_ended] agent=a1b2c3d4 (API fix) ws=login-fix since=e39 — 「テストを追加しました。残りは…」` |
| `agent.asked` | an agent asked a question (AskUserQuestion) | `[agent.asked] agent=c3d4e5f6 req=q7 — 「マイグレーションの順番」ほか1問` |
| `agent.permission_requested` | an agent waits on a permission prompt (FYI: only the person approves) | `[agent.permission_requested] agent=e5f6a7b8 req=p1 — 権限確認「rm -rf build」 (FYI: 承認できるのは人だけ)` |
| `agent.started` / `agent.exited` | an agent started / is gone | `[agent.exited] agent=a1b2c3d4 (API fix) ws=login-fix — 終了した` |
| `agent.failed` | an agent's pane shows a failure | `[agent.failed] agent=a1b2c3d4 (API fix) ws=login-fix — 失敗: conversation_host_lost` |
| `timer.elapsed` | a timer fired | `[timer.elapsed] tick` |
| `custom.NAME` | `orchestrator emit` | `[custom.deploy] — staging に deploy 完了` |

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
    unread `since`; a timer has at most one pending event;
  - different statements about one subject share its line, the latest
    leading it with its `[type]`, the others after `／ [type] …`, without the
    ids the line already has: `[github.pr_approved] PR #130「ログイン修正」 —
    bob が承認 ／ [github.pr_ready] ready for review になった https://…/pull/130`.
    `{EVENT_JSON}` carries them as the line's `also`.
- **Stale items are dropped before delivery.** Each pending item is re-read
  against live state when the message is rendered (`relevant`, in
  `orchestratorService.ts`) and dropped as `dropped-stale` if its subject no
  longer needs attention: an `unaccounted` agent that is no longer idle or is
  now named by an open escalation; a `turn_ended` whose agent is working
  again (someone has given it work; its output stays readable with `agent
  read`) or is gone; an `agent.asked` or `permission_requested` whose agent no
  longer waits on it; an `escalation_answered` whose escalation is closed.
- **Never said twice.** What the last delivery said about a subject is not
  delivered again (`repeat`) unless something about that subject has been
  heard since — a repeated `unaccounted` for the same idle period, the same
  CI result on the same commit. Events that add news each time (`init`,
  `escalation_answered`, review comments, replies, turns, timers, `custom.*`)
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
- `devhub --tell orchestrator events [--last N] [--json]` lists the last
  events (200 are kept) and what came of each: `delivered`, `pending`,
  `filtered`, `coalesced` (into which), `dropped-stale` (with why: no longer
  needs attention, or no net change), `repeat`, `overflow`, `dropped`, `self`.

### The sources

- **The board** (`orchestratorService.ts`): `init`, `escalation_answered`,
  `unaccounted`.
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
    commit's oid and checks rollup). Typically **2–6 points** a tick.
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
- **Workspaces and agents** (`liveEvents.ts`), read off the projection the
  window draws (the Sidebar's repository status included) while an
  orchestrator runs; the first projection is a baseline.
  `workspace.issue_assigned` is said by DevHub's Issue assignment itself.
  `turn_ended` waits 1.5 s for the status to settle, and carries the id of
  the message that began the turn as `since` and the start of the last reply.
- **Timers** (`timers.ts`): `[[orchestrator.timers]]` are the defaults;
  `orchestrator timer set NAME INTERVAL | clear NAME` changes them for the
  session, and a settings change moves the ones nobody set by hand.
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
  `escalation show ID`;
- an agent in 不明 it has not been shown — acknowledged by `board`.

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
events = ["init", "escalation_answered", "unaccounted", "github.*",
  "workspace.issue_assigned", "workspace.pr_linked", "agent.turn_ended",
  "agent.asked", "agent.exited", "agent.failed", "timer.*", "custom.*"]
```

(so `agent.started`, `workspace.opened`, `workspace.closed`,
`workspace.branch_changed` and `agent.permission_requested` are left out).
They are in Settings ▸ General ▸ Orchestrator and validated with every other
setting.

## The command line

```sh
devhub --tell board [--json]                         # 要回答, 対応中, 不明 as data (acknowledges 不明)
devhub --tell escalation new --title T --body -|TEXT [--agent A]... [--link URL]... [--option TEXT]... [--workspace W]
                         [--priority high|normal|low] [--effort quick|normal|deep] [--rank-note TEXT]
devhub --tell escalation rank ID [--priority P] [--effort E] [--rank-note TEXT]   # re-rank; "" clears the note
devhub --tell escalation ask ID --body -|TEXT [--option TEXT]...   # back to 要回答
devhub --tell escalation show ID [--json]           # the thread (acknowledges the answer)
devhub --tell escalation list [--state needs_answer|in_progress|closed] [--json]
devhub --tell escalation close ID [--note TEXT]
devhub --tell escalation link ID --agent A
devhub --tell orchestrator start --root PATH --profile P --gui|--tui [--prompt -|TEXT]
devhub --tell orchestrator status [--json]          # its agent, state, lane counts, pause, GitHub polling
devhub --tell orchestrator stop | restart           # Stop Agent / Restart Session on it
devhub --tell orchestrator pause | resume          # pause suspends GitHub polling; resume catches up and delivers, as one message
devhub --tell orchestrator events [--last N] [--json]   # recent events and what came of them
devhub --tell orchestrator emit --type custom.NAME --text TEXT|-
devhub --tell orchestrator timer list | set NAME INTERVAL | clear NAME   # for this session
devhub --tell focus orchestrator                    # the only one that changes the screen
```

`orchestrator start` takes every choice as an argument, `--root` included
(the refusal names `orchestrator.root`); it opens the folder as a Workspace
unselected, starts the agent there unfocused, marks it `role=orchestrator`,
and sends it `init` (or `--prompt`). One orchestrator at a time.

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
  relayed to the agent and closed, 不明 is kept empty), the escalation
  principles and template below, how to keep work moving (no idle agent
  without a reason, `agent read --since`, permission prompts are the
  person's, no `focus` unasked), the CLI it uses, and an interview: the
  team's lanes, existing skills, review and "done", what it may decide alone
  (and where decisions are recorded), events, timers, naming and meta.
  Then it drafts make-progress — a dispatcher on each line's `[type]`, a playbook per
  event, the 不明 rule, escalation rules, a reconcile on `init` — shows it,
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
