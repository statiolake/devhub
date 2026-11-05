/**
 * `devhub --tell`: what can be asked of the running DevHub by name.
 *
 * One vocabulary, read in two places. The CLI turns a command line into a
 * `TellCommand` (`parseTellArguments`) and sends it as the `tell` control
 * request; the app takes it back off the socket through `tellCommandFrom`,
 * which accepts exactly the shapes the parser can produce and nothing else.
 * Neither side trusts the other to have checked: a socket is a door anything
 * running as the user can knock on, and a command line is something a person
 * (or an Agent) typed.
 *
 * Every operation here is one the person can already do in DevHub's own
 * window — open a folder, start an Agent, hand an Issue to an Agent, write to
 * an Agent, answer the question it asked, stop or restart an Agent, resume
 * an earlier session — and it goes through the same path the window's does
 * (see `tell/service.ts`). The one thing deliberately left out is a
 * permission prompt: whether a tool call may run is the person's decision, in
 * DevHub, and no command line can make it for them.
 */

import {
	metaKeyProblem,
	metaValueProblem,
	parseMetaPair,
} from "../../../model/agentMeta.js";

export type AgentWaitUntil = "idle" | "waiting" | "any";

/** What `devhub --tell link` can make a link to. */
export type LinkTargetKind =
	| "agent"
	| "workspace"
	| "file"
	| "escalation"
	| "orchestrator"
	| "session";

const LINK_TARGET_KINDS: readonly LinkTargetKind[] = [
	"agent",
	"workspace",
	"file",
	"escalation",
	"orchestrator",
	"session",
];

/** The answer to one question of a request: `--q <question> --option <n>... --text <t>`. */
export interface AnswerPart {
	/** Its 1-based index in 'agent requests', its id, or its header. */
	readonly question: string;
	readonly options: readonly number[];
	readonly text?: string;
}

/** One `--meta KEY=VALUE`, checked (`checkMetaKey`, `checkMetaValue`). */
export interface AgentMetaPair {
	readonly key: string;
	readonly value: string;
}

export type TellCommand =
	| { readonly verb: "help" }
	/**
	 * The /devhub skill's text, for an agent DevHub did not start; with
	 * `orchestrator`, the /devhub-orchestrator skill's instead.
	 */
	| { readonly verb: "skill"; readonly orchestrator?: true }
	| { readonly verb: "workspaces" }
	| {
			readonly verb: "workspace-open";
			/** An absolute path, expanded on the CLI's side against its cwd. */
			readonly path: string;
			/** A branch to open a worktree of, made if it is not there yet. */
			readonly worktree?: string;
	  }
	| {
			/**
			 * The window's Close Workspace, every question its sheets ask given
			 * as a flag (`tell/windowActs.ts`, `closeAsTheWindowDoes`).
			 */
			readonly verb: "workspace-close";
			readonly workspace: string;
			/** A worktree Workspace's folder: kept, or removed. */
			readonly worktree?: "keep" | "remove";
			/** Busy agents stop with it. */
			readonly agents?: "stop";
			/** Running terminals end with it. */
			readonly terminals?: "close";
			/** Unsaved editors' changes are thrown away. */
			readonly discardUnsaved: boolean;
	  }
	/** One Workspace with its Issue, pull request, review and CI facts. */
	| { readonly verb: "workspace-status"; readonly workspace: string }
	| {
			readonly verb: "agents";
			readonly workspace?: string;
			/** Only the agents carrying every one of these (`--meta KEY=VALUE`). */
			readonly meta?: readonly AgentMetaPair[];
	  }
	/** The agent profiles, as the agent picker offers them. */
	| { readonly verb: "profiles" }
	/** The Issue actions, as Assign Issue offers them. */
	| { readonly verb: "issue-actions" }
	| {
			/** The window's Rename…: a name, or `clear` back to DevHub's label. */
			readonly verb: "agent-rename";
			readonly agent: string;
			/** Absent: `--clear`. */
			readonly name?: string;
	  }
	| {
			/** An agent's own key/value pairs: list, set one, or unset one. */
			readonly verb: "agent-meta";
			readonly agent: string;
			readonly op: "list" | "set" | "unset";
			readonly key?: string;
			readonly value?: string;
	  }
	| {
			readonly verb: "agent-new";
			/** Absent: the workspace of the pane that asked (`DEVHUB_ORIGIN`). */
			readonly workspace?: string;
			readonly profile?: string;
			readonly name?: string;
			readonly prompt?: string;
			readonly presentation?: "gui" | "tui";
			readonly meta?: readonly AgentMetaPair[];
	  }
	| {
			readonly verb: "issue-assign";
			readonly url: string;
			/**
			 * A clone of the repository: its absolute path. Required — absent is
			 * refused by the app (`tell/service.ts`) with the reason, not filled in.
			 */
			readonly repo?: string;
			/** Required unless `place` is `root` (then: the clone as it is). */
			readonly branch?: string;
			/** `--root`: the clone itself; otherwise a worktree of `branch`. */
			readonly place: "worktree" | "root";
			readonly profile?: string;
			/** One of the configured Issue actions, by id, or `none`. Required unless --editor-only. */
			readonly action?: string;
			readonly prompt?: string;
			readonly editorOnly: boolean;
			readonly presentation?: "gui" | "tui";
			/** The action's wording drafted or sent, for this call (`ActionStart`). */
			readonly start?: "draft" | "send";
			readonly meta?: readonly AgentMetaPair[];
	  }
	| {
			readonly verb: "agent-read";
			readonly agent: string;
			readonly last?: number;
			readonly since?: string;
			/** Every entry whole, nothing clipped (a tool's output too). */
			readonly full?: boolean;
			/** One entry, by its id, whole; reads nothing else and moves no cursor. */
			readonly entry?: string;
	  }
	| {
			readonly verb: "agent-send";
			readonly agent: string;
			readonly text: string;
	  }
	| { readonly verb: "agent-interrupt"; readonly agent: string }
	| { readonly verb: "agent-requests"; readonly agent: string }
	| {
			readonly verb: "agent-answer";
			readonly agent: string;
			readonly request: string;
			/**
			 * One-based option numbers without `--q`: numbered across the
			 * request's questions in order (1…n for the usual single one).
			 */
			readonly options: readonly number[];
			/** Free text without `--q`, for a request with one question. */
			readonly text?: string;
			/**
			 * `--q <question> [--option <n>]... [--text <t>]`, once per question:
			 * the question by its index in 'agent requests' (1-based), its id or
			 * its header; its options numbered within it. Every question of the
			 * request is answered, in one call.
			 */
			readonly questions?: readonly AnswerPart[];
	  }
	| {
			readonly verb: "agent-wait";
			readonly agent: string;
			readonly until: AgentWaitUntil;
			readonly timeoutSeconds: number;
	  }
	| {
			/**
			 * `agent wait --any|--all [<a>...]`: several Agents at once. `any`
			 * answers the first with something the caller has not read
			 * (`TellMemory`); `all` answers once every one is in the state.
			 */
			readonly verb: "agent-wait-many";
			readonly mode: "any" | "all";
			/** Empty: every Agent but the caller (of `workspace`, when given). */
			readonly agents: readonly string[];
			readonly workspace?: string;
			readonly until: AgentWaitUntil;
			readonly timeoutSeconds: number;
	  }
	| { readonly verb: "agent-status"; readonly agent: string }
	/** The window's Stop Agent and Restart Session, without their sheets. */
	| { readonly verb: "agent-stop"; readonly agent: string }
	| { readonly verb: "agent-restart"; readonly agent: string }
	| {
			/** The earlier sessions the agent picker offers to resume. */
			readonly verb: "sessions";
			readonly workspace?: string;
			/** A folder, open or not, on the caller's machine (made absolute by the CLI). */
			readonly folder?: string;
			/** Every folder's, newest first (bounded by each CLI's listing). */
			readonly all?: true;
			readonly profile?: string;
			readonly limit: number;
			/** Only the sessions carrying every pair (`model/sessionMeta.ts`). */
			readonly meta?: readonly AgentMetaPair[];
	  }
	| {
			/**
			 * A session's own key/value pairs, kept once its agent is stopped or
			 * closed: list, set one, or unset one, as `agent meta` does.
			 */
			readonly verb: "session-meta";
			readonly session: string;
			readonly workspace?: string;
			readonly profile?: string;
			readonly op: "list" | "set" | "unset";
			readonly key?: string;
			readonly value?: string;
	  }
	| {
			/** One of them, gone on with in a new GUI Agent. */
			readonly verb: "agent-resume";
			readonly session: string;
			readonly workspace?: string;
			/** The folder it is looked up (and resumed) in, open or not. */
			readonly folder?: string;
			readonly profile?: string;
			readonly name?: string;
	  }
	| {
			/** The asking Agent's own terminal, opened or shown. */
			readonly verb: "terminal-open";
			/** Typed into its shell when this starts it (not when it was running). */
			readonly command?: string;
			/** Put the person's keyboard in it. Default: leave it where it is. */
			readonly focus: boolean;
	  }
	| { readonly verb: "terminal-status" }
	| { readonly verb: "terminal-close" }
	/** The panes of your Workspace's editor terminals, to `bring` by id. */
	| { readonly verb: "terminal-panes" }
	| {
			/** Move one of those panes into your terminal, still running. */
			readonly verb: "terminal-bring";
			/** tmux's pane id: `%7`. */
			readonly pane: string;
			readonly focus: boolean;
	  }
	| { readonly verb: "commands" }
	/**
	 * Each CLI's plan limits, as the Sidebar has them: never a read of its
	 * own. `--json` after the verb, as well as before it.
	 */
	| { readonly verb: "usage"; readonly json?: true }
	| { readonly verb: "run"; readonly command: string }
	| { readonly verb: "focus"; readonly target: string }
	/**
	 * The canonical `devhub:` link to a place (`model/devhubLink.ts`), checked
	 * against what is open. `target` is the agent, workspace, escalation id or
	 * session; for `file`, the absolute path (made so on the CLI's side).
	 */
	| {
			readonly verb: "link";
			readonly kind: LinkTargetKind;
			readonly target?: string;
			readonly line?: number;
			readonly column?: number;
	  }
	| { readonly verb: "notify"; readonly text: string }
	// --- the Orchestrator row (`docs/orchestrator.md`) ----------------------
	| {
			/** The orchestrator raises one. There is no command that answers one. */
			readonly verb: "escalation-new";
			readonly title: string;
			readonly body: string;
			readonly agents: readonly string[];
			readonly links: readonly string[];
			readonly options: readonly string[];
			readonly workspace?: string;
			/** The orchestrator's ranking (`docs/orchestrator.md`). */
			readonly priority?: "high" | "normal" | "low";
			readonly effort?: "quick" | "normal" | "deep";
			readonly rankNote?: string;
	  }
	| {
			/** A follow-up question on the same ticket: back to needs_answer. */
			readonly verb: "escalation-ask";
			readonly id: number;
			readonly body: string;
			readonly options: readonly string[];
			/** More links it is about (`--link`); absent: none. */
			readonly links?: readonly string[];
	  }
	| { readonly verb: "escalation-show"; readonly id: number }
	| {
			readonly verb: "escalation-list";
			readonly state?: "needs_answer" | "in_progress" | "closed";
	  }
	| {
			readonly verb: "escalation-close";
			readonly id: number;
			readonly note?: string;
	  }
	| {
			/** Parked in in_progress by the orchestrator: never an answer. */
			readonly verb: "escalation-hold";
			readonly id: number;
			readonly note?: string;
	  }
	| {
			readonly verb: "escalation-link";
			readonly id: number;
			readonly agent: string;
	  }
	| {
			/** Ranked again, as things change: only what is given moves. */
			readonly verb: "escalation-rank";
			readonly id: number;
			readonly priority?: "high" | "normal" | "low";
			readonly effort?: "quick" | "normal" | "deep";
			readonly rankNote?: string;
	  }
	/** The three lanes, 不明 included. */
	| { readonly verb: "board" }
	| {
			readonly verb: "orchestrator-start";
			/** Required: the folder it runs in (the window reads orchestrator.root). */
			readonly root?: string;
			readonly profile?: string;
			readonly presentation?: "gui" | "tui";
			/** Sent in place of the init event's message. */
			readonly prompt?: string;
	  }
	| { readonly verb: "orchestrator-status" }
	| { readonly verb: "orchestrator-stop" }
	| { readonly verb: "orchestrator-restart" }
	/** Hold the orchestrator's events; resume delivers them, in order. */
	| { readonly verb: "orchestrator-pause" }
	| { readonly verb: "orchestrator-resume" }
	/** The recent events: delivered, pending, filtered, coalesced, dropped. */
	| {
			readonly verb: "orchestrator-events";
			readonly last: number;
			/** `--json` after the verb, as well as before it. */
			readonly json?: true;
	  }
	/** A `custom.NAME` event, through the same filter and coalescing. */
	| {
			readonly verb: "orchestrator-emit";
			readonly type: string;
			readonly text: string;
	  }
	| { readonly verb: "orchestrator-timer-list" }
	| {
			readonly verb: "orchestrator-timer-set";
			readonly name: string;
			readonly interval: string;
	  }
	| { readonly verb: "orchestrator-timer-clear"; readonly name: string };

