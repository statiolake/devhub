import {
  activeActivitySnapshot,
  activityLabel,
  type Activity,
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
 * A quiet activity glyph. It is decorative: every state also names itself in
 * text so nothing depends on the symbol being understood.
 */
function SurfaceMark({
  activity,
  tone,
}: {
  readonly activity: Activity;
  readonly tone?: "danger";
}) {
  const mark = activity === "editor" ? "⌘" : activity === "agent" ? "◇" : "⌁";
  return (
    <span className="surface-mark" data-tone={tone} aria-hidden="true">
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
          ? "The editor appears here once the local Workbench is ready."
          : activity === "agent"
            ? "The agent control stream appears here once its runtime is ready."
            : "The persistent terminal appears here once its session is ready."}
      </p>
      {activity === "editor" ? (
        <p className="surface-note">
          DevHub runs your own installed Visual Studio Code. Starting it means
          you accept the{" "}
          <a
            href="https://aka.ms/vscode-server-license"
            target="_blank"
            rel="noreferrer"
          >
            VS Code Server License Terms
          </a>
          .
        </p>
      ) : null}
    </div>
  );
}

function SurfaceUnavailable({
  activity,
  reason,
  workspace,
  actions,
}: {
  readonly activity: Activity;
  readonly reason: string;
  readonly workspace?: WorkspaceSnapshot;
  readonly actions?: readonly {
    readonly label: string;
    readonly primary?: boolean;
    readonly run: () => void;
  }[];
}) {
  const missingRoot = workspace?.state === "unavailable";
  return (
    <div className="surface-state surface-unavailable-state" role="status">
      <SurfaceMark activity={activity} tone="danger" />
      <p className="surface-kicker">Unavailable</p>
      <h1>{missingRoot ? workspace.label : "Surface unavailable"}</h1>
      <p className="surface-copy">{reason}</p>
      {missingRoot ? <p className="surface-note">{workspace.root}</p> : null}
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
        ref={surfaceRef}
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
        <SurfaceEmpty
          activity={activity}
          context={snapshot.selection.context}
          workspace={workspace}
        />
      )}
    </section>
  );
}
