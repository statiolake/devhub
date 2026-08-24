import {
  activeActivitySnapshot,
  activityLabel,
  type Activity,
  type AppAppearance,
  type AppSnapshot,
  type WorkspaceSnapshot,
  workspaceForContext,
} from "../../generated/app-shell";
import { TerminalSurface } from "../../terminal/TerminalSurface";
import { defaultAgentSurfaceClient } from "../../agent/client";
import { disabledReasonLabel } from "./activityPresentation";
import { useAppShell } from "../../app/useAppShell";

export interface SurfaceViewportProps {
  readonly snapshot: AppSnapshot;
  readonly intentError?: string;
  readonly appearance?: AppAppearance;
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

function SurfaceMark({ activity }: { readonly activity: Activity }) {
  const mark = activity === "editor" ? "⌘" : activity === "agent" ? "◇" : "⌁";
  return (
    <span className="surface-mark" aria-hidden="true">
      {mark}
    </span>
  );
}

function SurfaceEmpty({
  activity,
  context,
  workspace,
}: {
  readonly activity: Activity;
  readonly context: AppSnapshot["selection"]["context"];
  readonly workspace?: WorkspaceSnapshot;
}) {
  const label = activityLabel(activity);
  const contextText =
    context.kind === "global"
      ? "Scratch"
      : context.kind === "workspace"
        ? (workspace?.label ?? "Workspace")
        : (workspace?.label ?? "Agent workspace");
  return (
    <div className="surface-state surface-empty-state">
      <SurfaceMark activity={activity} />
      <p className="surface-kicker">{label} Surface</p>
      <h1>{contextText}</h1>
      <p className="surface-copy">
        {activity === "editor"
          ? "The editor surface will appear here when the local host is ready."
          : activity === "agent"
            ? "The agent control stream will appear here when the runtime is ready."
            : "The persistent terminal surface will appear here when the session is ready."}
      </p>
    </div>
  );
}

function SurfaceUnavailable({
  activity,
  reason,
  workspace,
}: {
  readonly activity: Activity;
  readonly reason: string;
  readonly workspace?: WorkspaceSnapshot;
}) {
  const title =
    workspace?.state === "unavailable"
      ? "Workspace unavailable"
      : "Surface unavailable";
  return (
    <div className="surface-state surface-unavailable-state" role="status">
      <SurfaceMark activity={activity} />
      <p className="surface-kicker">Unavailable</p>
      <h1>{title}</h1>
      <p className="surface-copy">{reason}</p>
    </div>
  );
}

function SurfaceClosing({
  activity,
  failed,
  workspace,
}: {
  readonly activity: Activity;
  readonly failed: boolean;
  readonly workspace: WorkspaceSnapshot;
}) {
  return (
    <div className="surface-state surface-closing-state" role="status">
      <SurfaceMark activity={activity} />
      <p className="surface-kicker">{failed ? "Close failed" : "Closing"}</p>
      <h1>{workspace.label}</h1>
      <p className="surface-copy">
        {failed
          ? "Some resources could not be closed. The workspace remains available for retry."
          : "The workspace is closing its editor, agents, and terminal resources."}
      </p>
    </div>
  );
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
    return (
      <SurfaceUnavailable
        activity="agent"
        reason="The selected Agent is no longer available."
        workspace={workspace}
      />
    );
  }
  if (agent.controlState !== "running") {
    return (
      <SurfaceUnavailable
        activity="agent"
        reason={
          agent.controlState === "stopping"
            ? "This Agent is stopping. Its control surface is read-only until cleanup completes."
            : "This Agent could not be stopped cleanly. Retry stop before reconnecting its control surface."
        }
        workspace={workspace}
      />
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
}: SurfaceViewportProps) {
  const { recordPerformanceMarker } = useAppShell();
  const activity = snapshot.selection.activity;
  const activitySnapshot = activeActivitySnapshot(snapshot);
  const workspace = workspaceForContext(snapshot, snapshot.selection.context);

  if (snapshot.readiness !== "ready") {
    return (
      <section
        className="surface"
        aria-label="Surface"
        aria-busy="true"
        aria-live="polite"
        data-surface-state="loading"
      >
        <div className="surface-state surface-loading-state" role="status">
          <SurfaceMark activity={activity} />
          <p className="surface-kicker">Connecting</p>
          <h1>Waking the local workbench</h1>
          <p className="surface-copy">
            Restoring the immutable application snapshot from the native host.
          </p>
        </div>
      </section>
    );
  }

  if (workspace?.state === "closing" || workspace?.state === "closing-failed") {
    return (
      <section
        className="surface"
        aria-label="Surface"
        aria-live="polite"
        data-surface-state={workspace.state}
      >
        {intentError && <InlineIntentError message={intentError} />}
        <SurfaceClosing
          activity={activity}
          failed={workspace.state === "closing-failed"}
          workspace={workspace}
        />
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
        <SurfaceUnavailable
          activity={activity}
          workspace={workspace}
          reason={disabledReasonLabel(activitySnapshot.resolution.reason)}
        />
      </section>
    );
  }

  return (
    <section
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
        <SurfaceEmpty
          activity={activity}
          context={snapshot.selection.context}
          workspace={workspace}
        />
      )}
    </section>
  );
}