export type TellVerb = TellCommand["verb"];

/** The longest `agent wait` there is: a request stays open no longer. */
export const MAX_WAIT_SECONDS = 600;
export const DEFAULT_WAIT_SECONDS = 300;
export const DEFAULT_SESSIONS_LIMIT = 20;
export const MAX_SESSIONS_LIMIT = 200;

export const TELL_USAGE = `devhub --tell — ask the running DevHub to do what its window does.

usage: devhub --tell [--json] [--as <name>] <subcommand> [arguments]

  --json       print the answer as JSON (for scripts and agents) instead of text
  --as <name>  for a caller DevHub did not start (Claude Desktop, a script):
               the name it is known by - what it has read for 'agent wait
               --any', and who answered in 'answered via devhub CLI by
               <name>'. Without it every such caller is one, "external".
               Refused inside DevHub, where the caller is its agent

  skill                            the /devhub skill (SKILL.md) for this
                                   DevHub's devhub command: an agent DevHub
                                   did not start (Claude Desktop, another
                                   tool) can read this to learn the CLI
  skill --orchestrator             the /devhub-orchestrator skill (SKILL.md)
                                   DevHub gives the orchestrator agent only:
                                   how to interview the person and write
                                   their make-progress skill (for an
                                   orchestrator DevHub did not start)

Commands that start or create something take every choice as an argument:
the flags marked (required) have no default, so what you get never depends
on the person's settings or on which item is listed first. Run 'profiles'
and 'issue actions' for the values. A call missing one changes nothing and
says which flags, and their values.

workspaces
  workspaces                       list open workspaces: id, name, path,
                                   machine, branch, worktree, Issue, pull
                                   request, unresolved review conversations,
                                   CI (--json: the row tooltip's facts under
                                   "github", null when unknown, and fetchedAt)
  workspace status <w>             one workspace in detail: branch, worktree,
                                   Issue (number, title, state, url), pull
                                   request (and draft), unresolved
                                   conversations, CI counts, and as of when
  workspace open <path> [--worktree <branch>]
                                   open a folder as a workspace (Cmd+Q f);
                                   with --worktree, open (making it if needed)
                                   the worktree of <branch> in the clone at
                                   <path>; the branch must name an Issue
                                   number, like 123-fix-login. Without it,
                                   <path> itself: nothing here reads a
                                   setting
  workspace close <w> [--worktree keep|remove] [--agents stop]
                      [--terminals close] [--discard-unsaved]
                                   Close Workspace, as the window does. Each
                                   question its sheets would ask is a flag,
                                   required when it applies: --worktree for a
                                   worktree workspace (remove deletes the
                                   folder), --agents stop for busy agents,
                                   --terminals close for running terminals,
                                   --discard-unsaved for unsaved editors
                                   (named). Missing one: nothing is closed,
                                   and the open ones are listed. Not Scratch,
                                   not the orchestrator's, not your own
                                   workspace. If it was selected,
                                   the window selects the next row, as when a
                                   person closes it; nothing else moves

agents
  profiles                         the agent profiles, as the agent picker
                                   offers them: id, name, kind, the modes it
                                   has (--gui/--tui), the window's default
                                   one, and whether it can start here (and
                                   why not)
  agents [--workspace <w>] [--meta KEY=VALUE]...
                                   list agents: id, name, kind, status (and
                                   for how long), unread entries, open
                                   requests, context, activity, metadata;
                                   --json has each one's full 'agent status'
                                   as state. --meta keeps only the agents
                                   carrying every pair given
  agent status <a>                 one agent in detail: kind, profile,
                                   workspace, status and since when, turn,
                                   last activity, open questions and
                                   permission prompts, entries you have not
                                   read and the cursor, context use, prompt
                                   cache, and why it stopped or broke
  agent new --workspace <w> --profile <p> --gui|--tui      (all required)
            [--name <n>] [--prompt <text>|-] [--meta KEY=VALUE]...
                                   start an agent (Cmd+Q c) and, with
                                   --prompt, tell it something once it is up
                                   (without: an idle agent)
  agent rename <a> <name>          the row menu's Rename...: the name the
  agent rename <a> --clear         Sidebar, the pane and the resume lists
                                   show (--clear: back to DevHub's label)
  agent meta <a>                   an agent's own KEY=VALUE metadata (yours
  agent meta <a> set <key> <value> or other agents': role=reviewer,
  agent meta <a> unset <key>       parent=<id>, ...); kept across restarts,
                                   shown in the row's tooltip. A key is a
                                   letter then up to 31 of [A-Za-z0-9_.-]; a
                                   value is one line of up to 256 characters
  agent read <a> [--last <n>] [--since <cursor>] [--full]
                                   the transcript of a GUI agent, as text;
                                   prints a cursor to pass as --since. A long
                                   entry is clipped (2,000 characters; a
                                   tool's output left out) and says so, with
                                   its length and the --entry to read it
                                   whole; --full clips nothing (--json: the
                                   whole text; otherwise truncated and length)
  agent read <a> --entry <id>      one entry, whole. Moves no cursor: what
                                   'agent wait --any' owes you is unchanged
  agent send <a> <text>|-          say something to an agent; queued while
                                   it is busy, like the composer does
  agent interrupt <a>              stop the agent's current turn
  agent requests <a>               the questions it is waiting on, with ids
                                   (permission prompts are listed, but are
                                   answered in DevHub only)
  agent answer <a> <request> [--option <n>]... [--text <t>]
                                   answer an AskUserQuestion-style question
  agent answer <a> <request> --q <question> [--option <n>]... [--text <t>]
                           [--q <question> ...]...
                                   answer a request of several questions in
                                   one call: --q names each (its index in
                                   'agent requests', its id or its header),
                                   then its options (numbered within it;
                                   several for a multi-select one) and/or
                                   its own words (--text, where it takes
                                   Other). Every question must be answered
  agent wait <a> [--until idle|waiting|any] [--timeout <seconds>]
                                   return when the agent is idle, waiting on
                                   somebody, or either (default: any)
  agent wait --any [<a>...] [--workspace <w>] [--until ...] [--timeout ...]
                                   return as soon as one GUI agent has news
                                   for you: idle with entries you have not
                                   read, or a request you have not seen;
                                   prints which, why, and the --since to read
                                   from. Without <a>: every GUI agent but you.
                                   What you have not read stays news until
                                   'agent read' (or 'agent requests', for a
                                   request), so nothing between two waits is
                                   missed
  agent wait --all [<a>...] [--workspace <w>] [--until ...] [--timeout ...]
                                   return once every one is in the state
  agent stop <a>                   Stop Agent, as its row does; the window's
                                   question is not asked (this is the
                                   decision): a busy agent's turn stops with
                                   it, and its terminal moves to the editor
  agent restart <a>                Restart Session, as the row menu does
                                   (an agent cannot stop or restart itself)
  sessions [--workspace <w> | --folder <path> | --all] [--profile <p>]
           [--limit <n>] [--meta KEY=VALUE]...
                                   earlier Claude/Codex sessions to resume, as
                                   the agent picker lists them: id, profile,
                                   when, title or agent name, branch or
                                   worktree, the folder it resumes in and
                                   whether a workspace has it open, the agent
                                   running it now, and the metadata of the
                                   agent that ran it, kept after it is
                                   stopped or closed (default: your
                                   workspace, 20). --folder: a folder that
                                   need not be open; --all: every folder's on
                                   this machine, newest first (each CLI's
                                   newest 50 are read). --meta keeps only the
                                   sessions carrying every pair
  session meta <session> [--workspace <w>] [--profile <p>]
               [set <key> <value> | unset <key>]
                                   a stopped session's metadata, as 'agent
                                   meta' (the same keys and values); a
                                   session an agent runs is that agent's.
                                   Kept for the 500 most recently changed
                                   sessions, 180 days each
  agent resume <session> [--workspace <w> | --folder <path>] [--profile <p>]
               [--name <n>]
                                   go on with one in a new GUI agent, as the
                                   picker does. Where it opens is the
                                   session's own: its folder, or its
                                   worktree (opened, or checked out again);
                                   a folder that is not open is opened as a
                                   workspace, unselected and unfocused.
                                   --workspace / --folder is where it is
                                   looked up (default: yours, then every
                                   folder's as 'sessions --all' lists them;
                                   a fact of where you run, not a setting).
                                   When more than one folder could take it,
                                   nothing is opened and they are listed:
                                   give --folder. --profile is required only
                                   when two profiles run the session's CLI.
                                   Always GUI: there is no --tui here. The
                                   new agent gets the session's metadata and
                                   given name back (--name: yours instead)

issues
  issue actions                    the Issue actions Assign Issue offers: id,
                                   label, whether the window drafts or sends
                                   it, and its wording
  issue assign <url> --repo <path> --branch <name>|--root
               --profile <p> --gui|--tui --action <id>|none --send|--draft
               [--prompt <text>|-] [--meta KEY=VALUE]...  (all but [] required)
  issue assign <url> --repo <path> --branch <name>|--root --editor-only
                                   hand an Issue or pull request to a new
                                   agent (Cmd+Q i): in the clone at --repo, in
                                   a worktree of --branch (made if need be;
                                   for a pull request, its own branch), or
                                   with --root in the clone itself (--branch
                                   too: switched to it; alone: as it is).
                                   --action none tells the agent nothing;
                                   otherwise --draft puts the action's
                                   wording into its input box unsent, --send
                                   sends it as its first message (no review
                                   sheet). --editor-only opens the editor and
                                   starts no agent

terminal (your own: one per agent, beside your pane; hidden with the editor alone)
  terminal open [--command <cmd>] [--focus]
                                   open your terminal, or show it if it is
                                   already open (the same one every time: a
                                   tmux session of its own, in your workspace,
                                   on its machine); prints the tmux handle.
                                   --command is typed into it only when this
                                   starts it
  terminal status                  your terminal: open/visible/focused, and the
                                   tmux handle with every pane in it (the
                                   person may have split it), each with where
                                   it is (top-left, bottom-right, ...)
  terminal close                   close it, and its session
  terminal panes                   the panes of your workspace's editor
                                   terminals: id, window, what runs in front
                                   (its command line, e.g. ssh host), cwd,
                                   title
  terminal bring <pane> [--focus]  move one of them (by id, %N) into your
                                   terminal, still running: it opens your
                                   terminal with it, or adds it as a split.
                                   An editor terminal left with no pane ends

app
  usage                            each CLI's plan limits, as the Sidebar
                                   shows them: per window (5-hour, 7-day, ...)
                                   the percent used and when it resets, or
                                   no plan limits; when DevHub last read them
                                   and why it could not since. Never reads
                                   them itself: the latest known, with its
                                   age (--json: a stable schema, nulls for
                                   what is not known)
  commands                         list the command palette's commands
  run <command-id>                 run one of them, exactly as the palette
                                   does - only those that move nothing in
                                   the window (refresh_repositories,
                                   mark_agent_unread); one that would ask or
                                   go somewhere is refused, naming the --tell
                                   command to use instead
  focus <agent|workspace|orchestrator>
                                   select it in DevHub ('orchestrator': the
                                   Orchestrator screen)
  notify <text>                    show a notification in DevHub
  link agent <a> | workspace <w> | file <path>[:line[:col]] | escalation <id>
       | orchestrator | session <session>
                                   print the canonical devhub: link to it
                                   (checked: it must be open), for an
                                   escalation's --link or a Markdown link
                                   [text](devhub:...) in a body or a chat
                                   answer. DevHub draws it as a chip that
                                   goes there

<w> is a workspace id, its folder, its name, "scratch", or "orchestrator"
(the orchestrator's folder, the Orchestrator row's workspace). A folder is a
folder on the machine devhub runs on: on an SSH host, the host's.
<a> is an agent id (or a unique prefix of one) or its name. <session> is a
session id from 'sessions' (or a unique prefix of one).

No --tell command puts a picker or a sheet up in the window, and none but
'focus' (and an explicit --focus) changes what the window selects or shows,
moves its keyboard or brings it to the front: what a command makes appears
in the Sidebar, unselected (a closed workspace that was selected is the one
exception: its row is gone, and the window selects the next). Where the
window would ask, the command takes the answer as an argument.

orchestrator (the Orchestrator row: the board, escalations, events)
  board                            the three lanes as data: needs_answer
                                   (oldest first), in_progress (how long
                                   since the answer), and unaccounted (idle
                                   agents no open escalation names); while
                                   GitHub is polled, the unattended Issues
                                   (assigned to me, open, no agent on them:
                                   --json unattendedIssues)
  escalation new --title <t> --body <text>|- [--agent <a>]...
                 [--link <url>]... [--option <text>]... [--workspace <w>]
                 [--priority high|normal|low] [--effort quick|normal|deep]
                 [--rank-note <text>]
                                   raise one for the person (Markdown: code,
                                   math, mermaid, svg - as the chat renders);
                                   needs_answer is sorted by priority, then
                                   effort (quick first), then age. A --link
                                   is an http(s) URL or a devhub: link
                                   ('link' makes one); a devhub: link, there
                                   or in the body, must name what is open
  escalation ask <id> --body <text>|- [--option <text>]... [--link <url>]...
                                   a follow-up question on the same ticket;
                                   back to needs_answer
  escalation show <id>             the thread, the person's answers included
                                   (this is what acknowledges an answer for
                                   'agent wait --any')
  escalation list [--state needs_answer|in_progress|closed]
  escalation close <id> [--note <text>]
                                   the answer is used up: close it
  escalation hold <id> [--note <text>]
                                   park a needs_answer one in in_progress
                                   while you work on it (not an answer; back
                                   to needs_answer with 'escalation ask')
  escalation rank <id> [--priority high|normal|low]
                 [--effort quick|normal|deep] [--rank-note <text>]
                                   rank it again as things change (a
                                   --rank-note of "" takes the note away)
  escalation link <id> --agent <a> another agent it is about
                                   (the person answers in DevHub only: no
                                   command writes an answer)
  orchestrator start --root <path> --profile <p> --gui|--tui [--prompt <text>|-]
                                   (all but [] required) open <path> as a
                                   workspace, start the orchestrator agent in
                                   it unfocused, and send it the init event
                                   (or --prompt). Refused while one runs
  orchestrator status              its agent, state, lane counts, whether
                                   its events are paused, and each GitHub
                                   board's items, assigned to me, unattended
  orchestrator stop | restart      Stop Agent / Restart Session on it
  orchestrator pause | resume      hold its events / deliver the held ones,
                                   in order, as one message
  orchestrator events [--last <n>] the recent events, one line each, and what
                                   came of them: delivered, pending, filtered,
                                   coalesced, dropped (default 20; --json: data),
                                   then why the last GitHub look said nothing
                                   of some cards (baseline, has an agent, …)
  orchestrator emit --type custom.<name> --text <text>|-
                                   send a custom event, through the same
                                   filter and coalescing as DevHub's own
  orchestrator timer list | set <name> <interval> | clear <name>
                                   the timers (timer.elapsed); set and clear
                                   last for this session, [[orchestrator.timers]]
                                   are the defaults

The few defaults left are fixed, never read from settings: agent read
--last 20, agent wait --until any --timeout 300, sessions --limit 20, and
your own workspace where sessions and agent resume look sessions up (agent
resume then every folder's, as sessions --all) - which is where you run, not
a setting.`;

