# GUI Agents

A GUI Agent is an Agent whose conversation DevHub draws itself, instead of
showing the CLI's own terminal screen. It is the same Agent in every other
respect: it is a tmux session, it lives through a DevHub restart, the sidebar
shows its status and unread mark, injections reach it through the same queue,
and Stop and close work as they do for a terminal Agent. What changes is what
runs inside the session and what the Agents page draws for it.

Only Claude Code and Codex can be GUI Agents, because only they have a
structured mode to talk to. Cursor and custom profiles are always terminals.

## Choosing a terminal or a GUI

Every Agent is launched as one or the other and stays that way. The choice has
three places, each overriding the one before:

- **The app-wide default.** `[agents] default_presentation = "tui" | "gui"` in
  `settings.toml` (Settings > General > Show agents as). Absent means `"tui"`.
  A kind that cannot be a GUI is a terminal under a `"gui"` default, with no
  error: the default is a preference, not a demand on every kind.
- **The profile's default.** `presentation = "tui" | "gui"` on an
  `[[agent_profiles]]` table. Absent means the app-wide default. A `"gui"` on a
  kind that cannot be one is refused as an invalid profile, at the key. A file
  older than version 3 wrote `presentation = "tui"` on every profile as a copy
  of the only default there was; that copy is read as absent, once.
- **This launch, the other way.** In New Agent (the sidebar's sheet, and the
  Agent step of the workspace picker) and in Assign Issue's agent step, each
  row says `GUI` or `TUI`. Holding ⌥
  flips it, and ⌥Return launches the Agent the other way. ⌘Return (beside the
  editor) combines with it. A kind with no GUI does not flip.

There is no switching an Agent between the two in place. "Continue in
terminal" (below) starts a new terminal Agent on the same session instead.

## What runs

A GUI Agent runs your own CLI, from the profile's `command`, in the structured
mode that CLI publishes for programs to drive it. DevHub starts it with the
profile's own arguments first and its own flags after them, so a
`--permission-mode` or `--model` you put in the profile still applies.

- **Claude Code**:

      <command> <profile args> -p --input-format stream-json
        --output-format stream-json --verbose --include-partial-messages
        --forward-subagent-text --replay-user-messages
        --permission-prompt-tool stdio

  `--bare` is never added: it makes the CLI read an API key only, and a GUI
  Agent runs on the same sign-in as a terminal Agent. DevHub then sends an
  `initialize` control request, and every message, answer, interrupt and
  setting change goes over stdin as stream-json.

- **Codex**:

      <command> <profile args> app-server

  and a JSON-RPC handshake over stdio: `initialize`, `initialized`,
  `account/read`, `thread/start` (or `thread/resume`), `model/list`.

`main/agent/conversation/claude/argv.ts` and `codex/argv.ts` hold these. The
[sources](#sources) are where each flag and message comes from.

## Why this is fine to use with your own subscription

DevHub drives the CLI you installed and signed in to. It adds nothing between
you and the vendor:

- **Nothing is bundled.** DevHub ships neither CLI. It starts whatever the
  profile's `command` names on your machine, unmodified.
- **No credential is touched.** DevHub has no sign-in screen and never reads,
  stores or forwards a token. Claude signs in through `/login` in its own
  terminal UI. Codex signs in through `codex login`, and DevHub never uses the
  app-server's token-passing sign-in (`chatgptAuthTokens`). When a CLI is not
  signed in, DevHub sends you to a terminal Agent to sign in there (see
  below).
- **No proprietary SDK.** DevHub does not depend on the Claude Agent SDK.
  That SDK is under Anthropic's Commercial Terms and ships its own copy of the
  Claude Code binary. DevHub speaks the CLI's stream-json directly, with its
  own types, written from the published shapes rather than copied from the
  SDK. Codex's protocol types are vendored from openai/codex, which is
  Apache-2.0, with its licence and notice.
- **Personal, interactive use.** Every turn is one a person typed, or a
  template injection they set up, in a UI they are sitting at.

What the vendors say about this:

- Anthropic's legal and compliance page says that OAuth sign-in "is intended
  exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise
  subscription plans and is designed to support ordinary use of Claude Code".
  It forbids third parties to "offer Claude.ai login into their own
  applications", to "route requests through Free, Pro, or Max plan
  credentials on behalf of their users", or to "collect, store, or
  intermediate Claude.ai credentials". It also states that this does not
  prevent "an end user from signing in to the unmodified Claude Code binary
  with their own Claude subscription". DevHub is that last case: your
  unmodified binary, your own sign-in, and nothing of the first three.
- Anthropic's Consumer Terms forbid access "through automated or non-human
  means, whether through a bot, script, or otherwise" unless explicitly
  permitted. DevHub's reading is that a person typing each turn in a UI is
  not automated access. That is an interpretation: no clause names this case.
- Codex is Apache-2.0. `app-server` is the interface OpenAI describes as what
  "Codex uses to power rich clients (for example, the Codex VS Code
  extension)". Its sign-in docs cover ChatGPT sign-in for the CLI. No
  statement was found that either allows or forbids another client driving
  `app-server` on a ChatGPT plan; the help-centre article on it could not be
  read. The risk is judged low, but that is a judgement, not a quote.

