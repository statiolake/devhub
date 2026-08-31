import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  type AgentProfile,
  type AgentProfilesAvailabilityWire,
  type AgentSnapshot,
  type AppIntent,
  type AppSnapshot,
  type WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { clampSidebarWidth } from "../../../ipc/appShell";
import { useAppShell } from "../../useAppShell";
import { devhub } from "../../client";
import { isImeComposing } from "../../accessibility/ime";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarRail } from "./SidebarRail";
import { StatusMark } from "./StatusMark";
import { statusLabel } from "./status";

function runtimeHealthLabel(health: AgentSnapshot["runtimeHealth"]): string {
  switch (health) {
    case "starting":
      return "Starting runtime";
    case "degraded":
      return "Runtime needs attention";
    case "unavailable":
      return "Runtime unavailable";
    case "failed":
      return "Runtime unavailable";
    case "healthy":
      return "Connected";
  }
}

export interface SidebarProps {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
}

function treeContextButtons(tree: HTMLElement): HTMLButtonElement[] {
  return [
    ...tree.querySelectorAll<HTMLButtonElement>(
      "[data-tree-item-id]:not([disabled])",
    ),
  ];
}

function setTreeTabStop(
  tree: HTMLElement,
  button: HTMLButtonElement | undefined,
): void {
  for (const item of treeContextButtons(tree)) {
    item.tabIndex = item === button ? 0 : -1;
  }
}

