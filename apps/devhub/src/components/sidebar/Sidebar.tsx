import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  type AppIntent,
  type AppSnapshot,
  type WorkspaceSnapshot,
} from "../../generated/app-shell";
import { clampSidebarWidth } from "../../app/client";
import { useAppShell } from "../../app/useAppShell";
import { StatusMark } from "./StatusMark";
import { statusLabel } from "./status";

export interface SidebarProps {
  readonly snapshot: AppSnapshot;
}

function WorkspaceRow({
  workspace,
  snapshot,
  onDispatch,
  chooseWorkspaceFolder,
}: {
  readonly workspace: WorkspaceSnapshot;
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
  readonly chooseWorkspaceFolder: () => Promise<string | undefined>;
}) {
  const selected =
    snapshot.selection.context.kind === "workspace" &&
    snapshot.selection.context.workspaceId === workspace.id;
  const selectedAgentId =
    snapshot.selection.context.kind === "agent"
      ? snapshot.selection.context.agentId
      : undefined;
  const expanded = snapshot.sidebar.expandedWorkspaceIds.includes(workspace.id);

  const dispatch = useCallback(
    (intent: AppIntent) => onDispatch(intent),
    [onDispatch],
  );

  return (
    <li className="sidebar-tree-item">
      <div
        className={`sidebar-row workspace-row${selected ? " is-selected" : ""}`}
        data-state={workspace.state}
      >
        {workspace.agents.length > 0 ? (
          <button
            className="disclosure-button"
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${workspace.label} agents`}
            aria-expanded={expanded}
            onClick={() =>
              dispatch({
                type: "toggle_workspace_disclosure",
                workspaceId: workspace.id,
                expanded: !expanded,
              })
            }
          >
            <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
          </button>
        ) : null}
        <button
          className="sidebar-context-button"
          type="button"
          aria-current={selected ? "page" : undefined}
          aria-label={`${workspace.label} workspace`}
          onClick={() =>
            dispatch({
              type: "select_context",
              context: { kind: "workspace", workspaceId: workspace.id },
            })
          }
        >
          <span className="workspace-glyph" aria-hidden="true">
            ▫
          </span>
          <span className="sidebar-row-copy">
            <span className="sidebar-row-label">{workspace.label}</span>
            <span className="sidebar-row-detail">{workspace.root}</span>
          </span>
          {workspace.agents.length > 0 && (
            <StatusMark status={workspace.aggregateStatus} compact />
          )}
        </button>
        {workspace.canCreateAgent && (
          <button
            className="row-action-button"
            type="button"
            aria-label={`Create agent in ${workspace.label}, unavailable`}
            title="Agent profile selection is not available yet"
            disabled
          >
            <span aria-hidden="true">＋</span>
          </button>
        )}
        {workspace.state === "unavailable" && (
          <>
            <button
              className="row-action-button"
              type="button"
              aria-label={`Retry ${workspace.label}`}
              title="Retry workspace"
              onClick={() =>
                dispatch({ type: "retry_workspace", workspaceId: workspace.id })
              }
            >
              ↻
            </button>
            <button
              className="row-action-button"
              type="button"
              aria-label={`Locate ${workspace.label}`}
              title="Locate workspace"
              onClick={() => {
                void chooseWorkspaceFolder().then((path) => {
                  if (path)
                    dispatch({
                      type: "locate_workspace",
                      workspaceId: workspace.id,
                      path,
                    });
                });
              }}
            >
              ⌕
            </button>
          </>
        )}
        {workspace.state === "closing-failed" && (
          <button
            className="row-action-button"
            type="button"
            aria-label={`Retry closing ${workspace.label}`}
            title="Retry close"
            onClick={() =>
              dispatch({
                type: "retry_close_workspace",
                workspaceId: workspace.id,
              })
            }
          >
            ↻
          </button>
        )}
        {workspace.state !== "closing" && (
          <button
            className="row-action-button"
            type="button"
            aria-label={`Close ${workspace.label}`}
            title="Close workspace"
            onClick={() =>
              dispatch({
                type: "request_close_workspace",
                workspaceId: workspace.id,
              })
            }
          >
            ×
          </button>
        )}
      </div>
      {workspace.agents.length > 0 && expanded && (
        <ul className="agent-tree" aria-label={`${workspace.label} agents`}>
          {workspace.agents.map((agent) => {
            const agentSelected = selectedAgentId === agent.id;
            return (
              <li key={agent.id}>
                <button
                  className={`sidebar-row agent-row${agentSelected ? " is-selected" : ""}`}
                  type="button"
                  aria-current={agentSelected ? "page" : undefined}
                  aria-label={`${agent.displayName}, ${statusLabel(agent.status)} agent`}
                  onClick={() =>
                    dispatch({
                      type: "select_context",
                      context: { kind: "agent", agentId: agent.id },
                    })
                  }
                >
                  <span className="agent-branch" aria-hidden="true">
                    └
                  </span>
                  <span className="agent-glyph" aria-hidden="true">
                    ◇
                  </span>
                  <span className="sidebar-row-copy">
                    <span className="sidebar-row-label">
                      {agent.displayName}
                    </span>
                    <span className="sidebar-row-detail">
                      {agent.runtimeHealth === "healthy"
                        ? "Connected"
                        : agent.runtimeHealth}
                    </span>
                  </span>
                  <StatusMark status={agent.status} compact />
                </button>
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
      <span className="scratch-glyph" aria-hidden="true">
        ⌁
      </span>
      <span className="sidebar-row-copy">
        <span className="sidebar-row-label">Scratch</span>
        <span className="sidebar-row-detail">Global terminal</span>
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

export function Sidebar({ snapshot }: SidebarProps) {
  const {
    dispatch,
    pickerCandidates,
    pickerBusy,
    startWorkspacePicker,
    cancelWorkspacePicker,
    selectWorkspacePicker,
    chooseWorkspaceFolder,
  } = useAppShell();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const rankedCandidates = useMemo(
    () => [...pickerCandidates].sort((left, right) => right.score - left.score),
    [pickerCandidates],
  );

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const timer = window.setTimeout(() => {
      void cancelWorkspacePicker().then(() =>
        startWorkspacePicker(pickerQuery),
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [cancelWorkspacePicker, pickerOpen, pickerQuery, startWorkspacePicker]);
  const [inProgressWidth, setInProgressWidth] = useState<number | null>(null);
  const renderedWidth = inProgressWidth ?? snapshot.sidebar.width;

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    pickerTriggerRef.current?.focus();
  }, []);

  const finishPickerAction = useCallback(
    (action?: () => Promise<unknown>) => {
      void cancelWorkspacePicker()
        .then(() => action?.())
        .catch(() => undefined)
        .finally(closePicker);
    },
    [cancelWorkspacePicker, closePicker],
  );

  const onDispatch = useCallback(
    (intent: AppIntent) => {
      void dispatch(intent);
    },
    [dispatch],
  );

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
            onClick={() => {
              setPickerOpen(true);
            }}
          >
            <span aria-hidden="true">＋</span>
          </button>
        </div>
        {pickerOpen && (
          <section className="workspace-picker" aria-label="Workspace picker">
            <div className="workspace-picker-header">
              <input
                autoFocus
                aria-label="Filter workspaces"
                placeholder="Filter workspaces"
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && rankedCandidates[0]) {
                    finishPickerAction(() =>
                      selectWorkspacePicker(rankedCandidates[0].path),
                    );
                  }
                  if (event.key === "Escape") {
                    finishPickerAction();
                  }
                }}
              />
              <button type="button" onClick={() => finishPickerAction()}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  finishPickerAction(async () => {
                    const path = await chooseWorkspaceFolder();
                    if (path) await selectWorkspacePicker(path);
                  })
                }
              >
                Open Folder…
              </button>
            </div>
            <div className="workspace-picker-results" aria-live="polite">
              {rankedCandidates.map((candidate) => (
                <button
                  type="button"
                  className="workspace-picker-result"
                  key={`${candidate.operationId}:${candidate.path}`}
                  onClick={() =>
                    finishPickerAction(() =>
                      selectWorkspacePicker(candidate.path),
                    )
                  }
                >
                  <span>{candidate.label}</span>
                  <small>{candidate.path}</small>
                </button>
              ))}
              {!pickerBusy && pickerCandidates.length === 0 && (
                <p>No workspaces found.</p>
              )}
              {pickerBusy && (
                <p role="status">Searching configured locations…</p>
              )}
            </div>
          </section>
        )}
        {snapshot.workspaces.length > 0 ? (
          <ul className="workspace-tree" aria-label="Open workspaces">
            {snapshot.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                snapshot={snapshot}
                onDispatch={onDispatch}
                chooseWorkspaceFolder={chooseWorkspaceFolder}
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
    </aside>
  );
}