Keep it that way: don't bundle or patch either CLI, don't add a sign-in or a
token path to DevHub, and don't call DevHub's features by the vendors'
product names.

## The host, the journal, and restarts

The session's command is not the CLI itself but a small POSIX `sh` script, the
*host* (`main/agent/conversation/hostScript.ts`), which runs the CLI with:

- its **stdin** on a FIFO, `in`, that the host itself also holds open, so the
  CLI never sees end-of-file while DevHub is away;
- its **stdout** appended to a file, `out`, the *journal*. A write never
  blocks, whether or not DevHub is reading;
- its **stderr** appended to `err`, and its exit status written to `exit` when
  it ends.

The CLI runs beside the host rather than in its place, and its pid is in
`cli`. To rewind a Claude conversation, DevHub writes `again` (the CLI's
whole argv for the new start, which replaces the one the host was started
with) and `again.mark` (the line for the journal), then stops the CLI. The
host finds `again`, appends the mark to `out` and starts the CLI again. A host
started by a DevHub from before restarts has no `cli`, and one from before the
argv was given whole has no `version`; either refuses the rewind, and the
Agent has to be stopped and started again.

Every argv that picks a session is composed by one function, `withSession`
(`resume.ts`): Continue in GUI or in terminal, `/resume` and a rewind take
out every argument already picking one (`--resume`, `-r`,
`--continue`, `-c`, `--resume-session-at`, `--resume-drops-turn`, Codex's
`resume <id>` or `resume --last`) and put their own at the end. After a
continue the CLI is never started on two sessions at once, and a rewind
to the first message really starts a new session.

Everything DevHub writes goes through the FIFO and is also appended to
`in.log`, prefixed with the journal offset it followed. The files live in
`~/.devhub/agents-<profile tag>/<Agent id>/` on the machine the Agent runs on,
one directory per DevHub profile, so two DevHubs on one account never touch
each other's.

