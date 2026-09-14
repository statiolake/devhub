/**
 * The `devhub` command.
 *
 * It runs under the app's own Electron binary with `ELECTRON_RUN_AS_NODE=1`,
 * which is what the generated launcher in the PATH directory arranges — so
 * there is no dependency on a system Node, in a checkout or in a packaged app.
 * Nothing here imports Electron, or anything from the app: this file is a
 * socket client and an argument parser, and the whole of DevHub's behaviour
 * lives on the other side of the socket.
 *
 * That includes `--version` and the extension options, which `code` answers in
 * a separate short-lived process of its own. DevHub does not: a second process
 * installing extensions into the directory the running app owns is the same
 * split-brain the single-instance design exists to prevent, and a version
 * printed from somewhere other than the running app is a version of something
 * else. One front door, and it is the socket.
 *
 * When DevHub is not running the command starts it, waits for its socket, and
 * then sends the request it was given — see `launch.ts`. Every command does
 * this, so nothing downstream of the send is written twice, once for a warm
 * DevHub and once for a cold one. Nothing here ever starts a second instance
 * against a user-data directory the first one owns, which is the failure mode
 * the whole single-instance design exists to avoid: the app's own
 * single-instance lock makes a second start a no-op, and the CLI only ever
 * waits for the one socket.
 */

import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFileAndPosition, type FilePosition } from "./goto.js";
import {
	commandLauncher,
	forwardedSocketLauncher,
	LAUNCH_COMMAND_ENVIRONMENT_VARIABLE,
	NotRunning,
	parseLaunchCommand,
	sendOrLaunch,
	type Launcher,
} from "./launch.js";
import { expandPath } from "./resolve.js";
import { spoolStdin, stdinSpoolPath } from "./stdin.js";
import {
	createMarker,
	markerWorld,
	removeMarker,
	waitForClose,
} from "./wait.js";
import type { ControlRequest, ControlResponse } from "./protocol.js";

export const USAGE = `devhub — drive the running DevHub from a terminal.

usage:
  devhub                           bring DevHub to the front
  devhub <folder>                  make the folder a workspace, show it, and
                                   bring DevHub to the front
  devhub <file>                    open the file in the workspace whose root
                                   contains it, or in the Scratch editor when
                                   no open workspace does
  devhub -                         open what is piped in as an editor, the way
                                   'code -' does; it lands in Scratch, like any
                                   other file no open workspace contains
  devhub -w|--wait <file>          open the file and do not return until its
                                   editor is closed again, so that this can be
                                   your EDITOR; closing it puts DevHub back
                                   where it was; combines with - and --goto
  devhub -g|--goto <file:line[:col]>
                                   open the file the same way and put the
                                   cursor on that line and column
  devhub --agent <profile> [-- <args>...]
                                   add an agent with that profile to the
                                   workspace containing the current directory
                                   and select it; <args> are appended to the
                                   profile's own arguments

extensions:
  devhub --install-extension <ext-id|path-to-vsix>
                                   install an extension from the gallery, or
                                   from a .vsix file; repeat the option to
                                   install several
  devhub --uninstall-extension <ext-id>
                                   uninstall an extension; repeat for several
  --force                          install over an extension that is already
                                   there, and uninstall one the user marked as
                                   built in
  devhub --list-extensions         list the installed extensions, one per line
  --show-versions                  list them as <ext-id>@<version>

  devhub -v|--version              print DevHub's version, VS Code's, and the
                                   commit it was built from
  devhub --metrics                 print, as JSON, what the running DevHub is
                                   costing: every process's CPU and memory,
                                   which workbench each renderer is showing,
                                   and how often DevHub polls. Take two
                                   readings a known time apart to get a rate.
  devhub -h|--help                 show this text

The command talks to DevHub over its control socket. If DevHub is not running
it is started first, and the command then does what it was asked.`;

/** What to say after a refusal, so nobody has to guess where the list is. */
const HINT = "Run 'devhub --help' to see what devhub takes.";

export type Command =
	| { readonly kind: "usage" }
	| { readonly kind: "activate" }
	| { readonly kind: "open-stdin"; readonly wait: boolean }
	| { readonly kind: "invalid"; readonly message: string }
	| {
			readonly kind: "open";
			readonly path: string;
			readonly position: FilePosition | undefined;
			readonly wait: boolean;
	  }
	| {
			readonly kind: "add-agent";
			readonly profileId: string;
			readonly args: readonly string[];
	  }
	| {
			readonly kind: "install-extensions";
			readonly targets: readonly string[];
			readonly force: boolean;
	  }
	| {
			readonly kind: "uninstall-extensions";
			readonly ids: readonly string[];
			readonly force: boolean;
	  }
	| { readonly kind: "list-extensions"; readonly showVersions: boolean }
	| { readonly kind: "version" }
	| { readonly kind: "metrics" };

