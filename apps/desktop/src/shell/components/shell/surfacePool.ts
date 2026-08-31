import type { AppSnapshot } from "../../../ipc/appShell";

/** One mounted Agent pane: what the pool needs to keep it, and its label. */
export interface PooledSurface {
  readonly key: string;
  readonly label: string;
}

/**
 * Every Agent pane that exists right now.
 *
 * All of them are mounted, and the selection decides which one is on screen.
 * There is no cheaper set to keep: these are the Agents the person started, and
 * an Agent parked off screen keeps its attachment and its scrollback rather
 * than paying to reconnect when it comes back.
 *
 * A pane outlives the selection but not its subject: an Agent that is no longer
 * running, or whose Workspace is closing, drops out of this map and so out of
 * the pool, which releases what it held instead of parking it.
 *
 * Neither the workbench nor a terminal is here. The workbench is a native
 * `WebContentsView` main lays over the page's hole, and a terminal is inside
 * that workbench now — so an Agent's pane is the only Surface this page draws.
 */
export function runningAgentSurfaces(
  snapshot: AppSnapshot,
): ReadonlyMap<string, PooledSurface> {
  const surfaces = new Map<string, PooledSurface>();
  for (const workspace of snapshot.workspaces) {
    if (workspace.state !== "available") continue;
    for (const agent of workspace.agents) {
      if (agent.controlState !== "running") continue;
      const key = `agent:${agent.id}`;
      surfaces.set(key, { key, label: agent.displayName });
    }
  }
  return surfaces;
}
