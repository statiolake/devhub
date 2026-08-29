import {
  activeActivitySnapshot,
  type AppAppearance,
  type AppError,
  type AppSnapshot,
  type WorkspaceSnapshot,
  workspaceForContext,
} from "../../generated/app-shell";
import { type ReactNode, type Ref, useEffect, useMemo } from "react";
import { EditorFrame } from "../../editor/EditorFrame";
import { TerminalSurface } from "../../terminal/TerminalSurface";
import { attachableSurfaces, editorSurfaces } from "./surfacePool";
import { disabledReasonLabel } from "./activityPresentation";
import { Failure, Waiting } from "./SurfaceState";
import { useAppShell } from "../../app/useAppShell";

export interface SurfaceViewportProps {
  readonly snapshot: AppSnapshot;
  readonly intentError?: AppError;
  readonly appearance?: AppAppearance;
  readonly surfaceRef?: Ref<HTMLElement>;
}

function InlineIntentError({
  message,
  detail,
  onDismiss,
}: {
  readonly message: string;
  readonly detail?: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="surface-inline-alert" role="alert">
      <span className="surface-inline-alert-mark" aria-hidden="true">
        !
      </span>
      <span className="surface-inline-alert-message">
        {message}
        {/* The summary says what to do; the detail says what happened. */}
        {detail ? (
          <span className="surface-inline-alert-detail">{detail}</span>
        ) : null}
      </span>
      {/* The alert covers the top of the Surface and nothing else retires it,
          so the user needs a way to put it away once they have read it. */}
      <button
        className="surface-inline-alert-close"
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The states around the Editor: everything before there is a server to draw
 * against. The Editors themselves are drawn by the pool, one per Workspace, so
 * a working one contributes nothing here.
 *
 * The server is asked for the first time the Editor is visited — nothing
 * starts a VS Code Server for a user who never opens one.
 */
function SurfaceEditorState() {
  const { editorRemote, editorFailure, ensureEditorRemote } = useAppShell();
  useEffect(() => {
    ensureEditorRemote();
  }, [ensureEditorRemote]);
  if (editorFailure) {
    return (
      <Failure
        summary={editorFailure.summary}
        detail={editorFailure.detail ?? undefined}
      />
    );
  }
  return editorRemote ? null : <Waiting label="Starting the editor server…" />;
}

/** The states around a running Agent. The Agent itself is drawn by the pool,
 * so a running one contributes nothing here. */
function SurfaceAgent({
  snapshot,
  workspace,
}: {
  readonly snapshot: AppSnapshot;
  readonly workspace?: WorkspaceSnapshot;
}) {
  const agentId =
    snapshot.selection.context.kind === "agent"
      ? snapshot.selection.context.agentId
      : undefined;
  const agent = workspace?.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return <Failure summary="This Agent is no longer available." />;
  }
  if (agent.controlState !== "running") {
    return agent.controlState === "stopping" ? (
      <Waiting label="Stopping the agent…" />
    ) : (
      <Failure summary="This Agent could not be stopped. Retry stop from the Sidebar." />
    );
  }
  return null;
}

export function SurfaceViewport({
  snapshot,
  intentError,
  appearance,
  surfaceRef,
}: SurfaceViewportProps) {
  const {
    recordPerformanceMarker,
    dispatch,
    chooseWorkspaceFolder,
    dismissIntentError,
    editorRemote,
  } = useAppShell();
  const activity = snapshot.selection.activity;
  const activitySnapshot = activeActivitySnapshot(snapshot);
  const workspace = workspaceForContext(snapshot, snapshot.selection.context);
  const attachable = useMemo(() => attachableSurfaces(snapshot), [snapshot]);
  const editors = useMemo(() => editorSurfaces(snapshot), [snapshot]);

  // A missing Workspace Root keeps its identity, so recovery belongs on the
  // Surface the user is already looking at rather than only in the Sidebar.
  const unavailableActions =
    workspace?.state === "unavailable"
      ? ([
          {
            label: "Retry",
            primary: true,
            run: () =>
              void dispatch({
                type: "retry_workspace",
                workspaceId: workspace.id,
              }),
          },
          {
            label: "Locate…",
            run: () =>
              void chooseWorkspaceFolder().then((path) => {
                if (path)
                  void dispatch({
                    type: "locate_workspace",
                    workspaceId: workspace.id,
                    path,
                  });
              }),
          },
          {
            label: "Close",
            run: () =>
              void dispatch({
                type: "request_close_workspace",
                workspaceId: workspace.id,
              }),
          },
        ] as const)
      : undefined;

  let surfaceState: string;
  let body: ReactNode = null;
  let activeKey: string | undefined;
  let activeEditorKey: string | undefined;
  let surfaceKeyAttr: string | undefined;
  // Only the transient states announce themselves; a provider Surface speaks
  // for itself, and `aria-live` on it would narrate every frame of output.
  let announce = true;
  let live = true;

  if (snapshot.readiness !== "ready") {
    surfaceState = "loading";
    body = <Waiting label="Connecting…" />;
  } else if (
    workspace?.state === "closing" ||
    workspace?.state === "closing-failed"
  ) {
    surfaceState = workspace.state;
    body =
      workspace.state === "closing-failed" ? (
        <Failure summary="This Workspace could not be closed. Retry close from the Sidebar." />
      ) : (
        <Waiting label="Closing the workspace…" />
      );
  } else if (activitySnapshot.resolution.kind === "disabled") {
    surfaceState = "unavailable";
    live = false;
    body = (
      <Failure
        summary={disabledReasonLabel(activitySnapshot.resolution.reason)}
        detail={workspace?.state === "unavailable" ? workspace.root : undefined}
        actions={unavailableActions}
      />
    );
  } else {
    const surfaceKey = activitySnapshot.resolution.surfaceKey;
    surfaceState = activity === "terminal" ? "terminal" : activity;
    surfaceKeyAttr = surfaceKey;
    announce = false;
    if (activity === "terminal") {
      activeKey = attachable.has(surfaceKey) ? surfaceKey : undefined;
    } else if (activity === "agent") {
      body = <SurfaceAgent snapshot={snapshot} workspace={workspace} />;
      activeKey = attachable.has(surfaceKey) ? surfaceKey : undefined;
    } else {
      body = <SurfaceEditorState />;
      activeEditorKey = editors.has(surfaceKey) ? surfaceKey : undefined;
    }
  }

  // Everything is mounted; the selection decides what is on screen. There is
  // no cheaper set to keep than the Workspaces the user has open, and a
  // Surface they have not been to yet is one they are about to go to.
  const pool = [...attachable.values()];
  const editorPool = [...editors.values()];

  const isScratch = (key: string) => key === "global-terminal";

  return (
    <section
      ref={live ? surfaceRef : undefined}
      className="surface"
      aria-label="Surface"
      aria-busy={snapshot.readiness !== "ready" ? "true" : undefined}
      aria-live={announce ? "polite" : undefined}
      data-surface-key={surfaceKeyAttr}
      data-surface-state={surfaceState}
    >
      {intentError && (
        <InlineIntentError
          message={intentError.summary}
          detail={intentError.detail ?? undefined}
          onDismiss={dismissIntentError}
        />
      )}
      {body}
      {editorRemote
        ? editorPool.map((editor) => (
            <div
              key={editor.key}
              className="surface-pool-entry"
              hidden={editor.key !== activeEditorKey}
            >
              <EditorFrame remote={editorRemote} folder={editor.folder} />
            </div>
          ))
        : null}
      {pool.map((surface) => (
        <div
          key={surface.key}
          className="surface-pool-entry"
          hidden={surface.key !== activeKey}
        >
          <TerminalSurface
            surfaceKey={surface.key}
            surfaceLabel={surface.label}
            appearance={appearance}
            client={surface.client}
            hidden={surface.key !== activeKey}
            onInteractive={
              isScratch(surface.key)
                ? () => recordPerformanceMarker("scratch_interactive")
                : undefined
            }
            onAttachInvokeRejected={
              isScratch(surface.key)
                ? () =>
                    recordPerformanceMarker("terminal_attach_invoke_rejected")
                : undefined
            }
            onResizeInvokeEntered={
              isScratch(surface.key)
                ? () =>
                    recordPerformanceMarker("terminal_resize_invoke_entered")
                : undefined
            }
            onResizeInvokeRejected={
              isScratch(surface.key)
                ? () =>
                    recordPerformanceMarker("terminal_resize_invoke_rejected")
                : undefined
            }
            onInputInvokeEntered={
              isScratch(surface.key)
                ? () => recordPerformanceMarker("terminal_input_invoke_entered")
                : undefined
            }
            onInputInvokeRejected={
              isScratch(surface.key)
                ? () =>
                    recordPerformanceMarker("terminal_input_invoke_rejected")
                : undefined
            }
            onOutputRendered={
              isScratch(surface.key)
                ? () => recordPerformanceMarker("terminal_output_rendered")
                : undefined
            }
            onOutputAfterInputRendered={
              isScratch(surface.key)
                ? () =>
                    recordPerformanceMarker(
                      "terminal_output_after_input_rendered",
                    )
                : undefined
            }
            onChannelDiagnostic={
              isScratch(surface.key)
                ? (marker) => recordPerformanceMarker(marker)
                : undefined
            }
          />
        </div>
      ))}
    </section>
  );
}
