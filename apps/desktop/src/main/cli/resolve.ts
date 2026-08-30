/**
 * Which workspace a path belongs to.
 *
 * DevHub deliberately does not do what `code` does. `code <file>` opens the
 * file in the *last focused window*, which means the same command lands
 * somewhere different depending on where you happened to click a minute ago.
 * DevHub answers from the path alone: a file belongs to the open workspace
 * whose root is its nearest ancestor, and to the Scratch editor when no open
 * workspace contains it. The same rule decides which workspace an `--agent`
 * request joins, walking up from the current directory instead of from a file.
 *
 * Everything here is pure: paths in, an answer out. Canonicalisation (`~`,
 * relative paths, symlinks) happens before these functions are called, because
 * that is the part that needs the filesystem, and comparing anything but
 * canonical paths is how two spellings of one folder become two workspaces.
 */

/** A path that has already been expanded, made absolute and realpath'd. */
export type CanonicalPath = string;

/** Whether `root` contains `path`, or is `path`. Both must be canonical. */
export function contains(root: CanonicalPath, path: CanonicalPath): boolean {
	return path === root || path.startsWith(`${root}/`);
}

/**
 * The open workspace a path belongs to, or `undefined` for the Scratch editor.
 *
 * When workspaces are nested the deepest one wins: it is the one whose root is
 * the *nearest* ancestor, which is what walking up from the path finds first.
 */
export function workspaceRootFor(
	path: CanonicalPath,
	roots: readonly CanonicalPath[],
): CanonicalPath | undefined {
	let best: CanonicalPath | undefined;
	for (const root of roots) {
		if (!contains(root, path)) continue;
		if (best === undefined || root.length > best.length) best = root;
	}
	return best;
}

/**
 * Expand a path the way a shell would not: `~` is ours to expand because the
 * CLI may be called from a script that passed it through unexpanded, and a
 * relative path is resolved against the caller's directory rather than the
 * app's, which is somewhere else entirely.
 *
 * This is lexical only. `..` is left for `realpath` to settle, because a `..`
 * that crosses a symlink means something different before and after resolution.
 */
export function expandPath(raw: string, cwd: string, home: string): string {
	const expanded =
		raw === "~" ? home : raw.startsWith("~/") ? `${home}/${raw.slice(2)}` : raw;
	return expanded.startsWith("/") ? expanded : `${cwd}/${expanded}`;
}
