/**
 * The tree as the table draws it: sorted, with what is collapsed left out.
 *
 * Pure, so the order and the folding are tested without a page.
 */

import type { TaskRowWire } from "../ipc/taskManager";

export type SortKey = "memory" | "cpu";

export interface VisibleRow {
  readonly row: TaskRowWire;
  readonly depth: number;
  readonly open: boolean;
  readonly parentId: string | undefined;
}

/** Heaviest first by the chosen column, the other one breaking a tie. */
export function sortRows(
  rows: readonly TaskRowWire[],
  key: SortKey,
): TaskRowWire[] {
  const primary = (row: TaskRowWire) =>
    key === "memory" ? row.memoryBytes : row.cpuPercent;
  const secondary = (row: TaskRowWire) =>
    key === "memory" ? row.cpuPercent : row.memoryBytes;
  return [...rows].sort(
    (a, b) =>
      primary(b) - primary(a) ||
      secondary(b) - secondary(a) ||
      a.label.localeCompare(b.label),
  );
}

/**
 * Whether a row is open: what the person said, else what is worth seeing
 * first — a Workspace open down to its workbench's and Agents' processes,
 * and DevHub's own, tmux and Other folded.
 */
export function isOpen(
  row: TaskRowWire,
  depth: number,
  toggled: ReadonlySet<string>,
): boolean {
  const byDefault =
    row.kind === "workspace" ||
    row.kind === "workbench" ||
    row.kind === "agent" ||
    (row.kind === "group" && depth === 1);
  return byDefault !== toggled.has(row.id);
}

export function visibleRows(
  rows: readonly TaskRowWire[],
  key: SortKey,
  toggled: ReadonlySet<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (
    level: readonly TaskRowWire[],
    depth: number,
    parentId: string | undefined,
  ) => {
    for (const row of sortRows(level, key)) {
      const open = row.children.length > 0 && isOpen(row, depth, toggled);
      out.push({ row, depth, open, parentId });
      if (open) walk(row.children, depth + 1, row.id);
    }
  };
  walk(rows, 0, undefined);
  return out;
}
