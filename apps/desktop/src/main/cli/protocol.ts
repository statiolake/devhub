/**
 * DevHub's own front door, and the only one.
 *
 * The `devhub` CLI and the workbench command that installs it both speak this
 * protocol over one unix socket in the running app's user-data directory.
 * VS Code's `--new-window` path through `openInBrowserWindow` still exists and
 * still works — it is how VS Code's own flows reach DevHub — but nothing in
 * this file goes through it. Two protocols would be two truths about what
 * "open this" means, and the second one would be the one nobody tested.
 *
 * The framing is one JSON object per line, request then response, then the
 * connection closes. There is no token: the socket lives under the user's own
 * application-support directory, is created 0600 inside a 0700 directory, and
 * a unix socket carries no network reachability. Anything that can read it can
 * already read the state file beside it.
 */

import { join } from "node:path";
import {
	callerLabelProblem,
	tellCommandFrom,
	type TellCommand,
} from "./tell/command.js";

/** Where the running app listens. One per user-data directory, so a scratch
 * run and a real one never meet. */
export function controlSocketPath(userDataPath: string): string {
	return join(userDataPath, "devhub", "control.sock");
}

/**
 * The user-data directory a workbench extension is running against.
 *
 * An extension is told its own global-storage directory and nothing else about
 * the app's layout, and that directory is always `<user data>/User/…` (or
 * `<user data>/User/profiles/<id>/…` under a non-default profile). Taking the
 * parent of the last `User` segment therefore gives the user-data directory in
 * both layouts, without an environment variable that a spawned extension host
 * may not have been given.
 */
export function userDataPathFromGlobalStorage(
	globalStoragePath: string,
): string | undefined {
	const marker = "/User/";
	const index = globalStoragePath.lastIndexOf(marker);
	return index <= 0 ? undefined : globalStoragePath.slice(0, index);
}

/** Where `--goto` asks for the cursor. One-based, as every editor counts. */
export interface ControlPosition {
	readonly line: number;
	readonly column: number;
}

