/**
 * The order workspaces appear in the Sidebar.
 *
 * They used to appear in the order their folders happened to be opened, which
 * for anybody using worktrees is no order at all: a repository, something
 * unrelated, and then two worktrees of the first one, three rows apart from the
 * thing they are worktrees of.
 *
 * Two rules, and the second follows from the first.
 *
 * **A repository keeps its worktrees.** They are the same repository checked
 * out in several places — git says so, and says it by giving them all the same
 * main worktree — so they sit together, with the repository itself at the top
 * of its own group. A worktree whose repository is not open is still a group;
 * it simply has no head.
 *
 * **Everything else is by name.** Groups against each other, and worktrees
 * within a group, because a person looking for a row is looking for a name and
 * an order they cannot predict is one they have to read all of.
 *
 * Nothing here knows about git. The identity arrives as a string per workspace
 * and is compared for equality — which is the whole of what "the same
 * repository" means once git has answered.
 */

/** What ordering needs to know about a workspace. */
export interface OrderableWorkspace {
  readonly id: string;
  readonly label: string;
  readonly root: string;
}

/** Names sort the way the reader's language sorts them, digits included. */
function byName(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function orderWorkspaces<T extends OrderableWorkspace>(
  workspaces: readonly T[],
  /**
   * The repository a workspace belongs to, as its main worktree's path.
   *
   * Absent for a workspace that is not a repository, or one whose git could not
   * be read this round — both of which stand alone, keyed by their own root, so
   * a failed read never merges two unrelated rows.
   */
  mainWorktreeOf: (workspace: T) => string | undefined,
): readonly T[] {
  const groups = new Map<string, T[]>();
  for (const workspace of workspaces) {
    const key = mainWorktreeOf(workspace) ?? workspace.root;
    const group = groups.get(key);
    if (group) group.push(workspace);
    else groups.set(key, [workspace]);
  }

  const ordered = [...groups.entries()].map(([key, members]) => {
    const sorted = [...members].sort((left, right) => {
      // The repository itself leads its own group, whatever it is called: it is
      // the thing the others are checkouts of.
      if (left.root === key) return -1;
      if (right.root === key) return 1;
      return byName(left.label, right.label);
    });
    return sorted;
  });

  // A group sorts by the name of whatever leads it — the repository when it is
  // open, and otherwise the first worktree, which is the name a person reading
  // the list actually sees at the top of that group.
  ordered.sort((left, right) =>
    byName(left[0]?.label ?? "", right[0]?.label ?? ""),
  );
  return ordered.flat();
}
