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

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Config } from "../../model/config.js";
import { cloneDirectoryName, joinPath } from "../../model/projects.js";
import { errorWireAt, TypedFailure, withSummary } from "../../model/wire.js";

/**
 * A refusal in the words it should be read in.
 *
 * "That folder already exists" and "Repository not found" are the whole value
 * of these two operations failing: a person can act on either. Thrown as a
 * plain `Error` they would arrive at the page as "the native app shell is
 * unavailable" with the real sentence buried in a detail nothing draws, which
 * is the same as not saying it. `TypedFailure` is what the codebase already
 * has for a failure it means to show.
 */
function projectFailure(summary: string): TypedFailure {
	return new TypedFailure(
		withSummary(errorWireAt("workspace_unavailable"), summary),
	);
}

/** How long `git clone` gets before DevHub stops waiting for it. */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
/** Enough of git's complaint to act on, and not a whole console of it. */
const MAX_STDERR_BYTES = 8 * 1024;

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
	readonly git: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
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
	await runGitClone(request, target);
	return target;
}

function runGitClone(request: CloneRequest, target: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(
			request.git,
			// `--` so a URL that begins with a dash is a URL and not an option.
			["clone", "--", request.url.trim(), target],
			{
				// The environment DevHub resolved at startup, so the clone finds the
				// same credential helper and the same ssh the person's shell would.
				env: request.environment as NodeJS.ProcessEnv,
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, CLONE_TIMEOUT_MS);
		child.once("error", (failure: Error) => {
			clearTimeout(timer);
			reject(projectFailure(failure.message));
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
				return;
			}
			// git says why on stderr and DevHub has nothing to add: passing its own
			// last line through is the difference between "clone failed" and
			// "Repository not found", and only one of those can be acted on.
			const said = stderr.trim().split("\n").at(-1)?.trim();
			reject(
				projectFailure(
					said && said.length > 0
						? said
						: signal
							? `git clone was stopped (${signal}).`
							: `git clone failed (exit ${String(code ?? "unknown")}).`,
				),
			);
		});
	});
}
