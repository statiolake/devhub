import {
  activeActivitySnapshot,
  type AppAppearance,
  type AppSnapshot,
  type WorkspaceSnapshot,
  workspaceForContext,
} from "../../generated/app-shell";
import type { Ref } from "react";
import { TerminalSurface } from "../../terminal/TerminalSurface";
import { defaultAgentSurfaceClient } from "../../agent/client";
import { disabledReasonLabel } from "./activityPresentation";
import { useAppShell } from "../../app/useAppShell";

export interface SurfaceViewportProps {
  readonly snapshot: AppSnapshot;
  readonly intentError?: string;
  readonly appearance?: AppAppearance;
  readonly surfaceRef?: Ref<HTMLElement>;
}

function InlineIntentError({ message }: { readonly message: string }) {
  return (
    <div className="surface-inline-alert" role="alert">
      <span className="surface-inline-alert-mark" aria-hidden="true">
        !
      </span>
      <span>{message}</span>
    </div>
  );
}

/**
 * Every non-provider state is the same shape: one line saying what is
 * happening, and — when something went wrong — the text needed to fix it.
 * Nothing restates the Workspace or the Activity, because the Sidebar and the
 * titlebar already show both.
 */
function Waiting({ label }: { readonly label: string }) {
  return (
    <div className="surface-state" role="status">
      <span className="surface-spinner" aria-hidden="true" />
      <p className="surface-line">{label}</p>
    </div>
  );
}

function Failure({
  summary,
  detail,
  actions,
}: {
  readonly summary: string;
  readonly detail?: string;
  readonly actions?: readonly {
    readonly label: string;
    readonly primary?: boolean;
    readonly run: () => void;
  }[];
}) {
  return (
    <div className="surface-state surface-failure" role="alert">
      <p className="surface-line">{summary}</p>
      {detail ? <pre className="surface-detail">{detail}</pre> : null}
      {actions && actions.length > 0 ? (
        <div className="surface-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              className={action.primary ? "primary-button" : "secondary-button"}
              type="button"
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The Editor's content is a native child WebView; the shell draws only the
 * states around it. */
function SurfaceEditor({ host }: { readonly host: AppSnapshot["editorHost"] }) {
  if (host.status === "failed") {
    return <Failure summary={host.summary} detail={host.detail ?? undefined} />;
  }
  return <Waiting label="Starting the editor…" />;
}

function SurfaceAgent({
  snapshot,
  workspace,
  surfaceKey,
  appearance,
}: {
  readonly snapshot: AppSnapshot;
  readonly workspace?: WorkspaceSnapshot;
  readonly surfaceKey: string;
  readonly appearance?: AppAppearance;
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
  return (
    <TerminalSurface
      surfaceKey={surfaceKey}
      surfaceLabel={agent.displayName}
      appearance={appearance}
      client={defaultAgentSurfaceClient}
    />
  );
}

export function SurfaceViewport({
  snapshot,
  intentError,
  appearance,
  surfaceRef,
}: SurfaceViewportProps) {
  const { recordPerformanceMarker, dispatch, chooseWorkspaceFolder } =
    useAppShell();
  const activity = snapshot.selection.activity;
  const activitySnapshot = activeActivitySnapshot(snapshot);
  const workspace = workspaceForContext(snapshot, snapshot.selection.context);

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

  if (snapshot.readiness !== "ready") {
    return (
      <section
        ref={surfaceRef}
        className="surface"
        aria-label="Surface"
        aria-busy="true"
        aria-live="polite"
        data-surface-state="loading"
      >
        <Waiting label="Connecting…" />
      </section>
    );
  }

  if (workspace?.state === "closing" || workspace?.state === "closing-failed") {
    return (
      <section
        ref={surfaceRef}
        className="surface"
        aria-label="Surface"
        aria-live="polite"
        data-surface-state={workspace.state}
      >
        {intentError && <InlineIntentError message={intentError} />}
        {workspace.state === "closing-failed" ? (
          <Failure summary="This Workspace could not be closed. Retry close from the Sidebar." />
        ) : (
          <Waiting label="Closing the workspace…" />
        )}
      </section>
    );
  }

  if (activitySnapshot.resolution.kind === "disabled") {
    return (
      <section
        className="surface"
        aria-label="Surface"
        aria-live="polite"
        data-surface-state="unavailable"
      >
        {intentError && <InlineIntentError message={intentError} />}
        <Failure
          summary={disabledReasonLabel(activitySnapshot.resolution.reason)}
          detail={
            workspace?.state === "unavailable" ? workspace.root : undefined
          }
          actions={unavailableActions}
        />
      </section>
    );
  }

  return (
    <section
      ref={surfaceRef}
      className="surface"
      aria-label="Surface"
      data-surface-key={activitySnapshot.resolution.surfaceKey}
      data-surface-state={activity === "terminal" ? "terminal" : activity}
    >
      {intentError && <InlineIntentError message={intentError} />}
      {activity === "terminal" ? (
        <TerminalSurface
          surfaceKey={activitySnapshot.resolution.surfaceKey}
          surfaceLabel={
            snapshot.selection.context.kind === "global"
              ? "Scratch"
              : (workspace?.label ?? "Workspace")
          }
          appearance={appearance}
          onInteractive={
            snapshot.selection.context.kind === "global"
              ? () => recordPerformanceMarker("scratch_interactive")
              : undefined
          }
          onAttachInvokeRejected={
            snapshot.selection.context.kind === "global"
              ? () => recordPerformanceMarker("terminal_attach_invoke_rejected")
              : undefined
          }
          onResizeInvokeEntered={
            snapshot.selection.context.kind === "global"
              ? () => recordPerformanceMarker("terminal_resize_invoke_entered")
              : undefined
          }
          onResizeInvokeRejected={
            snapshot.selection.context.kind === "global"
              ? () => recordPerformanceMarker("terminal_resize_invoke_rejected")
              : undefined
          }
          onInputInvokeEntered={
            snapshot.selection.context.kind === "global"
              ? () => recordPerformanceMarker("terminal_input_invoke_entered")
              : undefined
          }
          onInputInvokeRejected={
            snapshot.selection.context.kind === "global"
              ? () => recordPerformanceMarker("terminal_input_invoke_rejected")
              : undefined
          }
          onOutputRendered={
            snapshot.selection.context.kind === "global"
              ? () => recordPerformanceMarker("terminal_output_rendered")
              : undefined
          }
          onOutputAfterInputRendered={
            snapshot.selection.context.kind === "global"
              ? () =>
                  recordPerformanceMarker(
                    "terminal_output_after_input_rendered",
                  )
              : undefined
          }
          onChannelDiagnostic={
            snapshot.selection.context.kind === "global"
              ? (marker) => recordPerformanceMarker(marker)
              : undefined
          }
        />
      ) : activity === "agent" ? (
        <SurfaceAgent
          snapshot={snapshot}
          workspace={workspace}
          surfaceKey={activitySnapshot.resolution.surfaceKey}
          appearance={appearance}
        />
      ) : (
        <SurfaceEditor host={snapshot.editorHost} />
      )}
    </section>
  );
}