DevHub follows the journal with `tail` from a byte offset, through the
runtime's streaming channel (a pipe locally, `ssh -T` on the mux, `docker exec
-i`). When DevHub restarts, the host has not noticed: the CLI is still running,
possibly mid-turn. DevHub reads the journal from the start and replays each
`in.log` line where it was written, which rebuilds the same transcript: the
opening lines are not sent again, an open request stays open, and an answered
one is not answered twice. Then it follows the journal live.

- **Stop** kills the tmux session. The host leaves no `exit`, which is how a
  Stop is told apart from an ending.
- **The CLI ending on its own** writes `exit`. If DevHub did not cause the
  ending, a notice names the Agent, the exit code and the end of `err`.
- After either, DevHub removes the directory. A directory whose Agent this
  profile no longer has is removed by the startup sweep.

The page gets one normalized conversation, not the CLI's lines. The adapters
in `main/agent/conversation/{claude,codex}/` turn each line into events, the
one fold in `model/conversation.ts` builds the transcript, main keeps the true
copy, and the Agents page folds the same events with the same function.

The sidebar reads a GUI Agent's status from its conversation instead of its
screen:

| Conversation | Status |
|---|---|
| connecting | unknown |
| broken | error |
| a request waiting for an answer | waiting |
| a turn running | working |
| the last turn failed | error |
| otherwise | idle |

Unread, injections and the close question work exactly as for a terminal
Agent.

## What you can do in the GUI, and what you can't

The GUI draws the transcript and lets you:

- write messages at any time: while the Agent is busy they wait, and can be
  changed, removed or sent into the running turn (below);
- answer permission and question requests;
- interrupt a turn;
- rewind the conversation to before any of your messages (below);
- message a Codex subagent directly, where app-server allows it (below);
- change the model, effort and permission mode;
- use slash commands.

It covers what a turn does, not everything a CLI's own terminal UI has.

**Everything that is drawn**: Markdown with tables and code (coloured once
each block is complete), thinking folded, plans,
tool calls with their input and output or diff, subagents nested under the
call that started them, notices, turn ends with duration and cost, usage and
rate limits in the header, and pending requests as cards with the CLI's own
choices.

**Reading and copying.** The transcript is text: you can drag-select any of
it — answers, code, tool output, a subagent's work — and copy it with Cmd+C.
Every message also has a quiet Copy action under it, always shown, and every
code block has one in its header.

**Settings in the composer.** Model, Effort and Permissions sit under the
message box at the same size as what you type. A value the CLI has not named
yet says so instead of standing empty: Claude names its model only when the
first turn starts (its `system/init`), so until then the model reads *Not
known yet*; an effort nothing has chosen reads *Default*, the CLI's own
(Claude never reports the effort it runs at). Codex names its model and
effort when the thread opens, and a model you pick here shows that model's
default effort until you choose one.

**Context.** The header's usage line starts with how full the context window
is, *Context 45% (90k of 200k)*, with a thin meter. Claude's figure is the
latest top-level message's tokens (input, cache and output), known as soon as
that message arrives, against the context window the turn's `result` reports
for the model; before the first turn ends it reads only the tokens. Codex's is
`thread/tokenUsage/updated`'s last total against its model context window.

**Subagents.** A subagent is a card under the call that started it, with its
work inside. A Codex subagent is running while its thread has a turn running
and finished when that turn ends, whether or not app-server also sends a
`subAgentActivity` item about it. A Claude subagent is running from its call
until its end is told: its call's result, for one run in the foreground; a
task notification, for one started in the background (whose call's result
only says it launched) — a `task_notification` event in stream-json, or a
`<task-notification>` message in the session file, matched by the call's id
or else the task's. A subagent runs only inside the CLI process that started
it: one read back from a session file, or left running when the CLI is
started again (rewind, `/resume`), is *Unknown* unless its end was recorded.
Any other background task a call started (a command run in the background)
follows the same news, told as one quiet line on that call (*In the
background: Done — its summary*); only a notification no drawn call started
is a notice. Its work is drawn in one place at a time:

- When the pane is wide (1040 px or more), a running subagent moves to a
  column on the right, subagents stacked one above another, and goes back to
  its card when it finishes. *Beside* on a card puts a finished one there,
  *Close* on a pane takes one back; once you have done either, your choice
  stands.
- *Maximize* fills the pane with one subagent's transcript. A switcher bar
  under it moves between the conversation and each subagent (arrow keys move
  along it), and the composer still talks to the conversation.
- When the pane is narrow there is no column: a subagent is in its card or
  maximized, and the switcher bar is shown whenever there is a subagent.
- The waiting line over the composer finds a request card wherever it is,
  switching back to the conversation if the card is there.

**Claude Code: what does not come across**

- Terminal-only commands. `/login` and `/logout` are not offered. `/model`,
  `/effort` and `/permissions` open the composer's pickers instead of being sent.
- The terminal UI's own screens: the interactive `/config` and the
  folder-trust dialog. `/resume` is DevHub's own picker instead (see
  [Resuming an earlier session](#resuming-an-earlier-session)) (see [Folder trust](#folder-trust-hooks-and-mcpjson-run-without-asking)).
- Hook events. `--include-hook-events` is not passed, and hook events that
  arrive anyway are known and not shown.
- `tool_progress` and `prompt_suggestion`.
- Thinking the API withholds (it sends the block without its text), redacted
  thinking, citation deltas, and images inside messages.

**Codex: what does not come across**

- Only `/model`, `/effort` and `/approvals` are offered as commands. They open
  the composer's pickers. Codex has no protocol-level slash commands, and review,
  compact and diff are not wired yet.
- Permission modes are the terminal UI's presets: Read only, Auto and Full
  access (an approval policy and sandbox pair each).
- Not drawn:
  - the whole-turn diff (each file change shows its own);
  - the thread list, archive, rename, goals, queue, projects and environments;
  - skills changes;
  - hooks;
  - automatic approval review;
  - raw response events;
  - MCP server status, events and progress;
  - `command/exec` output.
- A request DevHub does not handle is answered "cannot", and a notice says so.

**Both CLIs**

- No images can be sent yet.
- An event DevHub has never heard of is not dropped. It appears in the
  transcript as a warning notice with the event folded under it, and the
  conversation goes on.
- A known event whose shape DevHub does not accept stops the conversation as
  *protocol mismatch*, naming where in the line it went wrong and the CLI's
  version. The transcript up to that point stays readable. This usually means
  the CLI was updated past what DevHub knows.

## Messages that wait, and sending one into a turn

A message you send while the Agent is idle is written to the CLI at once. One
you send while it is busy (a turn running, a request waiting, the CLI still
connecting or being started again by a rewind) waits instead. Waiting messages
are listed over the composer, oldest first. The Agent has not seen them yet,
so each one can be:

- **edited** in place (Enter saves, Esc gives up), the caret at the end of
  its words. While the editor is open the message is not sent, and neither is
  anything behind it: when a turn ends meanwhile, the next turn waits. Saving
  sends the new words in their turn; giving up sends the old ones. Closing
  the pane or the page with the editor open gives the edit up;
- **removed**, so it is never sent;
- **sent now**, into the running turn, instead of waiting for it to end.

When a turn ends, the oldest waiting message is sent and starts the next
turn, and the rest keep waiting for their turn. If writing one fails, it stays
in the list with the reason, and is sent when you press Send now.

"Send now" is the same action for both CLIs:

- **Codex**: `turn/steer` with the running turn's id (`expectedTurnId`).
  The message joins that turn, as typing during a turn does in Codex's own
  terminal UI.
- **Claude Code**: a stream-json user message with `priority: "next"`. The
  CLI takes it into the running turn at its next step, between tool calls,
  and does not stop the turn. `now` would stop the turn and `later` would wait
  for it to end. When `priority` is left out, the CLI assumes `next`. The
  field is in the CLI's input schema, but Claude's docs don't describe it.

Waiting messages live in DevHub, not in the CLI or the journal. **If DevHub
quits while a message is waiting, the message is lost.**

## Rewinding to an earlier message

Each of your messages has a **Rewind** action beside Copy while nothing is
running and nothing is waiting. It asks first. Rewinding drops that message
and everything after it from the conversation, and puts the message's words
back in the composer, ahead of anything you had typed. Template messages
can't be rewound to. While a turn runs there is no Rewind: stop the turn
first. A rewind that can't be done is refused with the reason.

**Files are not changed back.** Rewinding changes only the conversation.
Files the Agent edited and commands it ran after that point stay as they are.
Rewind says so before it does anything.

How each CLI takes turns back:

- **Codex**: `thread/revert` with the turn the message started
  (`beforeTurnId`), which drops that turn and every later one. A thread is
  cut by turns, so only a message that started a turn can be rewound to. A
  message sent into a running turn has no Rewind. This works only on a
  paginated thread, which is what `thread/start` makes by default
  (`thread.historyMode`). On a legacy thread (an old one resumed) there is no
  Rewind. When app-server refuses, a notice says why and nothing is dropped.
  (`thread/rollback` was removed from app-server; `thread/revert` replaces
  it.)
- **Claude Code**: stream-json has no documented way to take turns back, so
  the host starts the CLI again on the session cut after the message before
  yours: `--resume <session> --resume-session-at <that message>`. This is the
  flag behind the Agent SDK's `resumeSessionAt`, and it drops everything after
  the cut. DevHub doesn't pass `--resume-drops-turn` (the SDK's
  `resumeDropsTurn`). That flag names the one turn a cut is meant to drop, and
  the CLI refuses a cut that drops content from any other turn. A rewind
  deliberately drops every later turn. Rewind needs Claude Code 2.1.223 or
  later, the version that has `--resume-drops-turn`; an older CLI has no
  Rewind. If your message was the first one, there is nothing to resume, and
  the CLI starts a fresh session instead, with a new session id.

The host writes a line of DevHub's own, `devhub_rewind`, into the journal
between the old CLI's output and the new one's. A DevHub that restarts reads
the journal the same way and gets the same shortened transcript.

## Messaging a subagent

A subagent has a message box of its own when its CLI lets you talk to it
directly. The box goes with its work: under it in the card, or under its pane
when it is in the column beside the conversation or filling the pane. What you
send there goes to that subagent, not to the Agent that
started it. It joins the subagent's running turn, or starts a new turn if it
has none.

- **Codex**: a subagent is a thread of its own, and `turn/start` and
  `turn/steer` take any thread's id. DevHub offers the box only when
  app-server's `thread/started` for that thread says `canAcceptDirectInput:
  true`. Codex's own terminal UI uses the same field to decide whether a
  subagent takes input. The field is not in the pinned protocol schema, and
  a thread that doesn't mention it gets no box. Whether a real multi-agent
  subagent says true hasn't been seen yet: DevHub has been checked only
  against a hand-written fixture.
- **Claude Code**: no box. The Agent messages its own subagents with its
  `SendMessage` tool. stream-json has no input that reaches a subagent: a
  user message's `parent_tool_use_id` names where output came from, not where
  input goes, and no control request addresses a subagent.

## Not signed in, and Continue in terminal

When the CLI is not signed in, the conversation stops and the Agent's pane
says so:

- Claude reports it on its first answer (`authentication_failed`).
- Codex reports it at `account/read`.

The pane then offers **Open a terminal to sign in**, which starts a terminal
Agent from the same profile. Run `/login` (Claude) or `codex login` there,
then start a new GUI Agent. DevHub never signs in on your behalf.

**Continue in terminal** is the way out of a GUI Agent:

- It is a small floating button at the right of the conversation's column,
  just above the composer (left of the subagent column when one is open),
  translucent until it is pointed at or focused (the same rule as
  the Agent shortcuts). It is also on the failure over the pane when the
  conversation broke (the host was lost, a protocol mismatch, or the CLI
  refused to start).
- It starts a terminal Agent from the same profile, resuming the same
  session: `claude --resume <session id>`, or `codex resume <thread id>`.
- It selects that Agent, and stops the GUI one once the new one is running.
- If the conversation has no session yet, it is refused with the reason. If
  the new Agent fails to launch, the GUI Agent keeps running.

**Continue in GUI** is the mirror, for a terminal Claude or Codex Agent: a
floating button in the top right corner of its pane (the bottom right is the
shortcuts'). It starts a GUI Agent from the same profile resuming the
terminal's session, selects it, and stops the terminal Agent once the GUI one
is running and written down; a launch that fails leaves the terminal running.
Which session the terminal is in is found from the Agent's own processes:
the one tmux runs in its pane (`#{pane_pid}`, read with the Agent id the
session carries) and every one under it, read on the Workspace's machine with
`ps` (or `/proc` where there is no `ps`). Another terminal of the same CLI in
the same Workspace is never taken for it.

