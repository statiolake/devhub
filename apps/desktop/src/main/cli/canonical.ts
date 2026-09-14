/**
 * The one canonical spelling of a path, on the machine the path is on.
 *
 * Every workspace root in the model is a `realpath`, so every path compared
 * against one has to be a `realpath` too — two spellings of one folder is how
 * a workspace gets opened twice, and how a file inside a workspace gets
 * decided to be outside it.
 *
 * **On the machine the path is on.** A host's `/srv/app/src` has a host's
 * symlinks in it, and resolving it here answers about this disk: either a
 * refusal about a path that is perfectly fine over there, or — worse — a
 * different folder that happens to exist here under the same name. So the
 * filesystem this reaches is a `Runtime` (`../runtime/runtime.ts`), which is
 * the one seam that means "this machine" or "that one" without any caller
 * having to ask which.
 */

import { posix } from "node:path";
import type { Runtime } from "../runtime/runtime.js";

export interface ResolvedPath {
	/** Canonical as far as the filesystem goes; see below for what that means. */
	readonly path: string;
	readonly exists: boolean;
	readonly isDirectory: boolean;
}

/**
 * As much of a machine as canonicalising needs.
 *
 * Two methods rather than the whole `Runtime`, so that a test can answer them
 * by hand and so that this states exactly what it touches. Every `Runtime`
 * satisfies it by construction.
 */
export type PathMachine = Pick<Runtime, "stat" | "realpath">;

/**
 * Canonicalise a path that may not exist yet.
 *
 * `realpath` refuses a path with a missing component, and a path DevHub is
 * being asked to *create* is exactly that. So the deepest existing ancestor is
 * resolved — that is where the symlinks are — and the missing tail is appended
 * to it unchanged. A path that exists takes the first branch and is a plain
 * `realpath`, which is what every workspace root in the model already is.
 *
 * `posix` and not `path`: every path that reaches this is an absolute POSIX
 * path, on this Mac as much as on a host, and the platform-dependent spelling
 * was never the right one for the half that is not this machine.
 */
export async function canonicalise(
	machine: PathMachine,
	path: string,
): Promise<ResolvedPath> {
	if ((await machine.stat(path)) !== "absent") {
		const resolved = await machine.realpath(path);
		return {
			path: resolved,
			exists: true,
			// Re-read after resolving, because what a symlink points at is what
			// the caller is about to open.
			isDirectory: (await machine.stat(resolved)) === "directory",
		};
	}
	const parent = posix.dirname(path);
	if (parent === path) {
		throw new Error(`cannot resolve ${path}`);
	}
	const base = path.slice(parent.length + 1);
	const resolvedParent = await canonicalise(machine, parent);
	return {
		path: posix.join(resolvedParent.path, base),
		exists: false,
		isDirectory: false,
	};
}
