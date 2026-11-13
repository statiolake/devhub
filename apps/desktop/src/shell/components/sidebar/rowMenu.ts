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
import { formatDevhubLink, type DevhubLink } from "../../../model/devhubLink";
import { agentContinuation, agentRestart } from "../../../model/domain";
import { devhub } from "../../sidebar/client";

/**
 * Put a `devhub:` link to a row on the clipboard: canonical, or as
 * Markdown with the row's name. Main writes it and says so
 * (`SidebarBridge.copyDevhubLink`), as `Cmd+Q Y` / `Shift+Y` do for the
 * selection.
 */
export type CopyLink = (link: string, markdown: boolean) => void;

/** Copy Link and Copy Markdown Link, for one place. */
export function copyLinkItems(
  link: DevhubLink,
  copyLink: CopyLink,
): RowMenuItem[] {
  const text = formatDevhubLink(link);
  return [
    {
      id: "copy-link",
      label: "Copy Link",
      run: () => {
        copyLink(text, false);
      },
    },
    {
      id: "copy-markdown-link",
      label: "Copy Markdown Link",
      run: () => {
        copyLink(text, true);
      },
    },
  ];
}

export interface RowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
  /** Stand apart from what is above: the destructive items, last. */
  readonly separated?: true;
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
      items: items.map(({ id, label, separated }) => ({
        id,
        label,
        ...(separated === true ? { separatorBefore: true as const } : {}),
      })),
      at: { x: at.x, y: at.y },
    })
    .then((chosen) => {
      items.find((item) => item.id === chosen)?.run();
    });
}

/**
 * What a right-click on a Workspace offers: on every Workspace but Scratch,
 * which is today's folder and is never closed, Manage with Orchestrator (or
 * Stop Managing, on a managed one: `Workspace.managed`, which `Cmd+Q
 * Shift+M` toggles too) and the close the row's own button is. Empty for
 * Scratch.
 */
export function workspaceMenuItems(
  workspace: WorkspaceSnapshot,
  actions: {
    /** The row's close (`onCloseWorkspace`): one path, whatever the state. */
    readonly close: (workspace: WorkspaceSnapshot) => void;
    /** Closing deletes the folder (`closingDeletesWorktree`), and says so. */
    readonly deletesWorktree: boolean;
    readonly fixed: boolean;
    /** Raise an intent: `set_workspace_managed`, as the chord does. */
    readonly dispatch: (intent: AppIntent) => void;
    /** Copy Link: absent, the menu has none. */
    readonly copyLink?: CopyLink;
  },
): RowMenuItem[] {
  const items: RowMenuItem[] = [];
  if (!actions.fixed) {
    const managed = workspace.managed === true;
    items.push({
      id: "manage",
      label: managed ? "Stop Managing" : "Manage with Orchestrator",
      run: () => {
        actions.dispatch({
          type: "set_workspace_managed",
          workspaceId: workspace.id,
          managed: !managed,
        });
      },
    });
    if (actions.copyLink !== undefined)
      items.push(
        ...copyLinkItems(
          { kind: "workspace", workspace: workspace.id },
          actions.copyLink,
        ),
      );
    items.push({
      // The ellipsis is the row button's promise: a question may follow.
      id: "close-workspace",
      separated: true,
      label: actions.deletesWorktree ? "Close Worktree…" : "Close Workspace…",
      run: () => {
        actions.close(workspace);
      },
    });
  }
  return items;
}

/**
 * What a right-click on an Agent offers.
 *
 * Mark as Unread is here because it is the counterpart to opening one:
 * reading is automatic, and un-reading has to be something you can say.
 * Continue in Terminal / Continue in GUI are here and nowhere else on a
 * healthy Agent (`agentContinuation` says when); Stop Agent is the row's own
 * button and what `Cmd+Q X` does to an Agent, the last item and apart.
 * Manage with Orchestrator (Stop Managing, on a managed one:
 * `Agent.managed`, which `Cmd+Q Shift+M` toggles on the selected Agent) is
 * where the Workspace's is, ahead of the links: the person handing the
 * Agent to the Orchestrator, which main tells to adopt it — its Workspace
 * goes under management with it. Never on the Orchestrator itself
 * (`orchestratorAgentId`).
 * Copy Link is the link that opens this Agent, from DevHub or from
 * Slack and a browser (`Cmd+Q Y` on the selected one).
 */
export function agentMenuItems(
  agent: AgentSnapshot,
  dispatch: (intent: AppIntent) => void,
  onRename: (agent: AgentSnapshot) => void,
  onContinue: (agent: AgentSnapshot) => void,
  copyLink?: CopyLink,
  orchestratorAgentId?: string,
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
  const continuation = agentContinuation(agent);
  if (continuation !== undefined) {
    items.push({
      id: "continue",
      label:
        continuation === "terminal"
          ? "Continue in Terminal"
          : "Continue in GUI",
      run: () => {
        onContinue(agent);
      },
    });
  }
  if (agent.id !== orchestratorAgentId) {
    const managed = agent.managed === true;
    items.push({
      id: "manage",
      label: managed ? "Stop Managing" : "Manage with Orchestrator",
      run: () => {
        dispatch({
          type: "set_agent_managed",
          agentId: agent.id,
          managed: !managed,
        });
      },
    });
  }
  if (copyLink !== undefined)
    items.push(...copyLinkItems({ kind: "agent", agent: agent.id }, copyLink));
  if (agent.controlState.kind !== "stopping") {
    items.push({
      id: "stop",
      separated: true,
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
