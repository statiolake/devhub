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

export type ControlRequest =
	| {
			/** A folder or a file the person asked DevHub to open. */
			readonly kind: "open";
			readonly path: string;
			readonly cwd: string;
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
	  };

export interface ControlResponse {
	readonly ok: boolean;
	/** One sentence, meant to be printed or shown as-is. */
	readonly message: string;
}

/** Reject anything that is not a request this server understands. */
export function parseControlRequest(line: string): ControlRequest {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null) {
		throw new Error("a control request must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	switch (record["kind"]) {
		case "open":
			return {
				kind: "open",
				path: requireAbsolute(record["path"], "path"),
				cwd: requireAbsolute(record["cwd"], "cwd"),
			};
		case "add-agent":
			return {
				kind: "add-agent",
				profileId: requireString(record["profileId"], "profileId"),
				args: requireStrings(record["args"], "args"),
				cwd: requireAbsolute(record["cwd"], "cwd"),
			};
		case "install-cli":
			return { kind: "install-cli" };
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
