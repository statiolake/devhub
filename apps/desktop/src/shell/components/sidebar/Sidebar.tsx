import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
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
import { isImeComposing } from "../../accessibility/ime";
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
    if (isImeComposing(event)) return;
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
    <li
      className="sidebar-tree-item"
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      aria-expanded={workspace.agents.length > 0 ? expanded : undefined}
    >
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
            <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              <path d="M3.5 1.5 L7 5 L3.5 8.5" />
            </svg>
          </button>
        ) : (
          <span className="disclosure-spacer" aria-hidden="true" />
        )}
        <button
          className="sidebar-context-button"
          type="button"
          data-workspace-id={workspace.id}
          data-tree-item-id={`workspace:${workspace.id}`}
          tabIndex={selected ? 0 : -1}
          aria-current={selected ? "page" : undefined}
          aria-label={`${workspace.label} workspace, path ${workspace.root}, ${statusLabel(workspace.aggregateStatus)} aggregate status`}
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
            <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path d="M7 3.25v7.5M3.25 7h7.5" />
            </svg>
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
              <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <path d="M11 7a4 4 0 1 1-1.2-2.85M11 2.5V5H8.5" />
              </svg>
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
              <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <circle cx="6.4" cy="6.4" r="3.4" />
                <path d="M9 9l2.4 2.4" />
              </svg>
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
            <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path d="M11 7a4 4 0 1 1-1.2-2.85M11 2.5V5H8.5" />
            </svg>
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
            <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path d="M4 4l6 6M10 4l-6 6" />
            </svg>
          </button>
        )}
      </div>
      {workspace.agents.length > 0 && expanded && (
        <ul
          className="agent-tree"
          role="group"
          aria-label={`${workspace.label} agents`}
        >
          {workspace.agents.map((agent) => {
            const agentSelected = selectedAgentId === agent.id;
            return (
              <li
                key={agent.id}
                role="treeitem"
                aria-level={2}
                aria-selected={agentSelected}
              >
                <div
                  className={`sidebar-row agent-row${agentSelected ? " is-selected" : ""}`}
                  data-control-state={agent.controlState}
                >
                  <button
                    className="sidebar-context-button"
                    type="button"
                    data-tree-item-id={`agent:${agent.id}`}
                    tabIndex={agentSelected ? 0 : -1}
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
                    <span className="row-glyph" aria-hidden="true">
                      <svg viewBox="0 0 14 14" focusable="false">
                        <circle cx="7" cy="7" r="4.25" />
                      </svg>
                    </span>
                    <span className="row-label">{agent.displayName}</span>
                    {agent.controlState !== "running" ||
                    agent.runtimeHealth !== "healthy" ? (
                      <span className="row-note">
                        {agent.controlState === "stopping"
                          ? "Stopping"
                          : agent.controlState === "stop-failed"
                            ? "Stop failed"
                            : runtimeHealthLabel(agent.runtimeHealth)}
                      </span>
                    ) : null}
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
                    <svg
                      viewBox="0 0 14 14"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M9.4 2.9 11.1 4.6 5 10.7 2.9 11.1 3.3 9z" />
                    </svg>
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
                      <svg
                        viewBox="0 0 14 14"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M11 7a4 4 0 1 1-1.2-2.85M11 2.5V5H8.5" />
                      </svg>
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
                      <svg
                        viewBox="0 0 14 14"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M11 7a4 4 0 1 1-1.2-2.85M11 2.5V5H8.5" />
                      </svg>
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
      <span className="disclosure-spacer" aria-hidden="true" />
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
  const pickerCompositionActive = useRef(false);
  const renameCompositionActive = useRef(false);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const workspacePickerRef = useRef<HTMLElement>(null);
  const agentPickerRef = useRef<HTMLElement>(null);
  const renameDialogRef = useRef<HTMLElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const workspaceTreeRef = useRef<HTMLUListElement>(null);
  const treeFocusId = useRef<string | undefined>(undefined);
  const pendingTreeChildFocus = useRef<string | undefined>(undefined);
  const focusRestoreGeneration = useRef(0);
  const pendingFocusRestore = useRef<HTMLElement | null>(null);
  const agentPickerPreviousFocus = useRef<HTMLElement | null>(null);
  const renamePreviousFocus = useRef<HTMLElement | null>(null);
  const rankedCandidates = useMemo(
    () => [...pickerCandidates].sort((left, right) => right.score - left.score),
    [pickerCandidates],
  );

  useLayoutEffect(() => {
    const tree = workspaceTreeRef.current;
    if (!tree) return;
    const items = treeContextButtons(tree);
    if (pendingTreeChildFocus.current) {
      const workspaceButton = items.find(
        (item) => item.dataset.treeItemId === pendingTreeChildFocus.current,
      );
      const child = workspaceButton
        ?.closest<HTMLElement>("[role=treeitem]")
        ?.querySelector<HTMLButtonElement>(
          ".agent-tree [data-tree-item-id]:not([disabled])",
        );
      if (child) {
        pendingTreeChildFocus.current = undefined;
        treeFocusId.current = child.dataset.treeItemId;
        setTreeTabStop(tree, child);
        child.focus();
        return;
      }
    }
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
  }, [
    snapshot.selection.context,
    snapshot.sidebar.expandedWorkspaceIds,
    snapshot.workspaces,
  ]);

  const modalOpen =
    pickerOpen || Boolean(agentPickerWorkspaceId) || Boolean(renameTarget);

  useEffect(() => {
    const content = document.querySelector<HTMLElement>(".app-shell-content");
    if (!content) return undefined;
    content.inert = modalOpen;
    return () => {
      content.inert = false;
    };
  }, [modalOpen]);

  useEffect(() => {
    if (modalOpen || !pendingFocusRestore.current) return;
    const generation = focusRestoreGeneration.current;
    const target = pendingFocusRestore.current;
    pendingFocusRestore.current = null;
    const restore = () => {
      if (generation !== focusRestoreGeneration.current) return;
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        active !== document.body &&
        !active.closest("[role='dialog']")
      ) {
        return;
      }
      const inertContent =
        target?.closest<HTMLElement>(".app-shell-content") ??
        document.querySelector<HTMLElement>(".app-shell-content");
      // This effect only runs after modalOpen became false. Clear a stale
      // property left by browsers that do not reflect inert removal promptly.
      if (inertContent?.inert) inertContent.inert = false;
      const candidate =
        target &&
        target.isConnected &&
        !target.hasAttribute("disabled") &&
        !(target.closest<HTMLElement>("[inert]")?.inert ?? false)
          ? target
          : document.querySelector<HTMLElement>(
              '[aria-label="Workspace navigation"] .section-action-button:not([disabled]), [aria-label="Workspace navigation"] [data-tree-item-id]:not([disabled])[tabindex="0"], [aria-label="Workspace navigation"] button:not([disabled]), .activity-segments button:not([disabled])',
            );
      candidate?.focus();
    };
    queueMicrotask(restore);
  }, [modalOpen]);

  const scheduleFocusRestore = useCallback(
    (target: HTMLElement | null | undefined) => {
      focusRestoreGeneration.current += 1;
      pendingFocusRestore.current = target ?? null;
    },
    [],
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
    pickerCompositionActive.current = false;
    scheduleFocusRestore(pickerTriggerRef.current);
  }, [scheduleFocusRestore]);

  const closeAgentPicker = useCallback(() => {
    setAgentPickerWorkspaceId(undefined);
    pickerCompositionActive.current = false;
    const previous = agentPickerPreviousFocus.current;
    scheduleFocusRestore(previous);
    agentPickerPreviousFocus.current = null;
  }, [scheduleFocusRestore]);

  const closeRename = useCallback(() => {
    setRenameBusy(false);
    setRenameError(false);
    renameCompositionActive.current = false;
    setRenameTarget(undefined);
    const previous = renamePreviousFocus.current;
    scheduleFocusRestore(previous);
    renamePreviousFocus.current = null;
  }, [scheduleFocusRestore]);

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
      {/* The Sidebar runs the full height of the window, so its own top strip
          is where the window buttons live and where the window is dragged. */}
      <div className="sidebar-titlebar" />
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
            <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path d="M7 3.25v7.5M3.25 7h7.5" />
            </svg>
          </button>
        </div>
        {pickerOpen && typeof document !== "undefined"
          ? createPortal(
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
                    onCompositionStart={() => {
                      pickerCompositionActive.current = true;
                    }}
                    onCompositionEnd={() => {
                      pickerCompositionActive.current = false;
                    }}
                    onChange={(event) => setPickerQuery(event.target.value)}
                    onKeyDown={(event) => {
                      const composing = isImeComposing(
                        event.nativeEvent,
                        pickerCompositionActive.current,
                      );
                      if (
                        composing &&
                        (event.key === "Enter" || event.key === "Escape")
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      if (
                        !composing &&
                        event.key === "Enter" &&
                        rankedCandidates[0]
                      ) {
                        finishPickerAction(() =>
                          selectWorkspacePicker(rankedCandidates[0].path),
                        );
                      }
                      if (event.key === "Escape" && !composing) {
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
              </section>,
              document.body,
            )
          : null}
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
              if (event.key === "ArrowRight") {
                const disclosure =
                  item.querySelector<HTMLButtonElement>(".disclosure-button");
                const child = item.querySelector<HTMLButtonElement>(
                  ".agent-tree [data-tree-item-id]",
                );
                if (!disclosure) return;
                event.preventDefault();
                if (disclosure.getAttribute("aria-expanded") !== "true") {
                  pendingTreeChildFocus.current = activeItem.dataset.treeItemId;
                  disclosure.click();
                  window.requestAnimationFrame(() => {
                    const next = item.querySelector<HTMLButtonElement>(
                      ".agent-tree [data-tree-item-id]",
                    );
                    focusItem(next);
                  });
                } else if (child) {
                  focusItem(child);
                }
                return;
              }
              if (event.key === "ArrowLeft") {
                const parent =
                  item.parentElement?.closest<HTMLElement>("[role=treeitem]");
                if (parent) {
                  event.preventDefault();
                  focusItem(
                    parent.querySelector<HTMLButtonElement>(
                      ":scope > .sidebar-row [data-tree-item-id]",
                    ),
                  );
                  return;
                }
                const disclosure =
                  item.querySelector<HTMLButtonElement>(".disclosure-button");
                if (disclosure?.getAttribute("aria-expanded") === "true") {
                  event.preventDefault();
                  disclosure.click();
                }
              }
            }}
          >
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
      {agentPickerWorkspaceId && typeof document !== "undefined"
        ? createPortal(
            <section
              ref={agentPickerRef}
              className="agent-profile-picker"
              role="dialog"
              aria-modal="true"
              aria-labelledby="agent-profile-picker-title"
            >
              <div className="agent-profile-picker-card">
                <h2 id="agent-profile-picker-title">New Agent</h2>
                <p>
                  Select an enabled profile to launch at the workspace root.
                </p>
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
            </section>,
            document.body,
          )
        : null}
      {renameTarget && typeof document !== "undefined"
        ? createPortal(
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
                  if (renameCompositionActive.current) return;
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
                    onCompositionStart={() => {
                      renameCompositionActive.current = true;
                    }}
                    onCompositionEnd={() => {
                      renameCompositionActive.current = false;
                    }}
                    onKeyDown={(event) => {
                      if (
                        isImeComposing(
                          event.nativeEvent,
                          renameCompositionActive.current,
                        )
                      ) {
                        if (
                          event.key === "Enter" ||
                          event.key === "NumpadEnter" ||
                          event.key === "Escape"
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                        return;
                      }
                    }}
                    onChange={(event) => setRenameValue(event.target.value)}
                  />
                </label>
                {renameError && (
                  <p className="surface-inline-alert" role="alert">
                    Rename could not be completed. Try again.
                  </p>
                )}
                <div className="confirmation-actions">
                  <button
                    type="button"
                    onClick={closeRename}
                    disabled={renameBusy}
                  >
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
            </section>,
            document.body,
          )
        : null}
      <SidebarResizeHandle
        width={renderedWidth}
        onPreview={previewResize}
        onCommit={resize}
      />
    </aside>
  );
}
