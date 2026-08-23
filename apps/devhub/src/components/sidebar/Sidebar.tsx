import {
  useCallback,
  useEffect,
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
} from "../../generated/app-shell";
import { clampSidebarWidth } from "../../app/client";
import { useAppShell } from "../../app/useAppShell";
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
}

function dialogFocusables(dialog: HTMLElement): HTMLElement[] {
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ),
  ];
}

function trapDialogKey(
  event: KeyboardEvent,
  dialog: HTMLElement | null,
  onEscape: () => void,
): void {
  if (event.key === "Escape") {
    // Escape during IME composition belongs to the text composition, not the
    // modal lifecycle.
    if (event.isComposing) return;
    event.preventDefault();
    onEscape();
    return;
  }
  if (event.key !== "Tab" || !dialog) return;
  const focusables = dialogFocusables(dialog);
  if (focusables.length === 0) return;
  const index = focusables.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey
    ? index <= 0
      ? focusables.length - 1
      : index - 1
    : (index + 1) % focusables.length;
  event.preventDefault();
  focusables[next]?.focus();
}

function WorkspaceRow({
  workspace,
  snapshot,
  onDispatch,
  chooseWorkspaceFolder,
  agentProfiles,
  agentProfilesAvailability,
  onCreateAgent,
  onRenameAgent,
}: {
  readonly workspace: WorkspaceSnapshot;
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
  readonly chooseWorkspaceFolder: () => Promise<string | undefined>;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agentProfilesAvailability: AgentProfilesAvailabilityWire;
  readonly onCreateAgent: (workspaceId: string) => void;
  readonly onRenameAgent: (agent: AgentSnapshot) => void;
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
          data-workspace-id={workspace.id}
          aria-current={selected ? "page" : undefined}
          aria-label={`${workspace.label} workspace, ${statusLabel(workspace.aggregateStatus)} aggregate status`}
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
                <div
                  className={`sidebar-row agent-row${agentSelected ? " is-selected" : ""}`}
                  data-control-state={agent.controlState}
                >
                  <button
                    className="sidebar-context-button"
                    type="button"
                    aria-current={agentSelected ? "page" : undefined}
                    aria-label={`${agent.displayName}, ${statusLabel(agent.status)} agent, ${agent.controlState === "stopping" ? "Stopping" : agent.controlState === "stop-failed" ? "Stop failed" : runtimeHealthLabel(agent.runtimeHealth)}`}
                    disabled={agent.controlState === "stopping"}
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
                        {agent.controlState === "stopping"
                          ? "Stopping"
                          : agent.controlState === "stop-failed"
                            ? "Stop failed"
                            : runtimeHealthLabel(agent.runtimeHealth)}
                      </span>
                    </span>
                    <StatusMark status={agent.status} compact />
                  </button>
                  <button
                    className="row-action-button agent-row-action"
                    type="button"
                    aria-label="Rename agent"
                    title="Rename agent"
                    disabled={agent.controlState === "stopping"}
                    onClick={() => onRenameAgent(agent)}
                  >
                    <span aria-hidden="true">✎</span>
                  </button>
                  {agent.runtimeHealth !== "healthy" &&
                  agent.controlState !== "stopping" ? (
                    <button
                      className="row-action-button agent-row-action"
                      type="button"
                      aria-label="Reconcile agent"
                      title="Retry Agent runtime reconciliation"
                      onClick={() =>
                        dispatch({
                          type: "reconcile_agent",
                          agentId: agent.id,
                        })
                      }
                    >
                      <span aria-hidden="true">↻</span>
                    </button>
                  ) : null}
                  {agent.controlState === "stop-failed" ? (
                    <button
                      className="row-action-button agent-row-action"
                      type="button"
                      aria-label="Retry stopping agent"
                      title="Retry stop"
                      onClick={() =>
                        dispatch({
                          type: "retry_stop_agent",
                          agentId: agent.id,
                        })
                      }
                    >
                      <span aria-hidden="true">↻</span>
                    </button>
                  ) : agent.controlState === "stopping" ? null : (
                    <button
                      className="row-action-button agent-row-action"
                      type="button"
                      aria-label="Stop agent"
                      title="Stop agent"
                      onClick={() =>
                        dispatch({ type: "stop_agent", agentId: agent.id })
                      }
                    >
                      <span aria-hidden="true">×</span>
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
    agentProfiles,
    pickerCandidates,
    pickerBusy,
    startWorkspacePicker,
    cancelWorkspacePicker,
    selectWorkspacePicker,
    chooseWorkspaceFolder,
  } = useAppShell();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [agentPickerWorkspaceId, setAgentPickerWorkspaceId] = useState<
    string | undefined
  >();
  const [renameTarget, setRenameTarget] = useState<AgentSnapshot>();
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState(false);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const workspacePickerRef = useRef<HTMLElement>(null);
  const agentPickerRef = useRef<HTMLElement>(null);
  const renameDialogRef = useRef<HTMLElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const agentPickerPreviousFocus = useRef<HTMLElement | null>(null);
  const renamePreviousFocus = useRef<HTMLElement | null>(null);
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

  const closeAgentPicker = useCallback(() => {
    setAgentPickerWorkspaceId(undefined);
    agentPickerPreviousFocus.current?.focus();
    agentPickerPreviousFocus.current = null;
  }, []);

  const closeRename = useCallback(() => {
    setRenameBusy(false);
    setRenameError(false);
    setRenameTarget(undefined);
    renamePreviousFocus.current?.focus();
    renamePreviousFocus.current = null;
  }, []);

  useEffect(() => {
    if (!renameTarget) return;
    const current = snapshot.workspaces
      .flatMap((workspace) => workspace.agents)
      .find((agent) => agent.id === renameTarget.id);
    if (!current || current.controlState !== "running") closeRename();
  }, [closeRename, renameTarget, snapshot.workspaces]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const input = workspacePickerRef.current?.querySelector<HTMLElement>(
      "input, button, [tabindex='0']",
    );
    input?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      trapDialogKey(event, workspacePickerRef.current, closePicker);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closePicker, pickerOpen]);

  useEffect(() => {
    if (!agentPickerWorkspaceId) return undefined;
    const first = agentPickerRef.current?.querySelector<HTMLElement>(
      "button, [tabindex='0']",
    );
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      trapDialogKey(event, agentPickerRef.current, closeAgentPicker);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [agentPickerWorkspaceId, closeAgentPicker]);

  useEffect(() => {
    if (!renameTarget) return undefined;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
    const onKeyDown = (event: KeyboardEvent) => {
      trapDialogKey(event, renameDialogRef.current, closeRename);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeRename, renameTarget]);

  const openAgentPicker = useCallback((workspaceId: string) => {
    agentPickerPreviousFocus.current = document.activeElement as HTMLElement;
    setAgentPickerWorkspaceId(workspaceId);
  }, []);

  const openRename = useCallback((agent: AgentSnapshot) => {
    renamePreviousFocus.current = document.activeElement as HTMLElement;
    setRenameValue(agent.displayName);
    setRenameError(false);
    setRenameTarget(agent);
  }, []);

  const submitRename = useCallback(async () => {
    const agent = renameTarget;
    const displayName = renameValue.trim();
    if (
      !agent ||
      displayName.length === 0 ||
      agent.controlState !== "running" ||
      renameBusy
    )
      return;
    setRenameBusy(true);
    setRenameError(false);
    const outcome = await dispatch({
      type: "rename_agent",
      agentId: agent.id,
      displayName,
    });
    setRenameBusy(false);
    if (outcome) closeRename();
    else setRenameError(true);
  }, [closeRename, dispatch, renameBusy, renameTarget, renameValue]);

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
          <section
            ref={workspacePickerRef}
            className="workspace-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-picker-title"
          >
            <div className="workspace-picker-header">
              <h2 id="workspace-picker-title">Open workspace</h2>
              <input
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
                  if (
                    event.key === "Escape" &&
                    !event.nativeEvent.isComposing
                  ) {
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
                agentProfiles={agentProfiles.profiles}
                agentProfilesAvailability={agentProfiles.availability}
                onCreateAgent={openAgentPicker}
                onRenameAgent={openRename}
              />
            ))}
          </ul>
        ) : (
          <p className="sidebar-empty">No workspaces open</p>
        )}
      </div>
      {agentPickerWorkspaceId && (
        <section
          ref={agentPickerRef}
          className="agent-profile-picker"
          role="dialog"
          aria-modal="true"
          aria-labelledby="agent-profile-picker-title"
        >
          <div className="agent-profile-picker-card">
            <h2 id="agent-profile-picker-title">New Agent</h2>
            <p>Select an enabled profile to launch at the workspace root.</p>
            {agentProfiles.profiles.length > 0 ? (
              <div className="agent-profile-options">
                {agentProfiles.profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => {
                      onDispatch({
                        type: "request_create_agent",
                        workspaceId: agentPickerWorkspaceId,
                        profileId: profile.id,
                      });
                      closeAgentPicker();
                    }}
                  >
                    <span>{profile.displayName}</span>
                    <small>
                      {profile.kind === "codex" ? "Codex" : "Claude"}
                    </small>
                  </button>
                ))}
              </div>
            ) : (
              <p role="status">
                {agentProfiles.availability === "unavailable"
                  ? "Agent profiles are unavailable. Try again after configuration is restored."
                  : "No enabled Agent profiles are available."}
              </p>
            )}
            {agentProfiles.availability === "degraded" && (
              <p role="status">
                Profile configuration needs attention; these are the last
                confirmed choices.
              </p>
            )}
            <button type="button" onClick={closeAgentPicker}>
              Cancel
            </button>
          </div>
        </section>
      )}
      {renameTarget && (
        <section
          ref={renameDialogRef}
          className="agent-profile-picker"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-agent-title"
        >
          <form
            className="agent-profile-picker-card"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <h2 id="rename-agent-title">Rename Agent</h2>
            <label>
              Display name
              <input
                ref={renameInputRef}
                value={renameValue}
                maxLength={256}
                aria-invalid={renameError}
                disabled={renameBusy}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </label>
            {renameError && (
              <p className="surface-inline-alert" role="alert">
                Rename could not be completed. Try again.
              </p>
            )}
            <div className="confirmation-actions">
              <button type="button" onClick={closeRename} disabled={renameBusy}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  renameBusy ||
                  renameValue.trim().length === 0 ||
                  renameTarget.controlState !== "running"
                }
              >
                {renameBusy ? "Renaming…" : "Rename"}
              </button>
            </div>
          </form>
        </section>
      )}
      <SidebarResizeHandle
        width={renderedWidth}
        onPreview={previewResize}
        onCommit={resize}
      />
    </aside>
  );
}
