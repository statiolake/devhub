import {
  activeActivitySnapshot,
  type AppAppearance,
  type AppSnapshot,
  type WorkspaceSnapshot,
  workspaceForContext,
} from "../../generated/app-shell";
import { type ReactNode, type Ref, useMemo, useRef } from "react";
import { TerminalSurface } from "../../terminal/TerminalSurface";
import { attachableSurfaces } from "./surfacePool";
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
      <p className="failure-title">
        <svg
          className="failure-icon"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="7" />
          <path d="M8 4.6v4.2M8 11.1v.6" />
        </svg>
        {summary}
      </p>
      {detail ? <p className="failure-detail">{detail}</p> : null}
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
  const { recordPerformanceMarker, dispatch, chooseWorkspaceFolder } =
    useAppShell();
  const activity = snapshot.selection.activity;
  const activitySnapshot = activeActivitySnapshot(snapshot);
  const workspace = workspaceForContext(snapshot, snapshot.selection.context);
  const attachable = useMemo(() => attachableSurfaces(snapshot), [snapshot]);

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
      body = <SurfaceEditor host={snapshot.editorHost} />;
    }
  }

  // Visitation order, not snapshot order: a Surface joins the pool the first
  // time it is selected, so nothing attaches a PTY the user never asked for.
  const visited = useRef<readonly string[]>([]);
  if (activeKey && !visited.current.includes(activeKey)) {
    visited.current = [...visited.current, activeKey];
  }
  visited.current = visited.current.filter((key) => attachable.has(key));
  const pool = visited.current.map((key) => attachable.get(key)!);

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
      {intentError && <InlineIntentError message={intentError} />}
      {body}
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