/**
 * What the arguments asked for.
 *
 * `--` is the boundary and nothing else is: every argument after it belongs to
 * the agent, including ones that look like DevHub's own options. That is the
 * only way `devhub --agent claude -- --help` can mean "ask claude for its
 * help" rather than "print mine". `--agent` therefore has to come first, and
 * everything else is read by the scanner below.
 *
 * An option this command does not know is a refusal with a sentence, never a
 * path: `devhub --isntall-extension x` that quietly tried to open a file
 * called `--isntall-extension` would report a missing file, and the typo would
 * be the last thing anybody suspected.
 */
export function parseArguments(argv: readonly string[]): Command {
	const args = splitAssignments(argv);
	// `devhub` on its own is not a mistake, it is the smallest thing the
	// command can be asked for: put the app you already have in front of you.
	// The refusal below it is for arguments that add up to nothing — `devhub
	// --force` — which *is* a mistake, and a different one.
	if (args.length === 0) return { kind: "activate" };
	if (args[0] === "--help" || args[0] === "-h") return { kind: "usage" };
	if (args[0] === "--agent") return parseAgent(args.slice(1));
	return parseOptions(args);
}

/** `--option=value` is `--option value`; every reader downstream sees one form. */
function splitAssignments(argv: readonly string[]): readonly string[] {
	const out: string[] = [];
	for (const arg of argv) {
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		if (equals > 2) {
			out.push(arg.slice(0, equals), arg.slice(equals + 1));
		} else {
			out.push(arg);
		}
	}
	return out;
}

function parseAgent(rest: readonly string[]): Command {
	const profileId = rest[0];
	if (profileId === undefined || profileId.startsWith("-")) {
		return {
			kind: "invalid",
			message: "--agent needs the name of an agent profile.",
		};
	}
	const args = rest.slice(1);
	if (args.length === 0) return { kind: "add-agent", profileId, args: [] };
	if (args[0] !== "--") {
		return {
			kind: "invalid",
			message:
				"arguments for the agent go after `--`, as in: devhub --agent claude -- --model opus.",
		};
	}
	return { kind: "add-agent", profileId, args: args.slice(1) };
}

/**
 * Everything that is not `--agent`.
 *
 * The options are gathered in any order and the mode is decided at the end,
 * from what was gathered. Deciding it from the first argument instead would
 * make `--force --install-extension x` a different command from
 * `--install-extension x --force`, and `code` treats them as one.
 */
function parseOptions(args: readonly string[]): Command {
	const install: string[] = [];
	const uninstall: string[] = [];
	const paths: string[] = [];
	let goto: string | undefined;
	let stdin = false;
	let wait = false;
	let force = false;
	let list = false;
	let showVersions = false;
	let version = false;
	let metrics = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		// Every option that takes a value takes exactly one, and it is the next
		// argument. Reading it here rather than in each branch keeps the index
		// moving in one place.
		const takesValue =
			arg === "--install-extension" ||
			arg === "--uninstall-extension" ||
			arg === "-g" ||
			arg === "--goto";
		let value: string | undefined;
		if (takesValue) {
			index += 1;
			value = args[index];
		}
		switch (arg) {
			case "--install-extension": {
				if (value === undefined || value.length === 0) {
					return needsValue(arg, "an extension id or a path to a .vsix file");
				}
				install.push(value);
				continue;
			}
			case "--uninstall-extension": {
				if (value === undefined || value.length === 0) {
					return needsValue(arg, "an extension id");
				}
				uninstall.push(value);
				continue;
			}
			case "-g":
			case "--goto": {
				if (value === undefined || value.length === 0) {
					return needsValue(arg, "a file, optionally with :line:column");
				}
				goto = value;
				continue;
			}
			case "--force":
				force = true;
				continue;
			// A modifier rather than a mode: `--wait` says how to open, not
			// what to open, so it is gathered like `--force` and never counted
			// among the things devhub does one of at a time.
			case "-w":
			case "--wait":
				wait = true;
				continue;
			case "--list-extensions":
				list = true;
				continue;
			case "--show-versions":
				showVersions = true;
				continue;
			case "--metrics":
				metrics = true;
				continue;
			case "-v":
			case "--version":
				version = true;
				continue;
			case "-h":
			case "--help":
				return { kind: "usage" };
			// A lone `-` is the pipe, not an option and not a file called `-`.
			// It has to be caught before the rule below, which would otherwise
			// refuse it as an option nobody has heard of.
			case "-":
				stdin = true;
				continue;
			default:
				if (arg.startsWith("-")) {
					return {
						kind: "invalid",
						message: `devhub does not know the option '${arg}'.`,
					};
				}
				paths.push(arg);
		}
	}

	const modes = [
		install.length > 0,
		uninstall.length > 0,
		list,
		version,
		metrics,
		goto !== undefined,
		stdin,
		paths.length > 0,
	].filter(Boolean).length;
	if (modes === 0) {
		return {
			kind: "invalid",
			message: wait
				? "--wait waits for a file to be closed, so it needs a file to open."
				: "devhub was not asked to do anything.",
		};
	}
	if (modes > 1) {
		return {
			kind: "invalid",
			message: "devhub does one of these things at a time.",
		};
	}

	if (install.length > 0) {
		return { kind: "install-extensions", targets: install, force };
	}
	if (uninstall.length > 0) {
		return { kind: "uninstall-extensions", ids: uninstall, force };
	}
	if (list) return { kind: "list-extensions", showVersions };
	if (metrics) return { kind: "metrics" };
	if (version) return { kind: "version" };
	if (stdin) return { kind: "open-stdin", wait };
	if (goto !== undefined) {
		try {
			const { path, position } = parseFileAndPosition(goto);
			return { kind: "open", path, position, wait };
		} catch (error) {
			return { kind: "invalid", message: messageOf(error) };
		}
	}
	if (paths.length > 1) {
		return {
			kind: "invalid",
			message: "devhub opens one path at a time.",
		};
	}
	return { kind: "open", path: paths[0] ?? "", position: undefined, wait };
}

