import type { AppSnapshot } from "../../../ipc/appShell";

/** One attachable DOM Surface: what the pool needs to keep it mounted, and
 * the label it carries while it waits off screen. */
export interface PooledSurface {
  readonly key: string;
  readonly label: string;
  readonly kind: "terminal" | "agent";
}

/**
 * Every DOM Surface that exists right now.
 *
 * All of them are mounted, and the selection decides which one is on screen.
 * There is no cheaper set to keep: these are the Workspaces the user has open,
 * and a Workspace is open because they intend to work in it.
 *
 * A Surface outlives the selection but not its subject: a Workspace that is
 * closing or whose Root went missing, and an Agent that is no longer running,
 * drop out of this map and so out of the pool, which releases what they held
 * instead of parking it.
 *
 * The Editor is not here. Its Surface is a native `WebContentsView` that main
 * lays over the viewport's rectangle, so the page contributes a hole for it
 * rather than an element.
 */
export function attachableSurfaces(
  snapshot: AppSnapshot,
): ReadonlyMap<string, PooledSurface> {
  const surfaces = new Map<string, PooledSurface>();
  surfaces.set("global-terminal", {
    key: "global-terminal",
    label: "Scratch",
    kind: "terminal",
  });
  for (const workspace of snapshot.workspaces) {
    if (workspace.state !== "available") continue;
    const terminalKey = `workspace-terminal:${workspace.id}`;
    surfaces.set(terminalKey, {
      key: terminalKey,
      label: workspace.label,
      kind: "terminal",
    });
    for (const agent of workspace.agents) {
      if (agent.controlState !== "running") continue;
      const agentKey = `agent:${agent.id}`;
      surfaces.set(agentKey, {
        key: agentKey,
        label: agent.displayName,
        kind: "agent",
      });
    }
  }
  return surfaces;
}
