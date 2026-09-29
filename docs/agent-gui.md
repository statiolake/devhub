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
  row — a new session or an earlier one — says `GUI` or `TUI`. Holding ⌥
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
| a turn running (from the write of a message until the CLI ends the turn that answers it) | working |
| a message DevHub holds at the prompt | waiting |
| the last turn failed | error |
| something it started still working in the background | background |
| otherwise | idle |

*Background* is an Agent whose turn is over while a command it ran in the
background, a subagent it started in the background or a teammate at work is
still going. It is neither idle nor working, and it has its own quiet mark in
the Sidebar (the working ring broken into four still arcs, in a quieter
yellow). Each thing that reads a status treats it on purpose:

- **Stop, Continue and closing the workspace ask first**, as for a working
  Agent (`agentIsIdle` counts only idle): stopping the CLI stops what it left
  running.
- **An injection is sent into it**, as into an idle Agent (`agentAtPrompt`):
  the CLI reads a message then and starts a turn with it, as it would the
  person's own, and the tasks go on untouched. Holding it until they end would
  hold it for good behind a dev server or a watcher, which never end on their
  own.
- **Unread** is raised when a turn ends into it (leaving `working`), and the
  row wears the unread mark until somebody looks, as an idle one does.
- **The Sidebar's activity line** names the one task, or says how many there
  are.

A terminal Agent is never *Background*: its screen does show Claude's
background shells and agents (a `· 1 shell ·` in the footer, one line per
agent under it), but DevHub has no capture of a prompt at rest with them
showing to write a rule from, so its status reads the screen as before.

Unread, injections and the close question otherwise work exactly as for a
terminal Agent.

**Find (Cmd+F).** Cmd+F anywhere in a GUI Agent's pane — the composer
included, and with the keyboard nowhere in particular, as after a click on the
transcript's words, which leaves it on the page's body — opens a small find bar at the top right of the conversation, under
the Continue button: a field, *3 of 12*, *Aa* (match case), ↑ ↓ and ×. Return
and Shift+Return in the field, and F3 and Shift+F3 anywhere in the pane while
the bar is open, go to the next and the previous match, around the ends; Cmd+F
again puts the keyboard back in the field with its words selected; Esc closes
it and gives the keyboard back to where it was (a running turn is not stopped
by that Esc). A query starts at its last match, the one nearest the end of
the conversation, since a search usually goes back up from the latest words:
Shift+F3 goes up from there, F3 goes down and round to the first. The matches
on view are marked, the current one more strongly
(the CSS Custom Highlight API, so the document React draws is not touched),
and the current one is brought into view.

The count is exact however large — a one-letter query over a long session
finds millions — and never holds up the page: the search runs in slices of a
few milliseconds, one task each, so typing, scrolling and streaming go on
between them. It searches from the bottom up, so the last match is current as
soon as it is found and the count grows above it (*120,000 of 120,000…*,
*Searching…* before the first found), a new keystroke drops the running search, and ↑ ↓ step
through the matches found so far. A match is kept as its offset in its
entry's text, not as a live `Range` (the page keeps every live range up to
date on each change to its text); ranges are made only for the matches
within a screen of the view, again as it scrolls or changes size.