function needsValue(option: string, what: string): Command {
	return { kind: "invalid", message: `${option} needs ${what}.` };
}

/**
 * What a `devhub` run knows about where it is running.
 *
 * Read from the environment because that is where DevHub put it — on the tmux
 * session, at the moment DevHub created it (`terminal/tmux.ts`). A run from a
 * login shell, a script or a cron job has neither, and says so by leaving them
 * out rather than by guessing at this end.
 */
export interface CallerContext {
	/** The pane's `DEVHUB_ORIGIN`: which workbench this terminal belongs to. */
	readonly origin?: string;
	/** Which computer this `devhub` is running on, and so which the paths are on. */
	readonly machine?: string;
}

/** The environment read once, so that nothing downstream reaches for it again. */
export function callerContext(
	env: Readonly<Record<string, string | undefined>>,
): CallerContext {
	const origin = env["DEVHUB_ORIGIN"];
	const machine = env["DEVHUB_MACHINE"];
	return {
		...(origin === undefined || origin.length === 0 ? {} : { origin }),
		...(machine === undefined || machine.length === 0 ? {} : { machine }),
	};
}

export function requestFor(
	command: Command,
	cwd: string,
	home: string,
	waitMarkerPath?: string,
	caller: CallerContext = {},
): ControlRequest | undefined {
	switch (command.kind) {
		case "usage":
		case "invalid":
			return undefined;
		case "open-stdin":
			// `main` spools stdin to a file and continues as an `open` of that
			// file. Reaching here means that step was skipped, and the honest
			// answer to "which file?" is that there is not one yet.
			throw new Error(
				"devhub -: stdin must be spooled to a file before the app is asked to open it",
			);
		case "activate":
			return { kind: "activate" };
		case "open":
			return {
				kind: "open",
				path: expandPath(command.path, cwd, home),
				cwd,
				// Passed through exactly as it arrived, including not at all.
				// Which window this is and which computer it is on are facts
				// DevHub stated on the session; this command's job is to carry
				// them, not to have an opinion about them.
				...caller,
				...(command.position === undefined
					? {}
					: { position: command.position }),
				...(waitMarkerPath === undefined ? {} : { waitMarkerPath }),
			};
		case "add-agent":
			return {
				kind: "add-agent",
				profileId: command.profileId,
				args: command.args,
				cwd,
			};
		case "install-extensions":
			// The targets are sent as they were typed. Which of them is a `.vsix`
			// path rather than an extension id is VS Code's own rule, and it is
			// applied where that rule lives; `cwd` is what a path among them is
			// then resolved against.
			return {
				kind: "install-extensions",
				targets: command.targets,
				force: command.force,
				cwd,
			};
		case "uninstall-extensions":
			return {
				kind: "uninstall-extensions",
				ids: command.ids,
				force: command.force,
			};
		case "list-extensions":
			return {
				kind: "list-extensions",
				showVersions: command.showVersions,
			};
		case "version":
			return { kind: "version" };
		case "metrics":
			return { kind: "metrics" };
	}
}

