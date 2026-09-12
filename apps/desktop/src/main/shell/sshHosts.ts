/**
 * Reading `~/.ssh/config`, and the files it includes.
 *
 * The rule about what a config file *means* is in `model/sshConfig.ts` and is
 * tested without a disk. This is the disk: where the file is, how `Include`
 * resolves, and how far it is allowed to go.
 *
 * Two bounds, and both are about a file DevHub does not own. `Include` can
 * include a file that includes it back, so the set of files already read is the
 * cycle break; and a glob that matches a thousand files is a picker nobody can
 * read, so there is a ceiling on how many are opened at all. Neither is a
 * guess about what people write — they are the two ways a config file can stop
 * this from finishing.
 *
 * A file that cannot be read is not an error. `~/.ssh/config` is optional,
 * `Include ~/.ssh/config.d/*` matching nothing is what an empty directory
 * looks like, and a picker that refused to open because a machine has no SSH
 * config would be a worse answer than a picker with no SSH rows in it.
 */

import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	collectSshHosts,
	parseSshConfig,
	type SshConfigContents,
	type SshConfigHost,
} from "../../model/sshConfig.js";

/** How deep `Include` may nest. OpenSSH's own limit is 16. */
const MAX_INCLUDE_DEPTH = 16;
/** How many files one read may open, however the globs are written. */
const MAX_FILES = 64;

export function sshConfigPath(home = homedir()): string {
	return join(home, ".ssh", "config");
}

/**
 * Where one `Include` pattern looks.
 *
 * OpenSSH resolves a relative pattern against `~/.ssh` in a user config, which
 * is why `Include config.d/*` is the common spelling and means the same as
 * `Include ~/.ssh/config.d/*`.
 */
function includeRoot(home: string): string {
	return join(home, ".ssh");
}

function expandTilde(pattern: string, home: string): string {
	if (pattern === "~") return home;
	if (pattern.startsWith("~/")) return join(home, pattern.slice(2));
	return pattern;
}

/**
 * Every host `~/.ssh/config` and its includes name, in the order OpenSSH would
 * read them.
 *
 * Order is the whole of the precedence rule — see `collectSshHosts` — so the
 * traversal is depth-first at the point the `Include` appeared, exactly where
 * OpenSSH would have read it.
 */
export async function readSshHosts(
	home = homedir(),
): Promise<readonly SshConfigHost[]> {
	const seen = new Set<string>();
	const files: SshConfigContents[] = [];
	await readInto(sshConfigPath(home), home, 0, seen, files);
	return collectSshHosts(files);
}

async function readInto(
	path: string,
	home: string,
	depth: number,
	seen: Set<string>,
	files: SshConfigContents[],
): Promise<void> {
	if (depth > MAX_INCLUDE_DEPTH || files.length >= MAX_FILES) return;
	const canonical = resolve(path);
	if (seen.has(canonical)) return;
	seen.add(canonical);

	let text: string;
	try {
		text = await readFile(canonical, "utf8");
	} catch {
		// A config that is not there, or that this process may not read, is a
		// machine with no SSH rows — not a picker that refuses to open.
		return;
	}

	const contents = parseSshConfig(text);
	files.push(contents);
	for (const include of contents.includes) {
		for (const included of await matchInclude(include.pattern, home)) {
			await readInto(included, home, depth + 1, seen, files);
		}
	}
}

/** The files one `Include` pattern names, sorted so a read is reproducible. */
async function matchInclude(
	pattern: string,
	home: string,
): Promise<readonly string[]> {
	const expanded = expandTilde(pattern, home);
	const absolute = isAbsolute(expanded)
		? expanded
		: join(includeRoot(home), expanded);
	const matched: string[] = [];
	try {
		for await (const entry of glob(absolute)) {
			matched.push(entry);
			if (matched.length >= MAX_FILES) break;
		}
	} catch {
		// A pattern that matches nothing, or a directory that cannot be listed, is
		// the same answer: no files.
		return [];
	}
	return matched.sort();
}
