import type { AppSnapshot } from "../../generated/app-shell";
import type { TerminalClient } from "../../terminal/client";
import { defaultAgentSurfaceClient } from "../../agent/client";

/** One attachable Surface: what the pool needs to keep it mounted and to
 * label it while it waits off screen. */
export interface PooledSurface {
  readonly key: string;
  readonly label: string;
  readonly client?: TerminalClient;
}

/**
 * The Surfaces that are legal to hold an attachment right now.
 *
 * A pooled Surface outlives the selection but not its subject: a Workspace
 * that is closing or whose Root went missing, and an Agent that is no longer
 * running, drop out of this map and so out of the pool, which releases their
 * attachments instead of parking them.
 */
export function attachableSurfaces(
  snapshot: AppSnapshot,
): ReadonlyMap<string, PooledSurface> {
  const surfaces = new Map<string, PooledSurface>();
  surfaces.set("global-terminal", { key: "global-terminal", label: "Scratch" });
  for (const workspace of snapshot.workspaces) {
    if (workspace.state !== "available") continue;
    const terminalKey = `workspace-terminal:${workspace.id}`;
    surfaces.set(terminalKey, { key: terminalKey, label: workspace.label });
    for (const agent of workspace.agents) {
      if (agent.controlState !== "running") continue;
      const agentKey = `agent:${agent.id}`;
      surfaces.set(agentKey, {
        key: agentKey,
        label: agent.displayName,
        client: defaultAgentSurfaceClient,
      });
    }
  }
  return surfaces;
}