- **Claude** keeps a record of each process it runs as,
  `<config>/sessions/<pid>.json` (`~/.claude`, or `$CLAUDE_CONFIG_DIR`),
  whose `sessionId` is the session on screen: Claude 2.1.282 writes it at
  start, rewrites it whenever the session changes inside the terminal
  (`/clear`, `/resume`), and removes it on exit. The outermost Claude under the pane is the Agent's (a
  Claude it runs is under it). As a second source, a terminal Claude Agent is
  started with a `SessionStart` hook, given through `--settings` (added to
  your settings, not in place of them), which copies what Claude hands the
  hook into the Agent's own directory
  (`~/.devhub/agents-<tag>/<agent id>/claude-session`); it fires on start,
  on `--resume`, on `/clear` and on `/resume`, and prints nothing. The
  process's record is used when there is one, the hook's when there is not.
  Both there and naming different sessions is refused, naming both; neither
  there (a Claude that keeps no such record, and hooks turned off or an Agent
  started before DevHub gave it the hook) is refused, saying where DevHub
  looked.
- **Codex** has neither, so it is the rollout the Agent's Codex holds open
  (`/proc/<pid>/fd`, or `lsof`): the file of the thread it is writing,
  `rollout-<time>-<thread id>.jsonl`, whose first line says what started the
  thread. Only its terminal mode's (`source` `cli`) counts, not a subagent's.
  Codex keeps a thread it has left open too, so when it holds several, the
  one written last is taken: a thread switched to with `/new` or `/resume`
  counts from its first turn. A Codex that holds none (no turn yet) is
  refused.

