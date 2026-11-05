/**
 * `/devhub`: the skill DevHub gives the Agents it starts, so that an Agent can
 * be asked to drive DevHub itself — open a workspace, start another Agent,
 * hand an Issue on, watch the others and answer their questions — through
 * `devhub --tell`.
 *
 * Nothing of the person's is touched: no `~/.claude`, no `~/.codex`. DevHub
 * writes the skill into its own user-data directory on every start, beside a
 * `devhub` launcher that names this DevHub's socket, and points the Agents it
 * launches at it:
 *
 * - Claude (terminal and GUI): `--add-dir=<root>`. Claude Code loads
 *   `<dir>/.claude/skills/*` from every added directory as ordinary,
 *   un-namespaced skills — so the person types `/devhub`, not the
 *   `/devhub:devhub` a `--plugin-dir` plugin would be. (Checked against
 *   Claude Code 2.1: the `skills` list `system/init` reports includes
 *   `devhub` with `--add-dir=<root>` and not without.) The `=` form matters:
 *   `--add-dir` takes several directories, and a bare one would swallow the
 *   arguments after it.
 * - Codex (GUI): the thread's `developerInstructions` say that `/devhub` and
 *   `$devhub` mean "read and follow this SKILL.md". Codex has no flag that
 *   adds a skills directory, and its own skill roots are the person's.
 *
 * GUI Agents are also told to write the files they mention as Markdown links
 * to the local path, and that ```mermaid and ```svg blocks are drawn
 * (`GUI_AGENT_INSTRUCTIONS`, `conversation/linkInstructions.ts`):
 * Claude by `--append-system-prompt` (`conversation/claude/argv.ts`), Codex in
 * the same `developerInstructions` (`codexGuiInstructions`). Terminal Agents
 * are not: their screen draws no Markdown.
 *
 * Agents on another machine (an SSH host) get the same text, written there
 * under `~/.devhub/terminal/skill-<tag>/` by `RemoteShellRuntime.terminalLauncher`
 * beside the `devhub` shim DevHub installs on that machine, whose full path
 * it names. That shim reaches this DevHub over the control socket
 * reverse-forwarded onto the host (`ssh -O forward -R`), and says which
 * machine it is on, so paths it sends are read there (`docs/remote-ssh.md`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../../model/domain.js";
import { GUI_AGENT_INSTRUCTIONS } from "./conversation/linkInstructions.js";

export interface DevhubSkill {
	/** The directory handed to Claude's `--add-dir`. */
	readonly root: string;
	/** The SKILL.md itself, for Codex's instructions. */
	readonly skillFile: string;
	/** The launcher the skill tells the Agent to run. */
	readonly cli: string;
}

export function devhubSkillPaths(userDataPath: string): DevhubSkill {
	const root = join(userDataPath, "devhub", "agent-skill");
	return {
		root,
		skillFile: join(root, ".claude", "skills", "devhub", "SKILL.md"),
		cli: join(root, "bin", "devhub"),
	};
}

/** Write the skill and its launcher. Called on every start: the paths in them move with the app. */
export function writeDevhubSkill(skill: DevhubSkill, launcher: string): void {
	mkdirSync(join(skill.root, ".claude", "skills", "devhub"), {
		recursive: true,
		mode: 0o700,
	});
	mkdirSync(join(skill.root, "bin"), { recursive: true, mode: 0o700 });
	writeFileSync(skill.cli, launcher, { mode: 0o700 });
	writeFileSync(skill.skillFile, devhubSkillText(skill.cli), { mode: 0o600 });
}

/**
 * `devhub --tell skill`: the SKILL.md `writeDevhubSkill` writes under
 * `userDataPath`, and the launcher it names — for an agent DevHub did not
 * start, which has no skill directory handed to it.
 */
