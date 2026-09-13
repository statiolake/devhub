/**
 * The order workspaces are in.
 *
 * **There is one order, and this is it.** It used to be applied in the Sidebar
 * component, so the sidebar drew one list while `Cmd+Q Cmd+N`, `Cmd+Q ]` and
 * `Cmd+Q 1..9` stepped through another — the order folders happened to be
 * opened in. Two orders for one list is two answers to "which row is next",
 * and only one of them was ever the one on screen. So the projection carries
 * the order now (`snapshotWire`), every reader takes the array as it comes,
 * and nobody sorts anything a second time.
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
 *
 * # The order is a fact the person can set
 *
 * Those two rules are the *automatic* order, and it is what a list nobody has
 * arranged is in. A person who drags a row, or presses `Alt+↑`, is saying
 * something the automatic rule cannot: that this repository belongs above that
 * one for a reason no name or git relation knows about. So the model keeps an
 * **explicit order** — workspace ids, top to bottom — and this is where the two
 * meet.
 *
 * **The explicit order is a permutation request, never a second grouping.**
 * The merge takes the automatic list, permutes it by whatever the explicit
 * order names, and then re-imposes the grouping on the result. That is what
 * makes a worktree unable to leave its repository no matter what the state file
 * says: an explicit order that tried to separate them produces a list where
 * they are still together, rather than a broken sidebar. There is no case here
 * for "the order is invalid", because there is no order this cannot read.
 *
 * **A row the explicit order does not name lands where the automatic rule
 * would put it.** Not at the end: a worktree opened five minutes after its
 * repository was dragged to the top belongs under that repository, which is
 * exactly what the automatic rule says about it and exactly what nobody wants
 * to have to say again by hand. So each unnamed row is inserted after the row
 * that precedes it automatically. A file with no explicit order at all is
 * therefore the automatic order, unchanged — which is what every state file
 * written before this existed loads as.
 */

/** What ordering needs to know about a workspace. */
export interface OrderableWorkspace {
  readonly id: string;
  readonly label: string;
  /**
   * What makes this workspace this one: a local folder's path, and a remote
   * folder's host and path together. It is the key rather than the path
   * because grouping is an identity question, and `/src/api` on two machines
   * is two workspaces that must not be folded into one group. A local
   * workspace's key *is* its path, which is what lets it be compared against
   * the main worktree git names below.
   */
  readonly key: string;
}

