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
 * Every Surface that exists right now.
 *
 * All of them are mounted, and the selection decides which one is on screen.
 * There is no cheaper set to keep: these are the Workspaces the user has open,
 * and a Workspace is open because they intend to work in it. Editors and
 * terminals for open Workspaces are what the app is.
 *
 * A Surface outlives the selection but not its subject: a Workspace that is
 * closing or whose Root went missing, and an Agent that is no longer running,
 * drop out of this map and so out of the pool, which releases what they held
 * instead of parking it.
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

/** One Editor: the Workspace it opens, and the key the selection names it by. */
export interface PooledEditor {
  readonly key: string;
  readonly folder?: string;
}

/**
 * Every Editor that exists right now — one per available Workspace, plus the
 * folderless one.
 *
 * A Workbench holds the workspace it was raised with and cannot be given
 * another, so there is one document per Workspace and the selection decides
 * which is on screen. That is what DevHub replaced: several VS Code windows,
 * open at once, switched between.
 */
export function editorSurfaces(
  snapshot: AppSnapshot,
): ReadonlyMap<string, PooledEditor> {
  const editors = new Map<string, PooledEditor>();
  editors.set("global-editor", { key: "global-editor" });
  for (const workspace of snapshot.workspaces) {
    if (workspace.state !== "available") continue;
    const key = `workspace-editor:${workspace.id}`;
    editors.set(key, { key, folder: workspace.root });
  }
  return editors;
}
