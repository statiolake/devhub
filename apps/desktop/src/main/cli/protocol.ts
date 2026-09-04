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
			/**
			 * Extension ids, or paths to `.vsix` files. Which of the two a
			 * target is, is decided where VS Code's own rule lives — the app —
			 * so `cwd` comes along for the paths among them.
			 */
			readonly kind: "install-extensions";
			readonly targets: readonly string[];
			readonly force: boolean;
			readonly cwd: string;
	  }
	| {
			readonly kind: "uninstall-extensions";
			readonly ids: readonly string[];
			readonly force: boolean;
	  }
	| {
			readonly kind: "list-extensions";
			readonly showVersions: boolean;
	  }
	| {
			/** DevHub's version, VS Code's, and the commit it was built from. */
			readonly kind: "version";
	  }
	| {
			/** An Agent for the workspace the current directory belongs to. */
			readonly kind: "add-agent";
			readonly profileId: string;
			readonly args: readonly string[];
			readonly cwd: string;
	  }
	| {
			/** Put the `devhub` launcher on the PATH. Sent by the workbench command. */
			readonly kind: "install-cli";
	  }
	| {
			/**
			 * How this workbench's integrated terminal attaches to its DevHub
			 * session. Sent by the bridge extension, never by a person.
			 *
			 * The root is the workbench's own workspace folder, or `null` for the
			 * folderless one — which is the Scratch context, and the same session
			 * the Scratch terminal has always been.
			 */
			readonly kind: "terminal-profile";
			readonly root: string | null;
	  };

/** The command line a workbench's integrated terminal is started with. */
export interface TerminalProfileAnswer {
	readonly file: string;
	readonly args: readonly string[];
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
}

/** Reject anything that is not a request this server understands. */
export function parseControlRequest(line: string): ControlRequest {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null) {
		throw new Error("a control request must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	switch (record["kind"]) {
		case "activate":
			return { kind: "activate" };
		case "open":
			return {
				kind: "open",
				path: requireAbsolute(record["path"], "path"),
				cwd: requireAbsolute(record["cwd"], "cwd"),
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
		case "install-extensions":
			return {
				kind: "install-extensions",
				targets: requireNonEmptyStrings(record["targets"], "targets"),
				force: requireBoolean(record["force"], "force"),
				cwd: requireAbsolute(record["cwd"], "cwd"),
			};
		case "uninstall-extensions":
			return {
				kind: "uninstall-extensions",
				ids: requireNonEmptyStrings(record["ids"], "ids"),
				force: requireBoolean(record["force"], "force"),
			};
		case "list-extensions":
			return {
				kind: "list-extensions",
				showVersions: requireBoolean(record["showVersions"], "showVersions"),
			};
		case "version":
			return { kind: "version" };
		case "add-agent":
			return {
				kind: "add-agent",
				profileId: requireString(record["profileId"], "profileId"),
				args: requireStrings(record["args"], "args"),
				cwd: requireAbsolute(record["cwd"], "cwd"),
			};
		case "install-cli":
			return { kind: "install-cli" };
		case "terminal-profile":
			return {
				kind: "terminal-profile",
				root:
					record["root"] === null
						? null
						: requireAbsolute(record["root"], "root"),
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

/** An agent's arguments may be empty; a list of things to install may not. */
function requireNonEmptyStrings(
	value: unknown,
	field: string,
): readonly string[] {
	const items = requireStrings(value, field);
	if (items.length === 0 || items.some((item) => item.length === 0)) {
		throw new Error(`${field} must be a non-empty array of non-empty strings`);
	}
	return items;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be a boolean`);
	}
	return value;
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