Not adopted, and why: `claude --session-id <uuid>` names the session at
start only and not after `/clear` or `/resume`, which the process's record
follows anyway; no variable in the TUI's own environment names it (Codex
sets `CODEX_THREAD_ID` for the commands it runs, and the environment another
process can read, as `ps -E` shows it, is the one the TUI started with, which
cannot follow `/clear`); the newest session file of the directory, or
Codex's newest `cli` thread in it, belongs to whichever terminal wrote last,
not to this Agent.

## Resuming an earlier session

An earlier session is taken up in two ways: **Continue in terminal** and
**Continue in GUI** (above) start a new Agent on the session the first one is
in, and **`/resume`** inside a GUI Agent (below) has that Agent go on with
another session. New Agent starts afresh only.

A launch that resumes is an ordinary launch whose arguments end with the
terminal mode's resume: `--resume <session id>` or `resume <thread id>`. They
are part of the Agent's recorded profile, so a restart of DevHub knows what
it resumed.

- **Claude GUI** runs `claude --resume <id> -p …` in stream-json. stream-json
  prints nothing of the past, so DevHub reads the session's file at launch
  and writes its conversation at the head of the journal, before the CLI
  starts, as `devhub_history` lines: the chain of messages from the last one
  back to the first (a rewound branch and a subagent's lines are not part of
  it; across a compaction the earlier messages are). A record's parent is the
  last line above it with that uuid: Claude writes some records twice under
  one uuid, and a parent always comes before its child. The adapter draws them as
  the entries a live turn makes, without a turn running. The task
  notifications Claude recorded (as user messages or queued commands) come
  along, and end the tasks they name; they are nobody's words and draw no
  message.
