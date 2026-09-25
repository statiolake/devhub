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
two places:

- **The profile's default.** `presentation = "tui" | "gui"` on an
  `[[agent_profiles]]` table in `settings.toml`. Absent means `"tui"`. A `"gui"`
  on a kind that cannot be one is refused as an invalid profile, at the key.
- **This launch, the other way.** In New Agent (the sidebar's sheet, and the
  Agent step of the workspace picker), each row says `GUI` or `TUI`. Holding ⌥
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

- write messages, including mid-turn;
- answer permission and question requests;
- interrupt a turn;
- change the model, effort and permission mode;
- use slash commands.

It covers what a turn does, not everything a CLI's own terminal UI has.

**Everything that is drawn**: Markdown with tables and code (coloured once
each block is complete), thinking folded, plans,
tool calls with their input and output or diff, subagents nested under the
call that started them, notices, turn ends with duration and cost, usage and
rate limits in the header, and pending requests as cards with the CLI's own
choices.

**Claude Code: what does not come across**

- Terminal-only commands. `/login` and `/logout` are not offered. `/model`,
  `/effort` and `/permissions` open the header's pickers instead of being sent.
- The terminal UI's own screens: the interactive `/config`, the `/resume`
  picker and the folder-trust dialog (see [Folder trust](#folder-trust-hooks-and-mcpjson-run-without-asking)).
- Hook events. `--include-hook-events` is not passed, and hook events that
  arrive anyway are known and not shown.
- `tool_progress` and `prompt_suggestion`.
- Thinking the API withholds (it sends the block without its text), redacted
  thinking, citation deltas, and images inside messages.

**Codex: what does not come across**

- Only `/model`, `/effort` and `/approvals` are offered as commands. They open
  the header's pickers. Codex has no protocol-level slash commands, and review,
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

## Not signed in, and Continue in terminal

When the CLI is not signed in, the conversation stops and the Agent's pane
says so:

- Claude reports it on its first answer (`authentication_failed`).
- Codex reports it at `account/read`.

The pane then offers **Open a terminal to sign in**, which starts a terminal
Agent from the same profile. Run `/login` (Claude) or `codex login` there,
then start a new GUI Agent. DevHub never signs in on your behalf.

**Continue in terminal** is the way out of a GUI Agent:

- It is in the pane's header, and on the failure over the pane when the
  conversation broke (the host was lost, a protocol mismatch, or the CLI
  refused to start).
- It starts a terminal Agent from the same profile, resuming the same
  session: `claude --resume <session id>`, or `codex resume <thread id>`.
- It selects that Agent, and stops the GUI one once the new one is running.
- If the conversation has no session yet, it is refused with the reason. If
  the new Agent fails to launch, the GUI Agent keeps running.

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
terminal. The header's Permissions picker shows the mode the session reports
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
- **The journal is never trimmed.** Partial messages are journaled too, so a
  long session's `out` can reach tens of megabytes, and a restart reads all of
  it once.

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
- Codex app-server and authentication —
  <https://learn.chatgpt.com/docs/app-server>,
  <https://learn.chatgpt.com/docs/auth>
- openai/codex (Apache-2.0) — <https://github.com/openai/codex>