export type TellParse =
	| {
			readonly kind: "tell";
			readonly command: TellCommand;
			readonly json: boolean;
			/** `--as NAME`: an outside caller's label (`TellCaller.label`). */
			readonly as?: string;
	  }
	| { readonly kind: "invalid"; readonly message: string };

/** An `--as` label: a letter or digit, then up to 63 of [A-Za-z0-9_.@-]. */
const CALLER_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/u;

/** Why `label` cannot be an `--as` label; undefined when it can. */
export function callerLabelProblem(label: string): string | undefined {
	return CALLER_LABEL.test(label)
		? undefined
		: `--as takes a name: a letter or digit, then up to 63 letters, digits, '_', '.', '@' or '-'; not ${JSON.stringify(label)}.`;
}

/** `orchestrator events` without `--last`. */
const DEFAULT_EVENTS_LAST = 20;
/** The most `orchestrator events --last` shows: what the log keeps. */
const EVENT_LOG_LIMIT = 200;

/** A value read from stdin, standing in for a `-` where text was asked for. */
export const STDIN_TEXT = "-";

interface FlagSpec {
	/** Flags that take a value; repeated ones collect. */
	readonly values: readonly string[];
	/** Flags that stand alone. */
	readonly switches: readonly string[];
}

interface Flags {
	readonly positional: readonly string[];
	readonly values: ReadonlyMap<string, readonly string[]>;
	readonly switches: ReadonlySet<string>;
}

