/**
 * Dragging a row to somewhere else in the Sidebar.
 *
 * **The rule about where a row may go is not here.** It is in
 * `model/workspaceOrder.ts`, which is the same rule `Alt+↑` steps through and
 * the same rule the projection applies — so a drop the pointer cannot make is a
 * step the keyboard cannot take either, and neither of them can produce an
 * order the list would silently undo. What is here is only the part that is
 * about a pointer: which row is under it, which half of that row, and therefore
 * which gap between rows it means.
 *
 * # A gap is named by the row after it
 *
 * A list of n rows has n+1 gaps, and only n of them can be named by a row. So a
 * gap is "in front of this row", and the one gap left over — the bottom of the
 * list — is `undefined`. That is the same spelling `placeWorkspace` and
 * `placeAgent` take, which is why nothing has to be translated between the
 * pointer and the model.
 *
 * # Only the rows a row may land among are targets
 *
 * Not every row is a place to drop. A worktree may move within its repository's
 * group and nowhere else; a repository moves among the other repositories,
 * carrying its worktrees; an Agent moves among the Agents of its own workspace;
 * and Scratch does not move at all. So the rows that are not siblings of what
 * is being dragged are not targets, and the Sidebar dims them — the lit part of
 * the list *is* the range, which is a thing a person can see rather than a rule
 * they have to be told.
 */

import {
  sidebarWorkspaces,
  type AppSnapshot,
  type WorkspaceSnapshot,
} from "../../../ipc/appShell";
import {
  moveAgent,
  moveWorkspace,
  placeAgent,
  placeWorkspace,
  siblingsOf,
  type MoveDirection,
} from "../../../model/workspaceOrder";

/**
 * What is being dragged.
 *
 * A workspace row or an Agent row, which are the only two kinds of row that
 * move. Scratch is not one of them and never becomes one: it is the first row
 * by definition, not by arrangement, so every Workspace lane and every order
 * sent is over `sidebarWorkspaces(snapshot).rows`, which it is not in.
 */
export type DragSource =
  | { readonly kind: "workspace"; readonly id: string }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly workspaceId: string;
    };

/** A drag in progress: what is moving, and the gap it is currently over. */
export interface DragState {
  readonly source: DragSource;
  /**
   * The row the gap is in front of, `undefined` for the end of the range, and
   * absent when the pointer is not over any gap this row may use.
   */
  readonly before?: string | undefined;
  /** Whether the pointer is over a gap at all. See `before`. */
  readonly over: boolean;
}

/** Every row of a group, in order — a group being contiguous on screen. */
function agentsOf(
  snapshot: AppSnapshot,
  workspaceId: string,
): readonly string[] {
  const workspace = snapshot.workspaces.find(
    (one) => one.id === workspaceId,
  ) as WorkspaceSnapshot | undefined;
  return workspace?.agents.map((agent) => agent.id) ?? [];
}

/**
 * The rows this one may be dropped among, in the order they are drawn.
 *
 * Itself included: it is one of its own siblings, and leaving it out would make
 * "the gap in front of the row below me" a gap that does not exist.
 */
export function dropLane(
  snapshot: AppSnapshot,
  source: DragSource,
): readonly string[] {
  if (source.kind === "agent") return agentsOf(snapshot, source.workspaceId);
  return siblingsOf(
    sidebarWorkspaces(snapshot).rows,
    (workspace) => workspace.groupKey,
    source.id,
  ).map((workspace) => workspace.id);
}

/**
 * Which gap the pointer means, given the row it is over and where in it.
 *
 * The top half of a row is the gap in front of it and the bottom half is the
 * gap behind it, which is the gap in front of the *next* row — and at the end
 * of the range there is no next row, which is the bottom gap and is
 * `undefined`. `"none"` is a row that is not a place this may be dropped.
 */
export function gapUnder(
  lane: readonly string[],
  rowId: string,
  half: "top" | "bottom",
): string | undefined | "none" {
  const at = lane.indexOf(rowId);
  if (at < 0) return "none";
  if (half === "top") return rowId;
  return at + 1 < lane.length ? lane[at + 1] : undefined;
}

/** Which half of a row a pointer at `clientY` is in. */
export function halfOf(rect: DOMRect, clientY: number): "top" | "bottom" {
  return clientY < rect.top + rect.height / 2 ? "top" : "bottom";
}

/**
 * The intent a drop comes to, or nothing when it comes to nothing.
 *
 * Nothing is a real answer, and the ordinary one: a row let go in the gap it
 * was already in has not moved, and raising an intent for it would put a
 * revision on the wire for a gesture that changed the list not at all.
 */
export function dropIntent(
  snapshot: AppSnapshot,
  source: DragSource,
  before: string | undefined,
):
  | { readonly type: "reorder_workspaces"; readonly order: readonly string[] }
  | {
      readonly type: "reorder_agents";
      readonly workspaceId: string;
      readonly order: readonly string[];
    }
  | undefined {
  if (source.kind === "agent") {
    const order = placeAgent(
      agentsOf(snapshot, source.workspaceId),
      source.id,
      before,
    );
    return order === undefined
      ? undefined
      : {
          type: "reorder_agents",
          workspaceId: source.workspaceId,
          order,
        };
  }
  const order = placeWorkspace(
    sidebarWorkspaces(snapshot).rows,
    (workspace) => workspace.groupKey,
    source.id,
    before,
  );
  return order === undefined
    ? undefined
    : { type: "reorder_workspaces", order };
}

/**
 * A row from the id the tree walks it by. `workspace:<id>` or `agent:<id>`.
 *
 * The Sidebar's roving tab stop already identifies a row this way, and reusing
 * it is what lets `Alt+↑` act on the row the keyboard is *on* rather than on
 * the row that happens to be selected — which in a tree a person is walking are
 * two different rows.
 */
export function sourceOfTreeItem(
  snapshot: AppSnapshot,
  treeItemId: string,
): DragSource | undefined {
  const [kind, id] = [
    treeItemId.slice(0, treeItemId.indexOf(":")),
    treeItemId.slice(treeItemId.indexOf(":") + 1),
  ];
  if (kind === "workspace") return { kind: "workspace", id };
  if (kind !== "agent") return undefined;
  const owner = snapshot.workspaces.find((workspace) =>
    workspace.agents.some((agent) => agent.id === id),
  );
  return owner === undefined
    ? undefined
    : { kind: "agent", id, workspaceId: owner.id };
}

/**
 * One step up or down, as the intent it comes to.
 *
 * The keyboard's whole half of rearranging, and it is the drop rule with the
 * gap chosen for it: `moveWorkspace` and `moveAgent` are `placeWorkspace` and
 * `placeAgent` aimed at the neighbouring gap, so a step the pointer could not
 * have made is a step this cannot make either. Nothing at the ends of the
 * range, which is a no-op and not a wrap — one keystroke that jumped the length
 * of the Sidebar would be a keystroke nobody could aim.
 */
export function moveIntent(
  snapshot: AppSnapshot,
  source: DragSource,
  direction: MoveDirection,
): ReturnType<typeof dropIntent> {
  if (source.kind === "agent") {
    const order = moveAgent(
      agentsOf(snapshot, source.workspaceId),
      source.id,
      direction,
    );
    return order === undefined
      ? undefined
      : { type: "reorder_agents", workspaceId: source.workspaceId, order };
  }
  const order = moveWorkspace(
    sidebarWorkspaces(snapshot).rows,
    (workspace) => workspace.groupKey,
    source.id,
    direction,
  );
  return order === undefined
    ? undefined
    : { type: "reorder_workspaces", order };
}
