/**
 * The orchestrator's work in the Sidebar, as it is drawn: which lane each item
 * is in is the shared rule (`ipc/orchestratorLanes.ts`, which main reads too);
 * what is here is how a change of lane is held back and settled.
 */

import type { LaneId, OrchestratorItem } from "../../../ipc/orchestratorLanes";

export {
  LANES,
  groupByLane,
  inProgressCount,
  laneOf,
  orchestratorItems,
  type LaneBoard,
  type LaneGroup,
  type LaneId,
  type LaneSpec,
  type OrchestratorItem,
} from "../../../ipc/orchestratorLanes";

/** Where each item stands, by key: what the Sidebar has drawn. */
export type Arrangement = ReadonlyMap<string, LaneId>;

export function arrangementOf(items: readonly OrchestratorItem[]): Arrangement {
  return new Map(items.map((item) => [item.key, item.lane]));
}

/** Whether two arrangements draw the same rows in the same lanes. */
export function sameArrangement(a: Arrangement, b: Arrangement): boolean {
  if (a.size !== b.size) return false;
  for (const [key, lane] of a) if (b.get(key) !== lane) return false;
  return true;
}

/**
 * What to draw while a change waits (`useSettledArrangement`): the items as
 * they are now, each in the lane it was drawn in; an item that has gone is
 * gone (it cannot be drawn), and one that has not been drawn yet waits.
 */
export function heldArrangement(
  shown: Arrangement,
  live: Arrangement,
): Arrangement {
  const held = new Map<string, LaneId>();
  for (const [key, lane] of shown) if (live.has(key)) held.set(key, lane);
  return held;
}