class Refusal extends Error {}

function readFlags(args: readonly string[], spec: FlagSpec): Flags {
	const positional: string[] = [];
	const values = new Map<string, string[]>();
	const switches = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--") {
			positional.push(...args.slice(index + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			const name = equals > 2 ? arg.slice(0, equals) : arg;
			if (spec.values.includes(name)) {
				const value = equals > 2 ? arg.slice(equals + 1) : args[++index];
				if (value === undefined) throw new Refusal(`${name} needs a value.`);
				values.set(name, [...(values.get(name) ?? []), value]);
				continue;
			}
			if (spec.switches.includes(name) && equals < 0) {
				switches.add(name);
				continue;
			}
			throw new Refusal(`${arg} is not an option here.`);
		}
		positional.push(arg);
	}
	return { positional, values, switches };
}

function one(flags: Flags, name: string): string | undefined {
	const all = flags.values.get(name);
	if (all === undefined) return undefined;
	if (all.length > 1) throw new Refusal(`${name} is given more than once.`);
	return all[0];
}

function positionals(flags: Flags, names: readonly string[]): string[] {
	if (flags.positional.length < names.length)
		throw new Refusal(
			`missing ${names.slice(flags.positional.length).join(" ")}.`,
		);
	if (flags.positional.length > names.length)
		throw new Refusal(
			`unexpected ${JSON.stringify(flags.positional[names.length])}.`,
		);
	return [...flags.positional];
}

function count(value: string, name: string, min: number, max: number): number {
	if (!/^\d+$/.test(value)) throw new Refusal(`${name} takes a whole number.`);
	const number = Number(value);
	if (number < min || number > max)
		throw new Refusal(`${name} takes a number from ${min} to ${max}.`);
	return number;
}

function presentation(flags: Flags): "gui" | "tui" | undefined {
	const gui = flags.switches.has("--gui");
	const tui = flags.switches.has("--tui");
	if (gui && tui)
		throw new Refusal("--gui and --tui ask for different things.");
	return gui ? "gui" : tui ? "tui" : undefined;
}

/** `--send` or `--draft`: how an Issue action's wording reaches the agent. */
function start(flags: Flags): "draft" | "send" | undefined {
	const send = flags.switches.has("--send");
	const draft = flags.switches.has("--draft");
	if (send && draft)
		throw new Refusal("--send and --draft ask for different things.");
	return send ? "send" : draft ? "draft" : undefined;
}

/** Every `--meta KEY=VALUE`, checked; a key given twice is refused. */
function metaPairs(flags: Flags): readonly AgentMetaPair[] | undefined {
	const given = flags.values.get("--meta");
	if (given === undefined) return undefined;
	const pairs: AgentMetaPair[] = [];
	for (const text of given) {
		const pair = parseMetaPair(text);
		if (typeof pair === "string") throw new Refusal(pair);
		if (pairs.some((one) => one.key === pair.key))
			throw new Refusal(`--meta ${pair.key} is given more than once.`);
		pairs.push(pair);
	}
	return pairs;
}

const NO_FLAGS: FlagSpec = { values: [], switches: [] };

/** `--workspace W`, `--folder PATH` (and `--all`, where given): one at most. */
function oneWhere(
	flags: Flags,
	all: boolean,
): { workspace: string | undefined; folder: string | undefined } {
	const workspace = one(flags, "--workspace");
	const folder = one(flags, "--folder");
	const given = [
		...(workspace === undefined ? [] : ["--workspace"]),
		...(folder === undefined ? [] : ["--folder"]),
		...(all ? ["--all"] : []),
	];
	if (given.length > 1)
		throw new Refusal(
			`${given.join(" and ")} name different places: give one.`,
		);
	return { workspace, folder };
}

/**
 * `session meta <session> [--workspace <w>] [--profile <p>]
 * [set KEY VALUE... | unset KEY]`: the flags come before `set`/`unset`,
 * after which every word is the key and the value, as `agent meta` reads them.
 */
function parseSessionMeta(rest: readonly string[]): TellCommand {
	const at = rest.findIndex((word) => word === "set" || word === "unset");
	const head = at < 0 ? rest : rest.slice(0, at);
	const flags = readFlags(head, {
		values: ["--workspace", "--profile"],
		switches: [],
	});
	const [session] = positionals(flags, ["<session>"]);
	const where = defined({
		workspace: one(flags, "--workspace"),
		profile: one(flags, "--profile"),
	});
	if (at < 0)
		return { verb: "session-meta", session: session!, op: "list", ...where };
	const [op, key, ...words] = rest.slice(at) as ["set" | "unset", ...string[]];
	if (key === undefined) throw new Refusal("missing KEY.");
	const keyProblem = metaKeyProblem(key);
	if (keyProblem !== undefined) throw new Refusal(keyProblem);
	if (op === "unset") {
		if (words.length > 0)
			throw new Refusal(`unexpected ${JSON.stringify(words[0])}.`);
		return { verb: "session-meta", session: session!, op, key, ...where };
	}
	if (words.length === 0) throw new Refusal("missing VALUE.");
	const value = words.join(" ");
	const valueProblem = metaValueProblem(value);
	if (valueProblem !== undefined) throw new Refusal(valueProblem);
	return { verb: "session-meta", session: session!, op, key, value, ...where };
}

/**
 * `devhub --tell …`, everything after `--tell`.
 *
 * Paths are left as typed: the CLI expands them against its own cwd, which is
 * the one place that knows it. Text given as `-` is left as `-` too, and read
 * from stdin by the CLI before anything is sent.
 */
export function parseTellArguments(argv: readonly string[]): TellParse {
	let args = [...argv];
	let json = false;
	let as: string | undefined;
	try {
		for (;;) {
			if (args[0] === "--json") {
				json = true;
				args = args.slice(1);
				continue;
			}
			if (args[0] === "--as" || args[0]?.startsWith("--as=") === true) {
				const value = args[0] === "--as" ? args[1] : args[0].slice(5);
				if (value === undefined) throw new Refusal("--as needs a value.");
				const problem = callerLabelProblem(value);
				if (problem !== undefined) throw new Refusal(problem);
				as = value;
				args = args.slice(args[0] === "--as" ? 2 : 1);
				continue;
			}
			break;
		}
		const command = parseVerb(args);
		return {
			kind: "tell",
			command,
			json: json || ("json" in command && command.json === true),
			...(as === undefined ? {} : { as }),
		};
	} catch (error) {
		if (error instanceof Refusal)
			return { kind: "invalid", message: error.message };
		throw error;
	}
}

