/**
 * The one canonical spelling of a path.
 *
 * Every workspace root in the model is a `realpath`, so every path compared
 * against one has to be a `realpath` too — two spellings of one folder is how
 * a workspace gets opened twice, and how a file inside a workspace gets
 * decided to be outside it.
 */

import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ResolvedPath {
	/** Canonical as far as the filesystem goes; see below for what that means. */
	readonly path: string;
	readonly exists: boolean;
	readonly isDirectory: boolean;
}

/**
 * Canonicalise a path that may not exist yet.
 *
 * `realpath` refuses a path with a missing component, and a path DevHub is
 * being asked to *create* is exactly that. So the deepest existing ancestor is
 * resolved — that is where the symlinks are — and the missing tail is appended
 * to it unchanged. A path that exists takes the first branch and is a plain
 * `realpath`, which is what every workspace root in the model already is.
 */
export async function canonicalise(path: string): Promise<ResolvedPath> {
	try {
		const resolved = await realpath(path);
		return {
			path: resolved,
			exists: true,
			isDirectory: (await stat(resolved)).isDirectory(),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const parent = dirname(path);
	if (parent === path) {
		throw new Error(`cannot resolve ${path}`);
	}
	const base = path.slice(parent.length + 1);
	const resolvedParent = await canonicalise(parent);
	return {
		path: join(resolvedParent.path, base),
		exists: false,
		isDirectory: false,
	};
}
