/**
 * Where a worktree for a branch goes.
 *
 * The rule is not DevHub's own: it is the one the author's shell has used for
 * every worktree on this machine (`gwt co`), and a second rule would put the
 * same branch in two places depending on which tool made it. So it is written
 * here once, as a rule about strings, and the main process and the page both
 * read it — the page to show where the worktree is going to land before the
 * person commits to it, main to actually make it there.
 *
 * The parent is always the *main* worktree's parent, never the current one's.
 * A worktree made from inside another worktree otherwise nests, and a branch's
 * directory would then depend on where you happened to be standing.
 */

/**
 * A branch name as a directory name.
 *
 * `/` is the interesting one — `feature/128-tidy` is one directory named
 * `feature_128-tidy`, not a `feature` directory with something in it — and the
 * rest are the characters a filesystem or a shell would argue about.
 */
export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[/:\\*?"<>|]/gu, "_");
}

/** The directory part of a path, with no trailing separator. */
function parentDirectory(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** The last segment of a path. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * `{main worktree's parent}/{repo}_{sanitized branch}` — a sibling of the
 * repository, named for the repository and the branch it holds.
 */
export function worktreeDirectory(
  mainWorktree: string,
  branch: string,
): string {
  const parent = parentDirectory(mainWorktree);
  const name = `${baseName(mainWorktree)}_${sanitizeBranchName(branch)}`;
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}