export function devhubSkillAnswer(userDataPath: string): {
	readonly text: string;
	readonly cli: string;
} {
	const skill = devhubSkillPaths(userDataPath);
	return { text: devhubSkillText(skill.cli), cli: skill.cli };
}

/**
 * The profile an Agent on this machine is launched with: the person's own
 * arguments, then the one that makes `/devhub` a skill. Codex is told in its
 * thread instead (`codexDevhubInstructions`), so its argv is left alone.
 */
export function withDevhubSkill<T extends Pick<AgentProfile, "kind" | "args">>(
	profile: T,
	skill: DevhubSkill | undefined,
): T {
	if (skill === undefined || profile.kind !== "claude") return profile;
	const flag = `--add-dir=${skill.root}`;
	if (profile.args.includes(flag)) return profile;
	return { ...profile, args: [...profile.args, flag] };
}

export function codexDevhubInstructions(skill: DevhubSkill): string {
	return [
		"DevHub skill: when the user's message starts with /devhub or $devhub, or asks you to drive DevHub",
		"(open a workspace, start or hand work to another agent, check on or answer other agents),",
		'or asks you to prepare, open, use or close your terminal ("open a terminal", "the terminal on the right", "右のターミナル"),',
		`read ${skill.skillFile} and follow it. It explains the \`${skill.cli} --tell\` command.`,
	].join(" ");
}

/**
 * Everything a Codex GUI Agent's thread is told: the `/devhub` skill's
 * pointer once the skill is written on the Agent's machine, any further
 * skill's pointer this Agent alone has (the orchestrator's,
 * `orchestrator/orchestratorSkill.ts`), and always how to link files.
 */
export function codexGuiInstructions(
	skill: DevhubSkill | undefined,
	more: readonly string[] = [],
): string {
	return [
		...(skill === undefined ? [] : [codexDevhubInstructions(skill)]),
		...more,
		GUI_AGENT_INSTRUCTIONS,
	].join("\n\n");
}