- **Codex GUI** has no argument for it: DevHub takes `resume <id>` off the
  argv and sends `thread/resume` instead of `thread/start`. Its answer carries
  the thread's turns, which are drawn as the conversation.

A session that is not there (Claude's file is missing) refuses the launch
with the path.

`/resume`'s sheet lists the CLI's own sessions, read on the Workspace's
machine:

- **Codex**: `thread/list` on a short-lived `codex app-server`, filtered to
  the Workspace's directory (`cwd`), sorted by `updated_at`.
- **Claude** has no listing command. It keeps each session as JSONL under
  `~/.claude/projects/<the directory, every non-alphanumeric character as
  ->/` (or under `$CLAUDE_CONFIG_DIR`, from the profile's environment or the
  machine's). DevHub reads the newest 50 files there and never writes to
  them. A title is Claude's own `ai-title` when there is one.

A listing that fails says why in the sheet instead of showing an empty list.
The sheet lists **This project** first; **All projects** lists every
directory's sessions, as the CLIs' own pickers do: every
`<config>/projects/*` directory for Claude (newest 50 files across them, by
modification time), and `thread/list` without `cwd` for Codex. Claude resumes
a session only in the directory it ran in (its file is kept under that
directory's name), so another directory's session is listed with that reason
and cannot be taken; Codex resumes a thread in whatever directory it is given,
so every thread can. Beside the list, the highlighted session's last few
messages are previewed: the last 256 KiB of its file (Claude's session file,
or Codex's rollout, found by its thread id under `$CODEX_HOME/sessions`),
read when the pointer or the arrows rest on the row, and kept while the sheet
stands. Only the person's words and the answers are shown, not tools.

**`/resume` inside a GUI Agent** opens that sheet for the Agent's
Workspace, and the chosen session is carried on by this Agent, in place of
the one it is in (which is left as it is, and can be resumed again). Typed out
whole and sent, or picked from the completions, it is DevHub's command and
nothing is sent to the CLI. It is refused while a turn runs or a request is
open.

- **Claude**: the host starts the CLI again on `--resume <id>`, in place of
  whatever session its launch picked (the mechanism a rewind uses). The mark it puts in the journal between the two
  CLIs is `devhub_resume` followed by the session's past as `devhub_history`
  lines, read from its file before the CLI is touched, so a session that
  cannot be read back is refused and the running one goes on. The adapter
  drops what the conversation held (`session-switched`), draws the past, and
  greets the new CLI.
- **Codex**: `thread/resume` for the other thread on the same app-server. Its
  answer replaces the conversation with that thread's turns, and the next
  turn starts on it. A refusal is a notice, and the conversation stays where
  it was.

Either way it is in the journal, so a restart of DevHub replays to the same
conversation. The Agent's recorded profile still names what it was launched
with; the conversation's session is the one Continue in terminal resumes.

## Folder trust: hooks and `.mcp.json` run without asking

`claude -p` does not show the folder-trust prompt that interactive `claude`
does. **A GUI Claude Agent runs the Workspace's project hooks and starts the
servers in its `.mcp.json` without asking.** DevHub adds no prompt of its own
in this version, on the grounds that a Workspace is a folder you opened
yourself. If you open a repository you do not trust, start its Agent as a
terminal (⌥Return), where Claude asks first.

## Permissions follow your Claude settings

A GUI Claude Agent asks what your Claude settings say it should ask, like the
terminal UI does. DevHub only answers the requests the CLI sends. If your
`permissions.defaultMode` is `auto`, for example, Claude approves many tool
calls itself, and no permission card appears for them, in the GUI as in a
terminal. The composer's Permissions picker shows the mode the session reports
and changes it for this session.

## What has been checked against the real CLIs

- **Claude Code** (claude 2.1.281):
  - The adapter is tested against a scrubbed capture of a real session through
    DevHub's host (`fixtures/claude-session.capture.ndjson`). It covers:
    - the handshake;
    - a Markdown answer with a table and TypeScript;
    - a Bash call;
    - `set_model` and `set_permission_mode`;
    - an Agent-tool subagent running in the background, whose Bash call raised a
      real permission request after the turn had ended, answered Allow once;
    - the turn the CLI then started on its own;
    - thinking the API withheld.
  - The page's rendering of that capture is tested too.
  - A live pass in DevHub with the real CLI drew and copied that kind of answer,
    nested a subagent, and brought the conversation back unchanged after a
    DevHub restart, sending the CLI nothing again.
- **Codex** (codex 0.156.1):
  - Only the real `app-server` handshake and the not-signed-in path have been
    checked against the real CLI, from a signed-out capture
    (`codex/fixtures/signed-out.capture.ndjson`).
  - Turns, approvals, subagents and everything else are tested only against
    fixtures written by hand from the vendored 0.156.1 protocol types. Expect a
    protocol-mismatch notice where the real CLI differs.
- **Dev Container Agents** have been checked with a packaged DevHub
  (the 037e351 nightly), a `mcr.microsoft.com/devcontainers/base:ubuntu`
  container and the fake agent. Checked for a Claude and a Codex fixture:
  - the host runs in the container under DevHub's own tmux, and main follows
    its journal through `docker exec -i`;
  - the handshake reaches ready;
  - a turn with its permission cards is answered;
  - the conversation comes back unchanged after a DevHub restart, with nothing
    sent again;
  - Stop removes the host directory in the container.

  The profile's command is looked up on the Workspace's own machine
  (`Runtime.resolveProgram`, `command -v` there). This was checked with the
  2fbeb2c nightly and a command that exists only in the container
  (`/workspaces/ws/fake-agent.sh`). A command that is missing in the container
  fails only that launch, with "The agent could not start from this profile."
  and where it looked; the Workspace and its other Agents stay usable. (The
  first check, on 037e351, predated this and needed a path that existed on
  both sides.)

  A source run cannot start an Agent in a container at all. It has no commit,
  so it can install nothing there, tmux included.
- **SSH Agents** have not been checked on a real remote host.

## Usage limits in the Sidebar

The foot of the Sidebar says how much of Claude's and Codex's rate limits is
used (`Claude 42% · Codex 17%`): for each CLI, its window nearest the limit,
the one that stops it first. The tooltip lists every window each CLI reports —
Claude's five-hour and seven-day (`unifiedWindows` of its `rate_limit_event`),
Codex's `primary` and `secondary`, named by their length (`5-hour`, `7-day`) —
with how much is used and when it resets. DevHub does not ask the accounts:
the numbers are what running GUI Agents last reported — Claude's
`rate_limit_event`, Codex's `account/rateLimits/updated` — kept per window of
each CLI in main, the newer of two readings of a window being the one with the
later reset (or, for the same reset, more used), since journals replay in no
particular order at startup. A report that leaves a window out (Codex's sparse
updates) keeps that window as last seen. A CLI no GUI Agent has reported for
says so in the tooltip rather than showing zero, and while neither has
reported nothing is drawn. The conversation header reads the same way: the
session's window nearest its limit on the line, every window on hover.

## Known limits

- **`claude -p` may start defaulting to `--bare`**, which reads an API key
  only. Anthropic has announced it. DevHub never passes `--bare`, but if the
  default flips, it will need a way to opt out.
- **`--permission-prompt-tool stdio`**, the flag that routes permission
  requests to DevHub, is what the Agent SDK passes, but the CLI's own docs do
  not list it.
- **`codex app-server` is marked experimental** by OpenAI, and its schema
  changes between versions. DevHub's types are pinned to one version
  (`codex/protocol/`, regenerated by
  `apps/desktop/scripts/vendor-codex-protocol.mjs`). Whether every profile
  argument is accepted before `app-server` is not yet verified.
- **busybox `tail -f` polls once a second.** On a host with busybox, a
  NAS for example, streaming arrives in one-second steps. The BSD tail on macOS
  and GNU tail are immediate.
- **Rewinding does not change files back.** Neither CLI's way of
  taking back turns touches the working tree. Claude Code's file
  checkpoints (`--rewind-files`, the SDK's `rewindFiles`) have to be turned on
  when the session starts, and DevHub does not turn them on.
- **Rewinding a Claude conversation restarts the CLI.** MCP servers and background
  tasks start again with it. Right after a compaction, the resume point is
  the last message DevHub saw before it, not the compaction summary.
- **The journal is never trimmed.** Partial messages are journaled too, so a
  long session's `out` can reach tens of megabytes, and a restart reads all of
  it once.
- **Resuming a Claude session reads its file's format**, which Claude does not
  document: the directory naming, the record fields, `parentUuid` chains.
  A very long directory name, which Claude shortens with a hash, is not
  found; a session file over 32 MiB is refused rather than read in part.
  Past turns show no usage (neither CLI hands it back), and a Claude history
  has no turn endings between its messages.

## Troubleshooting

- **The pane says "Connecting to the Agent…" and stays there.** The sidebar
  shows the Agent as unknown. Check whether its host is alive: its tmux
  session is on the profile's socket (`tmux -L devhub ls` for the installed
  app, `devhub-<profile>` for another profile), and
  `~/.devhub/agents-<tag>/<id>/` has `pid` and no `exit`. A host that is gone
  is reported as the Agent ending. A live host that DevHub cannot follow
  should be reported over the pane as the host being lost. If it is not,
  that is a bug: report it with the host directory's file listing. Continue
  in terminal still works, because the session is in the CLI's own storage.
- **"Protocol mismatch".** Note the path and CLI version in the detail, and
  use Continue in terminal to keep working. Updating DevHub, or pinning the
  CLI to the version DevHub knows, fixes it.
- **A warning notice about an event DevHub does not know.** Nothing is wrong
  with the conversation. The notice carries the event as the CLI printed it,
  which is what a bug report needs.
- **The Agent ended by itself.** The notice has the exit code and the end of
  `err`. A CLI that is not on the host's `PATH` shows up here as `command not
  found`, exactly as it would for a terminal Agent.
- **For a bug report,** the host directory has everything: `out` is what the
  CLI printed, and `in.log` is what DevHub wrote. **Both contain the
  conversation**: your messages, file contents and command output. Read them
  before sharing them.

## Sources

What this page says about the transports and the terms rests on these,
read on 2026-09-25:

- Claude Code headless mode and CLI reference —
  <https://code.claude.com/docs/en/headless>,
  <https://code.claude.com/docs/en/cli-reference>
- Claude Agent SDK overview and licence —
  <https://code.claude.com/docs/en/agent-sdk/overview>
- Anthropic legal and compliance, authentication and credential use —
  <https://code.claude.com/docs/en/legal-and-compliance>
- Anthropic Consumer Terms — <https://www.anthropic.com/legal/consumer-terms>
- Claude Code 2.1.282's own `--help` text for `--resume-session-at` and
  `--resume-drops-turn`, and its stream-json input schema (`priority`:
  `now`, `next`, `later`; `next` when absent), read from the installed CLI
- A terminal session's own record, observed on 2026-09-26 with a scratch
  config directory and no prompt sent: Claude Code 2.1.282 run in tmux wrote
  `<config>/sessions/<pid>.json` (`pid`, `sessionId`, `cwd`, …) at start,
  rewrote its `sessionId` on `/clear`, and removed it on exit; `--session-id`
  was reflected in it. Codex 0.154.0's TUI, run as `codex resume <id>`, held
  the thread's rollout open (`lsof`) and still held it after `/new`
- Codex's terminal UI, `codex-rs/tui/src/app_server_session.rs`
  (`thread_blocks_direct_input`, `canAcceptDirectInput`) at `rust-v0.156.1`
- Claude Agent SDK TypeScript reference, `resumeSessionAt`,
  `resumeDropsTurn`, `forkSession`, `enableFileCheckpointing` —
  <https://code.claude.com/docs/en/agent-sdk/typescript>
- Codex app-server `thread/revert` and the removal of `thread/rollback`:
  `codex-rs/app-server/README.md` and
  `app-server-protocol/schema/typescript/v2/ThreadRevertParams.ts` at
  `rust-v0.156.1` in openai/codex
- Codex app-server and authentication —
  <https://learn.chatgpt.com/docs/app-server>,
  <https://learn.chatgpt.com/docs/auth>
- openai/codex (Apache-2.0) — <https://github.com/openai/codex>