function parseVerb(args: readonly string[]): TellCommand {
	const [head, sub, ...rest] = args;
	switch (head) {
		case undefined:
		case "help":
		case "--help":
		case "-h":
			return { verb: "help" };
		case "workspaces":
			positionals(readFlags(args.slice(1), NO_FLAGS), []);
			return { verb: "workspaces" };
		case "skill": {
			const flags = readFlags(args.slice(1), {
				values: [],
				switches: ["--orchestrator"],
			});
			positionals(flags, []);
			return flags.switches.has("--orchestrator")
				? { verb: "skill", orchestrator: true }
				: { verb: "skill" };
		}
		case "workspace": {
			if (sub === "status") {
				const [workspace] = positionals(readFlags(rest, NO_FLAGS), ["<w>"]);
				return { verb: "workspace-status", workspace: workspace! };
			}
			if (sub === "close") return parseWorkspaceClose(rest);
			if (sub !== "open")
				throw new Refusal("workspace takes: open, close, status.");
			const flags = readFlags(rest, { values: ["--worktree"], switches: [] });
			const [path] = positionals(flags, ["<path>"]);
			const worktree = one(flags, "--worktree");
			return {
				verb: "workspace-open",
				path: path!,
				...(worktree === undefined ? {} : { worktree }),
			};
		}
		case "agents": {
			const flags = readFlags(args.slice(1), {
				values: ["--workspace", "--meta"],
				switches: [],
			});
			positionals(flags, []);
			return {
				verb: "agents",
				...defined({
					workspace: one(flags, "--workspace"),
					meta: metaPairs(flags),
				}),
			};
		}
		case "profiles":
			positionals(readFlags(args.slice(1), NO_FLAGS), []);
			return { verb: "profiles" };
		case "agent":
			return parseAgent(sub, rest);
		case "session":
			if (sub !== "meta") throw new Refusal("session takes: meta.");
			return parseSessionMeta(rest);
		case "sessions": {
			const flags = readFlags(args.slice(1), {
				values: ["--workspace", "--folder", "--profile", "--limit", "--meta"],
				switches: ["--all"],
			});
			positionals(flags, []);
			const limit = one(flags, "--limit");
			const all = flags.switches.has("--all");
			const where = oneWhere(flags, all);
			return {
				verb: "sessions",
				limit:
					limit === undefined
						? DEFAULT_SESSIONS_LIMIT
						: count(limit, "--limit", 1, MAX_SESSIONS_LIMIT),
				...(all ? { all: true as const } : {}),
				...defined({
					...where,
					profile: one(flags, "--profile"),
					meta: metaPairs(flags),
				}),
			};
		}
		case "issue": {
			if (sub === "actions") {
				positionals(readFlags(rest, NO_FLAGS), []);
				return { verb: "issue-actions" };
			}
			if (sub !== "assign") throw new Refusal("issue takes: assign, actions.");
			const flags = readFlags(rest, {
				values: [
					"--repo",
					"--branch",
					"--profile",
					"--action",
					"--prompt",
					"--prompt-extra",
					"--meta",
				],
				switches: [
					"--root",
					"--worktree",
					"--editor-only",
					"--gui",
					"--tui",
					"--send",
					"--draft",
				],
			});
			const [url] = positionals(flags, ["<url>"]);
			if (flags.switches.has("--root") && flags.switches.has("--worktree"))
				throw new Refusal("--root and --worktree ask for different things.");
			const prompt = one(flags, "--prompt") ?? one(flags, "--prompt-extra");
			const optional = {
				repo: one(flags, "--repo"),
				branch: one(flags, "--branch"),
				profile: one(flags, "--profile"),
				action: one(flags, "--action"),
				prompt,
				presentation: presentation(flags),
				start: start(flags),
				meta: metaPairs(flags),
			};
			return {
				verb: "issue-assign",
				url: url!,
				place: flags.switches.has("--root") ? "root" : "worktree",
				editorOnly: flags.switches.has("--editor-only"),
				...defined(optional),
			};
		}
		case "terminal":
			return parseTerminal(sub, rest);
		case "commands":
			positionals(readFlags(args.slice(1), NO_FLAGS), []);
			return { verb: "commands" };
		case "run": {
			const [command] = positionals(readFlags(args.slice(1), NO_FLAGS), [
				"<command-id>",
			]);
			return { verb: "run", command: command! };
		}
		case "focus": {
			const [target] = positionals(readFlags(args.slice(1), NO_FLAGS), [
				"<agent|workspace>",
			]);
			return { verb: "focus", target: target! };
		}
		case "link":
			return parseLink(args.slice(1));
		case "board":
			positionals(readFlags(args.slice(1), NO_FLAGS), []);
			return { verb: "board" };
		case "usage": {
			const flags = readFlags(args.slice(1), {
				values: [],
				switches: ["--json"],
			});
			positionals(flags, []);
			return flags.switches.has("--json")
				? { verb: "usage", json: true }
				: { verb: "usage" };
		}
		case "escalation":
			return parseEscalation(sub, rest);
		case "orchestrator":
			return parseOrchestrator(sub, rest);
		case "notify": {
			const words = args.slice(1);
			if (words.length === 0) throw new Refusal("missing <text>.");
			return { verb: "notify", text: words.join(" ") };
		}
		default:
			throw new Refusal(
				`${JSON.stringify(head)} is not a --tell subcommand. Run 'devhub --tell help'.`,
			);
	}
}

/**
 * `link agent A | workspace W | file PATH[:L[:C]] | escalation ID |
 * orchestrator | session S`.
 */
function parseLink(args: readonly string[]): TellCommand {
	const kind = args[0];
	if (kind === undefined || !(LINK_TARGET_KINDS as string[]).includes(kind))
		throw new Refusal(
			`link takes what to link to: ${LINK_TARGET_KINDS.join(", ")} (e.g. 'link agent a1b2c3d4', 'link file src/app.ts:12').`,
		);
	const typed = kind as LinkTargetKind;
	if (typed === "orchestrator") {
		positionals(readFlags(args.slice(1), NO_FLAGS), []);
		return { verb: "link", kind: typed };
	}
	const [target] = positionals(readFlags(args.slice(1), NO_FLAGS), [
		typed === "file" ? "<path>[:line[:column]]" : `<${typed}>`,
	]);
	if (typed === "escalation")
		return { verb: "link", kind: typed, target: String(escalationId(target)) };
	if (typed !== "file") return { verb: "link", kind: typed, target: target! };
	const at = /^(.*?):(\d{1,7})(?::(\d{1,7}))?$/su.exec(target!);
	const line = at?.[2] === undefined ? undefined : Number(at[2]);
	const column = at?.[3] === undefined ? undefined : Number(at[3]);
	if (line === 0 || column === 0)
		throw new Refusal("a line and a column start at 1.");
	return {
		verb: "link",
		kind: typed,
		target: at === null ? target! : at[1]!,
		...defined({ line, column }),
	};
}

/** One of `allowed`, or refused naming them. */
function oneOf<T extends string>(
	flags: Flags,
	name: string,
	allowed: readonly T[],
): T | undefined {
	const value = one(flags, name);
	if (value === undefined) return undefined;
	if (!(allowed as readonly string[]).includes(value))
		throw new Refusal(`${name} takes ${allowed.join(" or ")}.`);
	return value as T;
}

/** `--priority`, `--effort` and `--rank-note`, the ones given. */
function rankFlags(flags: Flags): {
	readonly priority?: "high" | "normal" | "low";
	readonly effort?: "quick" | "normal" | "deep";
	readonly rankNote?: string;
} {
	return defined({
		priority: oneOf(flags, "--priority", ["high", "normal", "low"] as const),
		effort: oneOf(flags, "--effort", ["quick", "normal", "deep"] as const),
		rankNote: one(flags, "--rank-note"),
	});
}

