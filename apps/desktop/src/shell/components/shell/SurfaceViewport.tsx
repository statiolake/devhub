import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  activeActivitySnapshot,
  workspaceForContext,
  type AppAppearance,
  type AppError,
  type AppSnapshot,
  type WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { useAppShell } from "../../useAppShell";
import { devhub } from "../../client";
import { attachableSurfaces } from "./surfacePool";
import { surfaceRenderer } from "./surfaceRegistry";
import {
  closeDiagnosticLabel,
  disabledReasonLabel,
} from "./activityPresentation";
import { Failure, Waiting } from "./SurfaceState";
import { answerWorkbenchDialog, useWorkbenchDialogs } from "./workbenchDialogs";
import { ViewScopedAlert } from "./ViewScopedAlert";

export interface SurfaceViewportProps {
  readonly snapshot: AppSnapshot;
  readonly intentError?: AppError;
  readonly appearance?: AppAppearance;
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

/** One pooled Surface, mounted whether or not it is the one on screen. */
function PooledSurfaceEntry({
  surfaceKey,
  surfaceLabel,
  kind,
  appearance,
  visible,
}: {
  readonly surfaceKey: string;
  readonly surfaceLabel: string;
  readonly kind: "terminal" | "agent";
  readonly appearance: AppAppearance | undefined;
  readonly visible: boolean;
}) {
  const Renderer = surfaceRenderer(kind);
  return (
    <div className="surface-pool-entry" hidden={!visible}>
      {Renderer ? (
        <Renderer
          surfaceKey={surfaceKey}
          surfaceLabel={surfaceLabel}
          appearance={appearance}
          visible={visible}
        />
      ) : (
        <Failure
          summary={`The ${kind} surface is not available in this build.`}
          detail={`Nothing registered a renderer for ${surfaceKey}.`}
        />
      )}
    </div>
  );
}

/**
 * The viewport: one rectangle, and whatever the selection resolves to inside it.
 *
 * Two kinds of thing land here and they do not share a mechanism. A terminal or
 * an agent is a DOM Surface in this document, mounted in a pool and shown by
 * unhiding it. An Editor is a native `WebContentsView` that main positions over
 * this rectangle — so for the Editor the page draws *nothing* and instead tells
 * main where the hole is, and whether the hole is currently the thing on screen.
 */
export function SurfaceViewport({
  snapshot,
  intentError,
  appearance,
}: SurfaceViewportProps) {
  const { dispatch, chooseWorkspaceFolder, dismissIntentError, reportFailure } =
    useAppShell();
  const activity = snapshot.selection.activity;
  const activitySnapshot = activeActivitySnapshot(snapshot);
  const workspace = workspaceForContext(snapshot, snapshot.selection.context);
  const attachable = useMemo(() => attachableSurfaces(snapshot), [snapshot]);
  // Questions raised by workbenches, each waiting for the editor it belongs to
  // to be the one on screen.
  const workbenchDialogs = useWorkbenchDialogs();
  const viewportRef = useRef<HTMLElement | null>(null);

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

  // A question a workbench asked belongs to that workbench, whatever the
  // workspace is doing — a close is usually *why* it is asking. It is found by
  // the context's own editor key rather than by the resolved activity, so it
  // survives the workspace going into "closing" and survives being switched
  // away from: it goes away with its editor and comes back with it.
  const contextEditorKey =
    snapshot.selection.context.kind === "global"
      ? "global-editor"
      : workspace
        ? `workspace-editor:${workspace.id}`
        : undefined;
  const editorDialog =
    contextEditorKey === undefined
      ? undefined
      : workbenchDialogs.get(contextEditorKey);

  let surfaceState: string;
  let body: ReactNode = null;
  let activeKey: string | undefined;
  let surfaceKeyAttr: string | undefined;
  let editorOnScreen = false;
  // Only the transient states announce themselves; a provider Surface speaks
  // for itself, and `aria-live` on it would narrate every frame of output.
  let announce = true;

  if (snapshot.readiness !== "ready") {
    surfaceState = "loading";
    body = <Waiting label="Connecting…" />;
  } else if (editorDialog) {
    // The workbench is standing down under its own question; the question is
    // what is on screen, over the still frame it came with.
    surfaceState = "editor";
    announce = false;
  } else if (
    workspace?.state === "closing" ||
    workspace?.state === "closing-failed"
  ) {
    surfaceState = workspace.state;
    body =
      workspace.state === "closing-failed" ? (
        <Failure
          summary="This Workspace could not be closed. Retry close from the Sidebar."
          detail={
            workspace.stateDiagnostic
              ? closeDiagnosticLabel(workspace.stateDiagnostic)
              : undefined
          }
        />
      ) : (
        <Waiting label="Closing the workspace…" />
      );
  } else if (activitySnapshot.resolution.kind === "disabled") {
    surfaceState = "unavailable";
    body = (
      <Failure
        summary={disabledReasonLabel(activitySnapshot.resolution.reason)}
        detail={workspace?.state === "unavailable" ? workspace.root : undefined}
        actions={unavailableActions}
      />
    );
  } else {
    const surfaceKey = activitySnapshot.resolution.surfaceKey;
    surfaceState = activity;
    surfaceKeyAttr = surfaceKey;
    announce = false;
    if (activity === "editor") {
      editorOnScreen = true;
    } else {
      activeKey = attachable.has(surfaceKey) ? surfaceKey : undefined;
      if (activity === "agent") {
        body = <SurfaceAgent snapshot={snapshot} workspace={workspace} />;
      }
    }
  }

  // The workbench views are native siblings of this document, so the only way
  // main can place them is for the page to measure the hole it left.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const report = () => {
      const rect = element.getBoundingClientRect();
      void devhub()
        .setContentRect({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        })
        .catch(reportFailure);
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => {
      observer.disconnect();
    };
  }, [reportFailure]);

  // One flag, sent whenever it changes: is the native view the thing on screen?
  useEffect(() => {
    void devhub()
      .setSurfaceVisible(editorOnScreen && editorDialog === undefined)
      .catch(reportFailure);
  }, [editorOnScreen, editorDialog, reportFailure]);

  // Everything is mounted; the selection decides what is on screen. There is
  // no cheaper set to keep than the Workspaces the user has open.
  const pool = [...attachable.values()];

  return (
    <section
      className="surface"
      aria-label="Surface"
      aria-busy={snapshot.readiness !== "ready" ? "true" : undefined}
      aria-live={announce ? "polite" : undefined}
      data-surface-key={surfaceKeyAttr}
      data-surface-state={surfaceState}
      ref={viewportRef}
    >
      {intentError && (
        <InlineIntentError
          message={intentError.summary}
          detail={intentError.detail ?? undefined}
          onDismiss={dismissIntentError}
        />
      )}
      {body}
      {pool.map((surface) => (
        <PooledSurfaceEntry
          key={surface.key}
          surfaceKey={surface.key}
          surfaceLabel={surface.label}
          kind={surface.kind}
          appearance={appearance}
          visible={surface.key === activeKey}
        />
      ))}
      {editorDialog ? (
        <ViewScopedAlert
          request={editorDialog}
          onAnswer={(response) => {
            answerWorkbenchDialog(editorDialog, response);
          }}
        />
      ) : null}
    </section>
  );
}