function WorkspaceRow({
  workspace,
  snapshot,
  onDispatch,
  agentProfiles,
  agentProfilesAvailability,
  onCreateAgent,
  onRenameAgent,
  onAgentMenu,
}: {
  readonly workspace: WorkspaceSnapshot;
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agentProfilesAvailability: AgentProfilesAvailabilityWire;
  readonly onCreateAgent: (workspaceId: string) => void;
  readonly onRenameAgent: (agent: AgentSnapshot) => void;
  readonly onAgentMenu: (
    agent: AgentSnapshot,
    at: { x: number; y: number },
  ) => void;
}) {
  const selected =
    snapshot.selection.context.kind === "workspace" &&
    snapshot.selection.context.workspaceId === workspace.id;
  const selectedAgentId =
    snapshot.selection.context.kind === "agent"
      ? snapshot.selection.context.agentId
      : undefined;

  const dispatch = useCallback(
    (intent: AppIntent) => onDispatch(intent),
    [onDispatch],
  );

  return (
    <li
      className="sidebar-tree-item"
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      // A Workspace is always open. The attribute states that, and there is
      // nothing that can change it.
      aria-expanded={workspace.agents.length > 0 ? true : undefined}
    >
      <div
        className={`sidebar-row workspace-row${selected ? " is-selected" : ""}`}
        data-state={workspace.state}
      >
        <span className="row-rail" aria-hidden="true" />
        <button
          className="sidebar-context-button"
          type="button"
          data-workspace-id={workspace.id}
          data-tree-item-id={`workspace:${workspace.id}`}
          tabIndex={selected ? 0 : -1}
          aria-current={selected ? "page" : undefined}
          // A Workspace has no status of its own. Its Agents each carry
          // theirs on their own row, and rolling four of them into one mark
          // only produced a fifth thing to read that named none of them.
          aria-label={`${workspace.label} workspace, path ${workspace.root}`}
          title={workspace.root}
          onClick={() =>
            dispatch({
              type: "select_context",
              context: { kind: "workspace", workspaceId: workspace.id },
            })
          }
        >
          <span className="row-glyph" aria-hidden="true">
            <svg viewBox="0 0 14 14" focusable="false">
              <path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.4 1.6h4.6a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
            </svg>
          </span>
          <span className="row-label">{workspace.label}</span>
        </button>
        {workspace.canCreateAgent && (
          <button
            className="row-action-button"
            type="button"
            aria-label={`Create agent in ${workspace.label}${agentProfilesAvailability === "unavailable" || agentProfiles.length === 0 ? ", unavailable" : ""}`}
            title={
              agentProfilesAvailability === "degraded"
                ? "Agent profiles need attention"
                : agentProfiles.length > 0
                  ? "Create agent"
                  : "No enabled agent profiles"
            }
            disabled={
              agentProfilesAvailability === "unavailable" ||
              agentProfiles.length === 0
            }
            onClick={() => onCreateAgent(workspace.id)}
          >
            <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path d="M7 3.25v7.5M3.25 7h7.5" />
            </svg>
          </button>
        )}
        {/* One close, whatever state the Workspace is in: a close that failed
            is retried by asking for the same thing again, not by a second
            icon that means the same thing. */}
        {workspace.state !== "closing" && (
          <button
            className="row-action-button"
            type="button"
            aria-label={`Close ${workspace.label}`}
            title={
              workspace.state === "closing-failed"
                ? "Retry close"
                : "Close workspace"
            }
            onClick={() =>
              dispatch(
                workspace.state === "closing-failed"
                  ? {
                      type: "retry_close_workspace",
                      workspaceId: workspace.id,
                    }
                  : {
                      type: "request_close_workspace",
                      workspaceId: workspace.id,
                    },
              )
            }
          >
            <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path d="M4 4l6 6M10 4l-6 6" />
            </svg>
          </button>
        )}
      </div>
      {workspace.agents.length > 0 && (
        <ul
          className="agent-tree"
          role="group"
          aria-label={`${workspace.label} agents`}
        >
          {workspace.agents.map((agent) => {
            const agentSelected = selectedAgentId === agent.id;
            const stopFailed = agent.controlState === "stop-failed";
            return (
              <li
                key={agent.id}
                role="treeitem"
                aria-level={2}
                aria-selected={agentSelected}
              >
                <div
                  className={`sidebar-row agent-row${agentSelected ? " is-selected" : ""}${agent.unread ? " is-unread" : ""}`}
                  data-control-state={agent.controlState}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onAgentMenu(agent, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <button
                    className="sidebar-context-button"
                    type="button"
                    data-tree-item-id={`agent:${agent.id}`}
                    tabIndex={agentSelected ? 0 : -1}
                    aria-current={agentSelected ? "page" : undefined}
                    aria-label={`${agent.displayName}, ${statusLabel(agent.status)} agent, ${agent.controlState === "stopping" ? "Stopping" : stopFailed ? "Stop failed" : runtimeHealthLabel(agent.runtimeHealth)}${agent.unread ? ", unread" : ""}`}
                    disabled={agent.controlState === "stopping"}
                    onClick={() =>
                      dispatch({
                        type: "select_context",
                        context: { kind: "agent", agentId: agent.id },
                      })
                    }
                    // Renaming is what a source list does on a second click at
                    // rest, and it stays off the row: an icon whose meaning has
                    // to be guessed is worse than one that is not there.
                    onDoubleClick={() => onRenameAgent(agent)}
                  >
                    {/* The leading glyph *is* the status. There is no second
                        mark trailing the row saying the same thing in a
                        smaller size. */}
                    <StatusMark status={agent.status} />
                    <span className="row-label">{agent.displayName}</span>
                    {/* The unread mark is not a second status. It says the
                        Agent asked for you and you have not been, which is a
                        fact about the person and outlives whatever the Agent
                        is doing now. */}
                    {agent.unread ? (
                      <span className="row-unread" aria-hidden="true" />
                    ) : null}
                    {agent.controlState !== "running" ||
                    agent.runtimeHealth !== "healthy" ? (
                      <span className="row-note">
                        {agent.controlState === "stopping"
                          ? "Stopping"
                          : stopFailed
                            ? "Stop failed"
                            : runtimeHealthLabel(agent.runtimeHealth)}
                      </span>
                    ) : null}
                  </button>
                  {agent.controlState === "stopping" ? null : (
                    <button
                      className="row-action-button agent-row-action"
                      type="button"
                      aria-label={`Stop ${agent.displayName}`}
                      title={stopFailed ? "Retry stop" : "Stop agent"}
                      onClick={() =>
                        dispatch(
                          stopFailed
                            ? { type: "retry_stop_agent", agentId: agent.id }
                            : { type: "stop_agent", agentId: agent.id },
                        )
                      }
                    >
                      <svg
                        viewBox="0 0 14 14"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M4 4l6 6M10 4l-6 6" />
                      </svg>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function ScratchRow({
  snapshot,
  onDispatch,
}: {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
}) {
  const selected = snapshot.selection.context.kind === "global";
  return (
    <button
      className={`sidebar-row scratch-row${selected ? " is-selected" : ""}`}
      type="button"
      aria-current={selected ? "page" : undefined}
      aria-label="Scratch terminal"
      onClick={() =>
        onDispatch({ type: "select_context", context: { kind: "global" } })
      }
    >
      <span className="row-rail" aria-hidden="true" />
      {/* Mirrors a Workspace row's context button so the glyph, the label and
          the trailing inset land on the same columns. */}
      <span className="sidebar-context-button">
        <span className="row-glyph" aria-hidden="true">
          <svg viewBox="0 0 14 14" focusable="false">
            {/* Drawn to the Workspace folder's own ink box — 1.5 to 12.5 of
                the 14-unit viewBox — so the two glyphs share a leading edge
                with no optical correction between them. */}
            <path d="M1.5 3.6 L5.7 7 L1.5 10.4 M7.6 10.4 H12.5" />
          </svg>
        </span>
        <span className="row-label">Scratch</span>
      </span>
    </button>
  );
}

function SidebarResizeHandle({
  width,
  onPreview,
  onCommit,
}: {
  readonly width: number;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const pointerOrigin = useRef<
    { readonly x: number; readonly width: number } | undefined
  >(undefined);
  const previewWidth = useRef(width);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerOrigin.current = { x: event.clientX, width };
    previewWidth.current = width;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const continueResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = pointerOrigin.current;
    if (!origin || !dragging) return;
    const next = clampSidebarWidth(origin.width + event.clientX - origin.x);
    previewWidth.current = next;
    onPreview(next);
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pointerOrigin.current) onCommit(previewWidth.current);
    pointerOrigin.current = undefined;
    setDragging(false);
  };

  const moveByKeyboard = (delta: number) =>
    onCommit(clampSidebarWidth(width + delta));

  useEffect(() => {
    if (!dragging) return undefined;
    document.body.classList.add("is-resizing-sidebar");
    return () => document.body.classList.remove("is-resizing-sidebar");
  }, [dragging]);

  return (
    <div
      className={`sidebar-resize-handle${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={200}
      aria-valuemax={400}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={beginResize}
      onPointerMove={continueResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          moveByKeyboard(-4);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          moveByKeyboard(4);
        } else if (event.key === "Home") {
          event.preventDefault();
          onCommit(200);
        } else if (event.key === "End") {
          event.preventDefault();
          onCommit(400);
        }
      }}
    />
  );
}

export function Sidebar({ snapshot, onDispatch }: SidebarProps) {
  const { dispatch, agentProfiles } = useAppShell();
  // The sidebar draws no modals. Every one of them lives on the overlay layer
  // above the workbench views, so opening one is a request to main and nothing
  // more — there is no local "is it open" to keep in step with anything.
  const openPicker = useCallback(() => {
    void devhub().openModal({ kind: "workspace-picker" });
  }, []);
  // File ▸ Add Workspace… is the same command as the sidebar's +, so it opens
  // the same picker rather than a second way of adding a workspace.
  useEffect(
    () =>
      devhub().onMenuCommand((command) => {
        if (command === "open_workspace_picker") openPicker();
      }),
    [openPicker],
  );
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceTreeRef = useRef<HTMLUListElement>(null);
  const treeFocusId = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const tree = workspaceTreeRef.current;
    if (!tree) return;
    const items = treeContextButtons(tree);
    const previousId = treeFocusId.current;
    const requested = previousId
      ? items.find((item) => item.dataset.treeItemId === previousId)
      : undefined;
    const selected = items.find(
      (item) =>
        item
          .closest<HTMLElement>("[role=treeitem]")
          ?.getAttribute("aria-selected") === "true",
    );
    const target = requested ?? selected ?? items[0];
    setTreeTabStop(tree, target);
    if (!target) {
      treeFocusId.current = undefined;
      return;
    }
    const active = document.activeElement;
    const activeWasRemoved =
      Boolean(previousId) &&
      !requested &&
      (active === document.body || active === tree || tree.contains(active));
    treeFocusId.current = target.dataset.treeItemId;
    if (activeWasRemoved) target.focus();
  }, [snapshot.selection.context, snapshot.workspaces]);

  const [inProgressWidth, setInProgressWidth] = useState<number | null>(null);
  const renderedWidth = inProgressWidth ?? snapshot.sidebar.width;

  const openAgentPicker = useCallback((workspaceId: string) => {
    void devhub().openModal({ kind: "agent-picker", workspaceId });
  }, []);

  const openRename = useCallback((agent: AgentSnapshot) => {
    void devhub().openModal({ kind: "agent-rename", agentId: agent.id });
  }, []);

  /**
   * The row's context menu.
   *
   * One piece of state for the whole tree rather than one per row: only one
   * menu can be open, and saying so here is what makes that true instead of
   * hoping every row closes itself when another opens.
   */
  const [agentMenu, setAgentMenu] = useState<
    | {
        readonly agent: AgentSnapshot;
        readonly at: { x: number; y: number };
      }
    | undefined
  >(undefined);
  const openAgentMenu = useCallback(
    (agent: AgentSnapshot, at: { x: number; y: number }) => {
      setAgentMenu({ agent, at });
    },
    [],
  );
  const closeAgentMenu = useCallback(() => {
    setAgentMenu(undefined);
  }, []);

  const resize = useCallback(
    (width: number) => {
      setInProgressWidth(width);
      void dispatch({ type: "resize_sidebar", width }).finally(() => {
        setInProgressWidth(null);
      });
    },
    [dispatch],
  );

  const previewResize = useCallback((width: number) => {
    setInProgressWidth(width);
  }, []);

  // Collapsed, the Sidebar is the rail — the same navigation at icon width,
  // not an absent pane. Both forms are this component's, so nothing above it
  // has to know there are two.
  if (!snapshot.sidebar.expanded) {
    return (
      <SidebarRail
        snapshot={snapshot}
        onDispatch={onDispatch}
        onAddWorkspace={openPicker}
      />
    );
  }

  return (
    <aside
      className="sidebar"
      aria-label="Workspace navigation"
      style={{ "--sidebar-width": `${renderedWidth}px` } as React.CSSProperties}
    >
      {/* The Sidebar runs the full height of the window, so its own top strip
          is where the window buttons live, where the window is dragged, and
          where the one control left in DevHub's chrome sits. */}
      <SidebarHeader expanded onDispatch={onDispatch} />
      <div className="sidebar-scroll-region">
        <ScratchRow snapshot={snapshot} onDispatch={onDispatch} />
        <div className="sidebar-section-heading">
          <h2>Workspaces</h2>
          <button
            ref={pickerTriggerRef}
            className="section-action-button"
            type="button"
            aria-label="Open workspace picker"
            title="Open workspace picker"
            onClick={openPicker}
          >
            <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path d="M7 3.25v7.5M3.25 7h7.5" />
            </svg>
          </button>
        </div>
        {snapshot.workspaces.length > 0 ? (
          <ul
            ref={workspaceTreeRef}
            className="workspace-tree"
            role="tree"
            aria-label="Open workspaces"
            onFocusCapture={(event) => {
              const button = (
                event.target as HTMLElement
              ).closest<HTMLButtonElement>("[data-tree-item-id]");
              if (!button) return;
              const treeItemId = button.dataset.treeItemId;
              if (!treeItemId) return;
              treeFocusId.current = treeItemId;
              setTreeTabStop(event.currentTarget, button);
            }}
            onKeyDown={(event) => {
              if (
                isImeComposing(event.nativeEvent) ||
                event.target instanceof HTMLInputElement
              ) {
                return;
              }
              const active = event.currentTarget.ownerDocument
                .activeElement as HTMLElement | null;
              const activeItem = active?.closest<HTMLButtonElement>(
                "[data-tree-item-id]",
              );
              if (
                !activeItem ||
                activeItem.parentElement?.closest("[role=dialog]")
              ) {
                return;
              }
              const items = treeContextButtons(event.currentTarget);
              const index = items.indexOf(activeItem);
              if (index < 0) return;
              const focusItem = (
                item: HTMLButtonElement | null | undefined,
              ) => {
                if (!item) return;
                const treeItemId = item.dataset.treeItemId;
                if (!treeItemId) return;
                treeFocusId.current = treeItemId;
                setTreeTabStop(event.currentTarget, item);
                item.focus();
              };
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                focusItem(items[(index + delta + items.length) % items.length]);
                return;
              }
              if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                focusItem(event.key === "Home" ? items[0] : items.at(-1));
                return;
              }
              const item = activeItem.closest<HTMLElement>("[role=treeitem]");
              if (!item) return;
              // Nothing here collapses: a Workspace is always open, so the
              // horizontal keys only walk between a Workspace and its Agents.
              if (event.key === "ArrowRight") {
                const child = item.querySelector<HTMLButtonElement>(
                  ".agent-tree [data-tree-item-id]:not([disabled])",
                );
                if (!child) return;
                event.preventDefault();
                focusItem(child);
                return;
              }
              if (event.key === "ArrowLeft") {
                const parent =
                  item.parentElement?.closest<HTMLElement>("[role=treeitem]");
                if (!parent) return;
                event.preventDefault();
                focusItem(
                  parent.querySelector<HTMLButtonElement>(
                    ":scope > .sidebar-row [data-tree-item-id]",
                  ),
                );
              }
            }}
          >
            {snapshot.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                snapshot={snapshot}
                onDispatch={onDispatch}
                agentProfiles={agentProfiles.profiles}
                agentProfilesAvailability={agentProfiles.availability}
                onCreateAgent={openAgentPicker}
                onRenameAgent={openRename}
                onAgentMenu={openAgentMenu}
              />
            ))}
          </ul>
        ) : (
          <p className="sidebar-empty">No workspaces open</p>
        )}
      </div>
      <SidebarResizeHandle
        width={renderedWidth}
        onPreview={previewResize}
        onCommit={resize}
      />
      {agentMenu ? (
        <RowMenu
          at={agentMenu.at}
          label={`${agentMenu.agent.displayName} actions`}
          items={agentMenuItems(agentMenu.agent, onDispatch, openRename)}
          onDismiss={closeAgentMenu}
        />
      ) : null}
    </aside>
  );
}

/**
 * What a right-click on an Agent offers.
 *
 * Mark as Unread is the only one that is not already a control on the row, and
 * it is here because it is the counterpart to opening one: reading is
 * automatic, and un-reading has to be something you can say.
 */
function agentMenuItems(
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
  if (agent.controlState !== "stopping") {
    items.push({
      id: "stop",
      label: agent.controlState === "stop-failed" ? "Retry Stop" : "Stop Agent",
      run: () => {
        dispatch(
          agent.controlState === "stop-failed"
            ? { type: "retry_stop_agent", agentId: agent.id }
            : { type: "stop_agent", agentId: agent.id },
        );
      },
    });
  }
  return items;
}
