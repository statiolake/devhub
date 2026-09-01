import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import type { WorkspaceRepositoryWire } from "../../../ipc/contract";
import { useAppShell } from "../../useAppShell";
import { devhub } from "../../client";
import { isImeComposing } from "../../accessibility/ime";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { SidebarHeader } from "./SidebarHeader";
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
  repository,
  snapshot,
  onDispatch,
  agentProfiles,
  agentProfilesAvailability,
  onCreateAgent,
  onRenameAgent,
  onAgentMenu,
}: {
  readonly workspace: WorkspaceSnapshot;
  /** What it is working on, as of the last look. Absent until the first one. */
  readonly repository: WorkspaceRepositoryWire | undefined;
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
          {/* What it is working on, in the order a person reads it: which
              branch, then what that branch is for. Both are dimmed, because
              the row is still named by the workspace. */}
          {repository?.branch ? (
            <span className="row-branch">{repository.branch}</span>
          ) : null}
          {repository?.issue ? (
            <span className="row-issue">{repository.issue.title}</span>
          ) : null}
        </button>
        {/* The links trail the label rather than leading it, which is the one
            place this differs from the sketch: they are buttons, a button
            cannot go inside the row's own button, and putting them before it
            would move the glyph column that every other row lines up with. */}
        {repository?.issue ? <IssueLinks repository={repository} /> : null}
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
                    // Command-click opens the Agent beside its workbench; a
                    // plain click gives it the whole content area. The same
                    // pair as Return and Command-Return in the picker, because
                    // it is the same choice, and it is stated in the intent
                    // rather than applied afterwards.
                    onClick={(event) =>
                      dispatch({
                        type: "select_context",
                        context: { kind: "agent", agentId: agent.id },
                        split: event.metaKey,
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

/**
 * The Issue this workspace is for, and the pull request that says it closes
 * it, as two marks that open GitHub.
 *
 * They are marks rather than words because the row already has words. What
 * each one says is its colour and its shape — GitHub's own: an open issue is
 * green and a closed one purple, an open pull request is green and a draft is
 * grey — and what it says in full is in its label, for anyone who cannot use
 * either.
 */
function IssueLinks({
  repository,
}: {
  readonly repository: WorkspaceRepositoryWire;
}) {
  const { openExternalUrl } = useAppShell();
  const issue = repository.issue;
  if (!issue) return null;
  const pullRequest = repository.pullRequest;
  return (
    <>
      {pullRequest ? (
        <button
          className={`row-link-button is-${pullRequest.state}`}
          type="button"
          aria-label={`Pull request #${String(pullRequest.number)}, ${pullRequest.state}`}
          title={`Pull request #${String(pullRequest.number)} (${pullRequest.state})`}
          onClick={() => {
            openExternalUrl(pullRequest.url);
          }}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            <circle cx="4" cy="10.4" r="1.6" />
            <circle cx="4" cy="3.6" r="1.6" />
            <circle cx="10" cy="10.4" r="1.6" />
            <path d="M4 5.2v3.6M10 8.8V5.2a1.6 1.6 0 0 0-1.6-1.6H6.4" />
          </svg>
        </button>
      ) : null}
      <button
        className={`row-link-button is-${issue.state}`}
        type="button"
        aria-label={`Issue #${String(issue.number)}, ${issue.state}: ${issue.title}`}
        title={`Issue #${String(issue.number)} (${issue.state})`}
        onClick={() => {
          openExternalUrl(issue.url);
        }}
      >
        <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="4.6" />
          <circle cx="7" cy="7" r="1.4" />
        </svg>
      </button>
    </>
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
  const { dispatch, agentProfiles, repositoryStatus } = useAppShell();
  const repositories = useMemo(
    () =>
      new Map(
        repositoryStatus.workspaces.map((entry) => [entry.workspaceId, entry]),
      ),
    [repositoryStatus],
  );
  // The sidebar draws no modals. Every one of them lives on the overlay layer
  // above the workbench views, so opening one is a request to main and nothing
  // more — there is no local "is it open" to keep in step with anything.
  const openPicker = useCallback(() => {
    void devhub().openModal({ kind: "workspace-picker" });
  }, []);
  // Assigning an Issue is a way of starting work, so it stands beside the way
  // of opening one — same heading, same kind of request to main, and the
  // wizard it opens is drawn on the same layer as every other modal.
  const openIssueAssignment = useCallback(() => {
    void devhub().openModal({ kind: "issue-assignment" });
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

  return (
    <aside
      className="sidebar"
      aria-label="Workspace navigation"
      style={{ "--sidebar-width": `${renderedWidth}px` } as React.CSSProperties}
    >
      {/* The Sidebar runs the full height of the window, so its own top strip
          is where the window buttons live and where the window is dragged. */}
      <SidebarHeader />
      <div className="sidebar-scroll-region">
        <ScratchRow snapshot={snapshot} onDispatch={onDispatch} />
        <div className="sidebar-section-heading">
          <h2>Workspaces</h2>
          {/* The two ways to start work, kept together at the trailing edge:
              open a workspace you have, or take an Issue and let DevHub make
              one. */}
          <span className="sidebar-section-actions">
            <button
              className="section-action-button"
              type="button"
              aria-label="Assign issue"
              title="Assign issue"
              onClick={openIssueAssignment}
            >
              {/* An issue: a circle with a bar and a dot, the way GitHub draws
                one, so the row and this button say the same thing. */}
              <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <circle cx="7" cy="7" r="4.6" />
                <path d="M7 4.6v2.6M7 9.2v.3" />
              </svg>
            </button>
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
          </span>
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
                repository={repositories.get(workspace.id)}
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
        {/* Why what is on the rows may be out of date. It stands beside what
            is still known rather than replacing it, and it goes when a later
            look succeeds — a network that dropped must not read as an issue
            that closed. */}
        {repositoryStatus.diagnostic ? (
          <p className="sidebar-status-note" role="status">
            {repositoryStatus.diagnostic}
          </p>
        ) : null}
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