export type ControlRequest =
	| {
			/**
			 * Is there a DevHub behind this socket?
			 *
			 * Not a command: the answer is the *fact that an answer came back*,
			 * which is the one thing a connection does not establish. A unix
			 * socket reverse-forwarded onto a host with `ssh -R` belongs to the
			 * host's sshd, so `connect()` there succeeds long after the DevHub at
			 * the far end has quit — and `devhub --wait` on the host, whose whole
			 * job is to stop waiting when there is nobody left to close the file,
			 * waited forever. `git commit` over there never came back.
			 *
			 * So it is answered here, by the server loop itself, without going
			 * through a handler. "DevHub is running" must not be a claim about
			 * what DevHub can currently *do*: an app too busy to open a window is
			 * still an app that will close the editor, and an app that is gone
			 * answers nothing at all, which is the whole distinction.
			 */
			readonly kind: "ping";
	  }
	| {
			/**
			 * `devhub`, with nothing after it: bring DevHub to the front.
			 *
			 * It is a request of its own rather than an `open` with no path
			 * because it is not an open — nothing is chosen, nothing is
			 * revealed, and the selection the person left is the selection
			 * they come back to. Every other request here ends by bringing
			 * DevHub forward; this one is that ending on its own.
			 */
			readonly kind: "activate";
	  }
	| {
			/**
			 * A folder or a file the person asked DevHub to open, and — for
			 * `--goto` — where in it. A position is part of an open rather than
			 * a request of its own because it *is* one: the same ancestor walk
			 * picks the same workspace, and the only difference is what the
			 * editor is told once the file is there.
			 */
			readonly kind: "open";
			readonly path: string;
			readonly cwd: string;
			/**
			 * Which computer `path` is a path on: `local`, or `ssh:<host>` — a
			 * `RuntimeId`, the same key `terminal-profile` carries and the same
			 * key everything else about a machine is filed under.
			 *
			 * Absent means `local`, because that is what every caller that
			 * cannot say is: the launcher in this Mac's PATH, and a Finder
			 * open. A `devhub` run on a host says so, and it must — a path is
			 * a path on one computer, and `/srv/app` on two of them is one
			 * root to a matcher that was not told which is asking. The answer
			 * it gives then is not a slower open, it is a file opened from the
			 * wrong disk into a window that is not showing it.
			 */
			readonly machine?: string;
			/**
			 * Which pane the request came from: `<machine>\t<workspaceId |
			 * "scratch">\t<agentId | "none">`, as the pane's `DEVHUB_ORIGIN`
			 * spells it. The Agent is the difference between "in that window"
			 * and "beside the thing in it that asked".
			 *
			 * Separate from `machine` because they answer separate questions.
			 * `machine` is which computer the *path* is on; `origin` is which
			 * window is *asking*. A local terminal inside an SSH Workspace's
			 * window does not exist, but a local terminal opening a path while
			 * an SSH Workspace shares the root does — so one cannot be read off
			 * the other.
			 *
			 * Absent whenever the caller was not started from a DevHub pane: a
			 * login shell, a script, a Finder drop. That is the honest unknown
			 * and the containing-Workspace rule answers for it.
			 */
			readonly origin?: string;
			readonly position?: ControlPosition;
			/**
			 * `--wait`: the file the CLI is holding a terminal open for.
			 *
			 * The workbench deletes this file once the editor is closed, and
			 * the CLI returns when it goes. It rides along with the open for
			 * the same reason a position does — it is a fact about *this*
			 * open, and there is no waiting to be done for a file nobody
			 * opened.
			 */
			readonly waitMarkerPath?: string;
	  }
	| {
			/**
			 * The `--wait` named by this marker is over: the editor was closed.
			 *
			 * Sent by the CLI itself, once, on its way out. The CLI is what
			 * polls the marker, so the CLI is what knows; an app that watched
			 * the same marker would be a second answer to one question, free to
			 * disagree with the first. What DevHub does with it is go back to
			 * whatever was selected before the open — see `waitReturn.ts`.
			 */
			readonly kind: "wait-ended";
			readonly waitMarkerPath: string;
	  }
	| {
			/** DevHub's version, and the commit it was built from. */
			readonly kind: "version";
	  }
	| {
			/**
			 * One reading of what the running app is costing: every process's
			 * CPU and memory, joined to the workbench it is showing, plus the
			 * rates DevHub counts about itself.
			 *
			 * It goes over this socket rather than to a log because the only
			 * process that can answer it is the running one, and because a
			 * reading is a thing somebody takes twice a minute apart — a log
			 * would make the interval whatever the log happened to flush at.
			 */
			readonly kind: "metrics";
	  }
	| {
			/**
			 * `devhub --tell`: one of DevHub's own operations, by name. See
			 * `tell/command.ts` for the vocabulary and `tell/service.ts` for
			 * what each one does. `origin` is the asking pane's, as for `open`:
			 * it is how an answer is credited to the Agent that gave it.
			 */
			readonly kind: "tell";
			readonly command: TellCommand;
			readonly origin?: string;
			/**
			 * Which computer the asking `devhub` runs on (`DEVHUB_MACHINE`, set
			 * by the shim DevHub writes on a host or in a container), so the
			 * paths in the command are read on that machine even when no pane
			 * origin says so: an Agent's own shell, a script on the host.
			 */
			readonly machine?: string;
			/** `--as NAME`: what a caller DevHub did not start is called. */
			readonly as?: string;
	  }
	| {
			/** An Agent for the workspace the current directory belongs to. */
			readonly kind: "add-agent";
			readonly profileId: string;
			readonly args: readonly string[];
			readonly cwd: string;
	  }
	| {
			readonly kind: "terminal-profile";
			readonly machine: string;
			readonly root: string | null;
			/**
			 * The Workspace, by its key, when the window already knows which
			 * one it is and the directory cannot say: a workbench attached to a
			 * dev container runs its DevHub terminal on this Mac, in a directory
			 * that is not necessarily inside the Workspace — a folder on a host
			 * has no directory here at all. Absent, the directory decides.
			 */
			readonly workspace?: string;
	  };

/**
 * An `open`, whole.
 *
 * The handler takes the request rather than its fields spread out, because the
 * fields are what an open *is* — a path, the machine it is on, where in it,
 * and what is waiting for it — and a positional list of them is a list every
 * caller has to keep in the same order as every other one. Extracted from the
 * union rather than declared beside it so there is one statement of the shape.
 */
export type ControlOpenRequest = Extract<ControlRequest, { kind: "open" }>;

