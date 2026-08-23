import {
  activeActivitySnapshot,
  activityLabel,
  type Activity,
  type AppAppearance,
  type AppSnapshot,
  type WorkspaceSnapshot,
  workspaceForContext,
} from "../../generated/app-shell";
import { StatusMark } from "../sidebar/StatusMark";
import { TerminalSurface } from "../../terminal/TerminalSurface";

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
    return (
      <SurfaceUnavailable
        activity="agent"
        reason="The selected Agent is no longer available."
        workspace={workspace}
      />
    );
  }
  return (
    <div className="surface-state surface-empty-state">
      <SurfaceMark activity="agent" />
      <p className="surface-kicker">Agent Surface</p>
      <h1>{agent.displayName}</h1>
      <div className="surface-agent-status">
        <StatusMark status={agent.status} />
        <span>
          {agent.runtimeHealth === "healthy"
            ? "Connected"
            : agent.runtimeHealth}
        </span>
      </div>
      <p className="surface-copy">
        The provider control stream will mount here when the Agent Surface is
        available.
      </p>
    </div>
  );
}

export function SurfaceViewport({
  snapshot,
  intentError,
  appearance,
}: SurfaceViewportProps) {
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
          reason={activitySnapshot.resolution.reason.replaceAll("-", " ")}
        />
      </section>
    );
  }

  return (
    <section
      className="surface"
      aria-label="Surface"
      aria-live="polite"
      data-surface-key={activitySnapshot.resolution.surfaceKey}
      data-surface-state={activity === "terminal" ? "terminal" : "empty"}
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
        />
      ) : activity === "agent" ? (
        <SurfaceAgent snapshot={snapshot} workspace={workspace} />
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