async function ask(
	socketPath: string,
	request: ControlRequest,
): Promise<ControlResponse> {
	return new Promise<ControlResponse>((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			reject(
				error.code === "ENOENT" || error.code === "ECONNREFUSED"
					? new NotRunning()
					: error,
			);
		});
		socket.on("close", () => {
			const line = buffer.split("\n")[0] ?? "";
			if (line.length === 0) {
				reject(new Error("DevHub closed the connection without answering."));
				return;
			}
			resolve(JSON.parse(line) as ControlResponse);
		});
	});
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function main(argv: readonly string[]): Promise<number> {
	const parsed = parseArguments(argv);
	if (parsed.kind === "usage") {
		console.log(USAGE);
		return 0;
	}
	if (parsed.kind === "invalid") {
		console.error(`devhub: ${parsed.message}\n${HINT}`);
		return 2;
	}
	// `devhub -` becomes `devhub <spool file>` here, and everything past this
	// point is the ordinary open. A terminal on the other end of stdin means
	// there is nothing to read and never will be; `code` drops the `-` and
	// opens nothing at all, which leaves the person watching a command that
	// appeared to work and did not.
	let command: Command = parsed;
	if (command.kind === "open-stdin") {
		if (process.stdin.isTTY) {
			console.error(
				`devhub: 'devhub -' opens what is piped into it, and nothing is piped into this one. Try: echo hello | devhub -\n${HINT}`,
			);
			return 2;
		}
		const spool = stdinSpoolPath(tmpdir());
		await spoolStdin(process.stdin, spool);
		command = {
			kind: "open",
			path: spool,
			position: undefined,
			wait: command.wait,
		};
	}
	const socketPath = process.env["DEVHUB_CONTROL_SOCKET"];
	if (!socketPath) {
		console.error(
			"DEVHUB_CONTROL_SOCKET is not set. Run \"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette to write a launcher that sets it.",
		);
		return 1;
	}
	const caller = callerContext(process.env);
	// What to do when nothing is listening — and the two machines answer it
	// differently in kind, not in degree. On DevHub's own machine there is an
	// app to start; on a host there is not, because DevHub runs where the
	// window is and this socket is forwarded from there.
	//
	// Read before anything is sent, not at the moment DevHub turns out to be
	// missing: a launcher that cannot say how to start DevHub is broken whether
	// or not this particular run needed it, and finding that out only on the
	// cold start is finding it out in front of the person least able to act.
	let launcher: Launcher;
	try {
		launcher =
			caller.machine === undefined || caller.machine === "local"
				? commandLauncher(
						socketPath,
						parseLaunchCommand(
							process.env[LAUNCH_COMMAND_ENVIRONMENT_VARIABLE],
						),
					)
				: forwardedSocketLauncher(socketPath, caller.machine);
	} catch (error) {
		console.error(messageOf(error));
		return 1;
	}
	// The marker exists before the request that names it, because the workbench
	// deletes it to say the editor was closed — and a file that is not there
	// yet cannot be deleted, which would read as "closed already".
	const marker =
		command.kind === "open" && command.wait
			? await createMarker(tmpdir())
			: undefined;
	try {
		return await run(command, socketPath, launcher, caller, marker);
	} finally {
		if (marker !== undefined) await removeMarker(marker);
	}
}

/**
 * Send the command, print the answer, and — for `--wait` — hold the terminal
 * until the editor is closed.
 *
 * Split out so that the marker made for a `--wait` is cleared up however this
 * ends, including on the way out of a failure.
 */
async function run(
	command: Command,
	socketPath: string,
	launcher: Launcher,
	caller: CallerContext,
	marker: string | undefined,
): Promise<number> {
	const request = requestFor(command, process.cwd(), homedir(), marker, caller);
	if (!request) return 2;
	// A DevHub that is not running is started and then asked, so what comes
	// back is always an answer to the request above; see `launch.ts`.
	const response = await sendOrLaunch(() => ask(socketPath, request), launcher);
	if (!response.ok) {
		console.error(response.message);
		return 1;
	}
	if (marker === undefined) {
		console.log(response.message);
		return 0;
	}
	// Nothing is printed for a `--wait`: this command is somebody's EDITOR, and
	// an EDITOR that writes to stdout writes into whatever is reading it. The
	// report is the exit status, and the file.
	await waitForClose(markerWorld(marker, socketPath));
	// The editor is closed, so the modal session is over and DevHub goes back
	// to where it was (see `waitReturn.ts`). This is told rather than noticed
	// because this process is the one that watched the marker.
	try {
		const ended = await ask(socketPath, {
			kind: "wait-ended",
			waitMarkerPath: marker,
		});
		if (!ended.ok) console.error(ended.message);
	} catch (error) {
		// The edit itself happened, and `git commit` is reading this exit
		// status to decide whether to use it — so a DevHub that quit between
		// closing the tab and being told about it must not turn a finished
		// commit message into a failed commit. It is still said out loud, on
		// the stream nobody is parsing.
		console.error(messageOf(error));
	}
	return 0;
}

// `import.meta.url` is the module's own path; `process.argv[1]` is the script
// the runtime was given. They are the same file exactly when this module is
// the entry point, which is how an ESM module knows it is being run rather
// than imported by its own tests.
if (
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === resolvePath(process.argv[1])
) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(messageOf(error));
			process.exitCode = 1;
		});
}