/** `#12`, `12` or `E12`. */
function escalationId(text: string | undefined): number {
	const match = /^(?:#|e|E)?(\d{1,9})$/u.exec((text ?? "").trim());
	const id = match === null ? 0 : Number(match[1]);
	if (id < 1)
		throw new Refusal(
			`${JSON.stringify(text ?? "")} is not an escalation id (like 12 or #12).`,
		);
	return id;
}

function parseEscalation(
	sub: string | undefined,
	rest: readonly string[],
): TellCommand {
	switch (sub) {
		case "new": {
			const flags = readFlags(rest, {
				values: [
					"--title",
					"--body",
					"--agent",
					"--link",
					"--option",
					"--workspace",
					"--priority",
					"--effort",
					"--rank-note",
				],
				switches: [],
			});
			positionals(flags, []);
			const title = one(flags, "--title");
			const body = one(flags, "--body");
			if (title === undefined) throw new Refusal("--title is required.");
			if (body === undefined)
				throw new Refusal("--body is required (Markdown, or - for stdin).");
			return {
				verb: "escalation-new",
				title,
				body,
				agents: flags.values.get("--agent") ?? [],
				links: flags.values.get("--link") ?? [],
				options: flags.values.get("--option") ?? [],
				...defined({ workspace: one(flags, "--workspace") }),
				...rankFlags(flags),
			};
		}
		case "rank": {
			const flags = readFlags(rest, {
				values: ["--priority", "--effort", "--rank-note"],
				switches: [],
			});
			const [id] = positionals(flags, ["<id>"]);
			const rank = rankFlags(flags);
			if (Object.keys(rank).length === 0)
				throw new Refusal(
					"escalation rank takes --priority, --effort or --rank-note.",
				);
			return { verb: "escalation-rank", id: escalationId(id), ...rank };
		}
		case "ask": {
			const flags = readFlags(rest, {
				values: ["--body", "--option", "--link"],
				switches: [],
			});
			const [id] = positionals(flags, ["<id>"]);
			const body = one(flags, "--body");
			if (body === undefined)
				throw new Refusal("--body is required (Markdown, or - for stdin).");
			const links = flags.values.get("--link") ?? [];
			return {
				verb: "escalation-ask",
				id: escalationId(id),
				body,
				options: flags.values.get("--option") ?? [],
				...(links.length === 0 ? {} : { links }),
			};
		}
		case "show": {
			const [id] = positionals(readFlags(rest, NO_FLAGS), ["<id>"]);
			return { verb: "escalation-show", id: escalationId(id) };
		}
		case "list": {
			const flags = readFlags(rest, { values: ["--state"], switches: [] });
			positionals(flags, []);
			return {
				verb: "escalation-list",
				...defined({
					state: oneOf(flags, "--state", [
						"needs_answer",
						"in_progress",
						"closed",
					] as const),
				}),
			};
		}
		case "close": {
			const flags = readFlags(rest, { values: ["--note"], switches: [] });
			const [id] = positionals(flags, ["<id>"]);
			return {
				verb: "escalation-close",
				id: escalationId(id),
				...defined({ note: one(flags, "--note") }),
			};
		}
		case "hold": {
			const flags = readFlags(rest, { values: ["--note"], switches: [] });
			const [id] = positionals(flags, ["<id>"]);
			return {
				verb: "escalation-hold",
				id: escalationId(id),
				...defined({ note: one(flags, "--note") }),
			};
		}
		case "link": {
			const flags = readFlags(rest, { values: ["--agent"], switches: [] });
			const [id] = positionals(flags, ["<id>"]);
			const agent = one(flags, "--agent");
			if (agent === undefined) throw new Refusal("--agent is required.");
			return { verb: "escalation-link", id: escalationId(id), agent };
		}
		case "answer":
			throw new Refusal(
				"an escalation is answered by the person, in DevHub's window, and by no command.",
			);
		default:
			throw new Refusal(
				"escalation takes: new, ask, show, list, close, hold, link, rank.",
			);
	}
}

function parseOrchestrator(
	sub: string | undefined,
	rest: readonly string[],
): TellCommand {
	switch (sub) {
		case "start": {
			const flags = readFlags(rest, {
				values: ["--root", "--profile", "--prompt"],
				switches: ["--gui", "--tui"],
			});
			positionals(flags, []);
			return {
				verb: "orchestrator-start",
				...defined({
					root: one(flags, "--root"),
					profile: one(flags, "--profile"),
					presentation: presentation(flags),
					prompt: one(flags, "--prompt"),
				}),
			};
		}
		case "status":
		case "stop":
		case "restart":
		case "pause":
		case "resume":
			positionals(readFlags(rest, NO_FLAGS), []);
			return { verb: `orchestrator-${sub}` };
		case "events": {
			const flags = readFlags(rest, {
				values: ["--last"],
				switches: ["--json"],
			});
			positionals(flags, []);
			const last = one(flags, "--last");
			return {
				verb: "orchestrator-events",
				last:
					last === undefined
						? DEFAULT_EVENTS_LAST
						: count(last, "--last", 1, EVENT_LOG_LIMIT),
				...(flags.switches.has("--json") ? { json: true as const } : {}),
			};
		}
		case "emit": {
			const flags = readFlags(rest, {
				values: ["--type", "--text"],
				switches: [],
			});
			positionals(flags, []);
			const type = one(flags, "--type");
			const text = one(flags, "--text");
			if (type === undefined || text === undefined)
				throw new Refusal(
					"--type custom.NAME and --text <text>|- are required.",
				);
			if (!/^custom\.[a-z0-9][a-z0-9_-]{0,39}$/u.test(type))
				throw new Refusal(
					`--type is custom.NAME (lower-case letters, digits, - and _), not ${JSON.stringify(type)}.`,
				);
			if (text.trim().length === 0) throw new Refusal("--text is empty.");
			return { verb: "orchestrator-emit", type, text };
		}
		case "timer": {
			const [action, ...more] = rest;
			switch (action) {
				case "list":
					positionals(readFlags(more, NO_FLAGS), []);
					return { verb: "orchestrator-timer-list" };
				case "set": {
					const [name, interval] = positionals(readFlags(more, NO_FLAGS), [
						"NAME",
						"INTERVAL",
					]);
					return {
						verb: "orchestrator-timer-set",
						name: name!,
						interval: interval!,
					};
				}
				case "clear": {
					const [name] = positionals(readFlags(more, NO_FLAGS), ["NAME"]);
					return { verb: "orchestrator-timer-clear", name: name! };
				}
				default:
					throw new Refusal("orchestrator timer takes: list, set, clear.");
			}
		}
		default:
			throw new Refusal(
				"orchestrator takes: start, status, stop, restart, pause, resume, events, emit, timer.",
			);
	}
}

function parseWorkspaceClose(rest: readonly string[]): TellCommand {
	const flags = readFlags(rest, {
		values: ["--worktree", "--agents", "--terminals"],
		switches: ["--discard-unsaved"],
	});
	const [workspace] = positionals(flags, ["<w>"]);
	return {
		verb: "workspace-close",
		workspace: workspace!,
		discardUnsaved: flags.switches.has("--discard-unsaved"),
		...defined({
			worktree: oneOf(flags, "--worktree", ["keep", "remove"] as const),
			agents: oneOf(flags, "--agents", ["stop"] as const),
			terminals: oneOf(flags, "--terminals", ["close"] as const),
		}),
	};
}

function parseAgent(
	sub: string | undefined,
	rest: readonly string[],
): TellCommand {
	switch (sub) {
		case "new": {
			const flags = readFlags(rest, {
				values: ["--workspace", "--profile", "--name", "--prompt", "--meta"],
				switches: ["--gui", "--tui"],
			});
			positionals(flags, []);
			return {
				verb: "agent-new",
				...defined({
					workspace: one(flags, "--workspace"),
					profile: one(flags, "--profile"),
					name: one(flags, "--name"),
					prompt: one(flags, "--prompt"),
					presentation: presentation(flags),
					meta: metaPairs(flags),
				}),
			};
		}
		case "rename": {
			const flags = readFlags(rest, { values: [], switches: ["--clear"] });
			const clear = flags.switches.has("--clear");
			if (clear) {
				const [agent] = positionals(flags, ["<agent>"]);
				return { verb: "agent-rename", agent: agent! };
			}
			// The words are the name, whatever they look like.
			const [agent, ...words] = flags.positional;
			if (agent === undefined) throw new Refusal("missing <agent>.");
			const name = words.join(" ").trim();
			if (name.length === 0)
				throw new Refusal(
					"missing <name> (or --clear for the name DevHub gives it).",
				);
			return { verb: "agent-rename", agent, name };
		}
		case "meta": {
			// `agent meta <a> [set KEY VALUE... | unset KEY]`: positional, so a
			// value may be several words.
			const [agent, op, key, ...words] = rest;
			if (agent === undefined) throw new Refusal("missing <agent>.");
			if (op === undefined) return { verb: "agent-meta", agent, op: "list" };
			if (op !== "set" && op !== "unset")
				throw new Refusal(
					"agent meta takes: <agent>, <agent> set KEY VALUE, <agent> unset KEY.",
				);
			if (key === undefined) throw new Refusal("missing KEY.");
			const keyProblem = metaKeyProblem(key);
			if (keyProblem !== undefined) throw new Refusal(keyProblem);
			if (op === "unset") {
				if (words.length > 0)
					throw new Refusal(`unexpected ${JSON.stringify(words[0])}.`);
				return { verb: "agent-meta", agent, op, key };
			}
			if (words.length === 0) throw new Refusal("missing VALUE.");
			const value = words.join(" ");
			const valueProblem = metaValueProblem(value);
			if (valueProblem !== undefined) throw new Refusal(valueProblem);
			return { verb: "agent-meta", agent, op, key, value };
		}
		case "read": {
			const flags = readFlags(rest, {
				values: ["--last", "--since", "--entry"],
				switches: ["--full"],
			});
			const [agent] = positionals(flags, ["<agent>"]);
			const last = one(flags, "--last");
			const since = one(flags, "--since");
			const entry = one(flags, "--entry");
			const full = flags.switches.has("--full");
			if (
				entry !== undefined &&
				(last ?? since ?? (full || undefined)) !== undefined
			)
				throw new Refusal(
					"--entry reads one entry, whole: it takes no --last, --since or --full.",
				);
			return {
				verb: "agent-read",
				agent: agent!,
				...(last === undefined ? {} : { last: count(last, "--last", 1, 1000) }),
				...(since === undefined ? {} : { since }),
				...(full ? { full: true } : {}),
				...(entry === undefined ? {} : { entry }),
			};
		}
		case "send": {
			// The words are the message, whatever they look like.
			const [agent, ...words] = rest;
			if (agent === undefined) throw new Refusal("missing <agent>.");
			if (words.length === 0)
				throw new Refusal("missing <text> (or - for stdin).");
			return { verb: "agent-send", agent, text: words.join(" ") };
		}
		case "interrupt":
		case "requests":
		case "status":
		case "stop":
		case "restart": {
			const [agent] = positionals(readFlags(rest, NO_FLAGS), ["<agent>"]);
			return { verb: `agent-${sub}`, agent: agent! } as const;
		}
		case "resume": {
			const flags = readFlags(rest, {
				values: ["--workspace", "--folder", "--profile", "--name"],
				switches: [],
			});
			const [session] = positionals(flags, ["<session>"]);
			return {
				verb: "agent-resume",
				session: session!,
				...defined({
					...oneWhere(flags, false),
					profile: one(flags, "--profile"),
					name: one(flags, "--name"),
				}),
			};
		}
		case "answer": {
			const [agent, request, ...words] = rest;
			if (words.includes("--allow") || words.includes("--deny"))
				throw new Refusal(
					"permission prompts are answered in DevHub, by the person, and never from the command line.",
				);
			if (agent === undefined || request === undefined)
				throw new Refusal(
					`missing ${agent === undefined ? "<agent> <request>" : "<request>"}.`,
				);
			// Read in order: an --option or --text belongs to the --q before it.
			const loose: { options: number[]; text?: string } = { options: [] };
			const parts: { question: string; options: number[]; text?: string }[] =
				[];
			for (let index = 0; index < words.length; index += 1) {
				const word = words[index]!;
				const equals = word.indexOf("=");
				const name =
					word.startsWith("--") && equals > 2 ? word.slice(0, equals) : word;
				if (name !== "--q" && name !== "--option" && name !== "--text")
					throw new Refusal(`${word} is not an option here.`);
				const value =
					equals > 2 && word.startsWith("--")
						? word.slice(equals + 1)
						: words[++index];
				if (value === undefined) throw new Refusal(`${name} needs a value.`);
				const into = parts.at(-1) ?? loose;
				if (name === "--q") {
					if (
						parts.length === 0 &&
						(loose.options.length > 0 || loose.text !== undefined)
					)
						throw new Refusal(
							"with --q, every --option and --text goes after the --q of its question.",
						);
					parts.push({ question: value, options: [] });
				} else if (name === "--option") {
					into.options.push(count(value, "--option", 1, 100));
				} else {
					if (into.text !== undefined)
						throw new Refusal(
							parts.length === 0
								? "--text is given more than once."
								: `--text is given more than once for --q ${parts.at(-1)!.question}.`,
						);
					into.text = value;
				}
			}
			if (parts.length > 0) {
				for (const part of parts)
					if (part.options.length === 0 && part.text === undefined)
						throw new Refusal(
							`--q ${part.question} needs --option <n> or --text <t> after it.`,
						);
				return {
					verb: "agent-answer",
					agent,
					request,
					options: [],
					questions: parts.map((part) => ({
						question: part.question,
						options: part.options,
						...(part.text === undefined ? {} : { text: part.text }),
					})),
				};
			}
			if (loose.options.length === 0 && loose.text === undefined)
				throw new Refusal(
					"agent answer needs --option <n> or --text <t> (or --q <question> before each question's).",
				);
			return {
				verb: "agent-answer",
				agent,
				request,
				options: loose.options,
				...(loose.text === undefined ? {} : { text: loose.text }),
			};
		}
		case "wait": {
			const flags = readFlags(rest, {
				values: ["--until", "--timeout", "--workspace"],
				switches: ["--any", "--all"],
			});
			const until = one(flags, "--until") ?? "any";
			if (until !== "idle" && until !== "waiting" && until !== "any")
				throw new Refusal("--until takes idle, waiting or any.");
			const timeout = one(flags, "--timeout");
			const timeoutSeconds =
				timeout === undefined
					? DEFAULT_WAIT_SECONDS
					: count(timeout, "--timeout", 1, MAX_WAIT_SECONDS);
			const any = flags.switches.has("--any");
			const all = flags.switches.has("--all");
			if (any && all)
				throw new Refusal("--any and --all ask for different things.");
			const workspace = one(flags, "--workspace");
			if (!any && !all) {
				if (workspace !== undefined)
					throw new Refusal("--workspace goes with --any or --all.");
				const [agent] = positionals(flags, ["<agent>"]);
				return { verb: "agent-wait", agent: agent!, until, timeoutSeconds };
			}
			return {
				verb: "agent-wait-many",
				mode: any ? "any" : "all",
				agents: [...flags.positional],
				until,
				timeoutSeconds,
				...(workspace === undefined ? {} : { workspace }),
			};
		}
		default:
			throw new Refusal(
				"agent takes: new, read, send, interrupt, requests, answer, wait, status, stop, restart, resume, rename, meta.",
			);
	}
}

function parseTerminal(
	sub: string | undefined,
	rest: readonly string[],
): TellCommand {
	switch (sub) {
		case "open": {
			const flags = readFlags(rest, {
				values: ["--command"],
				switches: ["--focus"],
			});
			positionals(flags, []);
			return {
				verb: "terminal-open",
				focus: flags.switches.has("--focus"),
				...defined({ command: one(flags, "--command") }),
			};
		}
		case "status":
		case "show":
			positionals(readFlags(rest, NO_FLAGS), []);
			return { verb: "terminal-status" };
		case "close":
			positionals(readFlags(rest, NO_FLAGS), []);
			return { verb: "terminal-close" };
		case "panes":
			positionals(readFlags(rest, NO_FLAGS), []);
			return { verb: "terminal-panes" };
		case "bring": {
			const flags = readFlags(rest, { values: [], switches: ["--focus"] });
			const [pane] = positionals(flags, ["<pane>"]);
			if (!/^%\d+$/u.test(pane!))
				throw new Refusal(
					"bring takes a tmux pane id, like %7: see 'devhub --tell terminal panes'.",
				);
			return {
				verb: "terminal-bring",
				pane: pane!,
				focus: flags.switches.has("--focus"),
			};
		}
		default:
			throw new Refusal(
				"terminal takes: open, status (or show), close, panes, bring. It is always your own terminal, shown with your pane.",
			);
	}
}

function defined<T extends Record<string, unknown>>(
	record: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

// ---------------------------------------------------------------------------
// The app's side: a `TellCommand` back off the socket.

function text(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`a tell command's ${key} must be a non-empty string`);
	return value;
}

function optionalText(
	record: Record<string, unknown>,
	key: string,
): Record<string, string> {
	return record[key] === undefined ? {} : { [key]: text(record, key) };
}

/** An escalation's ranking off the socket: each of the three, when there. */
function rankRecord(record: Record<string, unknown>): {
	readonly priority?: "high" | "normal" | "low";
	readonly effort?: "quick" | "normal" | "deep";
	readonly rankNote?: string;
} {
	const priority = record["priority"];
	const effort = record["effort"];
	const note = record["rankNote"];
	if (
		priority !== undefined &&
		priority !== "high" &&
		priority !== "normal" &&
		priority !== "low"
	)
		throw new Error("a tell command's priority must be high, normal or low");
	if (
		effort !== undefined &&
		effort !== "quick" &&
		effort !== "normal" &&
		effort !== "deep"
	)
		throw new Error("a tell command's effort must be quick, normal or deep");
	// An empty note is how a note is taken away.
	if (note !== undefined && typeof note !== "string")
		throw new Error("a tell command's rankNote must be a string");
	return {
		...(priority === undefined ? {} : { priority }),
		...(effort === undefined ? {} : { effort }),
		...(note === undefined ? {} : { rankNote: note }),
	};
}

function optionalPresentation(record: Record<string, unknown>): {
	presentation?: "gui" | "tui";
} {
	const value = record["presentation"];
	if (value === undefined) return {};
	if (value !== "gui" && value !== "tui")
		throw new Error("a tell command's presentation must be gui or tui");
	return { presentation: value };
}

function optionalStart(record: Record<string, unknown>): {
	start?: "draft" | "send";
} {
	const value = record["start"];
	if (value === undefined) return {};
	if (value !== "draft" && value !== "send")
		throw new Error("a tell command's start must be draft or send");
	return { start: value };
}

function optionalMeta(record: Record<string, unknown>): {
	meta?: readonly AgentMetaPair[];
} {
	const value = record["meta"];
	if (value === undefined) return {};
	if (!Array.isArray(value))
		throw new Error("a tell command's meta must be a list");
	const pairs = value.map((each: unknown): AgentMetaPair => {
		if (typeof each !== "object" || each === null)
			throw new Error("a tell command's meta must be key/value pairs");
		const { key, value: text } = each as Record<string, unknown>;
		if (typeof key !== "string" || typeof text !== "string")
			throw new Error("a tell command's meta must be key/value pairs");
		const problem = metaKeyProblem(key) ?? metaValueProblem(text);
		if (problem !== undefined) throw new Error(problem);
		return { key, value: text };
	});
	return { meta: pairs };
}

function absolute(record: Record<string, unknown>, key: string): string {
	const value = text(record, key);
	if (!value.startsWith("/"))
		throw new Error(`a tell command's ${key} must be an absolute path`);
	return value;
}

function integer(
	value: unknown,
	key: string,
	min: number,
	max: number,
): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	)
		throw new Error(
			`a tell command's ${key} must be a whole number from ${min} to ${max}`,
		);
	return value;
}

