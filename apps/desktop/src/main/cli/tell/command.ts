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

/** One `--meta KEY=VALUE`, checked (`checkMetaKey`, `checkMetaValue`). */
export interface AgentMetaPair {
	readonly key: string;
	readonly value: string;
}

export type TellCommand =
	| { readonly verb: "help" }
	/** The /devhub skill's text, for an agent DevHub did not start. */
	| { readonly verb: "skill" }
	| { readonly verb: "workspaces" }
	| {
			readonly verb: "workspace-open";
			/** An absolute path, expanded on the CLI's side against its cwd. */
			readonly path: string;
			/** A branch to open a worktree of, made if it is not there yet. */
			readonly worktree?: string;
	  }
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
			/** One-based option numbers, for a request with one question. */
			readonly options: readonly number[];
			/** Free text, for a question that takes an answer of its own. */
			readonly text?: string;
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
			readonly profile?: string;
			readonly limit: number;
	  }
	| {
			/** One of them, gone on with in a new GUI Agent. */
			readonly verb: "agent-resume";
			readonly session: string;
			readonly workspace?: string;
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
	| { readonly verb: "run"; readonly command: string }
	| { readonly verb: "focus"; readonly target: string }
	| { readonly verb: "notify"; readonly text: string };

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

Commands that start or create something take every choice as an argument:
the flags marked (required) have no default, so what you get never depends
on the person's settings or on which item is listed first. Run 'profiles'
and 'issue actions' for the values. A call missing one changes nothing and
says which flags, and their values.

workspaces
  workspaces                       list open workspaces: id, name, path,
                                   machine, branch, worktree, Issue
  workspace open <path> [--worktree <branch>]
                                   open a folder as a workspace (Cmd+Q f);
                                   with --worktree, open (making it if needed)
                                   the worktree of <branch> in the clone at
                                   <path>; the branch must name an Issue
                                   number, like 123-fix-login. Without it,
                                   <path> itself: nothing here reads a
                                   setting

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
  agent read <a> [--last <n>] [--since <cursor>]
                                   the transcript of a GUI agent, as text;
                                   prints a cursor to pass as --since
  agent send <a> <text>|-          say something to an agent; queued while
                                   it is busy, like the composer does
  agent interrupt <a>              stop the agent's current turn
  agent requests <a>               the questions it is waiting on, with ids
                                   (permission prompts are listed, but are
                                   answered in DevHub only)
  agent answer <a> <request> [--option <n>]... [--text <t>]
                                   answer an AskUserQuestion-style question
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
  sessions [--workspace <w>] [--profile <p>] [--limit <n>]
                                   earlier Claude/Codex sessions to resume, as
                                   the agent picker lists them: id, profile,
                                   when, title or agent name, branch or
                                   worktree (default: your workspace, 20)
  agent resume <session> [--workspace <w>] [--profile <p>] [--name <n>]
                                   go on with one in a new GUI agent, as the
                                   picker does. Where it opens is the
                                   session's own: its folder, or its
                                   worktree (opened, or checked out again).
                                   --workspace is where it is looked up
                                   (default: yours, a fact of where you run,
                                   not a setting). --profile is required only
                                   when two profiles run the session's CLI.
                                   Always GUI: there is no --tui here

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
  commands                         list the command palette's commands
  run <command-id>                 run one of them, exactly as the palette
                                   does - only those that move nothing in
                                   the window (refresh_repositories,
                                   mark_agent_unread); one that would ask or
                                   go somewhere is refused, naming the --tell
                                   command to use instead
  focus <agent|workspace>          select it in DevHub
  notify <text>                    show a notification in DevHub

<w> is a workspace id, its folder, its name, or "scratch". A folder is a
folder on the machine devhub runs on: on an SSH host, the host's.
<a> is an agent id (or a unique prefix of one) or its name. <session> is a
session id from 'sessions' (or a unique prefix of one).

No --tell command puts a picker or a sheet up in the window, and none but
'focus' (and an explicit --focus) changes what the window selects or shows,
moves its keyboard or brings it to the front: what a command makes appears
in the Sidebar, unselected. Where the window would ask, the command takes
the answer as an argument.

The few defaults left are fixed, never read from settings: agent read
--last 20, agent wait --until any --timeout 300, sessions --limit 20, and
your own workspace where sessions and agent resume look sessions up - which
is where you run, not a setting.`;

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
		return {
			kind: "tell",
			command: parseVerb(args),
			json,
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
		case "skill":
			positionals(readFlags(args.slice(1), NO_FLAGS), []);
			return { verb: "skill" };
		case "workspace": {
			if (sub !== "open")
				throw new Refusal("workspace takes one subcommand: open.");
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
		case "sessions": {
			const flags = readFlags(args.slice(1), {
				values: ["--workspace", "--profile", "--limit"],
				switches: [],
			});
			positionals(flags, []);
			const limit = one(flags, "--limit");
			return {
				verb: "sessions",
				limit:
					limit === undefined
						? DEFAULT_SESSIONS_LIMIT
						: count(limit, "--limit", 1, MAX_SESSIONS_LIMIT),
				...defined({
					workspace: one(flags, "--workspace"),
					profile: one(flags, "--profile"),
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
				values: ["--last", "--since"],
				switches: [],
			});
			const [agent] = positionals(flags, ["<agent>"]);
			const last = one(flags, "--last");
			const since = one(flags, "--since");
			return {
				verb: "agent-read",
				agent: agent!,
				...(last === undefined ? {} : { last: count(last, "--last", 1, 1000) }),
				...(since === undefined ? {} : { since }),
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
				values: ["--workspace", "--profile", "--name"],
				switches: [],
			});
			const [session] = positionals(flags, ["<session>"]);
			return {
				verb: "agent-resume",
				session: session!,
				...defined({
					workspace: one(flags, "--workspace"),
					profile: one(flags, "--profile"),
					name: one(flags, "--name"),
				}),
			};
		}
		case "answer": {
			const flags = readFlags(rest, {
				values: ["--option", "--text"],
				switches: ["--allow", "--deny"],
			});
			if (flags.switches.has("--allow") || flags.switches.has("--deny"))
				throw new Refusal(
					"permission prompts are answered in DevHub, by the person, and never from the command line.",
				);
			const [agent, request] = positionals(flags, ["<agent>", "<request>"]);
			const options = (flags.values.get("--option") ?? []).map((value) =>
				count(value, "--option", 1, 100),
			);
			const text = one(flags, "--text");
			if (options.length === 0 && text === undefined)
				throw new Refusal("agent answer needs --option <n> or --text <t>.");
			return {
				verb: "agent-answer",
				agent: agent!,
				request: request!,
				options,
				...(text === undefined ? {} : { text }),
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
		case "skill":
		case "workspaces":
		case "commands":
			return { verb: record["verb"] };
		case "workspace-open":
			return {
				verb: "workspace-open",
				path: absolute(record, "path"),
				...optionalText(record, "worktree"),
			};
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
				...optionalText(record, "profile"),
			};
		case "agent-resume":
			return {
				verb: "agent-resume",
				session: text(record, "session"),
				...optionalText(record, "workspace"),
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
		case "run":
			return { verb: "run", command: text(record, "command") };
		case "focus":
			return { verb: "focus", target: text(record, "target") };
		case "notify":
			return { verb: "notify", text: text(record, "text") };
		default:
			throw new Error(`unknown tell command: ${String(record["verb"])}`);
	}
}