export function devhubSkillText(cli: string): string {
	return `---
name: devhub
description: Drive DevHub, the app this agent runs in - open workspaces, start agents, hand GitHub Issues to new agents with a good branch name, monitor, message, answer, stop, restart and resume other agents (orchestrate several from one session), and open your own terminal (on the right of your pane) and drive it with tmux. Use when the user says /devhub, explicitly asks for another agent or workspace in DevHub, or asks to prepare / open / use a terminal ("open a terminal", "the terminal on the right", "右のターミナル"). Not for subagents: "use a subagent" / "サブエージェント" / parallel helpers mean your own CLI's subagents, not DevHub agents.
---

# /devhub - drive DevHub from here

You are running inside DevHub. This command talks to the running DevHub app:

    "${cli}"

It is called \`devhub\` below; always run it by that full path, in double
quotes (the path may contain spaces), e.g. \`"${cli}" --tell agents\`. Everything it
does is something the person could do in DevHub's window; you are doing it for
them.

**If DevHub did not start you** (Claude Desktop, another tool running shell
commands - you read this through \`devhub --tell skill\`): everything below
works the same, with three differences. Name yourself with \`--as NAME\` right
after \`--tell\` (\`devhub --tell --as claude-desktop agents\`): it is who
answered a question, and what you have read for \`agent wait --any\`; without
it every outside caller is one reader, "external". You have no workspace of
your own, so pass \`--workspace\` wherever it is taken. And you have no
terminal: the \`terminal\` commands are an agent's own and are refused.

**When asked via /devhub, delegate - do not do the work yourself.** "/devhub
handle this Issue" means: start another agent on it and report back. Do not
start editing the Issue's code in your own session.

**A subagent is not a DevHub agent.** When the person asks you to use a
subagent, sub-agents, a helper or parallel workers ("サブエージェントで",
"use a subagent", "in parallel"), use your own CLI's subagent mechanism (in
Claude Code the Agent / Task tool; in Codex its own sub-agents) and keep the
work in this session. Start a DevHub agent with \`devhub --tell agent new\`
only when the person says /devhub or explicitly asks for another agent,
pane or workspace in DevHub (a new agent they will see and talk to), or to
hand an Issue on.

Add \`--json\` right after \`--tell\` for machine-readable output (recommended
when you parse results): \`devhub --tell --json agents\`.
Full reference: \`devhub --tell help\`.

**Pass every choice explicitly.** Commands that start something have no
defaults: \`agent new\` needs \`--workspace\`, \`--profile\` and \`--gui\` or
\`--tui\`; \`issue assign\` needs \`--repo\`, \`--branch\` or \`--root\`,
\`--profile\`, \`--gui\` or \`--tui\`, \`--action\` and \`--send\` or
\`--draft\`. Run \`profiles\` and \`issue actions\` first to see the values
(and \`workspaces\` for W). A call missing one does nothing and says which
flags, and their values. No \`--tell\` command opens a picker in the window
or takes the person's screen: what you start appears in the Sidebar,
unselected, and only \`focus\` (when the person asked to be shown something)
goes there.

## Look around

    devhub --tell workspaces                # id, name, folder, branch, worktree, Issue, PR, unresolved conversations, CI, agents
    devhub --tell --json workspace status W # one workspace: Issue, PR (draft), unresolved conversations, CI counts, fetchedAt (null: unknown)
    devhub --tell agents [--workspace W]    # id, name, kind, status, unread, open requests, meta
    devhub --tell profiles                  # agent profiles: id, kind, --gui/--tui, available
    devhub --tell issue actions             # Issue actions: id, label, wording (and none)

W is a workspace id, its folder path, its name, or \`scratch\`. Folder paths
are paths on the machine you run on (on an SSH host, the host's). Agents are
named by id (a unique prefix of 4+ characters works) or by their name.
Status is one of working, background, waiting (needs somebody), idle, error.

## Open a workspace and start an agent there

    devhub --tell workspace open ~/src/app
    devhub --tell agent new --workspace ~/src/app --profile claude --gui --name "API fix" --prompt "Fix the failing test in api/"

\`workspace open\` answers the workspace id. Profiles are the person's
configured agent profiles (\`profiles\`); use GUI (\`--gui\`) for agents you
will read and answer, as only a GUI agent's transcript can be read.
\`--prompt\` is typed into the new agent once it is ready (without it the
agent waits idle). For long prompts use \`--prompt -\` and pipe the text in
on stdin. \`agent rename A NAME\` (\`agent rename A --clear\` drops it)
names an agent, yourself included.

## Hand a GitHub Issue (or PR) to a new agent

    devhub --tell issue actions
    devhub --tell issue assign https://github.com/OWNER/REPO/issues/123 --repo ~/src/REPO --branch 123-fix-login-timeout --profile claude --gui --action issue_assignment --draft

- Read the Issue first (title/body, e.g. with \`gh issue view\`) and choose a
  short descriptive branch name: \`<number>-<a-few-words>\`, lowercase, words
  joined by \`-\`, e.g. \`123-fix-login-timeout\`. Keep the Issue number first;
  DevHub links a workspace to its Issue by it. For a pull request pass its own
  branch (\`gh pr view N --json headRefName\`).
- \`--repo\` is the clone to work in (find it with \`workspaces\`, or ask the
  person). \`--branch\` makes (or opens) a worktree of the branch;
  \`--root\` works in the clone itself instead (with \`--branch\`: switched
  to it; alone: as it is).
- \`--action\` is one of \`issue actions\` (or \`none\`: the agent is told
  nothing). \`--draft\` puts its wording into the new agent's input box
  unsent - the person reads it and sends it; \`--send\` sends it at once.
  Use \`--draft\` unless the person asked for the agent to start working.
- \`--prompt "..."\` adds your own instructions for the new agent (scope,
  constraints, what the person said). \`--editor-only\` (with \`--repo\` and
  \`--branch\`/\`--root\` only) opens the editor without an agent.

Then tell the person which agent took it (id, workspace, branch).

## Monitor other agents

    devhub --tell agent wait A --until any --timeout 300   # returns when A is idle or waiting
    devhub --tell agent read A --last 20                   # transcript tail (GUI agents)
    devhub --tell agent read A --since CURSOR              # only what is new since the last read
    devhub --tell agent read A --entry ID                  # one clipped entry in full (--full: all of them)

\`agent read\` prints a cursor on its last line (\`cursor ...\`; \`cursor\` in
JSON); pass it to \`--since\` next time. \`agent wait\` is the way to wait: do
not poll in a tight loop.

## Talk to them

    devhub --tell agent send A "Please also add a test for the empty case."
    devhub --tell agent interrupt A

A message to a busy agent is held and delivered when its turn ends, just like
the person's composer does. Terminal agents get it typed in once they are
idle; reading, interrupting and answering need a GUI agent.

## Answer their questions

    devhub --tell agent requests A
    devhub --tell agent answer A REQUEST_ID --option 2
    devhub --tell agent answer A REQUEST_ID --text "Use PostgreSQL"
    devhub --tell agent answer A REQUEST_ID --q 1 --option 2 --q 2 --option 1 --option 3 --q 3 --text "Use PostgreSQL"

One request can carry several questions (Claude asks up to four at once):
\`agent requests\` lists each as \`--q N\` with its options numbered within it
and whether it takes several (\`multiSelect\`) or words of its own
(\`--text\`). Answer them all in one call, \`--q\` then that question's
\`--option\`s and/or \`--text\`; a question left out is refused and nothing
is sent.

Only questions (AskUserQuestion-style) can be answered here. Permission
prompts (may a tool run) are listed as "answer in DevHub": they are the
person's decision - tell the person, never try to get around it. When unsure
what the person would want, ask the person instead of answering. Your answer
is recorded in that agent's transcript as answered via devhub CLI by you.

## Orchestrating other agents

When the person asks you to run or coordinate several DevHub agents, loop:

    devhub --tell --json agents                    # or: agent status A (one agent in detail)
    devhub --tell --json agent wait --any [A B ...] [--workspace W] --timeout 600
    devhub --tell --json agent read A --since SINCE # the wait's since (null: --last 20)
    devhub --tell agent answer A REQ --option 1     # questions only
    devhub --tell agent send A "next step ..."
    # ... and wait --any again

\`wait --any\` returns as soon as one of them (default: every GUI agent but
you) has something you have not read: its turn is over with new output, or a
request you have not seen. It names which, why, and the \`--since\` to read
from. What you have not read stays reported until you \`agent read\` it (a
request: until you read or list it with \`agent requests\`), so nothing that
happens between two calls is missed - always read before waiting again.
\`agent wait --all ...\` waits until every one is idle (or waiting).

- **Permission prompts are the person's.** When a wait reports one ("answer
  in DevHub"), tell the person - \`devhub --tell notify "A needs your
  permission: ..."\` - and go on with the others. Never try to approve it.
- \`agent stop A\` stops an agent that is done or going wrong;
  \`agent restart A\` starts its CLI again on the same session (stuck, or
  after a configuration change). Either one stops a running turn; you cannot
  stop or restart yourself. Prefer \`agent interrupt A\` to stop just a turn.
- Close a workspace (as the window's Close Workspace; never your own):

      devhub --tell workspace close W --worktree keep --agents stop --terminals close --discard-unsaved

  Each flag answers one question the window would ask and is required when
  it applies (\`--worktree remove\` deletes a worktree's folder). Run it
  without them first: it closes nothing and lists the open questions; ask
  the person before stopping their agents or discarding unsaved work.
- \`sessions [--workspace W] [--meta K=V]...\` lists earlier sessions (with the
  meta their stopped agents had); \`agent resume ID [--name N]\` goes on with one
  in a new GUI agent, its name and meta given back; \`session meta ID [set K V
  | unset K]\` tags a stopped one. \`sessions --folder PATH\` / \`--all\` look beyond
  your workspace; \`agent resume\` opens a closed folder unfocused.
- **Tag the agents you start**: \`--meta parent=YOUR_ID --meta role=reviewer\`
  on \`agent new\` and \`issue assign\`, then find them again with
  \`agents --meta parent=YOUR_ID\`. \`agent meta A [set KEY VALUE | unset
  KEY]\` reads or changes an agent's pairs; they show in its row's tooltip.
  Your own id is in \`DEVHUB_ORIGIN\` (its last field).

## The Orchestrator row: escalations for the person

If you are the orchestrator (the agent on DevHub's Orchestrator row), the
person reads a board of escalations and answers them in DevHub - only there;
no command answers one. Raise one when work cannot go on without the
person's decision or permission (finish read-only investigation first):

    devhub --tell escalation new --title T --body - [--agent A] [--link URL] [--option TEXT]  # repeatable; body on stdin
    devhub --tell escalation ask 12 --body -        # a follow-up on the same ticket
    devhub --tell escalation show 12                # the thread, the person's answers too
    devhub --tell escalation close 12 [--note TEXT] # the answer is used up
    devhub --tell --json board                      # needs_answer, in_progress, waiting

The body is Markdown drawn like a chat answer (code, math, mermaid, svg).
Related agents, workspaces, files and escalations can be pasted as devhub: links, in \`--link\` or as \`[text](devhub:...)\` here or in chat (\`devhub --tell link agent A | workspace W | file PATH[:L] | escalation ID\` prints one).
\`agent wait --any\` also wakes you on an answer you have not shown. DevHub also sends you each such event as a message (\`[event: ...]\`).
See docs/orchestrator.md in DevHub for a recommended escalation template.

## Your terminal

You have one terminal of your own: a tmux session on your workspace's machine,
in your workspace's folder, drawn with your pane in DevHub's window: on its
right when your pane fills the view, under it when your pane is beside the
editor. It is only on screen while your pane is — with the editor alone it is
hidden. It is yours alone and the same one every time — it stays when the
person switches to another agent or to the editor (hidden, still running) and
goes when you are closed.
**"The terminal on the right", "右のターミナル", "the terminal", "your
terminal", "隣の" all mean this one** — including when the person opened it
themselves with Cmd+Q V.

When the person asks you to "prepare a terminal" / "open a terminal" (to run a
server, tests, a REPL...), use it rather than running a long-lived process in
your own shell:

    devhub --tell --json terminal open [--command CMD] [--focus]
    devhub --tell --json terminal status      # the same answer, without opening it

\`open\` starts it, or shows it if it is already running (idempotent: the same
handle every time). \`--command\` is typed into its shell only when this call
starts it — into a running terminal, use \`send-keys\` yourself. It does not
take the person's keyboard unless you pass \`--focus\`. The answer
(\`terminal\` in JSON) says whether it \`exists\`, is \`open\` / \`visible\` /
\`focused\` (\`visible\` is \`open\` and your pane on screen), and gives the
handle:

    "tmux": { "tmux": "/path/to/tmux", "socket": "/private/tmp/tmux-501/devhub",
              "session": "tm-<id>", "target": "%7", "fullTarget": "tm-<id>:0.0",
              "prefix": ["/path/to/tmux", "-S", "/private/tmp/tmux-501/devhub"] },
    "panes": [ { "target": "%7", "where": "whole", "left": 0, "top": 0,
                 "width": 160, "height": 48, "command": "zsh", "active": true, ... } ]

\`target\` is the active pane (the one the person sees typed into). Tell the
person which session it is (\`tm-...\`); the pane itself shows no title, so
that name is how they find it (\`terminal show\`).

Drive it with plain tmux, always through the handle's own \`prefix\` (that
tmux and \`-S\` socket — not your default tmux) and \`-t <target>\`:

    T="/path/to/tmux"; S="/private/tmp/tmux-501/devhub"; P="%7"
    "$T" -S "$S" send-keys -t "$P" -l -- 'npm test'   # the text, literally
    "$T" -S "$S" send-keys -t "$P" Enter              # then Return, separately
    "$T" -S "$S" capture-pane -p -J -t "$P" -S -200   # read the last ~200 lines

- Always \`send-keys -l\` for text (without \`-l\`, words like \`Enter\` or \`C-c\`
  are keys), and send \`Enter\` as its own call. \`C-c\` without \`-l\` interrupts.
- Then wait and read: poll \`capture-pane\` every few seconds (\`sleep 2\`
  between reads), stop when the prompt is back or the output you need is
  there, and give up after a sensible timeout. Do not spam keys or poll in a
  tight loop; never type into a pane that is waiting for a password.
- Do not kill the session or send \`exit\` unless asked; close it with
  \`devhub --tell terminal close\` when the person is done with it.

**When the person split it.** It is a whole tmux session, so the person may
have split it (or opened windows) with tmux's own keys, and then say "the
bottom-right pane", "右下のペーン", "the left one", "上の". Do not guess and do
not type into the active pane by default: list the panes and pick by position.
\`terminal status\` lists them in \`panes\`, each with \`where\` (\`top-left\`,
\`top-right\`, \`bottom-right\`, \`left\`, \`bottom\`, \`middle\`, \`whole\`...),
its cells (\`left\`, \`top\`, \`width\`, \`height\`), \`windowIndex\`, \`active\`
and \`command\`. The same straight from tmux:

    "$T" -S "$S" list-panes -s -t tm-<id> -F '#{pane_id} #{window_index} #{window_active} #{pane_left},#{pane_top} #{pane_width}x#{pane_height} #{pane_active} #{pane_current_command}'

Pick by \`#{pane_left}\`,\`#{pane_top}\` within the window on screen
(\`window_active\` 1): "right" is the largest \`pane_left\`, "bottom" the
largest \`pane_top\`, "右下" both. Then use that pane's id (\`%N\`) as \`-t\`.
When two panes fit what the person said, ask which one instead of picking.

**Bringing the editor's terminal here.** The person may have been working in
the editor's own terminal (a DevHub terminal tab, the "main session" /
"メインセッション") and ask you to take it over: "bring the ssh terminal to the
right", 「メインセッションの ssh してる端末を右に持ってきて」. Move that pane
into your terminal; its process (the ssh, the server, ...) keeps running:

    devhub --tell --json terminal panes           # your workspace's editor terminals' panes
    devhub --tell --json terminal bring %7 [--focus]

\`panes\` gives each pane's \`pane\` (\`%N\`), \`session\`, \`windowIndex\` /
\`windowName\`, \`command\`, \`argv\` (what runs in front, e.g. \`ssh prod\`),
\`cwd\`, \`title\` and \`active\`. Pick by what the person said (the command or
host, the folder, the title); when more than one fits, ask which. \`bring\`
opens your terminal with that pane in it, or adds it as a split when your
terminal is already open, and answers your terminal's handle; drive the pane
by its id as above. A tab left with no pane closes in the editor. Only your
workspace's editor terminals can be brought — never an agent's pane.

## Other

    devhub --tell commands            # DevHub's command palette, by id
    devhub --tell run next_agent      # run one by id (one that would open a picker is refused)
    devhub --tell focus A             # select an agent (or a workspace W) in DevHub
    devhub --tell notify "Agent X finished the migration"
    devhub --tell usage               # each CLI's plan limits (5-hour, 7-day %, resets), as the Sidebar shows them

If a command fails, its message says why; fix the arguments rather than
retrying the same thing.
`;
}