It searches what the pane shows — the conversation, or the subagent that
fills the pane — and says which; subagents in the column beside it are not
searched. What it searches is the drawn transcript's words: the person's
messages, the Agent's answers as their Markdown is drawn, tool titles, the
readable views (diffs, checklists) and the input and
output folded inside each tool call. Buttons and what is drawn for the eye
only (a diff's line numbers) are not, and a match does not run from one block
into the next. This works because nothing that folds leaves anything out of
the document: a closed tool call keeps its input and output in its
`<details>`, the `Clip` keeps a long readable view's end, and a long message
not from the person keeps its lines past the fold `hidden`. A match that
becomes current inside a fold opens it — each `<details>` around it, and the
`Clip` or the long message, which open on the find bar's reveal event. The
count follows the conversation as it streams — only the entries added or
drawn again are searched again — and the current match stays where it was.

The keys reach the page untouched: main's chord layer claims only its prefix
(Cmd+Q) and the chords after it, the editing keys on DevHub's own chrome and
the Agent panes' zoom, none of which is Cmd+F or F3. In a terminal Agent's
pane the keys stay as they were: Cmd+F does nothing (xterm sends nothing for a
Command key and DevHub adds no search there), and F3 goes to the program in
the terminal as its escape sequence.

**Background tasks.** Under the composer, beside the context readout, a quiet
line says what the Agent has working in the background — *2 background
tasks · Start the dev server, Research the parser* — while anything is.
Opened, the list takes the composer's whole width under that row, and gives
each task the glyph a running tool call has, its title and its kind
(*shell*, *subagent*, *teammate*, or the CLI's own name for another kind). A
task whose call is known opens it, by one rule in a narrow pane and a wide
one: a subagent (or teammate) fills the pane, with ← back to the
conversation in its header; any other task's call is brought into view in
the conversation, opened, switching back from a maximized subagent first. A
task leaves the list when it ends. The list is
`Transcript.backgroundTasks`, the adapter's one account of it:

- Claude: the CLI's own list, `system/background_tasks_changed`, which it
  prints whole each time it changes (commands run in the background and
  subagents started in the background, a subagent's own included). A task is
  tied to its call by the `task_started` that names both, or the call's
  result that names the task; until then it has no call. Each running
  teammate the list does not name is added, and a subagent that sits idle is
  left out. The list ends with the CLI: a rewind or `/resume` empties it
  before anything is taken back.
- Codex: each subagent whose thread is running. app-server reports no end for
  a command it keeps running after its call has returned (a background
  terminal), so those are not listed.

**Stopping a background task.** Each task in the opened list has a stop
button at its right end. Pressed, it asks once more under the task, as Rewind
does — *Stop this background shell? The command it's running will be
terminated.* for a shell, *Stop this subagent? Its work so far stays, and it
won't resume on its own.* for a subagent — and only then asks the CLI (the `stop-task` command). Nothing is
taken off the list on DevHub's say-so: the task leaves when the CLI's own
account says it ended, and a CLI that refuses says so in an error notice
(*stop_task was refused: …*, *codex did not stop the subagent: …*). Whether
a task can be stopped is the adapter's to say (`RunningTask.stoppable`); one
that cannot has its button greyed, the tooltip saying why:

- Claude: every task the CLI lists is stopped with the documented control
  request `{subtype: "stop_task", task_id}` (the Agent SDK's `stopTask`), which
  the CLI answers with a `task_notification` of status `stopped` and a new
  `background_tasks_changed`. A teammate DevHub adds to the list is not one
  of the CLI's tasks, and `stop_task` is not documented for it: its button is
  greyed, *A teammate can't be stopped from here.*
- Codex: a subagent is stopped with the stable `turn/interrupt` on each of
  its threads that runs a turn; it leaves the list when that turn ends. Until
  app-server has said which turn a subagent runs, there is nothing to
  interrupt and its button is greyed. A background terminal could only be
  stopped with the experimental `thread/backgroundTerminals/terminate`, which
  DevHub does not use; those are not listed anyway.

Each task in the opened list says how long it has run, ticking, as the CLI
says it (*45s*, *3m 12s*, *1h 5m*). The start is the time the CLI itself
wrote on the call that started the task, so a replay after a DevHub restart
reads the same start from the journal: Claude's `timestamp` on the
assistant line that carried the call, Codex's `startedAtMs` on the call's
`item/started`. A task not yet tied to its call, or whose call carries no
time, says no time rather than one DevHub made up. The time is the clock of
the machine the CLI runs on, so an Agent on another machine whose clock is
off reads off by as much.

## What you can do in the GUI, and what you can't

The GUI draws the transcript and lets you:

- write messages at any time: while the Agent is busy they wait, and can be
  changed, removed or sent into the running turn (below);
- attach images to a message by pasting or dropping them (below);
- answer permission and question requests;
- interrupt a turn;
- rewind the conversation to before any of your messages (below);
- message a Codex subagent directly, where app-server allows it (below);
- change the model, effort and permission mode;
- use slash commands.

It covers what a turn does, not everything a CLI's own terminal UI has.

**Everything that is drawn**: Markdown with tables and code (coloured once
each block is complete), thinking folded, plans, a compaction as a divider
across the transcript (*Conversation compacted · auto · from 150,000
to 12,000 tokens*; Codex's too) and, while the CLI is compacting, a dashed
line at the end, *Compacting the conversation…*, that the divider takes the
place of once it is done (Claude's `system/status` `compacting` until its
`compact_boundary`, a `status` that says otherwise, or the turn's end; a
`compact_result` of `failed` is an error notice with `compact_error`; Codex's
`contextCompaction` item from `item/started` to `item/completed`),
tool calls with their input and output, subagents nested under the
call that started them, images, notices, a turn that was interrupted or failed (with
the CLI's reason), how full the context is under the composer, and pending
requests as cards with the CLI's own choices. A turn that completed draws no
divider, and no durations, token counts or cost are drawn anywhere: the rate
limits are the Sidebar's (below).

**Type follows the terminal.** The transcript's text is a step larger than
`[appearance] terminal_font_size` (15 px at the default 13) and zooms with the
terminal. Everything fixed-width — code blocks and inline code, diffs, a
command and its output, a tool's input and output — is set in
`[appearance] terminal_font_family`, the same family an Agent's terminal draws
with (Settings > General > Agent panes > Font), followed by the system's
monospace faces for anything it lacks. There is no separate setting: it is
DevHub's one monospace face, so the ids in a failure and the fixed-width fields
in Settings follow it too, and a change to it reaches an open conversation
without a reload.

**A tool call's state** is the glyph at the left of its row: a spinner while
it runs, ✓ done, ✕ failed or denied, – interrupted, ◦ idle, ? unknown. The
glyph carries the word as its accessible name and tooltip, and the right of
the row says only what the glyph cannot: *In the background*, a command's
*Exit code N*, *Denied*, *Interrupted*, *Idle*, *Unknown*. A plain running or
done call has nothing there. A call that set work going apart from the turn
— a command in the background, a subagent in the background, a teammate —
stands for that work: it is running while the work runs and ends as the work
ends, not *Done* the moment the launch returned (`workState` in
`model/conversation.ts`; every place a call's state is drawn reads it). A
call that itself failed, was denied or was interrupted is that, whatever it
started. A subagent's pane header in the column carries the same glyph.

**A call's readable view** is what it did drawn for reading, under its row
and outside its fold, whatever the call's status; the fold keeps its raw
input and output. Three things are one: the change a file edit makes (a
diff, each line its own row with its old and new line numbers, a long line
wrapping under itself, the file named relative to the Agent's directory when
inside it), the plan the latest TodoWrite set, and the images a call gave
back. A readable view taller than a snippet is cut, its end fading, with
*Show all* to open it whole and *Show less* to cut it again; closing keeps
the button where it was on screen, so the conversation does not jump to
what came after. Command output, text results, a question's answer and a
subagent's work have views of their own (the output in the fold, the
answer as your message, the subagent's card) and no readable view.

**A tool call's title** is the tool and what the call does: the argument
that says it for a tool DevHub knows (`Bash: npm test`, `SendMessage:
researcher — status`, `TaskUpdate: 3 → completed`, `ToolSearch: …`), an MCP
tool by its server and tool (`claude-in-chrome · computer: screenshot`), and
any other tool by its most telling argument (a description, command, path,
URL, query, action or name; else its first argument in words), so calls to
tools DevHub has never heard of still read as what they did.

**A plan** is a checklist, each step with a box that is empty, half filled
while the step is under way, or ticked once done: Codex's plan updates, and
the list a Claude TodoWrite call sets (whose title says how far it has come,
*TodoWrite: 2 of 5 done*). The latest plan is drawn unfolded under its call;
an earlier TodoWrite keeps its checklist folded in its call. The step under
way is also what the Agent's row says it is doing when no call runs.

**What a tool call gave back** is drawn part by part, in the order the tool
gave it:

- An edit (Claude's Edit, MultiEdit and Write; Codex's file changes) is a
  diff in the call's readable view (below): the text the call's input says
  it replaces from the moment the call is made, and the CLI's own patch,
  with its line numbers, once its result gives one. A failed edit shows the
  change it meant to make, and the CLI's words in its output.
- A command shows its output, and apart from it what it printed on stderr
  (Claude keeps the two apart), *Interrupted* when it was stopped, and its
  exit code when the CLI says it (a failed Claude command's *Exit code N*;
  a command that succeeded shows none, since Claude does not report 0).
- Output too large for the conversation, which Claude saved to a file and
  gave the model only the start of, says so with the file's path and shows
  the start it kept.
- A tool the result made available (a tool search's find) is named.
- An image a tool gave back (a screenshot, a picture it read, an MCP tool's
  image) is a thumbnail under the call, not folded into it, since the picture
  is often the result; clicking one shows it whole. An image the page cannot
  open (a file on the Agent's machine, as Codex's image view names it) is
  named where it would be.
- A Claude command run outside the sandbox (its Bash call's
  `dangerouslyDisableSandbox`) has a faint warm line at the left of its row
  and a small *unsandboxed* beside its title, which says *Ran outside the
  sandbox* on hover. It is an everyday thing, so it is only a hint, in the
  waiting colour of either theme. Codex sandboxes a turn by its permission
  mode, not a call, so its calls carry no mark.
- A block of a tool result DevHub does not know is a warning notice, like any
  unknown part of the conversation, never dropped in silence.

An image in a message of yours is drawn under its words the same way.

**Commands the CLI ran itself** — a slash command such as `/model sonnet`,
or a shell-mode `! ls` — are one quiet line each, the command as typed with
what it printed under it (in red when it printed an error), not a message
bubble. Claude records them as tagged text (`<command-name>`,
`<command-args>`, `<local-command-stdout>` and `-stderr`, `<bash-input>`,
`<bash-stdout>` and `-stderr`); the caveat it writes before them
(`<local-command-caveat>`) is for the model and is not drawn. Output that no
recorded command names is drawn as *Command output*.

A slash command sent from the composer (or by a template) is taken as sent
when the CLI says it ran a command, in whichever of its two forms: a
command that expands into a prompt (a skill, `/review 12`) is echoed in the
tagged form above; a local command (`/mcp`, `/cost`) is not echoed at all,
and is often answered by one assistant message of the model `<synthetic>` that
names the command it ran (`local_command_run`) and carries what it printed in
the same tags (`local_command_source`), then the command's `result`. That
message is drawn as the command, in the place the answer came. The command
is matched to the oldest message sending that invokes a command (`/name`, or
`!`), never by its text or its name, because the CLI reads the arguments its
own way and names the command it ran, not the alias sent (`/cost` runs
`usage`). This shape was observed on 2.1.273, 2.1.281, 2.1.283 and 2.1.284
alike; the two fields are not in the Agent SDK's types. Some local commands
print neither: `/clear` prints `conversation_reset` (drawn as *Context
cleared*) and then only its `result`, and a `/compact` that compacts prints
its `status` and `compact_boundary` and then its `result`.

None of that is what ends the turn, though. **A turn ends on the CLI's own
end-of-turn signal and nothing else**: Claude's `result`, Codex's
`turn/completed`. From the moment DevHub writes a message the Agent is
*working* (the adapter says a turn is under way), and the end of the turn
that answers it makes it idle again, whatever the CLI printed or did not
print in between: an echo or none, a synthetic answer or none, a compaction
only, an unknown command, an error. Which messages a Claude `result` answers
follows from the CLI reading its input in order: every message up to the
last one the turn took in (echoed), or, when it took none, the oldest one
written. A message answered without ever being echoed is drawn where it was
sending, as the command line (with the `result`'s text as its output when
the model was not asked, `num_turns` 0) or as the person's words. A message
still unanswered after a `result` is the next turn, so the Agent stays
working. For Codex the turn a message went to is in the answer to its
`turn/start` (`turn.id`) or `turn/steer` (`turnId`), and that turn's
`turn/completed` answers it the same way. What is drawn as sending plays no
part in the status. If the CLI never answers because it ended, the Agent
ends as any Agent whose CLI exits does (*The host, the journal, and
restarts*). One case the order cannot tell apart: a turn the CLI starts by itself (a background task's
notification) while a command written to it is still unechoed is taken as
that command's turn, so the command line may be drawn a turn early; it never
leaves the Agent working.

**Questions the Agent asks** (Claude's AskUserQuestion, Codex's
requestUserInput) are a card of choices, with an *Other* field where the CLI
takes words of your own. When a single-select question's options carry a
`preview` (a mockup, a snippet), the card lays the question out side by side,
as the CLI does: the options on the left, and on the right the preview of the
option the pointer is on, else the one the keyboard is on, else the one
picked, else the first. A preview is Markdown in a monospace box; its lines
keep their spaces and are never wrapped, so an ASCII mockup's columns stay in
line, and a long one scrolls inside the box. A multi-select question shows no
previews, as in the CLI.
`claude -p` does write previews: a model asking in a GUI Agent may give each
option a multi-line mockup (box-drawing characters, Japanese text), and the
card shows it as written. Box-drawing characters take one column of the
monospace font; a full-width character is drawn by whichever font has it, so
it is as wide as that font makes it, which with the default stack is not
exactly two columns — a box with Japanese in it lines up only as well as the
fonts allow.

The card is a panel of the transcript's own, not a tinted box: its border,
and *Needs your answer* in the waiting colour. Its controls are the ones the
rest of DevHub uses. A question's header is a small caption over its words;
its options are rows of a list as DevHub's pickers draw them — the label, and
its description on one quiet line under it — the pointer washing a row and a
chosen one drawn as the picker's selection, with a check (the radio or
checkbox behind each row is there for the keyboard). *Submit*, and a
permission's *Allow* / *Deny…*, are the small buttons of an inline
confirmation such as Rewind's, at the trailing end.

The answer is said **once**, as your message (below). The answered call has
no readable view; its fold keeps **what it asked** for reference
(`ToolEntry.asked`, read from the same record of the answer as the bubble),
over its input and output: each question as the card showed it, every
option, the chosen ones checked, the words written instead, and for a
single-select question the previews beside the options — the chosen one's,
or the one pointed at. Codex's questions are a request of their own rather
than a call, carry no previews, and have only the bubble.

Once answered, **your answer is your message**: the same bubble on the right
as a message you wrote, each question quietly over what you chose — every
option of a multi-select one — or what you wrote instead, as written, with
the note you added to a choice in the CLI's own dialog. It is read from the
record of the answer that is there in every way a conversation is drawn:

- **Claude**: the call's `tool_use_result` (`questions`, `answers`,
  `annotations`), which the CLI prints live, which a replay reads back from
  the journal, and which a resumed session's file keeps as `toolUseResult`. A
  multi-select answer the CLI recorded joined with `", "` is read back option
  by option, so a label that holds a comma is still one option; a declined
  question draws no answer. An answered call whose record has no answers
  breaks the conversation rather than drawing nothing.
- **Codex**: the reply DevHub wrote to the request, live and from `in.log`
  on a replay. A question Codex marked secret is drawn as *Hidden*.
  `thread/resume` hands back no record of the request, so a resumed Codex
  thread draws no answer bubble for questions asked before it.

**A message the Agent was given that you did not send** — another session's
message passed on, a subagent's or teammate's report, a plugin's prompt,
anything that reaches the CLI as a user message without DevHub writing it —
is not your bubble. It is a muted card on the left, *Message to the Agent
(not from you)*, with its words as they came, folded after 8 lines behind
*Show all*. The rule is only who sent it, never what the words look like:
Claude's live messages are matched to what DevHub wrote (`in.log` on a
replay), so anything else is not from you; Codex's carry DevHub's own
client id, and a message in a subagent's thread without one is its parent
Agent's. A Claude session read back from its file does not say who sent a
message, so there every message is drawn as yours; in a Codex thread read
back, the Agent's own messages without DevHub's id are yours (typed at
Codex's terminal). What the Agent sends to others is a tool call, and its
row names the recipient (*SendMessage: researcher — …*).

**Keys.** In every field where you write something to send — the composer,
a waiting message being edited, a message to a subagent, an answer typed into
a request — Return (with or without Shift) starts a new line and ⌘Return
sends, saves or answers, whatever the field's button does. While the `/`
command list is open, Return (or Tab) takes the highlighted command, as in any
list, and ⌘Return still sends what is typed. A key an input method is still
composing is the input method's, so Return confirms a conversion and sends
nothing. Esc and Ctrl+C stop a running turn from anywhere in the pane.

**Reading and copying.** The transcript is text: you can drag-select any of
it — answers, code, tool output, a subagent's work — and copy it with Cmd+C.
Every message also has a quiet Copy action under it, always shown, and every
code block has one in its header.

**Settings in the composer.** Model, Effort and Permissions sit under the
message box at the same size as what you type. A value the CLI has not named
yet says so instead of standing empty: Claude names its model only when the
first turn starts (its `system/init`), so until then the model reads *Not
known yet*. Claude's stream-json does not report the effort it runs at
(`system/init` carries an `effort` only on hosts that publish it, and DevHub
takes it when it does), so an effort nothing has chosen reads *CLI's
default*: the level the CLI resolves from `--effort`,
`CLAUDE_CODE_EFFORT_LEVEL`, the saved settings and the model's own default,
which DevHub does not guess. Codex names its model and effort when the thread
opens, and a model you pick here shows that model's default effort
(`model/list`'s `defaultReasoningEffort`) until you choose one.

A model reads by the full name the session reports for it, in the list and
as the current value alike: Claude's choices by the name each resolves to,
with the value `/model` takes beside it when that differs
(`claude-opus-5-5[1m] (opus[1m])`), Codex's by `model`. The CLI's own
display name for a choice is its tooltip.

The model the session reports is found in the CLI's own list the same way
however the session began (fresh, resumed, rewound, or a model picked here):
Claude's handshake choice by its value or the full name it resolves to
(`resolvedModel`), Codex's `model/list` entry by `model`, hidden models
included, every page read. A resumed Claude session keeps the model its
transcript was saved with, so it can be on a `[1m]` variant the list does
not offer (`claude-opus-5-5[1m]` beside a plain `opus`): that name is a
choice of its own, and its efforts are those of the choice the name
resolves to without `[1m]`, which picks the context window, not the model.
A model the list names in no form is still shown and offered by its own
name, and the effort says plainly that its levels are not known here.

**Context.** Under the message box, a quiet line says how full the context
window is, *Context 45% · 90k of 200k*, with a thin meter that turns orange
from 75% and red from 90% (the rule every usage meter keeps). Claude's figure is the
latest top-level message's tokens (input, cache and output), known as soon as
that message arrives, against the context window the turn's `result` reports
for the model; before the first turn ends it reads only the tokens. Codex's is
`thread/tokenUsage/updated`'s last total against its model context window.

**Subagents.** A subagent is a card under the call that started it, with its
work inside. A Codex subagent is running while its thread has a turn running
and finished when that turn ends, whether or not app-server also sends a
`subAgentActivity` item about it. Codex names the call that started a
subagent one of two ways — a `collabAgentToolCall` `spawnAgent` naming the
subagent's thread, or, under multi-agent v2 (which codex 0.158 runs), a
`subAgentActivity` `started` item whose id is the spawn call's — and the
card is linked to the thread by whichever comes first. What the thread says
before its call is named waits, and is drawn under the card once it is; a
thread no call is named for by the end of the conversation's turn is one
warning, not one per item. A Codex subagent drawn as running is *Unknown*
once the app-server that ran it is started again (Restart session, live or
read back from the journal), and one read from a thread's history is *Done*
if the history says so and *Unknown* otherwise, until its thread's own turn
says more. A Claude subagent is running from its call
until its end is told: its call's result, for one run in the foreground; a
task notification, for one started in the background (whose call's result
only says it launched) — a `task_notification` event in stream-json, or a
`<task-notification>` message in the session file, matched by the call's id
or else the task's. A subagent runs only inside the CLI process that started
it: one read back from a session file, or left running when the CLI is
started again (rewind, `/resume`), is *Unknown* unless its end was recorded.
A Claude teammate (an agent team's member, whose Agent call's result says
`teammate_spawned`) runs beside the conversation rather than inside the call:
it is *Running* from its spawn, *Idle* when it says it is waiting between
tasks, *Failed* when its idle notice names a failure, and *Done* once its
shutdown is approved. Its protocol messages set that and are not drawn; what
it says in words is a quiet line, *From researcher: …*. Read back from a
session file, or once the CLI is started again, a teammate nothing more was
recorded about is *Unknown*.
A task belongs to the call it was first tied to, for good: a subagent
woken again by SendMessage keeps its task id, and though the CLI then
names the SendMessage call on its task events, the news is the subagent's —
its Agent call runs again, stays in the column and the background tasks,
and ends with it — while the SendMessage call is only the message, done
with its own result.
A subagent outlives what DevHub drew of its session: its transcript is kept
apart from the conversation, through a compaction and across a restart, and
SendMessage can wake one whose Agent call this transcript never drew (it came
before the history read back from the session file, or a rewind cut it). Its
messages still name that call as their `parent_tool_use_id`, so the call is
drawn where the subagent is first heard of, as *A subagent started earlier in
this session*, *Unknown* (nothing ties its task to it), with the subagent's
messages under it. Its task, tied first to the SendMessage call, stands on
that call.
A notification that names only its task is matched through the call that
task belongs to: the one `task_started` tied it to, or, read back from a
session file, the call whose result named that task (a background agent's
id, a background command's `backgroundTaskId`).
Any other background task a call started (a command run in the background,
asked to or moved there by the CLI when it outran its timeout, whose result
names its `backgroundTaskId`) follows the same news on that call; the CLI's
one line about how it ended is a quiet line under the call. Only a
notification no drawn call started is a notice. Its work is drawn in one place at a time:

- One rule lists subagents in the column, in transcript order: a subagent
  until it ends (running, or idle and able to run again), unless you took it
  out with the *Beside* toggle on its card. A subagent that ends (done,
  failed or unknown) leaves, even one you put back; one filling the pane
  stays there until you leave it. Every subagent is reachable from its card
  whether it is listed or not, and *Maximize* on the card of one that ended
  opens it again. One at work is also in the background tasks under the
  composer (above), which opens it filling the pane; an idle teammate is not
  a background task, and is reached from its card.
- When the pane is wide (1040 px or more), the listed subagents are in a
  column on the right, stacked one above another; one goes back to its card
  when it ends. The *Beside* toggle on the card of one that has not ended
  takes it out of the column, or puts it back; one that ended has no toggle.
- The column is laid out the way VS Code lays out its views. Its left edge
  is a sash: drag it (or focus it and use the arrow keys) to widen or narrow
  the column, between 280 px and whatever leaves the conversation 400 px;
  double-click it to go back to the default share. The line between two
  panes is drawn over the lower one's header, where one ends and the next
  begins; between two open panes it is another sash that shares their
  height (neither under 96 px); double-click it to even them all out. The
  chevron on a pane's header, or the header
  itself, folds the pane to that one header row in its place, the open panes
  taking the room, and unfolds it again. The sizes and folds last as long as
  the Agent's pane does; a pane that leaves the column takes its own with it,
  the others sharing its room in the proportions they had, and comes back
  open at an ordinary size.
- A pane's header actions are icons (each named for the screen reader and
  with a tooltip): the fold on the left and *Maximize* on the right in the
  column, and ← back to the conversation on the left when the subagent fills
  the pane.
- *Maximize* fills the pane with one subagent's transcript, and ← in its
  header goes back to the conversation; the composer still talks to the
  conversation.
- When the pane is narrow there is no column: a subagent is in its card or
  maximized.
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
- Of the CLI's other system events, each is drawn as what it says or left
  out by a rule, never as an event DevHub does not know: `away_summary` is an
  information notice (*While you were away: …*); `informational` a notice at
  its own level; `model_refusal_no_fallback` an error notice with the API's
  reason; `local_command` the command it ran and what it printed, as a
  command line (above); `stop_hook_summary` a warning only when a hook
  failed; `vcs_state_changed` (a command of the CLI's committed, pushed,
  merged or rebased) an information notice saying what was done on which
  branch (*Pushed main*, *Committed on feature*), and a kind DevHub has no
  phrase for is named (*Changed the repository (stash) on main*).
  `permission_denied` (the CLI's own permission check refused a call: a
  rule, or auto mode's classifier) is said on that call, wherever it is
  drawn, as one quiet line — *Denied by auto mode: Modify Shared Resources* —
  with the CLI's whole message folded under it, and the call reads
  *Denied*; a call not drawn is told as a line in the subagent it was made in
  (its `agent_id`, matched as a task notification's task id is), and only
  one that names neither is a line in the conversation.
  `turn_duration` (the transcript draws no durations),
  `bridge_status` (a remote control of the session, not the conversation),
  `thinking_tokens` are not drawn; `background_tasks_changed` is the list of
  background tasks under the composer (*Background tasks*, above). A system
  event DevHub has never heard of is an information notice (below).
  Every information notice, whatever it reports, is drawn the one way: a
  quiet line in the faintest ink, smaller than a tool row, with no box, close
  to what comes before it, and the event it is about behind its fold.
  Warnings and errors keep their tinted box.
- Thinking the API withholds (it sends the block without its text), redacted
  thinking, and citation deltas.

**Codex: what does not come across**

- Only `/model`, `/effort` and `/approvals` are offered as commands. They open
  the composer's pickers. Codex has no protocol-level slash commands, and review,
  compact and diff are not wired yet.
- Skills are offered after `$`, as in Codex's own terminal UI, anywhere in a
  message: the enabled ones `skills/list` names for the thread's directory,
  asked once when the thread opens. Each skill a message mentions (`$name`
  starting a word) goes with its words as a `skill` input (its name and the
  path of its `SKILL.md`), the protocol's way of handing Codex a skill. A
  skill added while the Agent runs is offered once the Agent is started again
  (`skills/changed` is not followed).
- Permission modes are the terminal UI's presets: Read only, Auto and Full
  access (an approval policy and sandbox pair each).
- Not drawn:
  - the whole-turn diff (each file change shows its own);
  - the thread list, archive, rename, goals, queue, projects and environments;
  - hooks;
  - automatic approval review;
  - raw response events;
  - MCP server events and progress (their status is in the MCP panel, see
    [MCP servers](#mcp-servers-mcp));
  - `command/exec` output.
- A request DevHub does not handle is answered "cannot", and a notice says so.

**Both CLIs**

- **Images** go with a message: paste one (a screenshot) into the message
  box or drop image files on it. Each is a thumbnail over the field with its
  own remove button, and a message can be images alone. PNG, JPEG, GIF and
  WebP are taken; any other file is refused with a message naming it, not
  dropped. Claude is sent them as image blocks before the words of its
  stream-json user message; Codex as `image` inputs holding data URLs (the
  file is on this Mac, which need not be the Agent's machine). A message that
  waits keeps its images through an edit of its words, and a rewind puts a
  message's images back with its words.
- An event DevHub has never heard of is not dropped. It appears in the
  transcript as a warning notice with the event folded under it, and the
  conversation goes on.
- A known event whose shape DevHub does not accept stops the conversation as
  *protocol mismatch*, naming where in the line it went wrong and the CLI's
  version. The transcript up to that point stays readable. This usually means
  the CLI was updated past what DevHub knows.

## File paths open in the editor

A path in the conversation that names a file is a link: a click opens the
file in DevHub's editor, at the line or lines it names.

**Where paths are found.** In the Agent's prose and inline code, once the
paragraph has finished streaming; in a tool call's title (*Read: src/a.ts*),
in its output (a command's output and stderr, grep's `path:line:` lines,
Glob's list) and in a diff's file header, which opens the file at its first
changed hunk. Not in a fenced code block of an answer: that is code, and a
word in it that happens to be a file is not the Agent pointing at it.

**What counts as a path.** One word — whitespace, quotes, backticks,
brackets and braces, `, ; | = * ?` and CJK punctuation end it, so a path with
a space in it is not found. Absolute (`/work/app/src/a.ts`), in the home
directory (`~/notes/todo.md`), or relative to the Agent's directory: a
relative word counts when it has a `/` in it or ends in an extension
(`README.md`). A path has no `:` in it; after the path come:

| Written | Opens at |
| --- | --- |
| `src/a.ts:12` or `src/a.ts#L12` | line 12 |
| `src/a.ts:12:5` | line 12, column 5 |
| `src/a.ts:12-20` or `src/a.ts#L12-L20` | lines 12 to 20, selected |

A URL is never a path, and a trailing full stop is the sentence's.

**Only files that are there.** A word that could be a path is a link only
once DevHub has checked that it is a file on the Agent's machine — this Mac,
or the host an SSH Workspace's Agent runs on — so *and/or* or *e.g.* stays
text. The check is one `/bin/sh` per batch of paths through that machine's
runtime (`main/agent/conversation/pathLinks.ts`), and its answer is kept for
as long as the conversation is on screen; a word that named nothing is
checked again when the Agent's turn ends, since the turn may have made it. A
folder is not a link.

**Which editor.** The Workspace on the Agent's machine whose folder contains
the file; if no open Workspace does, the Agent's own Workspace, with the
editor shown beside the Agent (`routeAgentOpen` in
`main/cli/route.ts`). It is the same open `devhub <file>` makes — the one
`vscode:openFiles` message, remote files as `vscode-remote:` — weighed the
other way round: a terminal's `devhub` opens in the window it was typed in,
a link opens where the file's folder already is.

**When it cannot.** A file that has gone since the link was drawn, a
Workspace whose editor cannot be reached, or a machine that could not be
asked is said once, the way every other failure on the Agents page is — never
an empty editor for a file that is not there.

## Messages that wait, and sending one into a turn

A message you send while the Agent is idle is written to the CLI at once, and
its bubble is at the end of the conversation at once too, quieter (*sending*)
until the CLI takes it: Claude's echo of the message (`--replay-user-messages`),
its word that it ran a slash command (above), or Codex's `userMessage` item
puts the message itself in the same place, and so does the end of the turn
that answers a message the CLI never echoed (above). A
message the CLI refused (Codex's `turn/start` or `turn/steer` failing) stops
sending, and the refusal is a notice. Which messages are sending is read from
what was written (`in.log`), so after a restart a message written and not yet
taken is sending again. One you send while it is busy (a turn running, a request waiting, the CLI still
connecting or being started again by a rewind) waits instead. Waiting messages
are listed over the composer, oldest first. The Agent has not seen them yet,
so each one can be:

- **edited** in place (⌘Return saves, Esc gives up), the caret at the end of
  its words, in a field that grows with its text from three lines up to the
  composer's own limit. While the editor is open the message is not sent, and neither is
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

### The unsent draft

What you have typed and not sent is kept, though: each GUI Agent has one
*draft*, the words in its composer with the words of any waiting message
you are changing ahead of them. The Agents page tells main a moment
(400 ms) after typing pauses, and at once when the composer loses the
keyboard, a send clears it, the pane goes away or the page unloads. Main
keeps it in `drafts.json` beside `state.json` and hands it back when the
pane attaches again, after a restart of DevHub or of the page, and it comes
back into the composer ahead of anything typed since. The waiting message
you were changing goes as any waiting message does (lost with a restart of
DevHub, sent as it was when only the page went away); the words you were
typing into it come back, in the composer. Sending, or emptying the field, clears the
draft. Only words are kept: attached images are not, so they do not come
back. The draft lives exactly as long as its Agent: closing the Agent, or
the Agent ending, drops it, and a report that arrives after that is
dropped too. It is kept on this Mac rather than in the Agent's host
directory, which is on the Agent's machine and would be a round trip per
pause in typing. There is one draft per Agent, so if two places ever type to
the same Agent, the last report wins.

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

A usage limit does not stop the conversation: the CLI says so in the turn
(its message, and a notice), and the next message is written as the CLI's own
prompt would take it. A `rate_limit_event` that names no limiting window
(its `rateLimitType` is optional) changes no window's readout.

When the CLI is not signed in, or its sign-in is refused, the conversation
stops (*Authentication failed*):

- Claude reports it on an answer: an assistant message whose `error` is
  `authentication_failed` (`SDKAssistantMessageError`). What the message
  says ("Invalid API key · Please run /login", an expired token) is the
  reason the failure gives.
- Codex reports it at `account/read` (no account, `requiresOpenaiAuth`), or
  as a turn that failed with `codexErrorInfo` `unauthorized`, with its message.

The fix is the CLI's own sign-in, in a terminal on the Agent's machine:
`claude auth login` (or `/login` inside claude), or `codex login`. DevHub
never signs in on your behalf. Then **Try again** restarts the Agent's CLI on
the same session ([Restart Session](#restarting-the-session)).

### How a failure is shown

A failure of a GUI Agent's conversation — authentication failed, the CLI
refused to start, a protocol mismatch, the host lost — and a terminal Agent's
runtime failures are all drawn the same way, over that Agent's pane and
nothing else:

- A sheet in the middle of the pane, over the pane dimmed, so what the Agent
  said up to the failure stays in view behind it. It has the failure's name,
  its sentence, the detail (the CLI's reason and the fix), and:
  - **Try again**, where Restart Session can be taken — the same
    `restart_agent` as the Sidebar's menu. A CLI that stopped itself (signed
    out, refusing to start) runs nothing, so nothing is asked first.
  - The way out the failure has: **Open a terminal to sign in** (a terminal
    Agent from the same profile, on the same machine) for authentication,
    **Continue in terminal** for a conversation DevHub cannot follow.
  - **Dismiss** (or Escape), which leaves a line along the top of the pane
    with the same actions. The composer stays closed.
- How long it stands is one rule for every failure: the sheet is up from the
  moment a failure appears until it is dismissed; the failure, sheet or line,
  is drawn for as long as the Agent's readings say it; a different failure is
  asked about with the sheet again.

**Continue in terminal** is the way out of a GUI Agent:

- It is a small floating button in the top right corner of the
  conversation's column (left of the subagent column when one is open),
  translucent until it is pointed at or focused. It is also on the failure
  sheet when the conversation broke (the host was lost, a protocol mismatch,
  or the CLI refused to start).
- It starts a terminal Agent from the same profile, resuming the same
  session: `claude --resume <session id>`, or `codex resume <thread id>`.
- It selects that Agent, and stops the GUI one once the new one is running.
- If the conversation has no session yet, it is refused with the reason. If
  the new Agent fails to launch, the GUI Agent keeps running.
- When the Agent is not idle, it asks first (below).

**Continue in GUI** is the mirror, for a terminal Claude or Codex Agent: the
same floating button in the same place, the top right corner of its pane (the
bottom right is where the pane says what became of a message DevHub queued
for the Agent, from an Issue assignment or the Agent actions sheet: what it
waits for, a cancel or a failure; in a GUI pane a message that went is not
said there, because the transcript shows it, marked *Sent by a template*,
where it went). The two
are one control: the top right corner of the Agent's own column (a terminal
is its own column), the same distance in, and the same size whichever it
says. It starts a GUI Agent from the same profile resuming the
terminal's session, selects it, and stops the terminal Agent once the GUI one
is running and written down; a launch that fails leaves the terminal running.
**Smart Buttons.** While a GUI Agent is idle, a row of small buttons sits on
its composer's top right edge, touching it: what the Workspace's repository
says could be done next — commit, push, open a pull request, get a draft ready,
address review comments, fix CI (`smartButtonTriggers` in
`model/agentActions.ts`, read from the repository status the Sidebar already
has; nothing is polled for them). A terminal Agent's stand in its bottom right
corner, above the queued-message status. Each is an Agent action whose trigger
holds and whose `button` is on; pressing one queues its wording exactly as the
Agent actions sheet does, so the corner's rules for what became of it are
unchanged. They go when the Agent starts working or the condition stops
holding. The box rests translucent and comes up to full when pointed at,
focused or dragged; its handle drags it anywhere in the pane, main remembers
the place per presentation (`state.json` `smart_buttons`), and a double-click
on the handle puts it back.

**Continuing an Agent that is not idle.** A continue is a stop followed by a
resume elsewhere, in this order: the new Agent is launched on the session
first, and the one it replaces is stopped once the new one is running and
written down. Stopping it stops its CLI where it stands, so the turn it is
in (the tool call running and the answer not yet written to the session),
a permission question it is waiting on, and any subagents and background
tasks it started stop with it; a GUI Agent's messages DevHub still holds
(queued behind a turn, open to change, or written and not yet taken) never
reach the CLI. So the button is always there, and pressing it while the
Agent is not idle asks first, on the same sheet and by the same rule as
stopping it (`agentIsIdle`: working, background, waiting, error or not yet
read all ask). The question is main's, not the page's: the continue request is
answered with the question, and only its Confirm goes on. An idle Agent is
continued without one. A GUI Agent's status counts DevHub's hold on the
person's words for this: a message written and not yet answered is
`working`, one held at the prompt is `waiting`.

Which session the terminal is in is found from the Agent's own processes:
the one tmux runs in its pane (`#{pane_pid}`, read with the Agent id the
session carries) and every one under it, read on the Workspace's machine with
`ps` (or `/proc` where there is no `ps`). Another terminal of the same CLI in
the same Workspace is never taken for it.

- **Claude** keeps a record of each process it runs as,
  `<config>/sessions/<pid>.json` (`~/.claude`, or `$CLAUDE_CONFIG_DIR`),
  whose `sessionId` is the session on screen: Claude 2.1.282 writes it at
  start, rewrites it whenever the session changes inside the terminal
  (`/clear`, `/resume`, a session it goes on in after a compaction), and
  removes it on exit. The outermost Claude under the pane is the Agent's (a
  Claude it runs is under it). It is the only source: DevHub adds nothing to
  your Claude — no hook, no `--settings` — to find it out. A pane none of
  whose processes has the record (Claude no longer running there, or a
  Claude too old to keep one) is refused, saying where DevHub looked.
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
not to this Agent. A `SessionStart` hook given through `--settings`, which
DevHub once added as a second source, is not one either: it writes only when
a session starts, so it went stale when Claude went on in a new session
without one (after a compaction) and then contradicted the process's record,
and it put DevHub's hook into your Claude for something Claude already
records.

## Resuming an earlier session

An earlier session is taken up in three ways: **New Agent** (and Assign
Issue's agent step) offers the folder's earlier sessions under its new ones
(below), **Continue in terminal** and **Continue in GUI** (above) start a new
Agent on the session the first one is in, and **`/resume`** inside a GUI
Agent (below) has that Agent go on with another session.

**The agent picker.** New Agent's rows are "New Claude Session", "New Codex
Session", … — one per profile, in the settings' order — and under them the
earlier sessions of each Claude or Codex profile that ran in the folder the
Agent is for: "Claude Session: …", "Codex Session: …", newest first across
profiles, each with its title (the precedence below), how long ago it last
changed, and the git branch it was on when the CLI recorded one (Claude's
`gitBranch`, Codex's `gitInfo.branch`). A session two profiles of one kind
both list is offered once, under the first. Cursor and custom profiles keep no
sessions DevHub can list, so they have their New row only.

- **Which folder.** The Workspace's own: its root, on its machine. A sibling
  worktree of the same repository is not included, because a session is its
  checkout's work, on that checkout's branch, and Claude goes on with a
  session only in the directory it ran in. Codex is asked with that `cwd`;
  Claude's listing is that directory's `projects/` folder.
- **Typing** narrows the rows by title (and by profile and branch), the New
  rows too. The highlighted session is previewed beside the list, as
  `/resume` previews it.
- **Not waiting.** The New rows are drawn at once; the sessions are read on
  the folder's machine after the sheet is up, and fill in as each profile's
  listing answers, with a quiet "Earlier sessions — Reading…" row at the end
  until they all have. A listing that fails says why in the sheet's note
  (`sessions_unreadable`, or the profile's own refusal), and the New rows stay.
- **Taking one.** Return starts a new Agent from that profile resuming the
  session (a launch that resumes, below), ⌥Return in the other presentation,
  ⌘Return beside the editor, exactly as a New row does.
- **Assign Issue** acts on the folder before it asks which agent. Once the
  person picks a row of "Where to work on owner/repo#128", DevHub does the
  folder work and switches to it: it creates the worktree
  (`../<repo>_feature_128-wip` for a new branch; `../<repo>_<branch>`, with
  `/` as `_`, for the branch the work already has), or opens the worktree that
  branch is already checked out in, or opens the root checkout as it stands — and opens that
  folder as the selected Workspace, as opening one does. Only then does it ask
  which agent, with New Agent's picker for that Workspace, word for word under
  the title "Agent for owner/repo#128": New rows, the folder's earlier
  sessions with their preview, ⌥Return, ⌘Return. An existing worktree or the
  root checkout offers its sessions — the session that wrote a pull request is
  there when review comments arrive; a worktree just created has none, so it
  offers the New rows only. A resumed session is told about the Issue the way
  a new Agent is: the action's template is queued for it (after the review
  sheet, when the action asks for one) and sent when the resumed CLI is idle.
  A folder that cannot be made (a directory in the way, a branch nowhere to be
  fetched) is said under the branch question and no agent is asked about; a
  fetch that failed asks whether to start from the copy on disk first.
  Escaping the agent question goes back to the branch question and leaves the
  Workspace, and the worktree it may have created, in place: they were opened
  like any other, and closing them is its own act.

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
  last line above it with that uuid (Claude writes some records twice under
  one uuid), or the last line with it when it was written only after its
  child. A record whose parent names nothing the walk has not drawn yet goes
  on at the conversation standing above it in the file (the last line of the
  main chain above it): a compaction boundary's logical parent can be a
  reminder Claude wrote only after the summary, under it, or not be in the
  file at all. The adapter draws them as
  the entries a live turn makes, without a turn running. The task
  notifications Claude recorded (as user messages or queued commands) come
  along, and end the tasks they name; they are nobody's words and draw no
  message. So does the rest of what a live conversation would have shown:
  the system events on the chain (the compaction, a command the CLI ran, an
  away summary; the adapter draws or leaves out each by the same rule as
  live), a message you queued while a turn ran, and a file you attached or
  that changed outside the conversation, as a notice. The other attachments
  are the CLI's notes to the model (reminders, listings, the environment),
  which nothing live shows either.
- **Codex GUI** has no argument for it: DevHub takes `resume <id>` off the
  argv and sends `thread/resume` instead of `thread/start`. Its answer carries
  the thread's turns, which are drawn as the conversation.

A session that is not there (Claude's file is missing) refuses the launch
with the path. Otherwise DevHub never refuses a Claude session the CLI can
resume on account of reading its history: the CLI resumes it and has all of
it, whatever DevHub makes of the file. The walk above never draws a line
twice and always reaches the session's first record, so the pre-compaction
conversation, the compaction and what followed it are all drawn; a file over
32 MiB is resumed with a warning that its past is not drawn.
Nothing public asks the CLI for a session's past messages over stream-json:
`claude --help` has no such option (`--replay-user-messages` echoes only what
is written to stdin), and the Agent SDK's `getSessionMessages()` /
`get_session_messages()` are the SDK's own functions reading the session
files on disk, not a control request. So DevHub reads the file too, on the
Workspace's machine, where the CLI runs.

The agent picker and `/resume`'s sheet list the CLI's own sessions, read on
the Workspace's machine:

- **Codex**: `thread/list` on a short-lived `codex app-server`, filtered to
  the Workspace's directory (`cwd`), sorted by `updated_at`.
- **Claude** has no listing command. It keeps each session as JSONL under
  `~/.claude/projects/<the directory, every non-alphanumeric character as
  ->/` (or under `$CLAUDE_CONFIG_DIR`, from the profile's environment or the
  machine's). DevHub reads the newest 50 files there and never writes to
  them. A title follows the Agent SDK's precedence for a session's display
  name: the latest name a person gave it (`custom-title`, from `/rename` or
  `--name`), else Claude's latest `ai-title`, else its first prompt. Codex's
  is likewise the thread's `name` when a person set one, else its `preview`.

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

## Restarting the session

**Restart Session** stops a GUI Agent's CLI and starts it again on the same
session, in the same Agent: the pane, the transcript and the Agent's name
stay. It is for when the CLI has to start afresh to see a change — a
configuration or plugin that changed, a CLI that was updated. (One MCP server
is reconnected from the [MCP panel](#mcp-servers-mcp) without a restart.)

- It is in the Agent row's menu in the Sidebar, under `Cmd+Q Shift+R`
  (`restart_agent`), and typed as `/restart` in the composer, which is
  DevHub's own command like `/resume`, offered for Claude and Codex alike.
- It goes the way a rewind and `/resume` do: the host stops the CLI and starts
  it again, with a mark between the two in the journal
  (`{"type":"devhub_restart"}`), so a replay draws the same. Claude is started
  with `--resume <session id>` (a CLI that has named no session yet starts a
  new one); Codex's app-server is started again and resumes the same thread in
  its handshake (`thread/resume`), which draws nothing a second time.
- The transcript says *Session restarted* where it happened, as one quiet
  information line. Nothing the stopped CLI had going goes on: a call still
  running is marked interrupted, a question it asked closes, and its subagents
  and background tasks end with it (*Unknown*). A message written to it and
  not yet taken never reached it; messages DevHub still holds are written to
  the new CLI once it is ready.
- It is what a conversation its CLI stopped is for — signed out, or refusing
  to start: after signing in, **Try again** on the pane's failure sheet (or
  Restart Session) starts the CLI again, and the new CLI's start lifts the
  stop. The same session goes on.
- When the Agent is not idle it asks first, on the same sheet and by the same
  rule as Stop and Continue (`interruptsNothing`); an idle Agent, and one
  whose CLI stopped itself, is restarted at once.
- An answered question is over, whether or not what it asked for worked: a
  restart that failed says so, and the question is not left up to be
  answered a second time (main takes a confirmation once).
- Where it cannot be taken it is not offered, and asked for anyway (the
  chord, `/restart`) it is refused with why — one rule, `agentRestart`:
  - A terminal Agent: its CLI is the terminal's own process, which DevHub's
    host does not start. Continue it in the GUI to restart it there, or stop
    it and resume its session in a new one.
  - The host lost: the host is what starts the CLI again. DevHub attaches
    again every round.
  - A protocol mismatch, or DevHub failing on what it read: DevHub stopped
    reading the journal there, and would stop at the same line again. Continue
    it in a terminal.

## MCP servers (`/mcp`)

`/mcp` in a GUI Agent opens DevHub's MCP panel, a sheet drawn like the other
pickers: every MCP server the Agent's CLI reports, how it stands (Connected,
Needs sign-in, Failed with its reason, Connecting, Disabled) and where it is
configured (Claude's `scope`: `user`, `project`, `local`, `claudeai`,
`managed`…; for Codex, the plugin it came with). Nothing about MCP is written
into the conversation itself. It is DevHub's own command, offered for Claude
and Codex alike.

- **The list** is the CLI's answer to its documented status request, asked
  when the panel opens and again after each action is done: Claude's
  `mcp_status` control request (the Agent SDK's `mcpServerStatus()`, which a
  Claude Agent also asks once it is up and after each turn, beside the
  statuses each turn's `system/init` reports), Codex's `mcpServerStatus/list`
  for the thread (every page). Plugins Claude says did not load are listed
  under it.
- **Actions** are only the ones the CLI has a documented request for, offered
  per server as it stands:
  - *Reconnect* — Claude: `mcp_reconnect` (`reconnectMcpServer(name)`).
    Codex has no per-server request; its `config/mcpServer/reload` reconnects
    every server, and the panel shows them all working until it answers.
  - *Enable* / *Disable* — Claude: `mcp_toggle` (`toggleMcpServer(name,
    enabled)`). Codex keeps this in its config file, which DevHub does not
    write, so it is not offered.
  - *Sign In…* — for a server that needs it (Claude `needs-auth`; Codex
    `authenticationRequired`, or no sign-in yet), see below.
  A request the CLI refused is said in the panel's footer with the CLI's
  words, until the next action replaces it.
- **Signing in** runs the CLI's own documented `mcp login <server>` (Claude
  Code's CLI reference, "claude mcp login"; Codex's `codex mcp login`) on the
  Agent's machine, with the Agent's profile's program and environment, in the
  Workspace folder, so the credentials land where the Agent reads them. It runs
  on a pseudo-terminal, because Claude's command needs an interactive terminal
  when it cannot open a browser (over SSH it prints the authorization URL and
  asks for the redirect URL to be pasted back). The panel shows what it prints
  as it prints it, its URLs as links that open in the default browser, and a
  line typed under it goes to its prompt — paste the address the browser ended
  on there if the command asks. On this Mac the command may open the browser
  itself. When it succeeds DevHub has the Agent reconnect that server, and the
  list is asked again. One sign-in runs at a time per Agent; it can be
  cancelled, and one that has ended stays in the panel until it is dismissed
  or the next starts. It is DevHub's, not the journal's: quitting DevHub stops
  it.
- **The browser's way back.** The authorization URL's `redirect_uri` is
  `http://localhost:<port>/…` on the machine the command runs on. For an Agent
  on an SSH host DevHub forwards that port from this Mac to the host for as
  long as the command runs (`ssh -O forward -L <port>:localhost:<port>` over
  the host's existing master), and cancels the forward when the command ends,
  whether it succeeded or not; the panel says it is forwarded. A local Agent
  needs no forward. A forward that cannot be made (the port is taken on this
  Mac) is said in the panel with ssh's words, and the sign-in goes on: pasting
  the redirect address at the prompt still finishes it. A Workspace whose
  editor is in a dev container runs its Agents where its folder is, not in the
  container, so its sign-in is forwarded (or not) exactly as that machine's
  other Agents' are.

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
- **Codex** (codex 0.156.1; protocol types vendored at 0.158.0):
  - Only the real `app-server` handshake and the not-signed-in path have been
    checked against the real CLI, from a signed-out capture
    (`codex/fixtures/signed-out.capture.ndjson`).
  - Turns, approvals, subagents and everything else are tested only against
    fixtures written by hand from the vendored protocol types (multi-agent v2
    subagents from the 0.158.0 sources). Expect a
    protocol-mismatch notice where the real CLI differs.
- **Dev Containers** do not run Agents. A Workspace whose editor is attached
  to a dev container runs its Agents, TUI and GUI, on its own machine — this
  Mac, or the SSH host its folder is on — exactly as it would with the editor
  on that machine. See [Dev Container development](remote-containers.md).
- **SSH Agents** have not been checked on a real remote host.

## Usage limits in the Sidebar

The foot of the Sidebar says how much of Claude's and Codex's rate limits is
used: one slim row per CLI — its name, a bar, the percentage and when that
window resets, *12% (until 16:50)* — for its window that resets soonest among
the current readings (the five-hour one, usually). The reset is the time on
the 24-hour clock while it is within twelve hours, past midnight too, and the
date alone in the reader's locale (*10/3*) when further off; an unknown or
past reset has no parenthesis, and a narrow column cuts the parenthesis before
the percentage. The row's bar and numbers are quiet grey until 75%, orange to
90%, red beyond — by the strictest of the CLI's current windows, not only the
shown one; when the colour comes from another window, a small caption under
the bar names it by the CLI's label (*Approaching 7-day limit*, *7-day limit
nearly reached*). The rows share one grid, so every CLI's bar has the same
width and edges whatever the words beside it. On the collapsed rail the words
go and the bars stay. The tooltip draws every window each CLI reports — Claude's
five-hour and seven-day (`unifiedWindows` of its `rate_limit_event`), Codex's
`primary` and `secondary`, named by their length (`5-hour`, `7-day`) — as a
labelled bar with the percentage and its reset (*Resets in 2h 10m · 16:40*,
or the date alone, *10/3*, when over twelve hours away), worked out by the tooltip as it opens. A reading
whose reset has passed is history: faded, and said to be (*nothing reported
since*); history neither is the Sidebar row's shown window nor colours it, and a CLI
whose readings are all history shows the one nearest its limit, faded and
uncoloured.

The numbers come from two places, merged per window in main. **DevHub asks
the accounts itself**, in the background (`main/shell/usageReaders.ts`): one
long-lived process per CLI, started on this Mac a moment after the window is
up with the *first* profile of that kind in Settings' order — its command and
environment, not its arguments, which are for a conversation — and stopped on
quit. With several profiles of a kind, only the first is read. Claude's is
`claude -p` in stream-json with `--no-session-persistence` and hooks off
(`disableAllHooks`), sent the control requests `initialize` and then
`get_usage` (the SDK's `SDKControlGetUsageRequest`, which it marks
experimental); its `rate_limits.five_hour` and `seven_day` are read, already
0–100 with the reset as an ISO time. Codex's is `codex app-server`, sent
`initialize`/`initialized` and per reading `account/read` and, for a ChatGPT
sign-in, `account/rateLimits/read` (the request Codex's own TUI polls) — the
same `RateLimitSnapshot` as the notification. Neither is ever sent a message
or a thread, so no turn and no model call happens. They are asked at start and
then on Codex's TUI rule, by the most used window of the last reading: every
60 s, 30 s from 75%, 15 s from 90%, 5 s from 99%; Claude's experimental
endpoint stays at 60 s until a window reaches 90% (then 15 s, and 5 s from
99%). **And the running GUI Agents report** the same limits — Claude's
`rate_limit_event`, Codex's `account/rateLimits/updated`. Both go through one
entry, per window of each CLI, the newer of two readings being the one with
the later reset (or, for the same reset, more used), since journals replay in
no particular order at startup. A report that leaves a window out (Codex's
sparse updates) keeps that window as last seen.

A sign-in with no plan limits — Claude's `rate_limits_available: false`, a
Codex API key or Bedrock — is a state, not a failure: with no window read, the
row says *No plan limits* in place of a bar (nothing on the rail), and the
tooltip says why. A profile whose command is not on this Mac starts no reader,
and the tooltip says that instead. A reader that fails — its process will not
start or stops, the CLI refuses the request, or answers in a shape DevHub does
not read (checked strictly, because `get_usage` is experimental) — says so
once as a notice (*DevHub could not read a CLI's usage limits*), and stops:
there is no retry until DevHub is restarted, and the readout goes on with what
GUI Agents report. A CLI nothing has read says so in the tooltip (*Not read
yet*) rather than showing zero, and while neither has anything to say nothing
is drawn. The conversation itself shows no rate limits, except when one has
stopped it (below).

## Going on after a usage limit

When a usage limit stops a GUI Agent's turn, DevHub goes on with it by
itself once the limit has reset. Which turns count is each CLI's own
documented word, read by its adapter onto the turn's end
(`TurnEndEntry.limit`):

- **Claude**: the turn's answer is the API's `rate_limit` error (the
  `error` of the `assistant` message, the SDK's `SDKAssistantMessageError`),
  or the turn failed (`result.is_error`) after a `rate_limit_event` whose
  `status` was `rejected`. The reset is that event's own `resetsAt`, the
  window `rateLimitType` names; without one, the reset of a window the
  events report as used up (100%).
- **Codex**: the turn failed with `codexErrorInfo` `usageLimitExceeded`. The
  reset is that of the window `account/rateLimits/updated` reports as used
  up; a report that comes after the turn ended still fills it in.

A turn the person stopped is never a limit. While such a turn's end is the
last thing in the conversation — nothing running, written, held or asked
since — the conversation stands stopped at the limit, and a quiet line at
its end says what DevHub will do: *Rate limited — resuming at 16:50* (the
time as the Sidebar gives it, within twelve hours; the short date and time
further off) with **Cancel**. Thirty seconds after the reset (the CLI's clock
and this Mac's differ), DevHub writes `[agents] resume_after_limit_message`
(default *続けて*) through the conversation's one send, as the person's: it
is drawn as their bubble, marked *Sent automatically after the limit
reset*, and can be rewound to like their own. Nothing is written sooner
than thirty seconds after the line appeared.

One rule ends it: anything that moves the conversation on — the person's
words, a turn the Agent starts on its own, Restart session, a rewind,
`/resume`, the Agent stopped, closed or continued in a terminal — leaves the
stop no longer standing, and the resume goes with it; so does Cancel. A
limit whose reset the CLI did not say is not resumed, and the line says so
(*not resuming by itself: the CLI did not say when the limit resets*), as it
does for one whose reset had already passed when DevHub read it; **Dismiss**
puts either away. A write that fails is said on the line (*could not
resume: …*, with a warning's weight) and is not tried again.

It survives a restart of DevHub. What was decided about each Agent's last
stop — its turn end, the journal offset it first stood at, and when the
message is due or that it is over — is kept in `limit-resumes.json` beside
`state.json` (`main/agent/conversation/limitResume.ts`), and goes when the
Agent does. The next DevHub replays the journal and picks the recorded stop
up again: at the same time, or thirty seconds after start when the time
passed while it was down; an earlier stop the replay passes on the way is
history, and a stop after it (one that happened while DevHub was down) is
new. Settings → General → Agents turns it off (`[agents]
resume_after_limit = false`) and sets the message, which may not be empty;
turned off, a resume already shown is not written when it comes due.

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
  found; a session file over 32 MiB is resumed without its past drawn rather
  than read in part.
  Past turns show no context figure until the next turn reports one (neither
  CLI hands it back), and a Claude history has no turn endings between its
  messages.

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
- **A notice about an event DevHub does not know.** Nothing is wrong with
  the conversation. The notice carries the event as the CLI printed it
  (*Event as received*), which is what a bug report needs, and each kind of
  event is said once, however often it arrives. Its level follows one rule:
  - An event *beside* the conversation, which the CLIs add with new versions
    — a Claude `system` event of a subtype DevHub has never heard of, a
    Codex notification of a method DevHub has never heard of — is a quiet
    information line, *claude 2.1.0 reported "…"* or *codex … reported `…`*.
    The CLI is telling DevHub something about itself; the conversation's
    content does not arrive this way, so nothing of it is missing.
  - An event that may *be* the conversation — a Claude line of a type,
    stream event, delta or content block DevHub has never heard of, a Codex
    item of a type the protocol does not name — is a warning, *… DevHub
    does not know*: something the Agent said or did may not be drawn.
  - An event DevHub knows that arrives broken — a line that is not JSON, a
    known event without a field DevHub reads, a system event with no
    subtype — is not a notice at all: it is a "Protocol mismatch" (above).
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
- MCP from the command line (`claude mcp login`, `--no-browser`, the paste
  step over SSH) — <https://code.claude.com/docs/en/mcp> and
  <https://code.claude.com/docs/en/cli-reference>; the control requests
  `mcp_status`, `mcp_reconnect`, `mcp_toggle` and `McpServerStatus` in the
  Agent SDK's `sdk.d.ts`; Codex's `mcpServerStatus/list`,
  `config/mcpServer/reload` and `codex mcp login` in
  `app-server-protocol/schema/typescript` and `codex-rs/cli/src/mcp_cmd.rs`
  at `rust-v0.158.0` in openai/codex
- Claude Agent SDK TypeScript reference, `resumeSessionAt`,
  `resumeDropsTurn`, `forkSession`, `enableFileCheckpointing` —
  <https://code.claude.com/docs/en/agent-sdk/typescript>
- Codex app-server `thread/revert` and the removal of `thread/rollback`:
  `codex-rs/app-server/README.md` and
  `app-server-protocol/schema/typescript/v2/ThreadRevertParams.ts` at
  `rust-v0.156.1` in openai/codex
- A local slash command's answer over stream-json, observed on 2026-09-28
  with Claude Code 2.1.273, 2.1.281 and 2.1.283 (`/mcp`, `/mcp reconnect`,
  `/cost`, with `--no-session-persistence` and no network, so no prompt
  reached a model): the turn's `init`, one `<synthetic>` assistant message
  carrying `local_command_run` and `local_command_source`, and a `result`
  with `num_turns` 0; no echo and no `local_command` event. On 2026-09-29
  with 2.1.284 in a fresh session (`--no-session-persistence`): `/compact`
  with nothing to compact answers the same way (`local_command_outcome`
  failed, an empty `result`), `/cost` names `usage` in `local_command_run`
  and `cost` in the `result`'s `local_command`, and `/clear` prints
  `conversation_reset`, its `init` and its `result` only. The Agent SDK's
  types say a local command's output comes on a synthetic assistant message
  (`context_usage`) and that `terminal_reason` is unset when the loop was
  bypassed for a local slash command
- `/compact` and `/clear` in the Agent SDK —
  <https://code.claude.com/docs/en/agent-sdk/slash-commands> (a
  `compact_boundary` only when compaction ran, and a `success` result either
  way); `SDKStatusMessage` (`status` `compacting`, `compact_result`,
  `compact_error`), `SDKCompactBoundaryMessage` (`pre_tokens`,
  `post_tokens`) and `SDKConversationResetMessage` in the Agent SDK's
  `sdk.d.ts`
- Codex skills: `skills/list` and `UserInput`'s `skill` in
  `app-server-protocol` at `rust-v0.156.1` in openai/codex, and "run
  `/skills` or type `$` to mention a skill" —
  <https://learn.chatgpt.com/docs/build-skills>
- Codex app-server and authentication —
  <https://learn.chatgpt.com/docs/app-server>,
  <https://learn.chatgpt.com/docs/auth>
- openai/codex (Apache-2.0) — <https://github.com/openai/codex>