/** Names sort the way the reader's language sorts them, digits included. */
function byName(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * The order a person put the rows in: workspace ids, top to bottom.
 *
 * Empty means nobody has arranged anything, which is the automatic order. An id
 * naming a workspace that is not open is ignored rather than refused — a
 * workspace closed and reopened should come back where it was, and a state file
 * that outlives a folder is the ordinary case, not a corruption.
 */
export type EntryOrder = readonly string[];

/**
 * Which group a workspace is in, as one string.
 *
 * The repository's main worktree when git named one, and otherwise the
 * workspace's own key — a folder that is not a repository, or one whose git
 * could not be read this round, is a group of one and never merges with
 * anything. It is exported because the sidebar has to know which drops are
 * legal and the chords have to know what a row moves among, and a second
 * answer to "which group is this in" is a second answer waiting to disagree.
 */
export function groupKeyFor(
  workspaceKey: string,
  mainWorktree: string | undefined,
): string {
  return mainWorktree ?? workspaceKey;
}

/**
 * The automatic order: groups by name, worktrees under their repository.
 *
 * The whole of the rule this file started as, kept apart from the explicit
 * order so that "where would this row go on its own" stays a question with one
 * answer — it is what an unnamed row is placed by, and what an empty explicit
 * order comes out as.
 */
function automaticOrder<T extends OrderableWorkspace>(
  workspaces: readonly T[],
  groupKeyOf: (workspace: T) => string,
): readonly T[] {
  const groups = new Map<string, T[]>();
  for (const workspace of workspaces) {
    const groupKey = groupKeyOf(workspace);
    const group = groups.get(groupKey);
    if (group) group.push(workspace);
    else groups.set(groupKey, [workspace]);
  }

  const ordered = [...groups.entries()].map(([key, members]) => {
    const sorted = [...members].sort((left, right) => {
      // The repository itself leads its own group, whatever it is called: it is
      // the thing the others are checkouts of.
      if (left.key === key) return -1;
      if (right.key === key) return 1;
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

/**
 * The explicit order, with everything it does not name folded back in.
 *
 * Each unnamed row goes immediately after whatever preceded it automatically,
 * which is how a newly opened worktree lands under its repository rather than
 * at the bottom of a list somebody arranged last week.
 */
function mergeOrder<T extends OrderableWorkspace>(
  automatic: readonly T[],
  explicit: EntryOrder,
): readonly T[] {
  const byId = new Map(automatic.map((workspace) => [workspace.id, workspace]));
  const merged: T[] = [];
  const placed = new Set<string>();
  for (const id of explicit) {
    const workspace = byId.get(id);
    if (!workspace || placed.has(id)) continue;
    placed.add(id);
    merged.push(workspace);
  }
  // `anchor` is where the row before this one in the automatic list ended up.
  // Walking forwards means each run of unnamed rows keeps its automatic order
  // and lands together, behind the named row it automatically follows.
  let anchor = -1;
  for (const workspace of automatic) {
    const at = merged.indexOf(workspace);
    if (at >= 0) {
      anchor = at;
      continue;
    }
    anchor += 1;
    merged.splice(anchor, 0, workspace);
  }
  return merged;
}

/**
 * The rows of one group, in the order they were left in, repository first.
 *
 * The one place the grouping invariant is enforced, and it is enforced by
 * construction rather than checked: whatever order arrives, what comes out has
 * every group contiguous and every repository at the head of its own.
 */
function regroup<T extends OrderableWorkspace>(
  merged: readonly T[],
  groupKeyOf: (workspace: T) => string,
): readonly T[] {
  const groups = new Map<string, T[]>();
  for (const workspace of merged) {
    const key = groupKeyOf(workspace);
    const group = groups.get(key);
    if (group) group.push(workspace);
    else groups.set(key, [workspace]);
  }
  return [...groups.entries()].flatMap(([key, members]) => {
    const head = members.findIndex((member) => member.key === key);
    if (head <= 0) return members;
    return [members[head], ...members.filter((_, at) => at !== head)];
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
  /** What the person arranged, if they have. See `EntryOrder`. */
  explicit: EntryOrder = [],
): readonly T[] {
  const groupKeyOf = (workspace: T) =>
    groupKeyFor(workspace.key, mainWorktreeOf(workspace));
  const automatic = automaticOrder(workspaces, groupKeyOf);
  if (explicit.length === 0) return automatic;
  return regroup(mergeOrder(automatic, explicit), groupKeyOf);
}

/** Up the list, or down it. There is no third answer. */
export type MoveDirection = -1 | 1;

/** A group of rows as they are drawn: contiguous, repository first. */
function groupsOf<T extends OrderableWorkspace>(
  ordered: readonly T[],
  groupKeyOf: (workspace: T) => string,
): T[][] {
  const groups: T[][] = [];
  for (const workspace of ordered) {
    const last = groups.at(-1);
    if (last && groupKeyOf(last[0]) === groupKeyOf(workspace)) {
      last.push(workspace);
      continue;
    }
    groups.push([workspace]);
  }
  return groups;
}

/**
 * Where a row may be dropped, and where it may not.
 *
 * **A row moves among its siblings, and which rows those are is one rule read
 * two ways.** The row that leads a group — the repository, or the first
 * worktree when the repository is not open — *is* the group as far as moving
 * goes, so it moves among the other groups and takes its worktrees with it;
 * that is what makes "a repository keeps its worktrees" survive being
 * rearranged. Any other member moves within its own group, and never above the
 * repository, because a worktree over its repository is a list the grouping
 * rule would silently undo.
 *
 * So the siblings of a row are: the group heads, if it is one; otherwise the
 * rest of its group. That is what the sidebar highlights as it drags, and it is
 * what one press of `Alt+↑` steps through — the same sentence, so a drop nobody
 * is allowed to make is a step the keyboard cannot take either.
 */
export function siblingsOf<T extends OrderableWorkspace>(
  /** The rows exactly as they are drawn — what `orderWorkspaces` returned. */
  ordered: readonly T[],
  mainWorktreeOf: (workspace: T) => string | undefined,
  workspaceId: string,
): readonly T[] {
  const groupKeyOf = (workspace: T) =>
    groupKeyFor(workspace.key, mainWorktreeOf(workspace));
  const groups = groupsOf(ordered, groupKeyOf);
  const group = groups.find((one) =>
    one.some((member) => member.id === workspaceId),
  );
  if (!group) return [];
  if (group[0].id === workspaceId) return groups.map((one) => one[0]);
  // The head slot is the repository's, when the repository is open. With no
  // repository open the first worktree holds it only by being first, so another
  // worktree may take it — and then that one is what moves the group.
  return groupKeyOf(group[0]) === group[0].key ? group.slice(1) : group;
}

/**
 * Put a row above another one, and say what the whole order then is.
 *
 * The primitive both gestures are: a drop is this with the row the pointer is
 * above, and a step is this with the sibling one place over. `before` names the
 * sibling the row should land in front of, and `undefined` means last —
 * a list has one more gap than it has rows, and the gap at the bottom is the
 * one no row can name.
 *
 * `undefined` comes back when the move is not one that may be made: a row that
 * is not here, a `before` that is not one of its siblings, or a placement that
 * would leave the list exactly as it is. A no-op is a real answer, and the
 * caller's whole check.
 *
 * The result is the *whole* list, not a patch. Once a person has arranged
 * anything, the explicit order is the answer to where every open row goes; a
 * partial order would leave the rest to be merged against an automatic list
 * that has just been contradicted.
 */
export function placeWorkspace<T extends OrderableWorkspace>(
  ordered: readonly T[],
  mainWorktreeOf: (workspace: T) => string | undefined,
  workspaceId: string,
  before: string | undefined,
): EntryOrder | undefined {
  if (before === workspaceId) return undefined;
  const groupKeyOf = (workspace: T) =>
    groupKeyFor(workspace.key, mainWorktreeOf(workspace));
  const groups = groupsOf(ordered, groupKeyOf);
  const at = groups.findIndex((group) =>
    group.some((member) => member.id === workspaceId),
  );
  if (at < 0) return undefined;
  const group = groups[at];
  const leads = group[0].id === workspaceId;

  // Whichever list this row moves in, moving is the same three lines: take it
  // out, work out where the gap it named now is, and put it back there.
  const lane = leads ? groups : group;
  const laneAt = leads ? at : group.findIndex((one) => one.id === workspaceId);
  const idOf = (entry: T[] | T): string =>
    Array.isArray(entry) ? entry[0].id : entry.id;
  const floor = leads || groupKeyOf(group[0]) !== group[0].key ? 0 : 1;

  let target: number;
  if (before === undefined) {
    target = lane.length - 1;
  } else {
    const found = lane.findIndex((entry) => idOf(entry) === before);
    if (found < floor) return undefined;
    target = found > laneAt ? found - 1 : found;
  }
  if (target < floor || target === laneAt) return undefined;

  const moved = [...lane] as (T[] | T)[];
  moved.splice(laneAt, 1);
  moved.splice(target, 0, lane[laneAt]);
  if (leads) return (moved as T[][]).flat().map((one) => one.id);
  const regrouped = [...groups];
  regrouped[at] = moved as T[];
  return regrouped.flat().map((one) => one.id);
}

/**
 * One row, one step among its siblings.
 *
 * A step up is a drop in front of the sibling above; a step down is a drop in
 * front of the one two below, which is the gap after the sibling below — the
 * same primitive, so there is no second idea of what a legal move is. It is
 * `undefined` at either edge: there is nowhere for the top row to go, and
 * wrapping would make one keystroke jump the length of the sidebar.
 */
export function moveWorkspace<T extends OrderableWorkspace>(
  ordered: readonly T[],
  mainWorktreeOf: (workspace: T) => string | undefined,
  workspaceId: string,
  direction: MoveDirection,
): EntryOrder | undefined {
  const siblings = siblingsOf(ordered, mainWorktreeOf, workspaceId);
  const at = siblings.findIndex((one) => one.id === workspaceId);
  if (at < 0) return undefined;
  const before = stepTarget(
    siblings.map((one) => one.id),
    at,
    direction,
  );
  if (before === "none") return undefined;
  return placeWorkspace(ordered, mainWorktreeOf, workspaceId, before);
}

/**
 * The gap one step over, as the id in front of it.
 *
 * `"none"` where there is no such gap, which is `undefined`'s job taken by
 * something else: `undefined` already means the gap at the bottom, and the two
 * are not the same answer.
 */
function stepTarget(
  ids: readonly string[],
  at: number,
  direction: MoveDirection,
): string | undefined | "none" {
  if (direction === -1) return at === 0 ? "none" : ids[at - 1];
  if (at >= ids.length - 1) return "none";
  // Past the neighbour below: the gap after it, which the row two down names,
  // and which is the bottom gap when there is no row two down.
  return at + 2 < ids.length ? ids[at + 2] : undefined;
}

/**
 * An Agent's siblings are the Agents of its own workspace, and that is all.
 *
 * The group question is already answered for an Agent — it belongs to exactly
 * one workspace and there is nowhere else for it to go — so these two are the
 * same rules with the grouping taken out.
 *
 * Unlike a workspace's, an Agent's order needs nothing written down beside it.
 * The list *is* the order — the model keeps its Agents in a list, the state
 * file writes that list out in order, and loading puts them back in it — so
 * moving one is moving it, and a file from before this existed loads as the
 * order the Agents were created in, which is what it has always meant.
 */
export function placeAgent(
  agentIds: readonly string[],
  agentId: string,
  before: string | undefined,
): readonly string[] | undefined {
  if (before === agentId) return undefined;
  const at = agentIds.indexOf(agentId);
  if (at < 0) return undefined;
  let target: number;
  if (before === undefined) {
    target = agentIds.length - 1;
  } else {
    const found = agentIds.indexOf(before);
    if (found < 0) return undefined;
    target = found > at ? found - 1 : found;
  }
  if (target === at) return undefined;
  const moved = [...agentIds];
  moved.splice(at, 1);
  moved.splice(target, 0, agentId);
  return moved;
}

export function moveAgent(
  agentIds: readonly string[],
  agentId: string,
  direction: MoveDirection,
): readonly string[] | undefined {
  const at = agentIds.indexOf(agentId);
  if (at < 0) return undefined;
  const before = stepTarget(agentIds, at, direction);
  if (before === "none") return undefined;
  return placeAgent(agentIds, agentId, before);
}
