import {
  type AppSnapshot,
  workspaceForContext,
} from "../../generated/app-shell";
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

/**
 * The Surfaces worth mounting before they are asked for.
 *
 * A Surface the user has not visited costs an attachment to keep, so warming
 * is bounded to the Workspace they are already in: its terminal and its
 * running Agents. Those are the Surfaces one click away, and their processes
 * are alive regardless — the only thing being bought early is the handshake.
 * Scratch is warmed everywhere, because it is one click away from everywhere.
 */
export function warmSurfaces(snapshot: AppSnapshot): readonly string[] {
  const warm = ["global-terminal"];
  const workspace = workspaceForContext(snapshot, snapshot.selection.context);
  if (!workspace || workspace.state !== "available") return warm;
  warm.push(`workspace-terminal:${workspace.id}`);
  for (const agent of workspace.agents) {
    if (agent.controlState === "running") warm.push(`agent:${agent.id}`);
  }
  return warm;
}
