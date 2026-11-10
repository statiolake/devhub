/**
 * The state of the Orchestrator row's group that is the Sidebar's own: what
 * is folded, and when a lane change may move a row.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LANES,
  heldArrangement,
  sameArrangement,
  type Arrangement,
  type LaneId,
} from "./orchestratorLanes";

/** What is folded: each lane, and the Orchestrator row's whole group. */
export interface OrchestratorFolds {
  readonly group: boolean;
  readonly lanes: Readonly<Record<LaneId, boolean>>;
}

const FOLDS_KEY = "devhub.sidebar.orchestratorFolds";

function freshFolds(): OrchestratorFolds {
  return {
    group: false,
    lanes: Object.fromEntries(
      LANES.map((lane) => [lane.id, lane.startsFolded]),
    ) as Record<LaneId, boolean>,
  };
}

function readFolds(): OrchestratorFolds {
  const fresh = freshFolds();
  try {
    const text = window.sessionStorage.getItem(FOLDS_KEY);
    if (text === null) return fresh;
    const value = JSON.parse(text) as Partial<OrchestratorFolds>;
    return {
      group: value.group === true,
      lanes: Object.fromEntries(
        LANES.map((lane) => [
          lane.id,
          typeof value.lanes?.[lane.id] === "boolean"
            ? value.lanes[lane.id]
            : fresh.lanes[lane.id],
        ]),
      ) as Record<LaneId, boolean>,
    };
  } catch {
    return fresh;
  }
}

/** For tests: as a fresh session has it. */
export function forgetOrchestratorFolds(): void {
  try {
    window.sessionStorage.removeItem(FOLDS_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/**
 * What is folded, kept for the session (as the board keeps its own): 待機中
 * and 完了 start folded, the rest and the group open. `sessionStorage`, so a
 * reload of the page keeps it and a restart starts afresh.
 */
export function useOrchestratorFolds(): {
  readonly folds: OrchestratorFolds;
  readonly setGroupFolded: (folded: boolean) => void;
  readonly setLaneFolded: (lane: LaneId, folded: boolean) => void;
} {
  const [folds, setFolds] = useState(readFolds);
  const keep = useCallback(
    (next: (value: OrchestratorFolds) => OrchestratorFolds) => {
      setFolds((value) => {
        const updated = next(value);
        try {
          window.sessionStorage.setItem(FOLDS_KEY, JSON.stringify(updated));
        } catch {
          // Kept for this page's life only.
        }
        return updated;
      });
    },
    [],
  );
  return {
    folds,
    setGroupFolded: useCallback(
      (folded: boolean) => {
        keep((value) =>
          value.group === folded ? value : { ...value, group: folded },
        );
      },
      [keep],
    ),
    setLaneFolded: useCallback(
      (lane: LaneId, folded: boolean) => {
        keep((value) =>
          value.lanes[lane] === folded
            ? value
            : { ...value, lanes: { ...value.lanes, [lane]: folded } },
        );
      },
      [keep],
    ),
  };
}

/**
 * How long a change has to stand before a row moves for it. An agent that
 * has just started reads idle, then needs action, then working within a
 * fraction of a second, and a Workspace the orchestrator opens is followed
 * by its agent a moment later: none of that is a move worth drawing. What
 * stands for this long is.
 */
export const SETTLE_MS = 600;

function arrangementKey(arrangement: Arrangement): string {
  return [...arrangement].map(([key, lane]) => `${key}=${lane}`).join("|");
}

/** `steady` without what `live` no longer has. */
function withoutGone(steady: Arrangement, live: Arrangement): Arrangement {
  if ([...steady.keys()].every((key) => live.has(key))) return steady;
  return new Map([...steady].filter(([key]) => live.has(key)));
}

/**
 * How long the pointer rests in the group before a change it is holding back
 * is drawn: long enough that a hand on its way to a row is not overtaken,
 * short enough that a pointer left lying there does not hide a change.
 */
export const POINTER_IDLE_MS = 1500;

/**
 * A lane change, and a new item, wait while the pointer is in the group.
 *
 * The rule: a change that would move rows under the Orchestrator row — a
 * lane change, a new item — is drawn once it has stood for `SETTLE_MS`,
 * unless the pointer is inside the group and in use — moved within
 * the last `POINTER_IDLE_MS`, or a button held down. Then what is drawn is
 * what was drawn (each item in the lane it stood in, an item not drawn yet
 * not drawn), with every row's own content live; the change lands when the
 * pointer leaves the group, or rests for `POINTER_IDLE_MS` with no button
 * down. An item that has gone is never held: there is nothing to draw.
 * The keyboard does not hold anything back — focus follows the moved row by
 * its id (`Sidebar`'s roving tab stop) — and neither does Reduce Motion.
 */
export function useSettledArrangement(
  live: Arrangement,
  /**
   * Whether the board has been read. Until it has, every item's lane is a
   * guess, and the first reading is drawn at once rather than waited for.
   */
  ready = true,
): {
  readonly drawn: Arrangement;
  readonly pointerHandlers: {
    readonly onPointerEnter: () => void;
    readonly onPointerMove: () => void;
    readonly onPointerLeave: () => void;
    readonly onPointerDown: () => void;
    readonly onPointerUp: () => void;
    readonly onPointerCancel: () => void;
  };
} {
  // The arrangement once it has stood for `SETTLE_MS`. An item that has
  // gone leaves at once.
  const [steady, setSteady] = useState<Arrangement>(live);
  const latest = useRef(live);
  const liveKey = arrangementKey(live);
  if (!ready && !sameArrangement(steady, live)) setSteady(live);
  useEffect(() => {
    latest.current = live;
    // Set from a timer, never synchronously: the change has to have stood.
    const timer = setTimeout(() => {
      setSteady((value) =>
        sameArrangement(value, latest.current) ? value : latest.current,
      );
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
    // `liveKey` is `live`, said as a string: a new Map with the same rows is
    // not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);
  const settled = withoutGone(steady, live);
  const [holding, setHolding] = useState(false);
  // What was drawn when the hold began: kept up with what has settled while
  // nothing is held (the state-from-props pattern, set while rendering).
  const [shown, setShown] = useState<Arrangement>(settled);
  if (!holding && !sameArrangement(shown, settled)) setShown(settled);
  const pressed = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopIdle = () => {
    if (idle.current !== undefined) clearTimeout(idle.current);
    idle.current = undefined;
  };
  const restartIdle = () => {
    stopIdle();
    idle.current = setTimeout(() => {
      idle.current = undefined;
      if (!pressed.current) setHolding(false);
    }, POINTER_IDLE_MS);
  };
  useEffect(() => stopIdle, []);

  const drawn = holding ? heldArrangement(shown, settled) : settled;

  const inUse = () => {
    setHolding(true);
    restartIdle();
  };
  return {
    drawn,
    pointerHandlers: {
      onPointerEnter: inUse,
      onPointerMove: inUse,
      onPointerLeave: () => {
        pressed.current = false;
        stopIdle();
        setHolding(false);
      },
      onPointerDown: () => {
        pressed.current = true;
        inUse();
      },
      onPointerUp: () => {
        pressed.current = false;
        restartIdle();
      },
      onPointerCancel: () => {
        pressed.current = false;
        restartIdle();
      },
    },
  };
}
