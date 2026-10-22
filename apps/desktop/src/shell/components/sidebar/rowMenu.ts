/**
 * The context menu a Sidebar row opens on a right-click.
 *
 * A native menu, put up by main (`main/shell/contextMenu.ts`). It used to be a
 * DOM menu drawn in this page, and this page is a view the size of the
 * Sidebar: a box drawn in it is clipped by it, so on a collapsed rail the menu
 * was a sliver nobody could read. A native menu is above every view, and it
 * answers the keyboard the way every other Mac menu does.
 *
 * What is in it is still decided here, and each item's act is still a
 * function here, dispatched exactly the way the row's own buttons dispatch:
 * only the id and the label cross to main, and the id that comes back says
 * which act to run. So the row's actions and the menu's cannot drift apart.
 */

import type {
  AgentSnapshot,
  AppIntent,
  WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { agentRestart } from "../../../model/domain";
import { devhub } from "../../sidebar/client";

export interface RowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
}

/**
 * Put the menu up at the click that opened it — in this view's own
 * coordinates; main knows where the view is — and run what is chosen.
 */
export function openRowMenu(
  items: readonly RowMenuItem[],
  at: { readonly x: number; readonly y: number },
): void {
  void devhub()
    .showContextMenu({
      items: items.map(({ id, label }) => ({ id, label })),
      at: { x: at.x, y: at.y },
    })
    .then((chosen) => {
      items.find((item) => item.id === chosen)?.run();
    });
}

/**
 * What a right-click on a Workspace in a dev container offers — the only
 * Workspace row with a menu at all.
 */
export function workspaceMenuItems(
  workspace: WorkspaceSnapshot,
  reopenInContainer: (workspaceId: string) => void,
  reopenLocally: (workspaceId: string) => void,
): RowMenuItem[] {
  return [
    {
      // The way back in when the editor could not open because its
      // container was never built, or was removed: build it, then open the
      // editor in it — what Retry, which only starts a container, cannot do.
      id: "reopen-in-container",
      label: "Reopen Editor in Container",
      run: () => {
        reopenInContainer(workspace.id);
      },
    },
    {
      // The way out when an editor in a dev container cannot open — a
      // container never built, a Docker that is not running — and the same
      // act as the editor's own Reopen Folder Locally.
      id: "reopen-locally",
      label: "Reopen Editor Locally",
      run: () => {
        reopenLocally(workspace.id);
      },
    },
  ];
}

/**
 * What a right-click on an Agent offers.
 *
 * Mark as Unread is the only one that is not already a control on the row, and
 * it is here because it is the counterpart to opening one: reading is
 * automatic, and un-reading has to be something you can say.
 */
export function agentMenuItems(
  agent: AgentSnapshot,
  dispatch: (intent: AppIntent) => void,
  onRename: (agent: AgentSnapshot) => void,
): RowMenuItem[] {
  const items: RowMenuItem[] = [
    {
      id: "rename",
      label: "Rename…",
      run: () => {
        onRename(agent);
      },
    },
  ];
  if (!agent.unread) {
    items.push({
      id: "unread",
      label: "Mark as Unread",
      run: () => {
        dispatch({ type: "mark_agent_unread", agentId: agent.id });
      },
    });
  }
  // Offered where the coordinator would take it (`agentRestart`): a GUI
  // Agent's CLI is started again under its host, a terminal Claude's or
  // Codex's in its own tmux pane on the session it is in; a CLI with no
  // sessions to resume has nothing to restart, and a conversation DevHub
  // cannot follow could not follow a CLI started again either.
  if (
    agent.controlState.kind === "running" &&
    agentRestart(agent).kind === "available"
  ) {
    items.push({
      id: "restart",
      label: "Restart Session",
      run: () => {
        dispatch({ type: "restart_agent", agentId: agent.id });
      },
    });
  }
  if (agent.controlState.kind !== "stopping") {
    items.push({
      id: "stop",
      label:
        agent.controlState.kind === "stop-failed" ? "Retry Stop" : "Stop Agent",
      run: () => {
        dispatch(
          agent.controlState.kind === "stop-failed"
            ? { type: "retry_stop_agent", agentId: agent.id }
            : { type: "stop_agent", agentId: agent.id },
        );
      },
    });
  }
  return items;
}