function answerParts(value: unknown): { questions?: readonly AnswerPart[] } {
	if (value === undefined) return {};
	if (!Array.isArray(value) || value.length === 0)
		throw new Error("a tell command's questions must be a non-empty list");
	return {
		questions: value.map((each: unknown): AnswerPart => {
			if (typeof each !== "object" || each === null)
				throw new Error("a tell command's questions must be objects");
			const part = each as Record<string, unknown>;
			const options = part["options"];
			if (!Array.isArray(options))
				throw new Error("a tell command's question options must be a list");
			const text = part["text"];
			if (text !== undefined && typeof text !== "string")
				throw new Error("a tell command's question text must be a string");
			return {
				question: textOf(part, "question"),
				options: options.map((option) => integer(option, "option", 1, 100)),
				...(text === undefined ? {} : { text }),
			};
		}),
	};
}

function textList(
	record: Record<string, unknown>,
	key: string,
): readonly string[] {
	const value = record[key];
	if (
		!Array.isArray(value) ||
		value.some((one) => typeof one !== "string" || one.length === 0)
	)
		throw new Error(`a tell command's ${key} must be a list of strings`);
	return value as string[];
}

function textOf(record: Record<string, unknown>, key: string): string {
	return text(record, key);
}

function until(record: Record<string, unknown>): AgentWaitUntil {
	const value = record["until"];
	if (value !== "idle" && value !== "waiting" && value !== "any")
		throw new Error("a tell command's until must be idle, waiting or any");
	return value;
}

