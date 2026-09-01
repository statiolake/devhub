/**
 * The two ways a workspace can start that are not "find one that exists":
 * make an empty folder, or clone a repository into one.
 *
 * Both end in the same place — a directory on disk — and neither opens it.
 * Opening a folder is one act with one implementation (`open_folder`), and
 * these hand it a path the way the picker's own candidates do. That is the
 * whole reason they are this small.
 *
 * Failures are values here only in the sense that they are thrown with
 * something a person can read: "that folder already exists", or git's own
 * complaint about a URL it cannot reach. The sheet that asked shows it and
 * stays open, because the answer to a bad URL is a better URL, typed in the
 * field that is already on screen.
 */

import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Config } from "../../model/config.js";
import { cloneDirectoryName, joinPath } from "../../model/projects.js";
import {
	NETWORK_TIMEOUT_MS,
	runGit,
	workspaceFailure as projectFailure,
	type GitCommand,
} from "./git.js";

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * Where a new project goes unless the person says otherwise.
 *
 * The first filesystem workspace source, because that is the sentence "this is
 * where my projects live" already written in `config.toml`; the home directory
 * when there is none. It is a starting value in an editable field, never a
 * decision taken on the person's behalf.
 */
export function defaultProjectDirectory(config: Config | undefined): string {
	const source = config?.workspaceSources.find(
		(candidate) => candidate.type === "filesystem",
	);
	return source ? expandHome(source.path) : homedir();
}

function requireAbsolute(path: string): string {
	const expanded = expandHome(path.trim());
	if (expanded.length === 0) {
		throw projectFailure("Enter a path for the folder.");
	}
	if (!isAbsolute(expanded)) {
		throw projectFailure(`A folder needs a full path; ${expanded} is not one.`);
	}
	return expanded;
}

async function refuseIfPresent(path: string): Promise<void> {
	try {
		await stat(path);
	} catch {
		return;
	}
	throw projectFailure(`${path} already exists.`);
}

/**
 * Make the folder, and say so when it is already there.
 *
 * `mkdir -p` would succeed on an existing directory, which is the one answer
 * that must not be given: "New Project" on a folder full of somebody's work
 * looks like it worked and is not what was asked for.
 */
export async function createProject(path: string): Promise<string> {
	const target = requireAbsolute(path);
	await refuseIfPresent(target);
	await mkdir(target, { recursive: true });
	return target;
}

export interface CloneRequest {
	readonly url: string;
	readonly parentDirectory: string;
	/** The resolved `git`, from the same lookup every other runtime goes through. */
	readonly command: GitCommand;
}

/** Clone into `<parent>/<name>`, and answer with the directory git created. */
export async function cloneProject(request: CloneRequest): Promise<string> {
	const name = cloneDirectoryName(request.url);
	if (!name) {
		throw projectFailure("That does not look like a repository URL.");
	}
	const parent = requireAbsolute(request.parentDirectory);
	const target = joinPath(parent, name);
	await refuseIfPresent(target);
	await mkdir(parent, { recursive: true });
	// `--` so a URL that begins with a dash is a URL and not an option.
	await runGit(request.command, ["clone", "--", request.url.trim(), target], {
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	return target;
}
