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
 * an Agent, answer the question it asked — and it goes through the same path
 * the window's does (see `tell/service.ts`). The one thing deliberately left
 * out is a permission prompt: whether a tool call may run is the person's
 * decision, in DevHub, and no command line can make it for them.
 */

export type AgentWaitUntil = "idle" | "waiting" | "any";

export type TellCommand =
	| { readonly verb: "help" }
	| { readonly verb: "workspaces" }
	| {
			readonly verb: "workspace-open";
			/** An absolute path, expanded on the CLI's side against its cwd. */
			readonly path: string;
			/** A branch to open a worktree of, made if it is not there yet. */
			readonly worktree?: string;
	  }
	| { readonly verb: "agents"; readonly workspace?: string }
	| {
			readonly verb: "agent-new";
			/** Absent: the workspace of the pane that asked (`DEVHUB_ORIGIN`). */
			readonly workspace?: string;
			readonly profile?: string;
			readonly name?: string;
			readonly prompt?: string;
			readonly presentation?: "gui" | "tui";
	  }
	| {
			readonly verb: "issue-assign";
			readonly url: string;
			/** A clone of the repository: its absolute path. Absent: the first DevHub finds. */
			readonly repo?: string;
			readonly branch?: string;
			/** Where the branch is checked out: a new worktree (default) or the clone itself. */
			readonly place: "worktree" | "root";
			readonly profile?: string;
			/** One of the configured `agent_actions`, by id. Absent: the first enabled one. */
			readonly action?: string;
			readonly prompt?: string;
			readonly editorOnly: boolean;
			readonly presentation?: "gui" | "tui";
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
			/** The asking Agent's own terminal, opened or shown. */
			readonly verb: "terminal-open";
			/** Typed into its shell when this starts it (not when it was running). */
			readonly command?: string;
			/** Put the person's keyboard in it. Default: leave it where it is. */
			readonly focus: boolean;
	  }
	| { readonly verb: "terminal-status" }
	| { readonly verb: "terminal-close" }
	| { readonly verb: "commands" }
	| { readonly verb: "run"; readonly command: string }
	| { readonly verb: "focus"; readonly target: string }
	| { readonly verb: "notify"; readonly text: string };

export type TellVerb = TellCommand["verb"];

/** The longest `agent wait` there is: a request stays open no longer. */
export const MAX_WAIT_SECONDS = 600;
export const DEFAULT_WAIT_SECONDS = 300;

export const TELL_USAGE = `devhub --tell — ask the running DevHub to do what its window does.

usage: devhub --tell [--json] <subcommand> [arguments]

  --json  print the answer as JSON (for scripts and agents) instead of text

workspaces
  workspaces                       list open workspaces: id, name, path,
                                   machine, branch, worktree, Issue
  workspace open <path> [--worktree <branch>]
                                   open a folder as a workspace (Cmd+Q f);
                                   with --worktree, open (making it if needed)
                                   the worktree of <branch> in the clone at
                                   <path>; the branch must name an Issue
                                   number, like 123-fix-login

agents
  agents [--workspace <w>]         list agents: id, name, kind, status,
                                   unread, open requests, activity
  agent new [--workspace <w>] [--profile <p>] [--name <n>] [--gui|--tui]
            [--prompt <text>|-]    start an agent (Cmd+Q c) and, with
                                   --prompt, tell it something once it is up;
                                   without --workspace, in the workspace of
                                   the terminal or agent asking
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

issues
  issue assign <url> [--repo <path>] [--branch <name>] [--root]
               [--profile <p>] [--action <id>] [--prompt <text>|-]
               [--editor-only] [--gui|--tui]
                                   hand an Issue or pull request to a new
                                   agent (Cmd+Q i), in a worktree of
                                   <branch> (default: the Issue's own
                                   feature/<n>-wip)

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

app
  commands                         list the command palette's commands
  run <command-id>                 run one of them, exactly as the palette
                                   does (it asks first wherever the window
                                   would)
  focus <agent|workspace>          select it in DevHub
  notify <text>                    show a notification in DevHub

<w> is a workspace id, its folder, its name, or "scratch". A folder is a
folder on the machine devhub runs on: on an SSH host, the host's.
<a> is an agent id (or a unique prefix of one) or its name.`;

export type TellParse =
	| {
			readonly kind: "tell";
			readonly command: TellCommand;
			readonly json: boolean;
	  }
	| { readonly kind: "invalid"; readonly message: string };

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
	while (args[0] === "--json") {
		json = true;
		args = args.slice(1);
	}
	try {
		return { kind: "tell", command: parseVerb(args), json };
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
				values: ["--workspace"],
				switches: [],
			});
			positionals(flags, []);
			const workspace = one(flags, "--workspace");
			return {
				verb: "agents",
				...(workspace === undefined ? {} : { workspace }),
			};
		}
		case "agent":
			return parseAgent(sub, rest);
		case "issue": {
			if (sub !== "assign")
				throw new Refusal("issue takes one subcommand: assign.");
			const flags = readFlags(rest, {
				values: [
					"--repo",
					"--branch",
					"--profile",
					"--action",
					"--prompt",
					"--prompt-extra",
				],
				switches: ["--root", "--worktree", "--editor-only", "--gui", "--tui"],
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
				values: ["--workspace", "--profile", "--name", "--prompt"],
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
				}),
			};
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
		case "requests": {
			const [agent] = positionals(readFlags(rest, NO_FLAGS), ["<agent>"]);
			return sub === "interrupt"
				? { verb: "agent-interrupt", agent: agent! }
				: { verb: "agent-requests", agent: agent! };
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
				values: ["--until", "--timeout"],
				switches: [],
			});
			const [agent] = positionals(flags, ["<agent>"]);
			const until = one(flags, "--until") ?? "any";
			if (until !== "idle" && until !== "waiting" && until !== "any")
				throw new Refusal("--until takes idle, waiting or any.");
			const timeout = one(flags, "--timeout");
			return {
				verb: "agent-wait",
				agent: agent!,
				until,
				timeoutSeconds:
					timeout === undefined
						? DEFAULT_WAIT_SECONDS
						: count(timeout, "--timeout", 1, MAX_WAIT_SECONDS),
			};
		}
		default:
			throw new Refusal(
				"agent takes: new, read, send, interrupt, requests, answer, wait.",
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
		default:
			throw new Refusal(
				"terminal takes: open, status (or show), close. It is always your own terminal, shown with your pane.",
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
		case "workspace-open":
			return {
				verb: "workspace-open",
				path: absolute(record, "path"),
				...optionalText(record, "worktree"),
			};
		case "agents":
			return { verb: "agents", ...optionalText(record, "workspace") };
		case "agent-new":
			return {
				verb: "agent-new",
				...optionalText(record, "workspace"),
				...optionalText(record, "profile"),
				...optionalText(record, "name"),
				...optionalText(record, "prompt"),
				...optionalPresentation(record),
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
			return { verb: record["verb"], agent: text(record, "agent") };
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
			const until = record["until"];
			if (until !== "idle" && until !== "waiting" && until !== "any")
				throw new Error("a tell command's until must be idle, waiting or any");
			return {
				verb: "agent-wait",
				agent: text(record, "agent"),
				until,
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