/** The command line a workbench's integrated terminal is started with. */
export interface TerminalProfileAnswer {
	readonly file: string;
	readonly args: readonly string[];
	/**
	 * What that command needs in its environment in order to be itself.
	 *
	 * Part of the answer and not of the launcher, because it belongs to the
	 * executable and the executable is chosen here: a tmux DevHub shipped to a
	 * host carries its own compiled terminfo database, and `TERMINFO` is how it
	 * is told to read that rather than the host's — which on a bare appliance is
	 * not there at all. A launcher written before any of that was known could
	 * only have guessed.
	 *
	 * It was missing, and the whole of the symptom was a terminal tab that
	 * opened and closed: `missing or unsuitable terminal: xterm-256color`, from
	 * a tmux that could not find a single terminal description on the machine.
	 *
	 * Empty on a machine whose tmux needs nothing added, which is this one.
	 */
	readonly env: Readonly<Record<string, string>>;
}

export interface ControlResponse {
	readonly ok: boolean;
	/**
	 * What the CLI prints, as-is. Usually one sentence; a listing and an
	 * install transcript are several lines, and they are still one answer.
	 */
	readonly message: string;
	/**
	 * The one answer that is data rather than a sentence.
	 *
	 * Every other request on this socket is a person asking for something and
	 * reading the reply; `terminal-profile` is a workbench asking for an argv,
	 * and an argv squeezed through a human sentence would have to be parsed
	 * back out of it. Absent on every other answer, and on a failed one — a
	 * failure is a sentence, whoever is reading.
	 */
	readonly profile?: TerminalProfileAnswer;
	/** A `tell` answer, as data: what `devhub --tell --json` prints. */
	readonly data?: unknown;
}

/** Reject anything that is not a request this server understands. */
export function parseControlRequest(line: string): ControlRequest {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null) {
		throw new Error("a control request must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	switch (record["kind"]) {
		case "ping":
			return { kind: "ping" };
		case "activate":
			return { kind: "activate" };
		case "open":
			return {
				kind: "open",
				path: requireAbsolute(record["path"], "path"),
				cwd: requireAbsolute(record["cwd"], "cwd"),
				...(record["machine"] === undefined
					? {}
					: { machine: requireString(record["machine"], "machine") }),
				...(record["origin"] === undefined
					? {}
					: { origin: requireString(record["origin"], "origin") }),
				...(record["position"] === undefined
					? {}
					: { position: requirePosition(record["position"]) }),
				...(record["waitMarkerPath"] === undefined
					? {}
					: {
							waitMarkerPath: requireAbsolute(
								record["waitMarkerPath"],
								"waitMarkerPath",
							),
						}),
			};
		case "wait-ended":
			return {
				kind: "wait-ended",
				waitMarkerPath: requireAbsolute(
					record["waitMarkerPath"],
					"waitMarkerPath",
				),
			};
		case "version":
			return { kind: "version" };
		case "metrics":
			return { kind: "metrics" };
		case "tell":
			return {
				kind: "tell",
				command: tellCommandFrom(record["command"]),
				...(record["origin"] === undefined
					? {}
					: { origin: requireString(record["origin"], "origin") }),
				...(record["machine"] === undefined
					? {}
					: { machine: requireString(record["machine"], "machine") }),
				...(record["as"] === undefined
					? {}
					: { as: requireCallerLabel(record["as"]) }),
			};
		case "add-agent":
			return {
				kind: "add-agent",
				profileId: requireString(record["profileId"], "profileId"),
				args: requireStrings(record["args"], "args"),
				cwd: requireAbsolute(record["cwd"], "cwd"),
			};
		case "terminal-profile":
			return {
				kind: "terminal-profile",
				machine: requireString(record["machine"], "machine"),
				root:
					record["root"] === null
						? null
						: requireAbsolute(record["root"], "root"),
				...(record["workspace"] === undefined
					? {}
					: { workspace: requireString(record["workspace"], "workspace") }),
			};
		default:
			throw new Error(`unknown control request: ${String(record["kind"])}`);
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value;
}

function requireCallerLabel(value: unknown): string {
	const label = requireString(value, "as");
	const problem = callerLabelProblem(label);
	if (problem !== undefined) throw new Error(problem);
	return label;
}

function requireAbsolute(value: unknown, field: string): string {
	const raw = requireString(value, field);
	if (!raw.startsWith("/")) {
		throw new Error(`${field} must be an absolute path`);
	}
	return raw;
}

function requireStrings(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${field} must be an array of strings`);
	}
	return value as readonly string[];
}

function requirePosition(value: unknown): ControlPosition {
	if (typeof value !== "object" || value === null) {
		throw new Error("position must be an object");
	}
	const record = value as Record<string, unknown>;
	return {
		line: requireLineOrColumn(record["line"], "line"),
		column: requireLineOrColumn(record["column"], "column"),
	};
}

function requireLineOrColumn(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${field} must be a whole number from 1 up`);
	}
	return value;
}
