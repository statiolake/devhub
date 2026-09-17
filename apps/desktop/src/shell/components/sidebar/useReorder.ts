/**
 * The Sidebar's half of dragging a row: what one row has to be told, and what
 * the pane has to be told, while a drag is in progress.
 *
 * One hook for the whole tree rather than one per row, for the same reason the
 * row menu is one piece of state: only one row can be being dragged, and saying
 * so in one place is what makes that true instead of hoping every row lets go
 * when another starts.
 *
 * The rule about where a row may go is not here and not in `reorder.ts` either
 * — it is in `model/workspaceOrder.ts`, the same rule the keyboard steps
 * through and the projection applies. This turns a pointer into a question for
 * it and its answer into attributes.
 *
 * # HTML drag, not pointer arithmetic
 *
 * The browser already knows which element is under the pointer, already draws
 * the thing being dragged, already scrolls a list when the pointer reaches its
 * edge, and already ends the gesture when the person lets go somewhere else or
 * presses Escape. Every one of those is something a pointer-event
 * implementation would have to write again and get subtly wrong, and all of it
 * works in the App Shell page because the Sidebar is ordinary DOM in an
 * ordinary renderer — the native views this window also holds are elsewhere in
 * the window and never under this list.
 */

import { useCallback, useMemo, useState } from "react";
import type { AppSnapshot } from "../../../ipc/appShell";
import { useSidebarDispatch } from "../../sidebar/SidebarContext";
import {
  dropIntent,
  dropLane,
  gapUnder,
  halfOf,
  type DragSource,
} from "./reorder";

/** What one row needs on it, drag or no drag. */
export interface RowDragProps {
  readonly draggable: boolean;
  readonly "data-dragging"?: "true";
  /** Absent when nothing is being dragged: there is no range to be outside. */
  readonly "data-reorder-target"?: "true" | "false";
  readonly "data-drop-before"?: "true";
  readonly "data-drop-after"?: "true";
  readonly onDragStart: (event: React.DragEvent) => void;
  readonly onDragOver: (event: React.DragEvent) => void;
  readonly onDrop: (event: React.DragEvent) => void;
  readonly onDragEnd: () => void;
}

export interface Reorder {
  /** Whether a row is in the air. The pane dims what is out of range on it. */
  readonly active: boolean;
  readonly rowProps: (source: DragSource) => RowDragProps;
}

interface DragState {
  readonly source: DragSource;
  /** The row the line is in front of; `undefined` is the end of the range. */
  readonly before: string | undefined;
  /** Whether the pointer is over a gap this row may use at all. */
  readonly over: boolean;
}

export function useReorder(snapshot: AppSnapshot): Reorder {
  // The column's one dispatch, taken here rather than passed in: a drag ends
  // in an intent like every other control, and an intent's answer is the
  // page's to read. See `useSidebarDispatch`.
  const dispatch = useSidebarDispatch();
  const [drag, setDrag] = useState<DragState | undefined>(undefined);

  const lane = useMemo(
    () => (drag ? dropLane(snapshot, drag.source) : []),
    [drag, snapshot],
  );

  const rowProps = useCallback(
    (source: DragSource): RowDragProps => {
      const dragging = drag?.source.id === source.id;
      const inLane = lane.includes(source.id);
      const showsLine = drag !== undefined && drag.over && inLane;
      return {
        draggable: true,
        ...(dragging ? { "data-dragging": "true" as const } : {}),
        ...(drag === undefined
          ? {}
          : {
              "data-reorder-target": inLane
                ? ("true" as const)
                : ("false" as const),
            }),
        ...(showsLine && drag.before === source.id
          ? { "data-drop-before": "true" as const }
          : {}),
        // The one gap no row can name: the end of the range. It is drawn on the
        // last row of the range instead, below it.
        ...(showsLine && drag.before === undefined && lane.at(-1) === source.id
          ? { "data-drop-after": "true" as const }
          : {}),
        onDragStart: (event) => {
          // An Agent row sits inside a workspace row, and both are draggable.
          // The innermost one is what the person took hold of.
          event.stopPropagation();
          // Firefox refuses to start a drag with nothing on the transfer, and
          // the payload is never read: what is moving is this state, because
          // an id crossing a string boundary and back is a second answer to a
          // question already answered.
          event.dataTransfer?.setData("text/plain", source.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          setDrag({ source, before: undefined, over: false });
        },
        onDragOver: (event) => {
          const current = drag;
          if (!current) return;
          event.stopPropagation();
          const rows = dropLane(snapshot, current.source);
          const gap = gapUnder(
            rows,
            source.id,
            halfOf(event.currentTarget.getBoundingClientRect(), event.clientY),
          );
          if (gap === "none") {
            // Not a place this row may land. No `preventDefault`, which is how
            // the browser is told this is not a drop target — the pointer says
            // so without anything here having to draw a refusal.
            if (current.over) setDrag({ ...current, over: false });
            return;
          }
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          if (current.over && current.before === gap) return;
          setDrag({ ...current, before: gap, over: true });
        },
        onDrop: (event) => {
          const current = drag;
          if (!current) return;
          event.preventDefault();
          event.stopPropagation();
          setDrag(undefined);
          if (!current.over) return;
          const intent = dropIntent(snapshot, current.source, current.before);
          // Nothing is the ordinary answer: a row let go in the gap it was
          // already in has not moved, and there is nothing to say about it.
          if (intent) dispatch(intent);
        },
        onDragEnd: () => {
          setDrag(undefined);
        },
      };
    },
    [dispatch, drag, lane, snapshot],
  );

  return { active: drag !== undefined, rowProps };
}
