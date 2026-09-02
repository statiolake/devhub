/**
 * The last frame of a row that finished closing.
 *
 * A Workspace leaves the projection the instant its close completes, so
 * without this the row is there in one frame and gone in the next, and every
 * row below it jumps up by a row height. The jump is the problem: it happens
 * at the one moment the person is watching that part of the list, and it moves
 * whatever they were about to click.
 *
 * So the row is kept for as long as it takes to fade and collapse — a ghost,
 * carrying nothing but the label it had and the place it was in. It is not a
 * Workspace and cannot be interacted with; it is the row's departure, drawn.
 *
 * Only a row that was *closing* when it vanished gets one. A Workspace has no
 * other way to leave the list, but saying so here is what keeps a future
 * wholesale change of the snapshot — a reload, a restore — from playing a
 * dozen exit animations at once.
 */

import { useEffect, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../../../ipc/appShell";

/**
 * How long a ghost stands. The same number as the `row-exit` animation in
 * `shell.css`; the animation is what the person sees and this is only what
 * keeps the element alive long enough to finish it, so if one changes the
 * other has to.
 */
export const CLOSING_EXIT_MS = 180;

export interface ExitingRow {
  readonly id: string;
  readonly label: string;
  /** Where the row was, so the ghost stands in its own place and not at the end. */
  readonly index: number;
}

interface SeenRow {
  readonly id: string;
  readonly label: string;
  readonly closing: boolean;
}

function seen(workspaces: readonly WorkspaceSnapshot[]): SeenRow[] {
  return workspaces.map((workspace) => ({
    id: workspace.id,
    label: workspace.label,
    closing: workspace.state === "closing",
  }));
}

/**
 * Which rows have just gone, given the ordered list as it is now.
 *
 * Pure, and separate from the hook, because the interesting half is the
 * comparison and it is worth being able to ask it a question directly.
 */
export function rowsThatLeft(
  before: readonly SeenRow[],
  after: readonly WorkspaceSnapshot[],
): ExitingRow[] {
  const present = new Set(after.map((workspace) => workspace.id));
  const left: ExitingRow[] = [];
  before.forEach((row, index) => {
    if (row.closing && !present.has(row.id)) {
      left.push({ id: row.id, label: row.label, index });
    }
  });
  return left;
}

export type SidebarRowEntry =
  | { readonly kind: "workspace"; readonly workspace: WorkspaceSnapshot }
  | { readonly kind: "exiting"; readonly row: ExitingRow };

/**
 * The live rows with the ghosts put back where they were.
 *
 * A ghost goes in at the index it held, so the row fades out of its own place
 * rather than appearing at the bottom of the list to do it. The index is from
 * the list it left, which may since have got shorter, so it is clamped — a
 * ghost whose neighbours have all gone too lands at the end, which is where it
 * was.
 */
export function mergeExitingRows(
  workspaces: readonly WorkspaceSnapshot[],
  exiting: readonly ExitingRow[],
): SidebarRowEntry[] {
  const entries: SidebarRowEntry[] = workspaces.map((workspace) => ({
    kind: "workspace",
    workspace,
  }));
  for (const row of [...exiting].sort((a, b) => a.index - b.index)) {
    entries.splice(Math.min(row.index, entries.length), 0, {
      kind: "exiting",
      row,
    });
  }
  return entries;
}

/**
 * The ghosts to draw beside the live rows.
 *
 * The timer is per batch rather than per row: rows that went together came
 * from one close and go together, and a timer each would only be more things
 * to cancel for no visible difference.
 *
 * It is deliberately *not* cleaned up when `workspaces` changes. A ghost's
 * timer belongs to the ghost, not to the snapshot that happened to be current
 * when it started — tying the two together meant the next snapshot to arrive
 * cancelled the removal, and since that snapshot had nothing new leaving, no
 * replacement timer was set and the ghost stayed on the list for good. So the
 * only thing that cancels them is the Sidebar going away.
 */
export function useClosingExit(
  workspaces: readonly WorkspaceSnapshot[],
): readonly ExitingRow[] {
  const previous = useRef<SeenRow[]>(seen(workspaces));
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [exiting, setExiting] = useState<readonly ExitingRow[]>([]);

  useEffect(() => {
    const left = rowsThatLeft(previous.current, workspaces);
    previous.current = seen(workspaces);
    if (left.length === 0) return;
    setExiting((current) => [...current, ...left]);
    const gone = new Set(left.map((row) => row.id));
    timers.current.push(
      setTimeout(() => {
        setExiting((current) => current.filter((row) => !gone.has(row.id)));
      }, CLOSING_EXIT_MS),
    );
  }, [workspaces]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
    },
    [],
  );

  return exiting;
}
