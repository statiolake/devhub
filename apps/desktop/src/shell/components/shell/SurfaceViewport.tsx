import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  clampSplitRatio,
  workspaceForContext,
  type AppAppearance,
  type AppError,
  type AppSnapshot,
  type WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { useAppShell } from "../../useAppShell";
import { devhub } from "../../client";
import { runningAgentSurfaces } from "./surfacePool";
import { closeDiagnosticLabel } from "./diagnosticLabel";
import { Failure, Waiting } from "./SurfaceState";
import { useRestartingEditors } from "./workbenchDialogs";
import { TerminalSurface } from "../../terminal/TerminalSurface";

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

/**
 * The divider between the workbench and an Agent's pane.
 *
 * It has to be a real element of its own, between the two panes, rather than a
 * hairline drawn on the edge of either: the workbench is a native view that
 * main lays over the hole this page leaves for it, and a native view paints
 * over everything in the page. A divider on top of the hole would be invisible
 * — and a divider drawn on the Agent pane's leading edge would put its grab
 * area a few pixels from where the eye says the seam is. So the seam *is* this
 * element, the hole stops where it starts, and the pointer meets the same
 * pixels it can see.
 */
function SplitDivider({
  ratio,
  onPreview,
  onCommit,
  containerRef,
}: {
  readonly ratio: number;
  readonly onPreview: (ratio: number) => void;
  readonly onCommit: (ratio: number) => void;
  readonly containerRef: React.RefObject<HTMLElement | null>;
}) {
  const [dragging, setDragging] = useState(false);
  const preview = useRef(ratio);

  const ratioAt = (clientX: number): number | undefined => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return undefined;
    return clampSplitRatio((clientX - bounds.left) / bounds.width);
  };

  useEffect(() => {
    if (!dragging) return undefined;
    document.body.classList.add("is-resizing-split");
    return () => document.body.classList.remove("is-resizing-split");
  }, [dragging]);

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (dragging) onCommit(preview.current);
    setDragging(false);
  };

  const step = (delta: number) => onCommit(clampSplitRatio(ratio + delta));

  return (
    <div
      className={`split-divider${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-label="Resize the agent pane"
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={85}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        preview.current = ratio;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const next = ratioAt(event.clientX);
        if (next === undefined) return;
        preview.current = next;
        onPreview(next);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(-0.02);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          step(0.02);
        }
      }}
    />
  );
}

/**
 * Every running Agent, mounted; the selected one shown.
 *
 * The pool is why switching between two Agents does not restart either of
 * them: a parked surface keeps its attachment and its scrollback, and coming
 * back to it is unhiding it. There is no cheaper set to keep — these are the
 * Agents the person started.
 */
function AgentPane({
  snapshot,
  appearance,
  activeKey,
  presentation,
}: {
  readonly snapshot: AppSnapshot;
  readonly appearance: AppAppearance | undefined;
  readonly activeKey: string | undefined;
  readonly presentation: "full" | "beside";
}) {
  const pool = useMemo(() => runningAgentSurfaces(snapshot), [snapshot]);
  return (
    <div
      className="agent-pane"
      hidden={activeKey === undefined}
      data-presentation={presentation}
    >
      {[...pool.values()].map((surface) => (
        <div
          className="surface-pool-entry"
          key={surface.key}
          hidden={surface.key !== activeKey}
        >
          <TerminalSurface
            surfaceKey={surface.key}
            surfaceLabel={surface.label}
            appearance={appearance}
            hidden={surface.key !== activeKey}
            // The Sidebar already names the Agent on screen; a title inside
            // the pane would say it twice.
            hideTitle
          />
        </div>
      ))}
    </div>
  );
}

/** Why this Workspace cannot be shown, in the Sidebar's own vocabulary. */
function Unavailable({
  workspace,
  actions,
}: {
  readonly workspace: WorkspaceSnapshot | undefined;
  readonly actions: React.ComponentProps<typeof Failure>["actions"];
}) {
  if (!workspace) {
    return <Failure summary="The selected context is no longer available." />;
  }
  if (workspace.state === "closing") {
    return <Waiting label="Closing the workspace…" />;
  }
  return (
    <Failure
      summary={
        workspace.state === "closing-failed"
          ? "This Workspace could not be closed. Retry close from the Sidebar."
          : "This workspace is unavailable."
      }
      detail={
        workspace.stateDiagnostic
          ? closeDiagnosticLabel(workspace.stateDiagnostic)
          : workspace.root
      }
      actions={workspace.state === "unavailable" ? actions : undefined}
    />
  );
}

/**
 * The content area: the workbench, and — when an Agent is selected — the
 * Agent's pane beside it.
 *
 * The workbench is a native `WebContentsView` that main lays over a rectangle
 * this page leaves empty and measures. So the page draws *nothing* where the
 * workbench goes; what it draws is the hole's neighbours — the divider and the
 * Agent pane — and what it sends is where the hole is and whether a workbench
 * belongs in it at all.
 *
 * The hole is measured rather than computed from the ratio. The ratio is what
 * the flex basis is set from, but the pixels the divider and the window's own
 * rounding actually leave are the pixels the native view has to match, and
 * measuring is the only way those two cannot drift.
 */
export function SurfaceViewport({
  snapshot,
  intentError,
  appearance,
}: SurfaceViewportProps) {
  const { dispatch, chooseWorkspaceFolder, dismissIntentError, reportFailure } =
    useAppShell();
  const layout = snapshot.layout;
  const workspace = workspaceForContext(snapshot, snapshot.selection.context);
  const restartingEditors = useRestartingEditors();
  const holeRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);

  // The divider moves under the pointer; the model learns where it stopped.
  // Sending an intent per pointer move would put a round trip in the middle of
  // a drag, and the drag is the one thing that has to feel direct.
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const ratio = dragRatio ?? snapshot.splitRatio;
  const commitRatio = useCallback(
    (next: number) => {
      setDragRatio(next);
      void dispatch({ type: "resize_split", ratio: next }).finally(() => {
        setDragRatio(null);
      });
    },
    [dispatch],
  );

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
  let split = false;
  /**
   * Whether the Agent's pane covers the content area or sits beside it.
   *
   * Read straight off the layout rather than from the selection: the layout is
   * already the one answer to "what is in the content area", and asking the
   * selection separately would be a second reading of the same fact that could
   * disagree with the first.
   */
  let agentPresentation: "full" | "beside" = "beside";
  let agentKey: string | undefined;
  let editorKey: string | undefined;
  let workbenchOnScreen = false;
  // Only the transient states announce themselves; a workbench speaks for
  // itself, and `aria-live` on it would narrate every frame of output.
  let announce = true;

  if (snapshot.readiness !== "ready") {
    surfaceState = "loading";
    body = <Waiting label="Connecting…" />;
  } else if (layout.kind === "unavailable") {
    surfaceState = workspace?.state ?? "unavailable";
    body = <Unavailable workspace={workspace} actions={unavailableActions} />;
  } else if (layout.kind === "agent") {
    // No workbench in this arrangement, so none is asked for and none is
    // revealed. The views stay built and running behind it: this is the Agent
    // covering the workbench, not the workbench going away.
    surfaceState = "agent";
    agentPresentation = "full";
    agentKey = layout.agentKey;
  } else if (restartingEditors.has(layout.editorKey)) {
    // The workbench is being rebuilt in this same slot. The selection has not
    // moved and must not: what changed is that there is nothing to show yet,
    // which is a state of this area rather than a reason to leave it.
    surfaceState = "editor-restarting";
    editorKey = layout.editorKey;
    body = <Waiting label="Restarting the editor…" />;
  } else {
    surfaceState = layout.kind;
    editorKey = layout.editorKey;
    workbenchOnScreen = true;
    announce = false;
    if (layout.kind === "split") {
      split = true;
      agentPresentation = "beside";
      agentKey = layout.agentKey;
    }
  }

  // The workbench view is a native sibling of this document, so the only way
  // main can place it is for the page to measure the hole it left. The hole is
  // watched rather than reported once: the divider moves it, and so does the
  // window, and so does the sidebar.
  useLayoutEffect(() => {
    const element = holeRef.current;
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

  // One flag, sent whenever it changes: does a workbench belong on screen?
  useEffect(() => {
    void devhub().setSurfaceVisible(workbenchOnScreen).catch(reportFailure);
  }, [workbenchOnScreen, reportFailure]);

  return (
    <section
      className="surface"
      aria-label="Surface"
      aria-busy={snapshot.readiness !== "ready" ? "true" : undefined}
      aria-live={announce ? "polite" : undefined}
      data-surface-key={editorKey}
      data-surface-state={surfaceState}
      ref={contentRef}
    >
      {intentError && (
        <InlineIntentError
          message={intentError.summary}
          detail={intentError.detail ?? undefined}
          onDismiss={dismissIntentError}
        />
      )}
      <div className="surface-panes">
        <div
          className="workbench-hole"
          ref={holeRef}
          style={split ? { flex: `0 0 ${String(ratio * 100)}%` } : undefined}
        >
          {body}
        </div>
        {split ? (
          <SplitDivider
            ratio={ratio}
            onPreview={setDragRatio}
            onCommit={commitRatio}
            containerRef={contentRef}
          />
        ) : null}
        {/* Mounted whether or not it is on screen. That is the whole of what
            the pool is for: an Agent parked behind another context keeps its
            attachment and its scrollback, so coming back to it is unhiding a
            pane rather than reconnecting a session. */}
        <AgentPane
          snapshot={snapshot}
          appearance={appearance}
          activeKey={agentKey}
          presentation={agentPresentation}
        />
      </div>
    </section>
  );
}
