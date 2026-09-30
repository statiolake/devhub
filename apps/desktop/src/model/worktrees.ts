import { issueNumberFromBranch, type GitHubItem } from "./github.js";

/**
 * Where the worktree for a piece of work goes.
 *
 * A worktree is named for the *work* — the Issue it is for — and not for the
 * branch it holds. A branch is renamed once somebody knows what the work is
 * (`feature/128-wip` becomes `feature/128-short-name`), and a folder named
 * after the old name would then be a second folder for the same Issue the
 * next time the work is checked out for review. The number does not change.
 *
 * It is written here once, as a rule about strings, and the main process and
 * the page both read it — the page to show where the worktree is going to land
 * before the person commits to it, main to actually make it there.
 *
 * The parent is always the *main* worktree's parent, never the current one's.
 * A worktree made from inside another worktree otherwise nests, and the work's
 * directory would then depend on where you happened to be standing.
 *
 * The name is only where a *new* worktree goes. A branch that is already
 * checked out somewhere is found by git's own record of which worktree holds
 * which branch (`ensureWorktree`), whatever its folder is called — including
 * the `{repo}_{branch}` folders earlier versions of DevHub made.
 */

/** The work a worktree is for: an Issue, or a pull request. */
export type WorkItem = Pick<GitHubItem, "kind" | "number">;

/**
 * The number a worktree is named by: the Issue's.
 *
 * An Issue is its own number. A pull request is named by the Issue it is for
 * when DevHub can tell, and DevHub tells the way it tells everywhere else —
 * by the Issue number its branch carries (`issueNumberFromBranch`, the rule
 * the Sidebar links a Workspace to its Issue by) — so an Issue's worktree and
 * the worktree its pull request is reviewed in are the same folder. A pull
 * request whose branch names no Issue is named by its own number.
 */
export function worktreeNumber(work: WorkItem, branch: string): number {
  return work.kind === "issue"
    ? work.number
    : (issueNumberFromBranch(branch) ?? work.number);
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
 * `{main worktree's parent}/{repo}_{number}` — a sibling of the repository,
 * named for the repository and the Issue (see `worktreeNumber`).
 */
export function worktreeDirectory(
  mainWorktree: string,
  work: WorkItem,
  branch: string,
): string {
  const parent = parentDirectory(mainWorktree);
  const name = `${baseName(mainWorktree)}_${String(worktreeNumber(work, branch))}`;
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
