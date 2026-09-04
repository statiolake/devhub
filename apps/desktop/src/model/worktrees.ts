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

/**
 * Whether closing this workspace deletes a folder — the one rule, in one place.
 *
 * "Close" and "delete the worktree" are the same act in DevHub: a worktree is a
 * folder git made so that work could happen somewhere, and closing the
 * workspace while leaving the folder is how a machine fills with checkouts
 * nobody can account for. So there is exactly one question — *is this row a
 * worktree of something?* — and everything that closes a workspace asks it
 * here: main, to decide what to do, and the sidebar, so its button can say what
 * it is about to do rather than guessing at a second copy of the rule.
 *
 * Three facts have to hold, and each of them rules out a real row:
 *
 *   - git knows a main worktree for it. Its absence is the whole of what "not a
 *     repository" means, and a plain folder is only ever closed.
 *   - the checkout is not that main worktree. Removing the repository itself is
 *     not a close, it is losing the repository.
 *   - the row *is* the checkout's root, not merely inside it. `git worktree
 *     remove` takes the root, so a workspace opened on `worktree/packages/app`
 *     would delete the whole checkout around it — a folder the person never
 *     named.
 */
export function closingDeletesWorktree(
  repository:
    | {
        readonly mainWorktree?: string;
        readonly worktree?: string;
      }
    | undefined,
  root: string,
): boolean {
  return (
    repository?.mainWorktree !== undefined &&
    repository.worktree !== undefined &&
    repository.worktree !== repository.mainWorktree &&
    repository.worktree === root
  );
}