/** Accept exactly what `parseTellArguments` can produce. */
export function tellCommandFrom(value: unknown): TellCommand {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("a tell command must be a JSON object");
	const record = value as Record<string, unknown>;
	switch (record["verb"]) {
		case "help":
		case "workspaces":
		case "commands":
			return { verb: record["verb"] };
		case "usage":
			return { verb: "usage" };
		case "skill":
			return record["orchestrator"] === true
				? { verb: "skill", orchestrator: true }
				: { verb: "skill" };
		case "workspace-open":
			return {
				verb: "workspace-open",
				path: absolute(record, "path"),
				...optionalText(record, "worktree"),
			};
		case "workspace-status":
			return {
				verb: "workspace-status",
				workspace: text(record, "workspace"),
			};
		case "workspace-close": {
			if (typeof record["discardUnsaved"] !== "boolean")
				throw new Error("a tell command's discardUnsaved must be a boolean");
			const only = <T extends string>(key: string, allowed: readonly T[]) => {
				const value = record[key];
				if (value === undefined) return {};
				if (!(allowed as readonly unknown[]).includes(value))
					throw new Error(
						`a tell command's ${key} must be ${allowed.join(" or ")}`,
					);
				return { [key]: value as T };
			};
			return {
				verb: "workspace-close",
				workspace: text(record, "workspace"),
				discardUnsaved: record["discardUnsaved"],
				...(only("worktree", ["keep", "remove"] as const) as {
					worktree?: "keep" | "remove";
				}),
				...(only("agents", ["stop"] as const) as { agents?: "stop" }),
				...(only("terminals", ["close"] as const) as {
					terminals?: "close";
				}),
			};
		}
		case "agents":
			return {
				verb: "agents",
				...optionalText(record, "workspace"),
				...optionalMeta(record),
			};
		case "profiles":
		case "issue-actions":
			return { verb: record["verb"] };
		case "agent-rename":
			return {
				verb: "agent-rename",
				agent: text(record, "agent"),
				...optionalText(record, "name"),
			};
		case "agent-meta": {
			const op = record["op"];
			if (op !== "list" && op !== "set" && op !== "unset")
				throw new Error("a tell command's op must be list, set or unset");
			if (op === "list")
				return { verb: "agent-meta", agent: text(record, "agent"), op };
			const key = text(record, "key");
			const keyProblem = metaKeyProblem(key);
			if (keyProblem !== undefined) throw new Error(keyProblem);
			if (op === "unset")
				return { verb: "agent-meta", agent: text(record, "agent"), op, key };
			const value = record["value"];
			if (typeof value !== "string")
				throw new Error("a tell command's value must be a string");
			const valueProblem = metaValueProblem(value);
			if (valueProblem !== undefined) throw new Error(valueProblem);
			return {
				verb: "agent-meta",
				agent: text(record, "agent"),
				op,
				key,
				value,
			};
		}
		case "agent-new":
			return {
				verb: "agent-new",
				...optionalText(record, "workspace"),
				...optionalText(record, "profile"),
				...optionalText(record, "name"),
				...optionalText(record, "prompt"),
				...optionalPresentation(record),
				...optionalMeta(record),
			};
		case "issue-assign": {
			const place = record["place"];
			if (place !== "worktree" && place !== "root")
				throw new Error("a tell command's place must be worktree or root");
			if (typeof record["editorOnly"] !== "boolean")
				throw new Error("a tell command's editorOnly must be a boolean");
			return {
				verb: "issue-assign",
				url: text(record, "url"),
				place,
				editorOnly: record["editorOnly"],
				...(record["repo"] === undefined
					? {}
					: { repo: absolute(record, "repo") }),
				...optionalText(record, "branch"),
				...optionalText(record, "profile"),
				...optionalText(record, "action"),
				...optionalText(record, "prompt"),
				...optionalPresentation(record),
				...optionalStart(record),
				...optionalMeta(record),
			};
		}
		case "agent-read":
			return {
				verb: "agent-read",
				agent: text(record, "agent"),
				...(record["last"] === undefined
					? {}
					: { last: integer(record["last"], "last", 1, 1000) }),
				...optionalText(record, "since"),
				...optionalText(record, "entry"),
				...(record["full"] === undefined
					? {}
					: record["full"] === true
						? { full: true }
						: (() => {
								throw new Error("a tell command's full must be true");
							})()),
			};
		case "agent-send":
			return {
				verb: "agent-send",
				agent: text(record, "agent"),
				text: text(record, "text"),
			};
		case "agent-interrupt":
		case "agent-requests":
		case "agent-status":
		case "agent-stop":
		case "agent-restart":
			return { verb: record["verb"], agent: text(record, "agent") };
		case "agent-wait-many": {
			const mode = record["mode"];
			if (mode !== "any" && mode !== "all")
				throw new Error("a tell command's mode must be any or all");
			const agents = record["agents"];
			if (!Array.isArray(agents))
				throw new Error("a tell command's agents must be a list");
			return {
				verb: "agent-wait-many",
				mode,
				agents: agents.map((each: unknown) => {
					if (typeof each !== "string" || each.length === 0)
						throw new Error(
							"a tell command's agents must be non-empty strings",
						);
					return each;
				}),
				until: until(record),
				timeoutSeconds: integer(
					record["timeoutSeconds"],
					"timeoutSeconds",
					1,
					MAX_WAIT_SECONDS,
				),
				...optionalText(record, "workspace"),
			};
		}
		case "sessions":
			return {
				verb: "sessions",
				limit: integer(record["limit"], "limit", 1, MAX_SESSIONS_LIMIT),
				...optionalText(record, "workspace"),
				...optionalText(record, "folder"),
				...(record["all"] === true ? { all: true as const } : {}),
				...optionalText(record, "profile"),
				...optionalMeta(record),
			};
		case "session-meta": {
			const op = record["op"];
			if (op !== "list" && op !== "set" && op !== "unset")
				throw new Error("a tell command's op must be list, set or unset");
			const where = {
				session: text(record, "session"),
				...optionalText(record, "workspace"),
				...optionalText(record, "profile"),
			};
			if (op === "list") return { verb: "session-meta", op, ...where };
			const key = text(record, "key");
			const keyProblem = metaKeyProblem(key);
			if (keyProblem !== undefined) throw new Error(keyProblem);
			if (op === "unset") return { verb: "session-meta", op, key, ...where };
			const value = record["value"];
			if (typeof value !== "string")
				throw new Error("a tell command's value must be a string");
			const valueProblem = metaValueProblem(value);
			if (valueProblem !== undefined) throw new Error(valueProblem);
			return { verb: "session-meta", op, key, value, ...where };
		}
		case "agent-resume":
			return {
				verb: "agent-resume",
				session: text(record, "session"),
				...optionalText(record, "workspace"),
				...optionalText(record, "folder"),
				...optionalText(record, "profile"),
				...optionalText(record, "name"),
			};
		case "agent-answer": {
			const options = record["options"];
			if (!Array.isArray(options))
				throw new Error("a tell command's options must be a list");
			return {
				verb: "agent-answer",
				agent: text(record, "agent"),
				request: text(record, "request"),
				options: options.map((option) => integer(option, "option", 1, 100)),
				...answerParts(record["questions"]),
				...(record["text"] === undefined
					? {}
					: typeof record["text"] === "string"
						? { text: record["text"] }
						: (() => {
								throw new Error("a tell command's text must be a string");
							})()),
			};
		}
		case "agent-wait": {
			return {
				verb: "agent-wait",
				agent: text(record, "agent"),
				until: until(record),
				timeoutSeconds: integer(
					record["timeoutSeconds"],
					"timeoutSeconds",
					1,
					MAX_WAIT_SECONDS,
				),
			};
		}
		case "terminal-open": {
			if (typeof record["focus"] !== "boolean")
				throw new Error("a tell command's focus must be a boolean");
			return {
				verb: "terminal-open",
				focus: record["focus"],
				...optionalText(record, "command"),
			};
		}
		case "terminal-status":
			return { verb: "terminal-status" };
		case "terminal-close":
			return { verb: "terminal-close" };
		case "terminal-panes":
			return { verb: "terminal-panes" };
		case "terminal-bring": {
			if (typeof record["focus"] !== "boolean")
				throw new Error("a tell command's focus must be a boolean");
			return {
				verb: "terminal-bring",
				pane: text(record, "pane"),
				focus: record["focus"],
			};
		}
		case "board":
		case "orchestrator-status":
		case "orchestrator-stop":
		case "orchestrator-restart":
		case "orchestrator-pause":
		case "orchestrator-resume":
			return { verb: record["verb"] };
		case "escalation-new":
			return {
				verb: "escalation-new",
				title: text(record, "title"),
				body: text(record, "body"),
				agents: textList(record, "agents"),
				links: textList(record, "links"),
				options: textList(record, "options"),
				...optionalText(record, "workspace"),
				...rankRecord(record),
			};
		case "escalation-ask":
			return {
				verb: "escalation-ask",
				id: integer(record["id"], "id", 1, 999_999_999),
				body: text(record, "body"),
				options: textList(record, "options"),
				...(record["links"] === undefined
					? {}
					: { links: textList(record, "links") }),
			};
		case "escalation-show":
			return {
				verb: "escalation-show",
				id: integer(record["id"], "id", 1, 999_999_999),
			};
		case "escalation-list": {
			const state = record["state"];
			if (
				state !== undefined &&
				state !== "needs_answer" &&
				state !== "in_progress" &&
				state !== "closed"
			)
				throw new Error(
					"a tell command's state must be needs_answer, in_progress or closed",
				);
			return {
				verb: "escalation-list",
				...(state === undefined ? {} : { state }),
			};
		}
		case "escalation-close":
			return {
				verb: "escalation-close",
				id: integer(record["id"], "id", 1, 999_999_999),
				...optionalText(record, "note"),
			};
		case "escalation-hold":
			return {
				verb: "escalation-hold",
				id: integer(record["id"], "id", 1, 999_999_999),
				...optionalText(record, "note"),
			};
		case "escalation-link":
			return {
				verb: "escalation-link",
				id: integer(record["id"], "id", 1, 999_999_999),
				agent: text(record, "agent"),
			};
		case "escalation-rank":
			return {
				verb: "escalation-rank",
				id: integer(record["id"], "id", 1, 999_999_999),
				...rankRecord(record),
			};
		case "orchestrator-events":
			return {
				verb: "orchestrator-events",
				last: integer(record["last"], "last", 1, EVENT_LOG_LIMIT),
			};
		case "orchestrator-emit":
			return {
				verb: "orchestrator-emit",
				type: text(record, "type"),
				text: text(record, "text"),
			};
		case "orchestrator-timer-list":
			return { verb: "orchestrator-timer-list" };
		case "orchestrator-timer-set":
			return {
				verb: "orchestrator-timer-set",
				name: text(record, "name"),
				interval: text(record, "interval"),
			};
		case "orchestrator-timer-clear":
			return { verb: "orchestrator-timer-clear", name: text(record, "name") };
		case "orchestrator-start":
			return {
				verb: "orchestrator-start",
				...(record["root"] === undefined
					? {}
					: { root: absolute(record, "root") }),
				...optionalText(record, "profile"),
				...optionalText(record, "prompt"),
				...optionalPresentation(record),
			};
		case "run":
			return { verb: "run", command: text(record, "command") };
		case "focus":
			return { verb: "focus", target: text(record, "target") };
		case "link": {
			const kind = record["kind"];
			if (!(LINK_TARGET_KINDS as unknown[]).includes(kind))
				throw new Error(
					`a tell command's kind must be one of ${LINK_TARGET_KINDS.join(", ")}`,
				);
			const typed = kind as LinkTargetKind;
			if (typed === "orchestrator") return { verb: "link", kind: typed };
			return {
				verb: "link",
				kind: typed,
				...(typed === "file"
					? { target: absolute(record, "target") }
					: { target: text(record, "target") }),
				...(typed === "file" && record["line"] !== undefined
					? { line: integer(record["line"], "line", 1, 9_999_999) }
					: {}),
				...(typed === "file" && record["column"] !== undefined
					? { column: integer(record["column"], "column", 1, 9_999_999) }
					: {}),
			};
		}
		case "notify":
			return { verb: "notify", text: text(record, "text") };
		default:
			throw new Error(`unknown tell command: ${String(record["verb"])}`);
	}
}
