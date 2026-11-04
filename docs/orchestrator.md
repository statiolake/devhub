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

### The board

- **要回答** — oldest question first, with how long it has waited. A ticket
  asked again after an answer carries 追加の質問.
- **対応中** — answered longest ago first, with how long since the answer.
- **不明** — see below.
- **Closed** — a toggle in the header shows the last 30.

Clicking a card opens it in place: the whole thread, drawn by the GUI
conversation's own Markdown renderer (code, tables, KaTeX math, Mermaid, SVG,
Vega-Lite — whatever a chat answer can show), the related agents (a click
shows that agent, to talk to it directly) and links, and the composer: free
Markdown, ⌘Return sends, and the question's options as quick replies. Esc
goes back to the board.

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

Events are how DevHub tells the orchestrator something happened. Each one is
rendered into `[orchestrator] event_prompt` (`{EVENT}` is replaced by the
event's description) and queued for the orchestrator agent as an ordinary
message from the person — the same queue `devhub --tell agent send` uses, so
it is held while the orchestrator is mid-turn and written when its turn ends,
one at a time, in order.

| event                 | when                                           |
| --------------------- | ---------------------------------------------- |
| `init`                | the orchestrator starts (`init_prompt` if set) |
| `escalation_answered` | the person answered an escalation              |
| `unaccounted`         | an agent entered 不明                          |

The description is short and names where to look, e.g.

```text
[event: escalation_answered] #12 「本番 invoices への列追加」 was answered by the person (now in progress).
Read it: devhub --tell escalation show 12
```

**Pause** (the switch in the board's header, or `orchestrator pause`) holds
every event, in order; **resume** delivers them all. Held events live in
memory: a quit drops them, and the next start's `init` sends the orchestrator
to the board anyway.

### The seam, for new events

`main/orchestrator/events.ts` is the one place events go through:

1. add a variant to `OrchestratorEvent` (`{ kind: "pr_review", … }`);
2. word it in `describeEvent` — the `[event: kind]` line and where to look;
3. call `orchestrator.events.dispatch(event)` where it happens (the
   controller holds the `OrchestratorService`, whose `events` is the
   `EventDispatcher`).

The dispatcher does the rest: pause, order, the prompt, delivery. A loop-style
orchestrator that waits instead (`agent wait --any`) is woken by the board's
own news below; an event that should wake it too needs a reason there as well.

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
```

`root` defaults to `~/orchestrator`. The window's **Start** makes the folder
(and its parents) when it is missing; `orchestrator start --root` on a command
line never does, and refuses a folder that is not there.

`event_prompt` can invoke a skill: `"/make-progress {EVENT}"`. They are in
Settings ▸ General ▸ Orchestrator and validated with every other setting.

## The command line

```sh
devhub --tell board [--json]                         # 要回答, 対応中, 不明 as data (acknowledges 不明)
devhub --tell escalation new --title T --body -|TEXT [--agent A]... [--link URL]... [--option TEXT]... [--workspace W]
devhub --tell escalation ask ID --body -|TEXT [--option TEXT]...   # back to 要回答
devhub --tell escalation show ID [--json]           # the thread (acknowledges the answer)
devhub --tell escalation list [--state needs_answer|in_progress|closed] [--json]
devhub --tell escalation close ID [--note TEXT]
devhub --tell escalation link ID --agent A
devhub --tell orchestrator start --root PATH --profile P --gui|--tui [--prompt -|TEXT]
devhub --tell orchestrator status [--json]          # its agent, state, lane counts, pause
devhub --tell orchestrator stop | restart           # Stop Agent / Restart Session on it
devhub --tell orchestrator pause | resume
devhub --tell focus orchestrator                    # the only one that changes the screen
```

`orchestrator start` takes every choice as an argument, `--root` included
(the refusal names `orchestrator.root`); it opens the folder as a Workspace
unselected, starts the agent there unfocused, marks it `role=orchestrator`,
and sends it `init` (or `--prompt`). One orchestrator at a time.

## `/devhub-orchestrator`: writing the person's make-progress skill

What the orchestrator does on each event is the person's own skill in
`root` (say `/make-progress`, invoked by `event_prompt = "/make-progress
{EVENT_JSON}"`). DevHub does not ship one — workflows differ — but it gives
the orchestrator agent, and no other agent, a skill for **writing** one:
`/devhub-orchestrator` (`main/orchestrator/orchestratorSkill.ts`).

- **What it says** (in Japanese): what a delivery carries (`init`, one message
  per delivery that may batch several events, `{EVENT}` and `{EVENT_JSON}`,
  held mid-turn and while paused, the `events` filter), the event types by
  family, what each lane asks of the orchestrator (要回答 waits, 対応中 is
  relayed to the agent and closed, 不明 is kept empty), the escalation
  principles and template below, how to keep work moving (no idle agent
  without a reason, `agent read --since`, permission prompts are the
  person's, no `focus` unasked), the CLI it uses, and an interview: the
  team's lanes, existing skills, review and "done", what it may decide alone
  (and where decisions are recorded), events, timers, naming and meta.
  Then it drafts make-progress — a dispatcher on `type`, a playbook per
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
